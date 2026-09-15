import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommandEffect } from './command-effect';
import { listWorkspacesForTokenEffect, WorkspaceAccessError } from './workspace';
import { loadEnv } from '@/utils/const';
import { safeAccessQueryErrorDetails } from '@/utils/access-query-error';

const diagnostics = vi.hoisted(() => [] as string[]);
vi.mock('@/utils/logger', () => ({
  getLogger: () => ({ debug: (value: string) => diagnostics.push(value) }),
}));

const workspaces = [{ id: 'workspace', name: 'Synthetic', slug: null, role: 'owner' }];
const response = () =>
  new Response(
    JSON.stringify({ status: 'success', value: { valid: true, userId: 'user', workspaces } })
  );
const failure = () =>
  new TypeError('fetch failed at https://secret.invalid/token', { cause: { code: 'ECONNRESET' } });
const run = (signal?: AbortSignal) =>
  runCommandEffect(listWorkspacesForTokenEffect('synthetic-token'), { signal }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
const gate = () => {
  let resolve: () => void = () => {
    throw new Error('uninitialized gate');
  };
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
beforeEach(() => {
  diagnostics.length = 0;
  vi.useFakeTimers();
  vi.stubEnv('LODY_AUTH_URL', 'https://synthetic.convex.cloud');
  loadEnv();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  loadEnv();
});

describe('workspace access Effect at the real Convex HTTP boundary', () => {
  it('recovers a transient read using a bounded schedule', async () => {
    let failing = true;
    vi.stubGlobal('fetch', async () => {
      if (failing) throw failure();
      return response();
    });
    const result = run();
    await vi.advanceTimersByTimeAsync(0);
    failing = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toEqual({ ok: true, value: workspaces });
  });
  it('exhausts four read attempts and retains a typed, safe error at the Promise boundary', async () => {
    vi.stubGlobal('fetch', async () => {
      throw failure();
    });
    const result = run();
    await vi.advanceTimersByTimeAsync(3250);
    const settled = await result;
    expect(settled).toMatchObject({
      ok: false,
      error: { _tag: 'WorkspaceAccessError', kind: 'unavailable' },
    });
    if (settled.ok) throw new Error('expected failure');
    if (!(settled.error instanceof WorkspaceAccessError))
      throw new Error('expected typed workspace error');
    expect(settled.error.toLodyError()).toMatchObject({
      code: 'WORKSPACE_ACCESS_UNAVAILABLE',
      retryable: true,
    });
    expect(settled.error.message).not.toContain('secret.invalid');
    expect(safeAccessQueryErrorDetails(settled.error)).toEqual({
      causeCodes: ['ECONNRESET'],
      httpStatuses: [],
    });
    const records = diagnostics.map((value) => JSON.parse(value));
    expect(records.map((record) => record.attempt)).toEqual([1, 2, 3, 4]);
    expect(records[0]).toMatchObject({
      stage: 'workspace.query',
      endpoint: 'auth.workspace-list',
      causeCodes: ['ECONNRESET'],
    });
    expect(diagnostics.join(' ')).not.toMatch(/secret\.invalid|synthetic-token|fetch failed/);
  });
  it('missing cloud configuration fails without any I/O', async () => {
    vi.stubEnv('LODY_AUTH_URL', '');
    loadEnv();
    vi.stubGlobal('fetch', async () => response());
    expect(await run()).toMatchObject({ ok: false, error: { kind: 'not_configured' } });
  });
  it('a rejected HTTP response remains denied even if body cancellation does not settle', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }), {
          status: 403,
        })
    );
    expect(await run()).toMatchObject({ ok: false, error: { kind: 'denied' } });
  });
  it.each([401, 403, 400, 560])(
    'HTTP %s wins over misleading transport text without a retry delay',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        async () => new Response('fetch failed ECONNRESET secret-token', { status })
      );
      // No clock advancement: retrying would leave this unresolved.
      expect(await run()).toMatchObject({
        ok: false,
        error: { kind: status === 401 || status === 403 ? 'denied' : 'invalid_response' },
      });
    }
  );
  it('does not retry a Convex business error containing fetch failed', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            status: 'error',
            errorMessage: 'fetch failed business rule',
            logLines: [],
          })
        )
    );
    expect(await run()).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
  });
  it('does not retry a malformed successful response', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ status: 'success', value: { valid: true } }))
    );
    expect(await run()).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
  });
  it('retries a response-body transport failure, not just connection failures', async () => {
    let failing = true;
    vi.stubGlobal('fetch', async () =>
      failing
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.error(failure());
              },
            })
          )
        : response()
    );
    const result = run();
    await vi.advanceTimersByTimeAsync(0);
    failing = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toEqual({ ok: true, value: workspaces });
  });
  it('aborts a stalled response body at the attempt timeout and recovers', async () => {
    const entered = gate();
    const aborted = gate();
    let stalled = true;
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      if (!stalled) return response();
      return new Response(
        new ReadableStream({
          start(controller) {
            init.signal?.addEventListener(
              'abort',
              () => {
                controller.error(new Error('aborted'));
                aborted.resolve();
              },
              { once: true }
            );
            entered.resolve();
          },
        })
      );
    });
    const result = run();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(5000);
    await aborted.promise;
    stalled = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toEqual({ ok: true, value: workspaces });
  });
  it('enforces the total deadline and aborts the active fetch', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (!init.signal) throw new Error('missing cancellation signal');
          signals.push(init.signal);
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })
    );
    const result = run();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  it('isolates concurrent cancellation signals', async () => {
    const entered = gate();
    const release = gate();
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      if (!init.signal) throw new Error('missing cancellation signal');
      const signal = init.signal;
      signals.push(signal);
      if (signals.length === 2) entered.resolve();
      await Promise.race([
        release.promise,
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true })
        ),
      ]);
      if (signal.aborted) throw new Error('aborted');
      return response();
    });
    const controller = new AbortController();
    const canceled = run(controller.signal);
    const retained = run();
    await entered.promise;
    controller.abort();
    expect(await canceled).toMatchObject({ ok: false });
    release.resolve();
    expect(await retained).toEqual({ ok: true, value: workspaces });
    expect(signals.filter((signal) => signal.aborted)).toHaveLength(1);
  });
});
