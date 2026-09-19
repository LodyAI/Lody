import { describe, expect, it } from 'vitest';

import type {
  LocalSessionControlRequestValidated,
  MachineId,
  ServerToMachineValidated,
  SessionId,
  WorkspaceId,
} from '@lody/shared';

import { MessageProcessor } from '../src/lib/message-processor';
import type { Logger } from '../src/utils/logger';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
  setDebug: () => {},
});

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

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

describe('MessageProcessor permission responses', () => {
  it('does not deadlock permission_response behind session/chat', async () => {
    const logger = createSilentLogger();
    const processor = new MessageProcessor(logger, 2);

    const sessionId = 's-1' as SessionId;
    const machineId = 'm-1' as MachineId;
    const workspaceId = 'ws-1' as WorkspaceId;

    const events: string[] = [];

    let resolvePermission!: () => void;
    const permission = new Promise<void>((resolve) => {
      resolvePermission = resolve;
    });

    const chatMessage: ServerToMachineValidated = {
      type: 'session/chat',
      sessionId,
      machineId,
      workspaceId,
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-1',
      userId: 'u-1',
      userName: 'User',
      userEmail: 'user@example.com',
    };

    const permissionMessage: ServerToMachineValidated = {
      type: 'session/permission_response',
      sessionId,
      requestId: 'req-1',
      outcome: { outcome: 'cancelled' },
    };

    processor.enqueue(chatMessage, async (msg) => {
      if (msg.type !== 'session/chat') return;
      events.push('chat:start');
      await permission;
      events.push('chat:end');
    });

    processor.enqueue(permissionMessage, async (msg) => {
      if (msg.type !== 'session/permission_response') return;
      events.push('permission');
      resolvePermission();
    });

    await withTimeout(processor.drain(), 1000);

    expect(events.indexOf('permission')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('chat:end')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('permission')).toBeLessThan(events.indexOf('chat:end'));
  });

  it('does not block session/image-upload behind session/chat for the same session', async () => {
    const logger = createSilentLogger();
    const processor = new MessageProcessor(logger, 2);

    const sessionId = 's-1' as SessionId;
    const machineId = 'm-1' as MachineId;
    const workspaceId = 'ws-1' as WorkspaceId;

    const events: string[] = [];

    let resolveChat!: () => void;
    const chatBlocked = new Promise<void>((resolve) => {
      resolveChat = resolve;
    });

    let resolveUploadProcessed!: () => void;
    const uploadProcessed = new Promise<void>((resolve) => {
      resolveUploadProcessed = resolve;
    });

    const chatMessage: ServerToMachineValidated = {
      type: 'session/chat',
      sessionId,
      machineId,
      workspaceId,
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-1',
      userId: 'u-1',
      userName: 'User',
      userEmail: 'user@example.com',
    };

    processor.enqueue(chatMessage, async (msg) => {
      if (msg.type !== 'session/chat') return;
      events.push('chat:start');
      await chatBlocked;
      events.push('chat:end');
    });

    processor.enqueue(
      {
        type: 'session/image-upload',
        sessionId,
        machineId,
        workspaceId,
        paths: ['/tmp/screenshot.png'],
      },
      async (msg) => {
        if (msg.type !== 'session/image-upload') return;
        events.push('upload');
        resolveUploadProcessed();
      }
    );

    await withTimeout(uploadProcessed, 1000);
    expect(events).toEqual(['chat:start', 'upload']);

    resolveChat();
    await withTimeout(processor.drain(), 1000);

    expect(events.indexOf('upload')).toBeLessThan(events.indexOf('chat:end'));
  });
});

describe('MessageProcessor machine/acp-authenticate lanes', () => {
  const machineId = 'm-1';
  const workspaceId = 'ws-1';

  const createStartMessage = (requestId: string): LocalSessionControlRequestValidated => ({
    type: 'machine/acp-authenticate',
    machineId,
    workspaceId,
    requestId,
    action: 'start',
    configId: 'cfg-1',
  });

  it('dispatches cancel and submit-code while a start login is still blocked', async () => {
    const logger = createSilentLogger();
    const processor = new MessageProcessor(logger, 2);

    const events: string[] = [];

    let resolveStart!: () => void;
    const startBlocked = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });

    let resolveControlsProcessed!: () => void;
    const controlsProcessed = new Promise<void>((resolve) => {
      resolveControlsProcessed = resolve;
    });

    processor.enqueue(createStartMessage('req-start'), async (msg) => {
      if (msg.type !== 'machine/acp-authenticate') return;
      events.push('start:begin');
      await startBlocked;
      events.push('start:end');
    });

    // A blocked start must not hold up the control actions targeting it:
    // cancel is how the user aborts the very login that start is awaiting.
    processor.enqueue(
      {
        type: 'machine/acp-authenticate',
        machineId,
        workspaceId,
        requestId: 'req-cancel',
        action: 'cancel',
        authenticationRequestId: 'req-start',
      },
      async () => {
        events.push('cancel');
      }
    );

    processor.enqueue(
      {
        type: 'machine/acp-authenticate',
        machineId,
        workspaceId,
        requestId: 'req-submit',
        action: 'submit-code',
        authenticationRequestId: 'req-start',
        authorizationCode: 'code-1',
      },
      async () => {
        events.push('submit-code');
        resolveControlsProcessed();
      }
    );

    await withTimeout(controlsProcessed, 1000);
    expect(events).toEqual(['start:begin', 'cancel', 'submit-code']);

    resolveStart();
    await withTimeout(processor.drain(), 1000);

    expect(events.indexOf('submit-code')).toBeLessThan(events.indexOf('start:end'));
  });

  it('still serializes consecutive start actions', async () => {
    const logger = createSilentLogger();
    const processor = new MessageProcessor(logger, 2);

    const events: string[] = [];

    let resolveFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    processor.enqueue(createStartMessage('req-start-1'), async () => {
      events.push('start1:begin');
      await firstBlocked;
      events.push('start1:end');
    });

    processor.enqueue(createStartMessage('req-start-2'), async () => {
      events.push('start2:begin');
    });

    // Flush the queue's promise chains; the second start must not begin while
    // the first one holds the start lane.
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['start1:begin']);

    resolveFirst();
    await withTimeout(processor.drain(), 1000);

    expect(events).toEqual(['start1:begin', 'start1:end', 'start2:begin']);
  });
});
