import { describe, expect, it } from 'vitest';

import type { MachineId, ServerToMachineValidated, SessionId, WorkspaceId } from '@lody/shared';

import { MessageProcessor } from '../src/lib/message-processor';
import type { Logger } from '../src/utils/logger';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
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
