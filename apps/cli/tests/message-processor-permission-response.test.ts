import { describe, expect, it, vi } from 'vitest';

import type {
  MachineId,
  MachineAcpAuthenticateRequest,
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

function deferred() {
  let complete: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  if (!complete) throw new Error('Promise resolver was not initialized');
  return { promise, resolve: complete };
}

describe('MessageProcessor authentication continuations', () => {
  const start: MachineAcpAuthenticateRequest = {
    type: 'machine/acp-authenticate',
    machineId: 'machine',
    workspaceId: 'workspace',
    requestId: 'login',
    action: 'start',
    configId: 'config',
    accountProfileId: 'profile',
  };
  const controls: MachineAcpAuthenticateRequest[] = [
    {
      type: 'machine/acp-authenticate',
      machineId: 'machine',
      workspaceId: 'workspace',
      requestId: 'code',
      action: 'submit-code',
      authenticationRequestId: 'login',
      authorizationCode: 'synthetic-code',
    },
    {
      type: 'machine/acp-authenticate',
      machineId: 'machine',
      workspaceId: 'workspace',
      requestId: 'cancel',
      action: 'cancel',
      authenticationRequestId: 'login',
    },
    {
      type: 'machine/acp-authenticate',
      machineId: 'machine',
      workspaceId: 'workspace',
      requestId: 'input',
      action: 'submit-input',
      authenticationRequestId: 'login',
      interactionId: 'form',
      authenticationInput: 'synthetic-input',
    },
  ];

  it.each(controls)(
    'dispatches $action while login occupies the only main slot',
    async (control) => {
      const processor = new MessageProcessor(createSilentLogger(), 1);
      const login = deferred();
      const started = deferred();
      const handled = deferred();
      const events: string[] = [];
      processor.enqueue(start, async () => {
        events.push('start');
        started.resolve();
        await login.promise;
        events.push('finish');
      });
      await started.promise;
      processor.enqueue(start, async () => {
        events.push('duplicate-start');
      });
      processor.enqueue(control, async (message) => {
        expect(message).toBe(control);
        events.push(control.action);
        handled.resolve();
      });
      try {
        await withTimeout(handled.promise, 1000);
        expect(events).toEqual(['start', control.action]);
      } finally {
        login.resolve();
        await withTimeout(processor.drain(), 1000);
      }
      expect(events).toEqual(['start', control.action, 'finish', 'duplicate-start']);
    }
  );

  it('bounds continuation concurrency and includes the reserved lane in drain and counts', async () => {
    vi.useFakeTimers();
    const processor = new MessageProcessor(createSilentLogger(), 1);
    const first = deferred();
    const firstStarted = deferred();
    const second = vi.fn(async () => {});
    const control: MachineAcpAuthenticateRequest = {
      ...start,
      action: 'cancel',
      authenticationRequestId: 'login',
    };
    try {
      processor.enqueue(control, async () => {
        firstStarted.resolve();
        await first.promise;
      });
      await firstStarted.promise;
      processor.enqueue(
        { ...control, authenticationRequestId: 'other-login', requestId: 'other' },
        second
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(processor.getQueueSize()).toBe(1);
      expect(processor.getActiveSessions()).toBe(1);
      let drained = false;
      const draining = processor.drain().then(() => {
        drained = true;
      });
      const timedDrain = processor.drainWithTimeout(1);
      await vi.advanceTimersByTimeAsync(1);
      await timedDrain;
      expect(drained).toBe(false);
      expect(second).not.toHaveBeenCalled();
      first.resolve();
      await draining;
      expect(second).toHaveBeenCalledOnce();
      expect(processor.getActiveSessions()).toBe(0);
    } finally {
      first.resolve();
      await processor.drain();
      vi.useRealTimers();
    }
  });

  it('reports continuation errors and honors stop without disrupting queued cleanup', async () => {
    const processor = new MessageProcessor(createSilentLogger(), 1);
    const error = vi.fn();
    processor.on('message:error', error);
    const control: MachineAcpAuthenticateRequest = {
      ...start,
      action: 'cancel',
      authenticationRequestId: 'login',
    };
    processor.enqueue(control, async () => {
      throw new Error('control failed');
    });
    const next = vi.fn(async () => {});
    processor.enqueue(control, next);
    processor.stop();
    const ignored = vi.fn(async () => {});
    processor.enqueue(control, ignored);
    await withTimeout(processor.drain(), 1000);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'control failed' }),
      control
    );
    expect(next).toHaveBeenCalledOnce();
    expect(ignored).not.toHaveBeenCalled();
  });
});

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
