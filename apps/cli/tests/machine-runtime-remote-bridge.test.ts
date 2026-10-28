import { describe, expect, it, vi } from 'vitest';
import { MachineRuntime, type MachineRuntimeOptions } from '../src/lib/machine-runtime';
import type { Logger } from '../src/utils/logger';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const createHarness = (encrypted = false) => {
  // Stateful shared-resource model: attach/detach flip the same booleans the
  // real LoroDocumentManager transport + MessageHandler backfill gate flip.
  const state = { transportAttached: false, backfillEnabled: false };
  const workspaceDocument = {
    attachRemoteStreamsTransport: vi.fn(async () => {
      state.transportAttached = true;
    }),
    detachRemoteStreamsTransport: vi.fn(async () => {
      state.transportAttached = false;
    }),
  };
  const handler = {
    activateRemoteServices: vi.fn(() => {}),
    enableRemoteBackfillAndScan: vi.fn(async () => {
      state.backfillEnabled = true;
    }),
    disableRemoteBackfill: vi.fn(() => {
      state.backfillEnabled = false;
    }),
    recheckPendingSessionAccess: vi.fn(() => {}),
    cancelActiveTurnsForRemoteRevocation: vi.fn(async () => {}),
  };
  const runtime = new MachineRuntime({
    sessionManagerFactory: () => {
      throw new Error('not used');
    },
    workspaceDocument: workspaceDocument as never,
    handlerConfig: {
      token: 'token',
      encryptedWorkspace: encrypted,
      workspaceId: 'workspace',
      machineId: 'machine',
      userId: 'owner',
    } as never,
    logger: createSilentLogger(),
  } satisfies MachineRuntimeOptions);
  (runtime as unknown as { handler: unknown }).handler = handler;
  return { runtime, workspaceDocument, handler, state };
};

describe('MachineRuntime remote bridge transitions', () => {
  it('completes a normal attach and becomes idempotent', async () => {
    const { runtime, workspaceDocument, handler, state } = createHarness();

    expect(runtime.isRemoteBridgeAttached()).toBe(false);
    await runtime.attachRemoteBridge();
    expect(runtime.isRemoteBridgeAttached()).toBe(true);
    expect(handler.activateRemoteServices).toHaveBeenCalledTimes(1);
    expect(workspaceDocument.attachRemoteStreamsTransport).toHaveBeenCalledTimes(1);
    expect(handler.enableRemoteBackfillAndScan).toHaveBeenCalledTimes(1);
    expect(handler.recheckPendingSessionAccess).toHaveBeenCalledWith('remote-bridge-online');
    expect(state.transportAttached).toBe(true);
    expect(state.backfillEnabled).toBe(true);

    await runtime.attachRemoteBridge();
    expect(workspaceDocument.attachRemoteStreamsTransport).toHaveBeenCalledTimes(1);
    expect(handler.activateRemoteServices).toHaveBeenCalledTimes(1);
  });

  it('a revoke queued behind an in-flight attach leaves the bridge detached and backfill off', async () => {
    const { runtime, workspaceDocument, handler, state } = createHarness();
    const streamsAttach = deferred<void>();
    workspaceDocument.attachRemoteStreamsTransport.mockImplementation(async () => {
      await streamsAttach.promise;
      state.transportAttached = true;
    });

    const attach = runtime.attachRemoteBridge();
    const revoke = runtime.handleRemoteAccessRevoked();
    streamsAttach.resolve();
    await attach;
    await revoke;

    // Serialized: the revoke body ran after the attach body, so the net state
    // is detached with backfill authorization off (S5 撤权不上传).
    expect(state.transportAttached).toBe(false);
    expect(state.backfillEnabled).toBe(false);
    expect(handler.cancelActiveTurnsForRemoteRevocation).toHaveBeenCalledTimes(1);
    const lastDisable = handler.disableRemoteBackfill.mock.invocationCallOrder.at(-1) ?? 0;
    const enableOrder = handler.enableRemoteBackfillAndScan.mock.invocationCallOrder.at(-1) ?? 0;
    expect(lastDisable).toBeGreaterThan(enableOrder);

    // Not wedged: a fresh attach re-attaches end-to-end.
    await runtime.attachRemoteBridge();
    expect(state.transportAttached).toBe(true);
    expect(state.backfillEnabled).toBe(true);
  });

  it('a detach queued behind an in-flight attach nets out detached (offline debounce path)', async () => {
    const { runtime, workspaceDocument, state } = createHarness();
    const streamsAttach = deferred<void>();
    workspaceDocument.attachRemoteStreamsTransport.mockImplementation(async () => {
      await streamsAttach.promise;
      state.transportAttached = true;
    });

    const attach = runtime.attachRemoteBridge();
    const detach = runtime.detachRemoteBridge();
    streamsAttach.resolve();
    await attach;
    await detach;

    expect(runtime.isRemoteBridgeAttached()).toBe(false);
    expect(state.transportAttached).toBe(false);
    expect(state.backfillEnabled).toBe(false);

    await runtime.attachRemoteBridge();
    expect(state.transportAttached).toBe(true);
    expect(state.backfillEnabled).toBe(true);
  });
});

it('admits encrypted file and preview features through machine dispatch while rejecting foreign routing and requester identity', async () => {
  const { runtime, handler } = createHarness(true);
  const files = new Map<string, string>();
  Object.assign(handler, {
    handleLocalMachineRpc: async (
      request: import('@lody/shared/local-machine-rpc').LocalMachineRpcRequest
    ) => {
      if (request.method === 'code-collab/save-text' && request.params.text.encoding === 'plain')
        files.set(request.params.path, request.params.text.text);
      return { ok: true, result: { status: 'ok' } };
    },
  });
  const request = {
    workspaceId: 'workspace',
    machineId: 'machine',
    method: 'code-collab/save-text' as const,
    params: {
      sessionId: 'session',
      requestedByUserId: 'owner',
      path: 'private.ts',
      baseDigest: 'sha256:' + '11'.repeat(32),
      text: { encoding: 'plain' as const, text: 'private contents', rawBytes: 16 },
    },
  };
  await runtime.handleEncryptedFeatureRpc(request);
  expect(files.get('private.ts')).toBe('private contents');
  await expect(
    runtime.handleEncryptedFeatureRpc({ ...request, workspaceId: 'other' })
  ).rejects.toThrow('e2ee_feature_scope');
  await expect(
    runtime.handleEncryptedFeatureRpc({
      ...request,
      params: { ...request.params, requestedByUserId: 'other', path: 'foreign.ts' },
    })
  ).rejects.toThrow('e2ee_feature_requester');
  expect([...files.keys()]).toEqual(['private.ts']);
});
