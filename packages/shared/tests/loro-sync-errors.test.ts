import { afterEach, describe, expect, it, vi } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroRepo, RepoSyncError, RepoTransportError, type RepoDiagnosticEvent } from 'loro-repo';
import { StreamsTransportAdapter } from 'loro-repo/transport/streams';
import { createLoroSyncErrorTools } from '../src/loro-sync-errors';

const { collectLoroSyncFailures, formatLoroSyncError, getLoroSyncDiagnostic } =
  createLoroSyncErrorTools({
    RepoTransportError,
    RepoSyncError,
  });

const secret = 'synthetic-provider-token-secret';
const adapters: StreamsTransportAdapter[] = [];
const repos: LoroRepo[] = [];
const createAdapter = (
  options: Partial<ConstructorParameters<typeof StreamsTransportAdapter>[0]> = {}
) => {
  const adapter = new StreamsTransportAdapter({
    bucketId: 'fixture',
    baseUrl: 'https://streams.synthetic.invalid',
    persistence: { mode: 'ephemeral' },
    ...options,
  });
  adapters.push(adapter);
  return adapter;
};

afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.destroy();
  for (const adapter of adapters.splice(0)) await adapter.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('safe Lody sync diagnostics from published Streams and Repo', () => {
  it.each([
    { code: 'ENOTFOUND', errorClass: Error },
    { code: 'ECONNREFUSED', errorClass: TypeError },
  ])(
    'shows the observed $code code without the fetch message or cause',
    async ({ code, errorClass }) => {
      vi.stubGlobal('fetch', async () => {
        throw new errorClass(secret, { cause: Object.assign(new Error(secret), { code }) });
      });
      const records: ReturnType<typeof getLoroSyncDiagnostic>[] = [];
      const adapter = createAdapter({
        diagnostics: (event) => records.push(getLoroSyncDiagnostic(event)),
      });
      const result = await adapter.syncMeta(new Flock());
      expect(result.ok).toBe(false);
      const message = formatLoroSyncError(result.error);
      expect(message).toContain('network request failed');
      expect(message).toContain(`networkCode=${code}`);
      expect(message).toContain('stage=bootstrap');
      expect(message).not.toContain(secret);
      expect(records.filter(Boolean)).toMatchObject([
        {
          event: 'sync.meta.failed',
          roomKind: 'meta',
          phase: 'sync',
          failures: [{ retryable: true, streamsContext: { source: 'fetch', networkCode: code } }],
        },
      ]);
      expect(JSON.stringify(records)).not.toContain(secret);
    }
  );

  it('shows HTTP response evidence including status and request ID', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(secret, {
          status: 503,
          headers: { 'x-request-id': 'fixture-request', authorization: secret },
        })
    );
    const result = await createAdapter().syncMeta(new Flock());
    const message = formatLoroSyncError(result.error);
    expect(message).toContain('HTTP response error');
    expect(message).toContain('status=503');
    expect(message).toContain('requestId=fixture-request');
    expect(message).toContain('code=server_error');
    expect(message).not.toContain(secret);
  });

  it('reports local cursor failure and explicit false without making a network request', async () => {
    const adapter = createAdapter({
      persistence: {
        mode: 'ephemeral',
        remoteCursorStore: {
          load: async () => {
            throw new TypeError(secret);
          },
          save: async () => {},
        },
      },
    });
    vi.stubGlobal('fetch', async () => {
      throw new Error('unexpected network request');
    });
    const result = await adapter.syncMeta(new Flock());
    expect(collectLoroSyncFailures(result.error)).toMatchObject([
      {
        failureKind: 'local-storage',
        retryable: false,
        streamsContext: { source: 'cursor_store', stage: 'cursor_load' },
      },
    ]);
    expect(formatLoroSyncError(result.error)).toContain('local storage failed');
    expect(formatLoroSyncError(result.error)).toContain('retryable=false');
    expect(formatLoroSyncError(result.error)).not.toContain(secret);
  });

  it('shows the measured initial-sync deadline with fake timers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      async (_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        })
    );
    const pending = createAdapter({
      reconnectConfig: {
        initialSyncHardTimeoutMs: 50,
        initialSyncSlowAfterMs: 0,
      },
    }).syncMeta(new Flock());
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;
    const message = formatLoroSyncError(result.error);
    expect(message).toContain('request timed out');
    expect(message).toContain('timeoutMs=50');
    expect(message).toContain('elapsedMs=50');
    expect(message).toContain('code=initial_sync_timeout');
  });

  it('keeps both registered transports in a real total-failure report', async () => {
    vi.stubGlobal('fetch', async () => new Response(secret, { status: 503 }));
    const repo = await LoroRepo.create({});
    repos.push(repo);
    await repo.addTransport('cloud-primary', createAdapter());
    await repo.addTransport('cloud-secondary', createAdapter());
    const error = await repo.sync({ scope: 'meta' }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(RepoSyncError);
    expect(collectLoroSyncFailures(error).map((failure) => failure.transportId)).toEqual([
      'cloud-primary',
      'cloud-secondary',
    ]);
    expect(formatLoroSyncError(error)).toContain('transport=cloud-secondary');
    expect(formatLoroSyncError(error)).not.toContain(secret);
  });

  it('formats caller wrappers and cyclic causes without exposing their raw message', async () => {
    vi.stubGlobal('fetch', async () => new Response(secret, { status: 503 }));
    const result = await createAdapter().syncMeta(new Flock());
    const wrapped = new Error(secret, { cause: result.error });
    const cyclic = new Error(secret);
    cyclic.cause = cyclic;
    const combined = new AggregateError([wrapped, cyclic], secret);
    expect(formatLoroSyncError(combined)).toContain('status=503');
    expect(formatLoroSyncError(combined)).not.toContain(secret);
    expect(collectLoroSyncFailures(cyclic)).toEqual([]);
  });

  it('keeps legacy provenance unknown and ignores ordinary errors and normal activity', () => {
    const legacy = new RepoTransportError(secret, {
      code: 'network',
      phase: 'sync',
      transportId: 'streams',
    });
    expect(formatLoroSyncError(legacy)).toContain('failure source unknown');
    expect(formatLoroSyncError(legacy)).not.toContain(secret);
    expect(formatLoroSyncError(new Error('ordinary failure'))).toBeUndefined();
    expect(
      formatLoroSyncError(
        new RepoTransportError('local plane failure', {
          code: 'network',
          phase: 'sync',
          transportId: 'local',
        })
      )
    ).toBeUndefined();
    expect(getLoroSyncDiagnostic({ level: 'debug', event: 'cursor.saved' })).toBeUndefined();
  });

  it('projects only documented fields, without serializing the exception', () => {
    const error = new RepoTransportError(secret, {
      code: 'internal',
      phase: 'sync',
      transportId: 'streams',
      failureKind: 'local',
      retryable: false,
      streamsCode: 'payload_protection_error',
      streamsContext: {
        source: 'payload_protection',
        operation: 'sync',
        stage: 'payload_encode',
        originalCode: 'payload_protection_error',
        retryable: false,
      },
      cause: new Error(secret),
    });
    Object.assign(error.streamsContext!, {
      body: secret,
      headers: { authorization: secret },
      provider: secret,
    });
    const event: RepoDiagnosticEvent = { level: 'warn', event: 'sync.meta.failed', error };
    const record = getLoroSyncDiagnostic(event);
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(record?.failures[0]?.streamsContext?.source).toBe('payload_protection');
    expect(formatLoroSyncError(error)).not.toContain(secret);
  });
});
