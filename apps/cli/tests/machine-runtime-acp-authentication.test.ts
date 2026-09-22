import { describe, expect, it, vi } from 'vitest';

import type {
  AgentConfigId,
  LocalSessionControlRequestValidated,
  MachineId,
  WorkspaceId,
} from '@lody/shared';

import { MachineRuntime, type MachineRuntimeOptions } from '../src/lib/machine-runtime';
import type { MessageDispatchContext } from '../src/lib/message-handler';
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

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
};

describe('MachineRuntime ACP authentication dispatch', () => {
  it('delivers interactive input while the authentication start is waiting for it', async () => {
    const machineId = 'machine-1' as MachineId;
    const workspaceId = 'workspace-1' as WorkspaceId;
    const startEntered = deferred();
    const inputReceived = deferred();
    const events: string[] = [];

    const handler = {
      handleMessage: vi.fn(
        async (
          message: LocalSessionControlRequestValidated,
          context: MessageDispatchContext
        ): Promise<void> => {
          if (message.type !== 'machine/acp-authenticate') return;
          if (message.action === 'start') {
            events.push('start:waiting');
            startEntered.resolve();
            await inputReceived.promise;
            events.push('start:authenticated');
            context.send({
              type: 'machine/acp-authenticate_response',
              machineId,
              requestId: message.requestId,
              agentType: 'sorbet',
              success: true,
              disposition: 'authenticated',
            });
            return;
          }

          events.push(`reply:${message.action}`);
          context.send({
            type: 'machine/acp-authenticate_response',
            machineId,
            requestId: message.requestId,
            agentType: 'sorbet',
            success: true,
            disposition: 'input-accepted',
          });
          inputReceived.resolve();
        }
      ),
    };
    const runtime = new MachineRuntime({
      sessionManagerFactory: () => {
        throw new Error('not used');
      },
      workspaceDocument: {} as never,
      handlerConfig: { machineId, workspaceId, token: 'token' } as never,
      logger: createSilentLogger(),
      memoryPressure: {} as never,
      maxConcurrentSessions: 1,
    } satisfies MachineRuntimeOptions);
    (runtime as unknown as { handler: typeof handler }).handler = handler;

    const startMessage: LocalSessionControlRequestValidated = {
      type: 'machine/acp-authenticate',
      machineId,
      workspaceId,
      requestId: 'auth-1',
      action: 'start',
      configId: 'config-1' as AgentConfigId,
    };
    const replyMessage: LocalSessionControlRequestValidated = {
      type: 'machine/acp-authenticate',
      machineId,
      workspaceId,
      requestId: 'reply-1',
      action: 'submit-input',
      authenticationRequestId: 'auth-1',
      interactionId: 'consent-1',
      authenticationInput: JSON.stringify({ action: 'accept' }),
    };

    const startResponse = runtime.dispatchLocalMessageForResponse(startMessage);
    await withTimeout(startEntered.promise, 1_000);

    const replyResponse = runtime.dispatchLocalMessageForResponse(replyMessage);
    try {
      await expect(withTimeout(replyResponse, 1_000)).resolves.toEqual([
        expect.objectContaining({
          requestId: 'reply-1',
          disposition: 'input-accepted',
        }),
      ]);
    } finally {
      inputReceived.resolve();
      await startResponse;
    }

    expect(events).toEqual(['start:waiting', 'reply:submit-input', 'start:authenticated']);
  });
});
