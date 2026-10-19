import { Effect } from 'effect';
import type { Logger } from '../src/utils/logger';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createCommandAttachmentTransfer,
  createCloudSessionSharingPort,
  createCloudStreamsTokenPort,
} from '../src/lib/cloud-cli-port';

afterEach(() => vi.unstubAllGlobals());

it('preserves the client retry key and separate server ID through the real HTTP result parser', async () => {
  const requests = new Map<string, string>();
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    expect(body.path).toBe('sessionSharing:requestFromCli');
    const { requestId } = body.args[0] as { requestId: string };
    if (!requests.has(requestId)) requests.set(requestId, `server-${requests.size + 1}`);
    return Response.json({
      status: 'success',
      value: { requestId, shareRequestId: requests.get(requestId), status: 'pending' },
    });
  });
  const port = createCloudSessionSharingPort({
    authBaseUrl: 'https://share-fixture.convex.cloud',
    token: 'synthetic-cli-token',
  });
  const input = {
    workspaceId: 'workspace',
    requestId: 'client-retry-key',
    requesterUserId: 'alice',
    sourceSessionId: 'root',
    sourceTurnId: 'turn',
    sessionIds: ['root'],
    purpose: 'Share for review',
    deliveryPublicKey: 'a'.repeat(588),
  };
  const first = await port.request(input);
  expect(first).toEqual({
    requestId: 'client-retry-key',
    shareRequestId: 'server-1',
    status: 'pending',
  });
  expect(await port.request({ ...input, requestId: first.requestId })).toEqual(first);
  expect(requests.size).toBe(1);
});

it('keeps local workspace attachments local inside a cloud process', () => {
  vi.stubEnv('LODY_PLATFORM', 'cloud');
  try {
    expect(createCommandAttachmentTransfer('', true)).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('official native Streams token port supplies the shared kernel and cancels owned HTTP on Scope close', async () => {
  vi.stubEnv('LODY_HTTP_TRANSPORT', 'default');
  let start!: () => void;
  let end!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  let signal: AbortSignal | null | undefined;
  let authorization: string | null = null;
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    trace: () => {},
    success: () => {},
    setLevel: () => {},
    child: () => logger,
    close: async () => {},
  };
  vi.stubGlobal('fetch', (_url: unknown, init: RequestInit) => {
    signal = init.signal;
    authorization = new Headers(init.headers).get('Authorization');
    start();
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => {
          end();
          reject(new DOMException('fixture aborted', 'AbortError'));
        },
        { once: true }
      );
    });
  });
  const port = createCloudStreamsTokenPort({
    token: 'synthetic-cli-token',
    authBaseUrl: 'https://fixture.convex.cloud',
    logger,
  });
  try {
    const running = Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* port.createTokenProvider({ workspaceId: 'workspace' });
          yield* Effect.forkChild(provider.getToken());
          yield* Effect.promise(() => started);
          yield* provider.close;
        })
      )
    );
    await started;
    await ended;
    await running;
    expect(authorization).toBe('Bearer synthetic-cli-token');
    expect(signal?.aborted).toBe(true);
    await port.closeLegacy();
    expect(() => port.createTokenProviderLegacy({ workspaceId: 'workspace' })).toThrow('closed');
  } finally {
    vi.unstubAllEnvs();
  }
});
