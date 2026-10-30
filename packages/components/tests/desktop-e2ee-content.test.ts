import { describe, expect, it, vi } from 'vitest';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { LoroDoc } from 'loro-crdt';
import { createDesktopE2eeContent } from '../src/providers/desktop-e2ee-content';

const context = {
  protocol: 'loro-streams-crdt-payload-protection',
  version: 2,
  kind: 'update_batch',
} as const;

describe('desktop E2EE content epoch safety', () => {
  it.each([false, true])(
    'advertises only real purpose-bound RPC capabilities (%s)',
    async (supported) => {
      const host = (supported
        ? {
            prepareFeatureRpc: async () => ({}),
            acceptFeatureRpcResponse: async () => null,
            prepareDispatch: async () => ({}),
            acceptDispatchResponse: async () => ({}),
          }
        : {}) as unknown as E2eeWorkspaceRuntime;
      const access = createDesktopE2eeContent({
        runtime: host,
        workspaceId: 'workspace',
        genesisHash: '11'.repeat(32),
        epoch: 0,
        authToken: () => null,
      });
      try {
        expect(access.e2ee.supportsRpc).toBe(supported);
        if (!supported)
          await expect(access.e2ee.prepareFeatureRpc({} as never)).rejects.toThrow(
            'e2ee_rpc_unavailable'
          );
      } finally {
        await access.close();
      }
    }
  );
  it('derives the file write role from verified ledger status and drops it on close', async () => {
    const access = createDesktopE2eeContent({
      runtime: {} as unknown as E2eeWorkspaceRuntime,
      workspaceId: 'workspace',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => null,
    });
    const seen: string[] = [];
    const unsubscribe = access.e2ee.codeCollabRole.subscribe(() =>
      seen.push(access.e2ee.codeCollabRole.get())
    );
    // No verified status yet: fail closed.
    expect(access.e2ee.codeCollabRole.get()).toBe('read');
    const status = { epoch: 0, rotationRequired: false, hasCurrentKey: true };
    access.updateStatus({ ...status, memberRole: 'member' });
    access.updateStatus({ ...status, memberRole: 'member' });
    access.updateStatus({ ...status, memberRole: 'guest' });
    access.updateStatus({ ...status, memberRole: 'admin' });
    expect(seen).toEqual(['write', 'read', 'write']);
    await access.close();
    expect(access.e2ee.codeCollabRole.get()).toBe('read');
    expect(seen).toEqual(['write', 'read', 'write', 'read']);
    unsubscribe();
  });
  it('does not hydrate a previous epoch token when a retired provider left a cache row', async () => {
    const entries = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    });
    let issued = 0;
    const runtime = {
      contentStreamsToken: async () => ({
        token: `epoch-token-${++issued}`,
        bucketId: 'encrypted-content',
        gatewayBaseUrl: 'https://streams.example.com',
        expiresIn: 900,
        expiresAt: 1_900_000_000_000,
      }),
    } as unknown as E2eeWorkspaceRuntime;
    const access = createDesktopE2eeContent({
      runtime,
      workspaceId: 'token-epoch-workspace',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => 'account-token',
    });
    const first = access.e2ee.createTokenProvider(new AbortController().signal);
    let successor: typeof first | undefined;
    try {
      expect(await first.getToken()).toBe('epoch-token-1');
      // A stale row can still exist from an older client that persisted tokens.
      entries.set('stale-epoch-row', 'epoch-token-1');
      access.updateStatus({ epoch: 1, rotationRequired: false, hasCurrentKey: true });
      await access.transition({
        // Even a cache row that could not be removed cannot select the next token.
        install: async () => ({ epoch: 1, rotationRequired: false, hasCurrentKey: true }),
      });
      successor = access.e2ee.createTokenProvider(new AbortController().signal);
      expect(await successor.getToken()).toBe('epoch-token-2');
      expect(access.e2ee.bucketId()).toBe('encrypted-content');
    } finally {
      await first.close();
      await successor?.close();
      await access.close();
      vi.unstubAllGlobals();
    }
  });
  it('mints a fresh content token for a recreated runtime instead of hydrating storage', async () => {
    const entries = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    });
    let issued = 0;
    const runtime = {
      contentStreamsToken: async () => ({
        token: `content-token-${++issued}`,
        bucketId: 'encrypted-content',
        gatewayBaseUrl: 'https://streams.example.com',
        expiresIn: 480,
        expiresAt: 1_900_000_000_000,
      }),
    } as unknown as E2eeWorkspaceRuntime;
    const open = () =>
      createDesktopE2eeContent({
        runtime,
        workspaceId: 'recreated-runtime-workspace',
        genesisHash: '11'.repeat(32),
        epoch: 0,
        authToken: () => 'account-token',
      });
    const first = open();
    const firstProvider = first.e2ee.createTokenProvider(new AbortController().signal);
    expect(await firstProvider.getToken()).toBe('content-token-1');
    await firstProvider.close();
    await first.close();
    // RuntimeProvider recreates the workspace runtime with the same epoch. The
    // successor's transports read its bucket before any request, so the token must
    // come from the native host, which also re-checks admission, not from storage.
    const second = open();
    const secondProvider = second.e2ee.createTokenProvider(new AbortController().signal);
    try {
      expect(await secondProvider.getToken()).toBe('content-token-2');
      expect(second.e2ee.bucketId()).toBe('encrypted-content');
      expect(entries.size).toBe(0);
    } finally {
      await secondProvider.close();
      await second.close();
      vi.unstubAllGlobals();
    }
  });
  it('replaces a gateway-rejected cached token through the native token capability', async () => {
    let cached = 'cached-token';
    const rejected: Array<string | undefined> = [];
    const runtime = {
      contentStreamsToken: async (workspaceId: string, rejectedToken?: string) => {
        expect(workspaceId).toBe('workspace');
        rejected.push(rejectedToken);
        if (rejectedToken === cached) cached = 'replacement-token';
        return {
          token: cached,
          bucketId: 'encrypted-content',
          gatewayBaseUrl: 'https://streams.example.com',
          expiresIn: 900,
          expiresAt: 1_900_000_000_000,
        };
      },
    } as unknown as E2eeWorkspaceRuntime;
    const access = createDesktopE2eeContent({
      runtime,
      workspaceId: 'workspace',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => 'account-token',
    });
    const provider = access.e2ee.createTokenProvider(new AbortController().signal);
    const authenticate = provider.createAuthCallback();
    try {
      expect(await authenticate({ reason: 'request' })).toBe('cached-token');
      // This is the callback the Streams transport uses after a gateway 401.
      expect(await authenticate({ reason: 'unauthorized', previousToken: 'cached-token' })).toBe(
        'replacement-token'
      );
      expect(rejected).toEqual([undefined, 'cached-token']);
      // A delayed rejection of the old token cannot replace the healthy token.
      expect(await authenticate({ reason: 'unauthorized', previousToken: 'cached-token' })).toBe(
        'replacement-token'
      );
      expect(cached).toBe('replacement-token');
    } finally {
      await provider.close();
    }
  });

  it('requests repair without blocking replay, then clears the recovery hint on a valid read', async () => {
    const requests: unknown[][] = [];
    const statuses: boolean[] = [];
    const release = Promise.withResolvers<unknown>();
    let valid = false;
    const runtime = {
      openContent: async () => {
        if (!valid) throw new Error('snapshot rejected');
        return new Uint8Array([7]);
      },
      contentStreamsToken: (...args: unknown[]) => {
        requests.push(args);
        return release.promise;
      },
    } as unknown as E2eeWorkspaceRuntime;
    const access = createDesktopE2eeContent({
      runtime,
      workspaceId: 'workspace',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => null,
      onSnapshotRecoveryChange: (pending) => statuses.push(pending),
    });
    if (access.content.mode !== 'protected') throw new Error('expected protected content');
    const room = access.content.resolve({ kind: 'meta' });
    if (room.mode !== 'protected') throw new Error('expected protected room');
    const request = {
      context: { ...context, kind: 'snapshot' as const, continuationOffset: '00000001' },
      header: new Uint8Array([4]),
      sealed: new Uint8Array([1]),
      additionalData: new Uint8Array([2]),
    };
    try {
      await expect(room.config.provider.open(request)).rejects.toThrow('snapshot rejected');
      access.content.snapshotUpload.onSnapshotRecovery!(
        'https://streams.invalid/ds/encrypted/workspace%3Ameta',
        true
      );
      access.content.snapshotUpload.onSnapshotRecovery!(
        'https://streams.invalid/ds/encrypted/workspace%3Ameta',
        true
      );
      await expect(room.config.provider.open(request)).rejects.toThrow('snapshot rejected');
      expect(requests).toEqual([['workspace', undefined, 'workspace:meta']]);
      expect(statuses.at(-1)).toBe(true);
      valid = true;
      // The request action is still unsettled; retained history remains usable.
      expect(await room.config.provider.open({ ...request, context })).toEqual(new Uint8Array([7]));
      access.content.snapshotUpload.onSnapshotRecovery!(
        'https://streams.invalid/ds/encrypted/workspace%3Ameta',
        false
      );
      expect(statuses.at(-1)).toBe(false);
    } finally {
      release.resolve(undefined);
    }
  });

  it('reports E2E transport effects from the provider seal/open the live transport calls', async () => {
    const reports: { workspaceId: string; effects: Record<string, unknown> }[] = [];
    vi.stubGlobal('window', {
      __LODY_E2E_CLIENT_LOSS__: true,
      ipc: { send: (_channel: string, payload: (typeof reports)[number]) => reports.push(payload) },
    });
    let readable = true;
    const access = createDesktopE2eeContent({
      runtime: {
        seal: async () => ({ header: new Uint8Array([3]), sealed: new Uint8Array([1]) }),
        openContent: async () => {
          if (!readable) throw new Error('e2ee_member_removed');
          return new Uint8Array([7]);
        },
      } as unknown as E2eeWorkspaceRuntime,
      workspaceId: 'effects-workspace',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => null,
    });
    try {
      if (access.content.mode !== 'protected') throw new Error('expected protected content');
      const room = access.content.resolve({ kind: 'doc', docId: 'session' });
      if (room.mode !== 'protected') throw new Error('expected protected room');
      await room.config.provider.seal({
        context,
        plaintext: new Uint8Array([7]),
        additionalData: (header: Uint8Array) => header,
      });
      const frame = {
        context,
        header: new Uint8Array([3]),
        sealed: new Uint8Array([1]),
        additionalData: new Uint8Array([2]),
      };
      await room.config.provider.open(frame);
      readable = false;
      await expect(room.config.provider.open(frame)).rejects.toThrow('e2ee_member_removed');
      expect(reports.at(-1)).toMatchObject({
        workspaceId: 'effects-workspace',
        effects: { contentWrites: 1, contentReadEvents: 1, pendingWrites: 0 },
      });
    } finally {
      vi.unstubAllGlobals();
      await access.close();
    }
  });
  it('keeps one selected snapshot epoch across a concurrent key transition', async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const frames: Uint8Array[] = [];
    const runtime = {
      seal: async (
        _workspaceId: string,
        request: {
          epoch: number;
          context: typeof context & { continuationOffset?: string };
          additionalData: Uint8Array;
        }
      ) => {
        if (frames.length === 0) {
          entered.resolve();
          await release.promise;
        }
        const frame = new Uint8Array([request.epoch, request.additionalData[0]!]);
        frames.push(frame);
        return { header: new Uint8Array([4]), sealed: frame };
      },
    } as unknown as E2eeWorkspaceRuntime;
    const access = createDesktopE2eeContent({
      runtime,
      workspaceId: 'snapshot-transition',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => null,
    });
    if (access.content.mode !== 'protected') throw new Error('expected protected content');
    const selected = access.content.resolve({ kind: 'doc', docId: 'session' });
    if (selected.mode !== 'protected') throw new Error('expected protected room');
    const request = {
      context: { ...context, kind: 'snapshot' as const, continuationOffset: '0000123' },
      plaintext: new Uint8Array([7]),
      additionalData: (header: Uint8Array) => header,
    };
    let first: ReturnType<typeof selected.config.provider.seal> | undefined;
    try {
      access.updateStatus({ epoch: 1, rotationRequired: false, hasCurrentKey: false });
      expect(await access.content.snapshotUpload.canUpload()).toBe(true);
      first = selected.config.provider.seal(request);
      await entered.promise;
      await access.transition({
        install: async () => ({ epoch: 1, rotationRequired: false, hasCurrentKey: true }),
      });
      release.resolve();
      expect((await first).sealed).toEqual(new Uint8Array([0, 4]));
      expect((await selected.config.provider.seal(request)).sealed).toEqual(new Uint8Array([1, 4]));
    } finally {
      release.resolve();
      await first;
      await access.close();
    }
  });

  it.each([
    { epoch: 1, rotationRequired: false },
    { epoch: 0, rotationRequired: true },
  ])('retains local edits and continues encrypted sends after %j', async (status) => {
    const doc = new LoroDoc();
    const received: Uint8Array[] = [];
    let updateRequired = false;
    const runtime = {
      seal: async (_workspaceId: string, request: { plaintext: Uint8Array }) => {
        const sealed = new Uint8Array([99, request.plaintext.length]);
        received.push(sealed);
        return { header: new Uint8Array([3]), sealed };
      },
    } as unknown as E2eeWorkspaceRuntime;
    const access = createDesktopE2eeContent({
      runtime,
      workspaceId: 'workspace',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => null,
      onKeyUpdateRequired: () => {
        updateRequired = true;
      },
    });
    try {
      const room =
        access.content.mode === 'protected'
          ? access.content.resolve({ kind: 'doc', docId: 'session' })
          : undefined;
      if (!room || room.mode !== 'protected') throw new Error('expected protected room');
      const request = {
        context,
        plaintext: new Uint8Array([1, 2]),
        additionalData: () => new Uint8Array([3]),
      };
      if (access.content.mode !== 'protected') throw new Error('expected protected content');
      expect(await access.content.snapshotUpload.canUpload()).toBe(true);
      await room.config.provider.seal(request);
      const accepted = received.length;
      access.updateStatus(status);
      expect(await access.content.snapshotUpload.canUpload()).toBe(true);
      doc.getText('draft').insert(0, 'saved locally while keys update');
      doc.commit();
      await room.config.provider.seal({ ...request, plaintext: doc.export({ mode: 'update' }) });
      access.updateStatus({ epoch: 0, rotationRequired: false });
      await room.config.provider.seal(request);
      expect(received.length).toBe(accepted + 2);
      expect(doc.getText('draft').toString()).toBe('saved locally while keys update');
      expect(updateRequired).toBe(status.epoch > 0);
    } finally {
      doc.free();
    }
  });
});

it.each(['token', 'snapshot'] as const)(
  'native member removal from %s retires content without waiting on the failed request',
  async (source) => {
    let retire = () => {};
    const retired = new Promise<void>((resolve) => {
      retire = resolve;
    });
    const access = createDesktopE2eeContent({
      workspaceId: 'workspace',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => 'synthetic-login',
      onMemberRemoved: () => retire(),
      runtime: {
        contentStreamsToken: async () => {
          throw new Error(
            "Error invoking remote method 'e2ee.contentStreamsToken': Error: e2ee_member_removed"
          );
        },
      } as unknown as E2eeWorkspaceRuntime,
    });
    const token = access.e2ee.createTokenProvider(new AbortController().signal);
    try {
      if (source === 'token') await expect(token.getToken()).rejects.toThrow();
      else
        access.content.snapshotUpload?.onSnapshotRecovery?.(
          'https://synthetic.invalid/stream/doc',
          true
        );
      await retired;
      expect(await access.content.snapshotUpload?.canUpload()).toBe(false);
      const room = access.content.resolve({ kind: 'doc', docId: 'session' });
      if (room.mode !== 'protected') throw new Error('expected protected room');
      await expect(
        room.config.provider.seal({
          context,
          plaintext: new Uint8Array([1]),
          additionalData: (header) => header,
        })
      ).rejects.toThrow('e2ee_member_removed');
    } finally {
      await token.close();
      await access.close();
    }
  }
);

describe('shared portable content lifetime', () => {
  it.each(['attachment', 'dispatch'] as const)(
    'rejects a late %s result after the content bridge retires',
    async (channel) => {
      let enter!: () => void, finish!: () => void;
      const entered = new Promise<void>((resolve) => {
          enter = resolve;
        }),
        released = new Promise<void>((resolve) => {
          finish = resolve;
        });
      const runtime = {
        contentStreamsToken: async () => {
          enter();
          await released;
          return { attachmentToken: 'synthetic-attachment' };
        },
        prepareDispatch: async () => {
          enter();
          await released;
          return { requestId: 'synthetic-request', frameHex: 'ciphertext-original' };
        },
      } as unknown as E2eeWorkspaceRuntime;
      const access = createDesktopE2eeContent({
        runtime,
        workspaceId: 'workspace',
        genesisHash: '11'.repeat(32),
        epoch: 0,
        authToken: () => 'account-token',
      });
      const work =
        channel === 'attachment'
          ? access.e2ee.attachmentToken()
          : access.e2ee.prepareDispatch('machine', {
              sessionId: 'session',
              userTurnId: 'turn',
              userId: 'user',
              timestamp: '2026-10-29T00:00:00.000Z',
              inputConfig: {},
            });
      try {
        await entered;
        await access.close();
        finish();
        await expect(work).rejects.toThrow('e2ee_closed');
      } finally {
        finish();
        await work.catch(() => {});
        await access.close();
      }
    }
  );

  it('gets a protected token when AbortSignal.any is unavailable', async () => {
    const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!;
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    const runtime = {
      contentStreamsToken: async () => ({
        token: 'portable-token',
        bucketId: 'protected-content',
        gatewayBaseUrl: 'https://streams.example.test',
        expiresIn: 900,
        expiresAt: 1_900_000_000_000,
      }),
    } as unknown as E2eeWorkspaceRuntime;
    const access = createDesktopE2eeContent({
      runtime,
      workspaceId: 'portable-token-workspace',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => 'account-token',
    });
    const provider = access.e2ee.createTokenProvider(new AbortController().signal);
    try {
      expect(await provider.getToken()).toBe('portable-token');
    } finally {
      await provider.close();
      await access.close();
      Object.defineProperty(AbortSignal, 'any', any);
    }
  });
});
