import { describe, expect, it, vi } from 'vitest';
import type { LocalSessionControlRequestValidated, SessionId } from '@lody/shared';
import { SessionPreviewRevokeRequestSchema } from '@lody/shared';
import { MachineRuntime } from '../src/lib/machine-runtime';
import { MessageProcessor, MessageProcessorStoppedError } from '../src/lib/message-processor';
import type { Logger } from '../src/utils/logger';

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => logger,
  close: async () => {},
};
const message: LocalSessionControlRequestValidated = {
  type: 'session/cancel',
  sessionId: 'synthetic-stop-session' as SessionId,
};

function runtimeWithHandler(handleMessage: () => Promise<void>) {
  const runtime = new MachineRuntime({
    sessionManagerFactory: () => {
      throw new Error('Not used by dispatch test');
    },
    workspaceDocument: { clearMachineMonitorProvider: () => {} } as never,
    handlerConfig: {} as never,
    memoryPressure: {
      getLatest: async () => {
        throw new Error('No OS probes in dispatch test');
      },
      refresh: async () => {
        throw new Error('No OS probes in dispatch test');
      },
    },
    logger,
  });
  Object.assign(runtime, {
    handler: {
      handleMessage,
      cancelPendingPermissionRequests: () => {},
      cleanup: async () => {},
    },
  });
  return runtime;
}

describe('local control shutdown admission', () => {
  it('rejects requests arriving after force termination begins', async () => {
    const handler = vi.fn(async () => {});
    const runtime = runtimeWithHandler(handler);
    await runtime.forceTerminateSessions();
    await expect(runtime.dispatchLocalMessageForResponse(message)).rejects.toBeInstanceOf(
      MessageProcessorStoppedError
    );
    expect(handler).not.toHaveBeenCalled();
    await runtime.cleanup();
  });

  it('rejects queued dispatch immediately, but preserves active completion and skips queued side effects', async () => {
    const entered = deferred();
    const finish = deferred();
    const handler = vi.fn(async () => {
      entered.release();
      await finish.promise;
    });
    const runtime = runtimeWithHandler(handler);
    const active = runtime.dispatchLocalMessageForResponse(message);
    await entered.promise;
    const queued = runtime.dispatchLocalMessageForResponse(message);
    const rejected = expect(queued).rejects.toBeInstanceOf(MessageProcessorStoppedError);
    await runtime.forceTerminateSessions();
    // This must settle while the active handler is still blocked.
    await rejected;
    expect(handler).toHaveBeenCalledTimes(1);
    finish.release();
    await expect(active).resolves.toEqual([]);
    await runtime.cleanup();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not replace an active handler failure with a shutdown error', async () => {
    const entered = deferred();
    const finish = deferred();
    const failure = new Error('Actual handler failure');
    const runtime = runtimeWithHandler(async () => {
      entered.release();
      await finish.promise;
      throw failure;
    });
    const result = runtime.dispatchLocalMessageForResponse(message);
    const rejected = expect(result).rejects.toBe(failure);
    await entered.promise;
    await runtime.forceTerminateSessions();
    finish.release();
    await rejected;
    await runtime.cleanup();
  });

  it('discards entries waiting for global capacity exactly once across repeated stop calls', async () => {
    const processor = new MessageProcessor(logger, 1);
    const entered = deferred();
    const finish = deferred();
    const activeDiscard = vi.fn();
    processor.enqueue(
      message,
      async () => {
        entered.release();
        await finish.promise;
      },
      activeDiscard
    );
    await entered.promise;
    const queuedHandler = vi.fn(async () => {});
    const discard = vi.fn();
    // Preview requests have a separate lane, so this waits on global capacity.
    processor.enqueue(
      SessionPreviewRevokeRequestSchema.parse({
        type: 'session/preview-revoke',
        sessionId: message.sessionId,
        machineId: 'synthetic-machine',
        workspaceId: 'synthetic-workspace',
        requestedByUserId: 'synthetic-user',
      }),
      queuedHandler,
      discard
    );
    await Promise.resolve();
    expect(processor.getQueueSize()).toBe(1);
    processor.stop();
    processor.stop();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith(expect.any(MessageProcessorStoppedError));
    expect(activeDiscard).not.toHaveBeenCalled();
    finish.release();
    await processor.drain();
    expect(queuedHandler).not.toHaveBeenCalled();
  });
});
