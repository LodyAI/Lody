// Regression tests for finding F3 of the 2026-07-04 adversarial review
// (concurrent attachRemoteBridge tearing down its sibling's transport).
//
// `MachineRuntime` serializes all remote-bridge transitions through a
// single-writer queue (`runBridgeTransition`): attach/detach/revoke bodies
// never interleave. The invariant under test: whenever the bridge reports
// attached (attach() being an idempotent no-op), the transport is actually
// attached and backfill is enabled.

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

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (e: Error) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const createHarness = () => {
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
    handlerConfig: { token: 'token' } as never,
    logger: createSilentLogger(),
  } satisfies MachineRuntimeOptions);
  (runtime as unknown as { handler: unknown }).handler = handler;
  return { runtime, workspaceDocument, handler, state };
};

describe('F3 regression: concurrent attachRemoteBridge transitions are serialized', () => {
  it('a concurrent attach while one is in flight is a serialized no-op, not a second transport attach', async () => {
    const { runtime, workspaceDocument, state } = createHarness();
    const streamsAttach = deferred<void>();
    workspaceDocument.attachRemoteStreamsTransport.mockImplementationOnce(async () => {
      await streamsAttach.promise;
      state.transportAttached = true;
    });

    const attachA = runtime.attachRemoteBridge();
    const attachB = runtime.attachRemoteBridge();
    streamsAttach.resolve();
    await attachA;
    await attachB;

    expect(workspaceDocument.attachRemoteStreamsTransport).toHaveBeenCalledTimes(1);
    expect(state.transportAttached).toBe(true);
    expect(state.backfillEnabled).toBe(true);
  });

  it('a failed attach does not poison a queued sibling: the retry attaches end-to-end', async () => {
    const { runtime, workspaceDocument, state } = createHarness();
    workspaceDocument.attachRemoteStreamsTransport.mockImplementationOnce(async () => {
      throw new Error('token_expired');
    });

    const attachA = runtime.attachRemoteBridge();
    const attachB = runtime.attachRemoteBridge();
    await expect(attachA).rejects.toThrow('token_expired');
    await attachB;

    expect(state.transportAttached).toBe(true);
    expect(state.backfillEnabled).toBe(true);

    // Idempotent afterwards: no duplicate transport attach.
    await runtime.attachRemoteBridge();
    expect(workspaceDocument.attachRemoteStreamsTransport).toHaveBeenCalledTimes(2);
  });
});
