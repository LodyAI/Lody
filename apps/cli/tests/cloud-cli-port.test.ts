import { isCloudE2eeMemberRemoved, isCloudE2eeDeviceRevoked } from '../src/lib/cloud-e2ee-errors';
import { Effect, Exit, Scope } from 'effect';
import type { Logger } from '../src/utils/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  encryptedAttachmentPath,
  getSessionFileDownloadApiPath,
  readEncryptedAttachment,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { SessionAttachmentTransfer } from '../src/lib/session-attachment-transfer';
import { downloadSessionImageForPrompt } from '../src/lib/session-image-download';
import {
  createCommandAttachmentTransfer,
  createCloudE2eePort,
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

it('workspace Streams borrowers share one kernel; a closed borrower ends only its own reads', async () => {
  vi.stubEnv('LODY_HTTP_TRANSPORT', 'default');
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
  type Pending = { respond: (token: string) => void; aborted: Promise<void>; workspaceId: string };
  const requests: Pending[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const requestCount = (count: number) =>
    new Promise<void>((resolve) => {
      if (requests.length >= count) resolve();
      else waiters.push({ count, resolve });
    });
  vi.stubGlobal('fetch', (_url: unknown, init: RequestInit) => {
    let aborted!: () => void;
    const pending: Pending = {
      respond: () => {},
      aborted: new Promise<void>((resolve) => (aborted = resolve)),
      workspaceId: (JSON.parse(init.body as string) as { workspaceId: string }).workspaceId,
    };
    const response = new Promise<Response>((resolve, reject) => {
      pending.respond = (token) => resolve(Response.json({ token, expiresIn: 3600 }));
      init.signal?.addEventListener(
        'abort',
        () => {
          aborted();
          reject(new DOMException('fixture aborted', 'AbortError'));
        },
        { once: true }
      );
    });
    requests.push(pending);
    for (const waiter of waiters) if (requests.length >= waiter.count) waiter.resolve();
    return response;
  });
  const port = createCloudStreamsTokenPort({
    token: 'synthetic-cli-token',
    authBaseUrl: 'https://fixture.convex.cloud',
    logger,
  });
  try {
    // Durable/presence borrow natively; Machine RPC borrows through the Legacy facade.
    const durableScope = Effect.runSync(Scope.make());
    const durable = await Effect.runPromise(
      Scope.provide(port.createTokenProvider({ workspaceId: 'workspace' }), durableScope)
    );
    const rpc = port.createTokenProviderLegacy({ workspaceId: 'workspace' });
    const other = port.createTokenProviderLegacy({ workspaceId: 'other' });

    const durableRead = Effect.runPromise(durable.getToken());
    const rpcRead = rpc.getToken();
    const otherRead = other.getToken();
    await requestCount(2);
    expect(requests.map((request) => request.workspaceId).sort()).toEqual(['other', 'workspace']);

    // The durable transport detaches mid-refresh: its own read ends, the shared request survives.
    const durableClosed = Effect.runPromise(Scope.close(durableScope, Exit.void));
    await expect(durableRead).rejects.toBeDefined();
    await durableClosed;
    const shared = requests.find((request) => request.workspaceId === 'workspace')!;
    shared.respond('jwt-workspace');
    await expect(rpcRead).resolves.toBe('jwt-workspace');
    requests.find((request) => request.workspaceId === 'other')!.respond('jwt-other');
    await expect(otherRead).resolves.toBe('jwt-other');

    // A later borrower of the same workspace reuses the cached token.
    const reattached = port.createTokenProviderLegacy({ workspaceId: 'workspace' });
    await expect(reattached.getToken()).resolves.toBe('jwt-workspace');
    expect(requests).toHaveLength(2);

    // The last borrower's close ends the kernel; a pending refresh is aborted with it.
    rpc.invalidate('manual');
    const refresh = reattached.getToken();
    await requestCount(3);
    await rpc.close();
    await reattached.close();
    await requests[2]!.aborted;
    await expect(refresh).rejects.toBeDefined();
    await other.close();
    await port.closeLegacy();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('a borrower joining a terminally rejected workspace kernel gets one fresh admission', async () => {
  vi.stubEnv('LODY_HTTP_TRANSPORT', 'default');
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
  let accessAllowed = false;
  let requests = 0;
  vi.stubGlobal('fetch', async () => {
    requests++;
    return accessAllowed
      ? Response.json({ token: 'jwt-restored', expiresIn: 3600 })
      : new Response(null, { status: 403 });
  });
  const port = createCloudStreamsTokenPort({
    token: 'synthetic-cli-token',
    authBaseUrl: 'https://fixture.convex.cloud',
    logger,
  });
  try {
    // Machine RPC keeps its lease while workspace access is revoked.
    const rpc = port.createTokenProviderLegacy({ workspaceId: 'workspace' });
    await expect(rpc.getToken()).rejects.toBeDefined();
    // The terminal answer still fences the existing borrower without new requests.
    await expect(rpc.getToken()).rejects.toBeDefined();
    expect(requests).toBe(1);

    // Access is restored and durable sync reattaches through a new borrower.
    accessAllowed = true;
    const scope = Effect.runSync(Scope.make());
    const durable = await Effect.runPromise(
      Scope.provide(port.createTokenProvider({ workspaceId: 'workspace' }), scope)
    );
    await expect(Effect.runPromise(durable.getToken())).resolves.toBe('jwt-restored');
    await expect(rpc.getToken()).resolves.toBe('jwt-restored');
    expect(requests).toBe(2);

    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rpc.close();
    await port.closeLegacy();
  } finally {
    vi.unstubAllEnvs();
  }
});

describe('shared Streams kernel after a failed response-body release', () => {
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
  // The first token response is a 503 whose body cancellation rejects: the kernel
  // records a release failure. Later responses succeed.
  const failingReleaseThenRecovered = () => {
    vi.stubEnv('LODY_HTTP_TRANSPORT', 'default');
    let requests = 0;
    vi.stubGlobal('fetch', async () => {
      requests++;
      if (requests === 1)
        return new Response(
          new ReadableStream({
            cancel: () => Promise.reject(new Error('synthetic body release failure')),
          }),
          { status: 503 }
        );
      return Response.json({ token: 'jwt-recovered', expiresIn: 3600 });
    });
    const port = createCloudStreamsTokenPort({
      token: 'synthetic-cli-token',
      authBaseUrl: 'https://fixture.convex.cloud',
      logger,
    });
    return { port, requests: () => requests };
  };

  afterEach(() => vi.unstubAllEnvs());

  it('lets the next durable reattach recover the kernel while Machine RPC keeps its lease', async () => {
    const { port, requests } = failingReleaseThenRecovered();
    const rpc = port.createTokenProviderLegacy({ workspaceId: 'workspace' });
    await expect(rpc.getToken()).rejects.toBeDefined();

    // Durable sync reattaches; its first read drives the shared cleanup.
    const scope = Effect.runSync(Scope.make());
    const durable = await Effect.runPromise(
      Scope.provide(port.createTokenProvider({ workspaceId: 'workspace' }), scope)
    );
    await expect(Effect.runPromise(durable.getToken())).resolves.toBe('jwt-recovered');
    expect(requests()).toBe(2);
    // The long-lived Machine RPC borrower recovers with it.
    await expect(rpc.getToken()).resolves.toBe('jwt-recovered');
    expect((await Effect.runPromise(durable.health)).state).toBe('open');

    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rpc.close();
    await port.closeLegacy();
  });

  it('finishes a failed last close through retryCleanup without releasing a lease twice', async () => {
    const { port, requests } = failingReleaseThenRecovered();
    const durable = port.createTokenProviderLegacy({ workspaceId: 'workspace' });
    await expect(durable.getToken()).rejects.toBeDefined();
    await expect(durable.close()).rejects.toBeDefined();
    // Retrying cleanup finishes the kernel close; the same close then succeeds.
    await durable.retryCleanup();
    await expect(durable.close()).resolves.toBeUndefined();

    // The retired kernel is gone: a new borrower gets a fresh kernel and token.
    const next = port.createTokenProviderLegacy({ workspaceId: 'workspace' });
    await expect(next.getToken()).resolves.toBe('jwt-recovered');
    expect(requests()).toBe(2);
    await next.close();
    await port.closeLegacy();
  });

  it('does not interrupt another borrower when cleanup is retried on a healthy kernel', async () => {
    vi.stubEnv('LODY_HTTP_TRANSPORT', 'default');
    let respond!: () => void;
    const requested = new Promise<void>((started) => {
      vi.stubGlobal(
        'fetch',
        () =>
          new Promise<Response>((resolve) => {
            respond = () => resolve(Response.json({ token: 'jwt-shared', expiresIn: 3600 }));
            started();
          })
      );
    });
    const port = createCloudStreamsTokenPort({
      token: 'synthetic-cli-token',
      authBaseUrl: 'https://fixture.convex.cloud',
      logger,
    });
    const rpc = port.createTokenProviderLegacy({ workspaceId: 'workspace' });
    const durable = port.createTokenProviderLegacy({ workspaceId: 'workspace' });
    const rpcRead = rpc.getToken();
    await requested;
    // A durable reattach retries cleanup of its previous provider before closing it.
    await durable.retryCleanup();
    await durable.close();
    respond();
    await expect(rpcRead).resolves.toBe('jwt-shared');
    await rpc.close();
    await port.closeLegacy();
  });
});

it('runs the paired machine port with only one encrypted workspace and a revocable service credential', async () => {
  const { createCloudE2eeMachinePort } = await import('../src/lib/cloud-cli-port');
  type Client = NonNullable<Parameters<typeof createCloudE2eeMachinePort>[0]['client']>;
  vi.stubEnv('LODY_PLATFORM', 'cloud');
  vi.stubEnv('LODY_HTTP_TRANSPORT', 'default');
  let deliver: ((value: unknown) => void) | undefined;
  const account = 'synthetic-machine-owner',
    workspaceId = 'synthetic-workspace',
    credential = 'a1'.repeat(32);
  const client: Client = {
    onUpdate: ((_ref: unknown, _args: unknown, listener: (value: unknown) => void) => {
      deliver = listener;
      return () => {
        deliver = undefined;
      };
    }) as Client['onUpdate'],
    query: (async () => ({
      status: 'authorized',
      userId: account,
      workspaces: [
        {
          id: workspaceId,
          name: 'Synthetic',
          slug: null,
          role: 'member',
          contentMode: 'e2ee',
          genesisHash: 'ab'.repeat(32),
        },
      ],
    })) as Client['query'],
    close: async () => {
      deliver = undefined;
    },
  };
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    trace: () => {},
    success: () => {},
    setLevel: () => {},
    setDebug: () => {},
    child: () => logger,
    close: async () => {},
  };
  const packets: Record<string, unknown>[] = [];
  const relayBase = 'https://paired-relay.test';
  const attachmentToken = 'ce'.repeat(32);
  const objects = new Map<string, Uint8Array>();
  let revoked = false;
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit) => {
    if (String(url).startsWith(relayBase)) {
      const headers = new Headers(init.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${attachmentToken}`);
      expect(String(url)).toMatch(/\/session-encrypted-(files|images)\//);
      if (revoked) return new Response(null, { status: 403 });
      if (init.method !== 'POST') {
        const id = String(url).split('/').at(-1)!;
        return new Response(objects.get(id) as Uint8Array<ArrayBuffer>);
      }
      expect(headers.get('x-file-name')).toBe('attachment.bin');
      expect(headers.get('x-file-mime-type')).toBe('application/octet-stream');
      const bytes = new Uint8Array(init.body as ArrayBuffer);
      const fileId = `opaque-${objects.size}`;
      objects.set(fileId, bytes);
      return Response.json({
        file: {
          type: 'file',
          fileId,
          fileName: 'attachment.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: bytes.length,
          sha256: headers.get('x-file-sha256'),
          textPreview: false,
          transport: 'r2',
          uploadedAt: 1,
        },
      });
    }
    const body = JSON.parse(String(init.body));
    packets.push(body);
    if (body.path === 'e2eeContent:contentStreamsToken') {
      expect(body.args).toEqual([{ workspaceId, credential }]);
      return Response.json({
        status: 'success',
        value: {
          token: 'protected-streams-token',
          attachmentToken,
          bucketId: 'encrypted-bucket',
          gatewayBaseUrl: 'https://streams.test',
          expiresIn: 900,
          expiresAt: 900_000,
        },
      });
    }
    return Response.json({
      status: 'success',
      value: {
        workspaceId,
        genesisHash: 'ab'.repeat(32),
        checkpoint: { headHash: 'cd'.repeat(32), length: 1 },
        startIndex: 0,
        recordsHex: ['00'],
        position: 'position',
        nextCursor: null,
      },
    });
  });
  const port = createCloudE2eeMachinePort({
    accountId: account,
    workspaceId,
    genesisHash: 'ab'.repeat(32),
    machineId: 'machine',
    credential,
    authBaseUrl: 'https://synthetic.convex.cloud',
    serverBaseUrl: relayBase,
    logger,
    client,
  });
  const states: unknown[] = [];
  const stop = port.access.watchWorkspaceAccess(
    (state) => states.push(state),
    (error) => {
      throw error;
    }
  );
  try {
    for (const name of [
      'streamsTokens',
      'notifications',
      'usage',
      'billing',
      'githubTokens',
      'bugReports',
      'sessionSharing',
      'prAssociation',
      'remotePreview',
    ] as const)
      expect(port[name]).toBeNull();
    expect(port.attachmentUpload).toEqual({ serverBaseUrl: relayBase });
    const authorized = {
      status: 'authorized',
      userId: account,
      workspaces: [
        {
          id: workspaceId,
          name: 'Synthetic',
          slug: null,
          role: 'member',
          contentMode: 'e2ee',
          genesisHash: 'ab'.repeat(32),
        },
      ],
    };
    deliver?.(authorized);
    expect(states).toEqual([authorized]);
    expect(await port.e2ee!.getHistory({ workspaceId, credential })).toMatchObject({ workspaceId });
    expect(packets).toEqual([
      expect.objectContaining({
        path: 'e2eeWorkspaces:history',
        args: [expect.objectContaining({ workspaceId, credential })],
      }),
    ]);
    await port.e2ee!.readEpochGroup!({
      workspaceId,
      credential,
      key: {
        genesis: 'ab'.repeat(32),
        epoch: 1,
        publisher: 'cd'.repeat(32),
        commitment: 'ef'.repeat(32),
      },
    });
    expect(packets.at(-1)).toMatchObject({
      path: 'e2eeEpochStaging:readGroup',
      args: [expect.objectContaining({ workspaceId, credential })],
    });
    expect(() =>
      port.e2ee!.readEpochGroup!({
        workspaceId: 'other',
        credential,
        key: {
          genesis: 'ab'.repeat(32),
          epoch: 1,
          publisher: 'cd'.repeat(32),
          commitment: 'ef'.repeat(32),
        },
      })
    ).toThrow('e2ee_binding_conflict');
    expect(JSON.stringify(packets)).not.toContain('cliToken');
    expect(() => port.e2ee!.getHistory({ workspaceId: 'other', credential })).toThrow(
      'e2ee_binding_conflict'
    );
    const token = async () => {
      const result = await port.e2ee!.getContentToken({ workspaceId, credential });
      if (!result.attachmentToken) throw new Error('e2ee_attachment_unavailable');
      return result.attachmentToken;
    };
    const transfer = new SessionAttachmentTransfer(
      credential,
      port.attachmentUpload!.serverBaseUrl,
      { token }
    );
    const scope = {
      workspaceId: workspaceId as WorkspaceId,
      sessionId: 'paired-session' as SessionId,
    };
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paired-attachments-'));
    try {
      const plaintext = Buffer.alloc(4 * 1024 * 1024 + 3, 0x61);
      const filePath = path.join(directory, 'private.txt');
      await fs.writeFile(filePath, plaintext);
      const file = await transfer.validateSessionFileUploadPath(filePath);
      const uploaded = await transfer.uploadValidatedSessionFile({ ...scope, file });
      expect(uploaded.encryption!.parts).toHaveLength(2);
      const received: Uint8Array[] = [];
      for await (const bytes of readEncryptedAttachment({
        ...scope,
        encryption: uploaded.encryption!,
        fetchPart: async (id) =>
          fetch(
            new URL(
              encryptedAttachmentPath(
                getSessionFileDownloadApiPath(scope.workspaceId, scope.sessionId, id)
              ),
              port.attachmentUpload!.serverBaseUrl
            ),
            { headers: { Authorization: `Bearer ${await token()}` } }
          ),
      }))
        received.push(bytes);
      expect(Buffer.concat(received)).toEqual(plaintext);
      expect(Buffer.from(objects.get(uploaded.fileId)!)).not.toEqual(
        plaintext.subarray(0, 4 * 1024 * 1024)
      );
      const imageBytes = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
      const imagePath = path.join(directory, 'private.png');
      await fs.writeFile(imagePath, imageBytes);
      const image = await transfer.uploadSessionImageFile({
        ...scope,
        file: await transfer.validateSessionImageUploadPath(imagePath),
      });
      const download = () =>
        downloadSessionImageForPrompt({
          ...scope,
          imageId: image.imageId,
          encryption: image.encryption,
          expectedMimeType: image.mimeType,
          serverBaseUrl: port.attachmentUpload!.serverBaseUrl,
          token: credential,
          attachmentToken: token,
        });
      expect((await download()).bytes).toEqual(imageBytes);
      revoked = true;
      await expect(download()).rejects.toThrow('Encrypted attachment unavailable');
      await expect(transfer.uploadValidatedSessionFile({ ...scope, file })).rejects.toThrow('403');
      expect(JSON.stringify(packets)).not.toContain('cliToken');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
    deliver?.({ status: 'unauthorized', reason: 'Machine revoked; pair again' });
    expect(states.at(-1)).toEqual({
      status: 'unauthorized',
      reason: 'Machine revoked; pair again',
    });
    stop();
    expect(deliver).toBeUndefined();
  } finally {
    stop();
    await port.dispose();
    vi.unstubAllEnvs();
  }
});

it('reads retained execution originals from the admitted encrypted stream with its device credential', async () => {
  vi.stubEnv('LODY_HTTP_TRANSPORT', 'default');
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
  const message = Uint8Array.of(9, 8, 7);
  const grants: unknown[] = [];
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    const url = new URL(input);
    if (url.hostname === 'execution-fixture.convex.cloud') {
      const body = JSON.parse(String(init.body));
      expect(body.path).toBe('e2eeContent:contentStreamsToken');
      grants.push(body.args[0]);
      return Response.json({
        status: 'success',
        value: {
          token: 'content-token',
          bucketId: 'encrypted-bucket',
          gatewayBaseUrl: 'https://streams-fixture.example',
          expiresIn: 300,
          expiresAt: 2000000000000,
        },
      });
    }
    expect(url.pathname).toBe('/ds/encrypted-bucket/workspace%3As%3Asession');
    expect(url.searchParams.get('direction')).toBe('backward');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer content-token');
    return new Response(Uint8Array.from([1, 0, 3, ...message]), {
      headers: {
        'Content-Type': 'application/vnd.loro-streams.frames',
        'Stream-Prev-Offset': '00000000000000000000',
        'Stream-End-Offset': '00000000000000000003',
        'Stream-At-Start': 'true',
        'Stream-At-Retained-Start': 'true',
      },
    });
  });
  try {
    const port = createCloudE2eePort({
      authBaseUrl: 'https://execution-fixture.convex.cloud',
      logger,
    });
    expect(
      await port.readExecutionOriginPage!(
        { workspaceId: 'workspace', credential: 'device-credential', docId: 'session-session' },
        new AbortController().signal
      )
    ).toEqual({ messages: [message], before: '00000000000000000000', atStart: true });
    expect(grants).toEqual([{ workspaceId: 'workspace', credential: 'device-credential' }]);
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each(['e2ee_member_removed', 'e2ee_device_revoked', 'temporary_network_failure'] as const)(
  'brands only fixed credential endpoint confirmation (%s)',
  async (code) => {
    vi.stubEnv('LODY_HTTP_TRANSPORT', 'default');
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
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.path).toBe('e2eeContent:contentStreamsToken');
      expect(body.args[0]).toMatchObject({
        workspaceId: 'workspace',
        credential: 'synthetic-device-credential',
      });
      return Response.json({
        status: 'error',
        errorMessage: 'e2ee_member_removed',
        errorData: { code },
      });
    });
    try {
      const port = createCloudE2eePort({
        authBaseUrl: 'https://credential-fixture.convex.cloud',
        logger,
      });
      const failure = await port.readExecutionOriginPage!(
        {
          workspaceId: 'workspace',
          credential: 'synthetic-device-credential',
          docId: 'session-session',
        },
        new AbortController().signal
      ).catch((cause: unknown) => cause);
      expect(isCloudE2eeMemberRemoved(failure)).toBe(code === 'e2ee_member_removed');
      expect(isCloudE2eeDeviceRevoked(new Error('SDK wrapper', { cause: failure }))).toBe(
        code === 'e2ee_device_revoked'
      );
    } finally {
      vi.unstubAllEnvs();
    }
  }
);
