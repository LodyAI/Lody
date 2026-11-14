import { describe, expect, it, vi } from 'vitest';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { LoroDoc } from 'loro-crdt';
import { PersonalHostError } from '@lody/e2ee-client';
import {
  createDesktopE2eeContent,
  KEY_PENDING_REFRESH_INTERVAL_MS,
  KEY_PENDING_WAIT_MS,
} from '../src/providers/desktop-e2ee-content';

const context = {
  protocol: 'loro-streams-crdt-payload-protection',
  version: 2,
  kind: 'update_batch',
} as const;

describe('desktop E2EE content epoch safety', () => {
  it('observes a failed new seal only for a verified missing current key, without changing its failure', async () => {
    let failure = new Error('installed key unavailable');
    const sources: Array<'seal' | 'seal-complete' | undefined> = [];
    const draft = new LoroDoc();
    draft.getText('draft').insert(0, 'local edit remains here');
    draft.commit();
    const access = createDesktopE2eeContent({
      runtime: {
        seal: async () => {
          throw failure;
        },
      } as unknown as E2eeWorkspaceRuntime,
      workspaceId: 'workspace',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => null,
      onKeyUpdateRequired: (source) => {
        sources.push(source);
        if (source === 'seal') throw new Error('observer failure');
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
        plaintext: draft.export({ mode: 'update' }),
        additionalData: () => Uint8Array.of(3),
      };
      // A generic save/transport failure with no missing-key status is unrelated.
      access.updateStatus({ epoch: 1, rotationRequired: false, hasCurrentKey: true });
      await expect(room.config.provider.seal(request)).rejects.toBe(failure);
      expect(sources.filter((source) => source === 'seal')).toEqual([]);
      access.updateStatus({ epoch: 1, rotationRequired: false, hasCurrentKey: false });
      // IO failures during the grace are not a missing-key deadline signal.
      await expect(room.config.provider.seal(request)).rejects.toBe(failure);
      expect(sources.filter((source) => source === 'seal')).toEqual([]);
      failure = new Error(
        "Error invoking remote method 'e2ee.seal': Error: e2ee_key-update-required"
      );
      await expect(room.config.provider.seal(request)).rejects.toBe(failure);
      failure = Object.assign(new Error('current key required'), { code: 'key-update-required' });
      await expect(room.config.provider.seal(request)).rejects.toBe(failure);
      expect(sources.filter((source) => source === 'seal')).toEqual(['seal', 'seal']);
      failure = new Error('e2ee_device_revoked');
      await expect(room.config.provider.seal(request)).rejects.toBe(failure);
      expect(sources.filter((source) => source === 'seal')).toEqual(['seal', 'seal']);
      failure = new Error('installed key unavailable');
      access.updateStatus({ epoch: 1, rotationRequired: false, hasCurrentKey: true });
      await expect(room.config.provider.seal(request)).rejects.toBe(failure);
      expect(sources.filter((source) => source === 'seal')).toEqual(['seal', 'seal']);
      expect(draft.getText('draft').toString()).toBe('local edit remains here');
    } finally {
      await access.close();
      draft.free();
    }
  });
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
  it('closes with a host token call still queued, so the workspace reopens and ignores the late result', async () => {
    // Electron IPC cannot cancel a host contentStreamsToken call; on a restarted
    // member device it can queue behind other account work for longer than the
    // token kernel's release bound. Switching away must still close the token
    // provider, and the abandoned host answer must never reach the next runtime.
    type Token = Awaited<ReturnType<E2eeWorkspaceRuntime['contentStreamsToken']>>;
    let releaseQueued!: (token: Token) => void;
    const queued = new Promise<Token>((resolve) => (releaseQueued = resolve));
    let calls = 0;
    const runtime = {
      contentStreamsToken: () =>
        ++calls === 1
          ? queued
          : Promise.resolve({
              token: 'successor-token',
              bucketId: 'encrypted-content',
              gatewayBaseUrl: 'https://streams.example.com',
              expiresIn: 480,
              expiresAt: 1_900_000_000_000,
            }),
    } as unknown as E2eeWorkspaceRuntime;
    const open = () =>
      createDesktopE2eeContent({
        runtime,
        workspaceId: 'queued-token-workspace',
        genesisHash: '11'.repeat(32),
        epoch: 0,
        authToken: () => 'account-token',
      });
    const first = open();
    const firstProvider = first.e2ee.createTokenProvider(new AbortController().signal);
    const pending = firstProvider.getToken();
    const pendingOutcome = pending.then(
      () => 'resolved',
      () => 'rejected'
    );
    await vi.waitFor(() => expect(calls).toBe(1));
    let closed: 'ok' | 'failed' | undefined;
    vi.useFakeTimers();
    try {
      const closing = firstProvider.close().then(
        () => (closed = 'ok'),
        () => (closed = 'failed')
      );
      // Strictly inside the 5s release bound: close must already be confirmed.
      await vi.advanceTimersByTimeAsync(4_999);
      expect(closed).toBe('ok');
      await closing;
    } finally {
      // Let a bug-path release bound expire before restoring real timers.
      await vi.advanceTimersByTimeAsync(20_000);
      vi.useRealTimers();
    }
    expect(await pendingOutcome).toBe('rejected');
    await first.close();

    const second = open();
    const secondProvider = second.e2ee.createTokenProvider(new AbortController().signal);
    try {
      expect(await secondProvider.getToken()).toBe('successor-token');
      // The abandoned host call answers late with another bucket.
      releaseQueued({
        token: 'stale-token',
        bucketId: 'stale-bucket',
        gatewayBaseUrl: 'https://streams.example.com',
        expiresIn: 480,
        expiresAt: 1_900_000_000_000,
      });
      await queued;
      await Promise.resolve();
      expect(second.e2ee.bucketId()).toBe('encrypted-content');
      expect(await secondProvider.getToken()).toBe('successor-token');
    } finally {
      await secondProvider.close();
      await second.close();
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

  it('configures snapshot upload with a hard max byte threshold for multi-writer rooms', () => {
    const access = createDesktopE2eeContent({
      runtime: {} as unknown as E2eeWorkspaceRuntime,
      workspaceId: 'workspace',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => null,
    });
    if (access.content.mode !== 'protected') throw new Error('expected protected content');
    expect(access.content.snapshotUpload).toMatchObject({
      debounceMs: 30_000,
      minBytesSinceRemoteSnapshot: 1024 * 1024,
      maxBytesSinceRemoteSnapshot: 4 * 1024 * 1024,
    });
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

const desktopLoss = (code: string) => () =>
  new Error(`Error invoking remote method 'e2ee.contentStreamsToken': Error: ${code}`);
it.each([
  ['token', 'e2ee_member_removed', desktopLoss('e2ee_member_removed')],
  ['token', 'e2ee_device_revoked', desktopLoss('e2ee_device_revoked')],
  // A phone or browser's personal host rejects its own revoked device from the verified
  // ledger; that must reach the re-pairing route instead of endless reconnecting.
  ['token', 'e2ee_device_revoked', () => new PersonalHostError({ code: 'revoked' })],
] as const)(
  'native access loss from %s (%s) retires content without waiting on the failed request',
  async (source, code, failure) => {
    let retire = (_reason: string) => {};
    const retired = new Promise<string>((resolve) => {
      retire = resolve;
    });
    const access = createDesktopE2eeContent({
      workspaceId: 'workspace',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => 'synthetic-login',
      onMemberRemoved: (reason) => retire(reason),
      runtime: {
        contentStreamsToken: async () => {
          throw failure();
        },
      } as unknown as E2eeWorkspaceRuntime,
    });
    const token = access.e2ee.createTokenProvider(new AbortController().signal);
    try {
      await expect(token.getToken()).rejects.toThrow();
      expect(await retired).toBe(code);
      expect(await access.content.snapshotUpload?.canUpload()).toBe(false);
      const room = access.content.resolve({ kind: 'doc', docId: 'session' });
      if (room.mode !== 'protected') throw new Error('expected protected room');
      await expect(
        room.config.provider.seal({
          context,
          plaintext: new Uint8Array([1]),
          additionalData: (header) => header,
        })
      ).rejects.toThrow(code);
    } finally {
      await token.close();
      await access.close();
    }
  }
);

describe('reading an epoch whose key this device has not received yet', () => {
  const pendingKey = () => new Error('e2ee_key-pending');
  const setup = (runtime: Partial<E2eeWorkspaceRuntime>, onMemberRemoved = vi.fn()) => {
    const access = createDesktopE2eeContent({
      runtime: runtime as E2eeWorkspaceRuntime,
      workspaceId: 'rotated',
      genesisHash: '11'.repeat(32),
      epoch: 2,
      authToken: () => null,
      onMemberRemoved,
    });
    if (access.content.mode !== 'protected') throw new Error('expected protected content');
    const room = access.content.resolve({ kind: 'doc', docId: 'session' });
    if (room.mode !== 'protected') throw new Error('expected protected room');
    const open = () =>
      room.config.provider.open({
        sealed: Uint8Array.of(3),
        header: Uint8Array.of(3),
        context,
        additionalData: Uint8Array.of(3),
      });
    return { access, open };
  };

  it('receives the key once for every waiting read, then retries each read once', async () => {
    const installed = Promise.withResolvers<void>();
    let keyInstalled = false;
    const opens: boolean[] = [];
    const refresh = vi.fn(async () => {
      await installed.promise;
      keyInstalled = true;
      return { epoch: 3, rotationRequired: false, hasCurrentKey: true };
    });
    const { access, open } = setup({
      openContent: async () => {
        opens.push(keyInstalled);
        if (!keyInstalled) throw pendingKey();
        return Uint8Array.of(42);
      },
      refresh,
    } as unknown as Partial<E2eeWorkspaceRuntime>);
    try {
      const first = open(),
        second = open();
      await vi.waitFor(() => expect(opens).toEqual([false, false]));
      installed.resolve();
      expect(await first).toEqual(Uint8Array.of(42));
      expect(await second).toEqual(Uint8Array.of(42));
      expect(refresh).toHaveBeenCalledTimes(1);
      // Explicit reception: a portable host's bare refresh would skip the key round.
      expect(refresh).toHaveBeenCalledWith('rotated', { installKeys: true, keyMode: 'receive' });
      expect(opens).toEqual([false, false, true, true]);
    } finally {
      await access.close();
    }
  });

  it("receives the key for a portable host's typed pending failure, but not for other codes", async () => {
    const typed = (code: string) =>
      Object.assign(new Error(''), { _tag: 'PersonalHostError', code });
    let keyInstalled = false;
    const refresh = vi.fn(async () => {
      keyInstalled = true;
      return { epoch: 3, rotationRequired: false, hasCurrentKey: true };
    });
    const pending = setup({
      openContent: async () => {
        if (!keyInstalled) throw typed('key-pending');
        return Uint8Array.of(7);
      },
      refresh,
    } as unknown as Partial<E2eeWorkspaceRuntime>);
    expect(await pending.open()).toEqual(Uint8Array.of(7));
    expect(refresh).toHaveBeenCalledWith('rotated', { installKeys: true, keyMode: 'receive' });
    await pending.access.close();

    const other = vi.fn();
    const unrelated = setup({
      openContent: async () => {
        throw typed('missing-read-key');
      },
      refresh: other,
    } as unknown as Partial<E2eeWorkspaceRuntime>);
    await expect(unrelated.open()).rejects.toMatchObject({ code: 'missing-read-key' });
    expect(other).not.toHaveBeenCalled();
    await unrelated.access.close();
  });

  it('fails after the bounded wait, or after one retry, without reading again', async () => {
    vi.useFakeTimers();
    try {
      let opens = 0;
      const { access, open } = setup({
        openContent: async () => {
          opens++;
          throw pendingKey();
        },
        refresh: () => new Promise(() => {}),
      } as unknown as Partial<E2eeWorkspaceRuntime>);
      const read = open();
      const failure = expect(read).rejects.toThrow('e2ee_key_pending_timeout');
      await vi.advanceTimersByTimeAsync(KEY_PENDING_WAIT_MS);
      await failure;
      expect(opens).toBe(1);
      await access.close();

      // The round finished but the key is still missing: one retry, then the failure.
      let retried = 0;
      const again = setup({
        openContent: async () => {
          retried++;
          throw pendingKey();
        },
        refresh: async () => ({ epoch: 3, rotationRequired: false, hasCurrentKey: false }),
      } as unknown as Partial<E2eeWorkspaceRuntime>);
      await expect(again.open()).rejects.toThrow('e2ee_key-pending');
      expect(retried).toBe(2);
      await again.access.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('spaces receptions so frames the ledger cannot verify yet cost at most one refresh per interval', async () => {
    vi.useFakeTimers();
    try {
      // Streams ahead of the ledger feed: every open stays pending until the ledger
      // catches up, as a peer streaming unverifiable frames would keep it.
      let caughtUp = false;
      const refresh = vi.fn(async () => ({
        epoch: 3,
        rotationRequired: false,
        hasCurrentKey: true,
      }));
      const { access, open } = setup({
        openContent: async () => {
          if (!caughtUp) throw pendingKey();
          return Uint8Array.of(9);
        },
        refresh,
      } as unknown as Partial<E2eeWorkspaceRuntime>);
      await expect(open()).rejects.toThrow('e2ee_key-pending');
      expect(refresh).toHaveBeenCalledTimes(1);
      // Reads arriving inside the interval share one reception that waits for it.
      const later = [open(), open(), open()];
      await vi.advanceTimersByTimeAsync(KEY_PENDING_REFRESH_INTERVAL_MS - 1);
      expect(refresh).toHaveBeenCalledTimes(1);
      caughtUp = true;
      await vi.advanceTimersByTimeAsync(1);
      expect(await Promise.all(later)).toEqual([
        Uint8Array.of(9),
        Uint8Array.of(9),
        Uint8Array.of(9),
      ]);
      expect(refresh).toHaveBeenCalledTimes(2);
      await access.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting on close and on access loss, and never waits for other failures', async () => {
    let opens = 0;
    const closing = setup({
      openContent: async () => {
        opens++;
        throw pendingKey();
      },
      refresh: () => new Promise(() => {}),
    } as unknown as Partial<E2eeWorkspaceRuntime>);
    const read = closing.open();
    const closed = expect(read).rejects.toThrow('e2ee_closed');
    await vi.waitFor(() => expect(opens).toBe(1));
    await closing.access.close();
    await closed;
    expect(opens).toBe(1);

    const onMemberRemoved = vi.fn();
    const revoked = Object.assign(new Error('e2ee_device_revoked'), {
      accessLoss: 'device_revoked',
    });
    const losing = setup(
      {
        openContent: async () => {
          throw pendingKey();
        },
        refresh: async () => {
          throw revoked;
        },
      } as unknown as Partial<E2eeWorkspaceRuntime>,
      onMemberRemoved
    );
    await expect(losing.open()).rejects.toBe(revoked);
    expect(onMemberRemoved).toHaveBeenCalledTimes(1);
    await losing.access.close();

    for (const terminal of ['e2ee_invalid-ledger', 'e2ee_device_revoked', 'e2ee_closed']) {
      const refresh = vi.fn();
      const other = setup({
        openContent: async () => {
          throw new Error(terminal);
        },
        refresh,
      } as unknown as Partial<E2eeWorkspaceRuntime>);
      await expect(other.open()).rejects.toThrow(terminal);
      expect(refresh).not.toHaveBeenCalled();
      await other.access.close();
    }
  });
});

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
