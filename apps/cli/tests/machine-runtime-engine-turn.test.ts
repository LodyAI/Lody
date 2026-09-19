import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { MachineRuntime, type MachineRuntimeOptions } from '../src/lib/machine-runtime';
import type { Logger } from '../src/utils/logger';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

describe('MachineRuntime engine-turn activity cleanup', () => {
  it('clears the engine-turn marker on the exit lifecycle path, not only terminated', async () => {
    // The subscription is registered during initialize(), before the (here
    // deliberately failing) MessageHandler construction, so emitting afterwards
    // still exercises the wiring.
    const sessionManager = new EventEmitter() as EventEmitter & {
      initialize: () => Promise<void>;
    };
    sessionManager.initialize = async () => {};
    const handler = { clearEngineTurnActivity: vi.fn() };
    const runtime = new MachineRuntime({
      sessionManagerFactory: () => sessionManager as never,
      workspaceDocument: {
        configureMachineMonitor: () => {},
        attachRemoteStreamsTransport: async () => {},
        detachRemoteStreamsTransport: async () => {},
      } as never,
      handlerConfig: { token: 'token' } as never,
      logger: createSilentLogger(),
    } satisfies MachineRuntimeOptions);
    (runtime as unknown as { handler: unknown }).handler = handler;

    await runtime.initialize().catch(() => {});

    sessionManager.emit('exit', { sessionId: 'session-1', exitCode: 1 });
    expect(handler.clearEngineTurnActivity).toHaveBeenCalledWith('session-1');
  });
});
