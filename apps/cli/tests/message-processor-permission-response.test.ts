import { describe, expect, it, vi } from 'vitest';

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

const deferred = () => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('MessageProcessor local control lanes', () => {
  const target = { machineId: 'm-1' as MachineId, workspaceId: 'ws-1' as WorkspaceId };
  const refresh = (configId: string): LocalSessionControlRequestValidated => ({
    ...target,
    type: 'machine/acp-capabilities-refresh',
    configId,
  });
  const lifecycle = (
    type: 'machine/restart' | 'machine/upgrade'
  ): LocalSessionControlRequestValidated => ({
    ...target,
    type,
    requesterUserId: 'u-1',
    requestToken: 'token-1',
    requestId: 'req-1',
  });
  const cancel: LocalSessionControlRequestValidated = {
    ...target,
    type: 'session/cancel',
    sessionId: 's-1' as SessionId,
    turnId: 'turn-1',
  };
  const independentMessages: LocalSessionControlRequestValidated[] = [
    { ...target, type: 'machine/status' },
    { ...target, type: 'machine/ping', requestId: 'ping-1' },
    cancel,
    refresh('cfg-2'),
    { ...target, type: 'machine/provider-rate-limits-refresh', configId: 'cfg-1' },
    { ...target, type: 'machine/acp-binary-status', agentType: 'codex' },
    { ...target, type: 'machine/acp-binary-install', agentType: 'codex' },
    lifecycle('machine/restart'),
    lifecycle('machine/upgrade'),
  ];

  it.each(independentMessages)(
    'completes $type while a capability refresh is blocked',
    async (message) => {
      const processor = new MessageProcessor(createSilentLogger(), 2);
      const started = deferred();
      const release = deferred();
      const completed = deferred();
      const events: string[] = [];
      try {
        processor.enqueue(refresh('cfg-1'), async () => {
          started.resolve();
          await release.promise;
          events.push('refresh:end');
        });
        await started.promise;
        processor.enqueue(message, async () => {
          events.push('control:end');
          completed.resolve();
        });
        await withTimeout(completed.promise, 1000);
        expect(events).toEqual(['control:end']);
      } finally {
        release.resolve();
        processor.stop();
        await processor.drain();
      }
    }
  );

  it('cancels a session while its chat is blocked on the main lane', async () => {
    const processor = new MessageProcessor(createSilentLogger(), 2);
    const started = deferred();
    const release = deferred();
    const completed = deferred();
    const events: string[] = [];
    try {
      processor.enqueue(
        {
          ...target,
          type: 'session/chat',
          sessionId: 's-1' as SessionId,
          acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
          userTurnId: 'turn-1',
          userId: 'u-1',
          userName: 'User',
          userEmail: 'user@example.com',
        },
        async () => {
          started.resolve();
          await release.promise;
          events.push('chat:end');
        }
      );
      await started.promise;
      processor.enqueue(cancel, async () => {
        events.push('cancel:end');
        completed.resolve();
      });
      await withTimeout(completed.promise, 1000);
      expect(events).toEqual(['cancel:end']);
    } finally {
      release.resolve();
      processor.stop();
      await processor.drain();
    }
  });

  it.each([
    { name: 'same config refreshes', first: refresh('cfg-1'), second: refresh('cfg-1') },
    {
      name: 'restart then upgrade',
      first: lifecycle('machine/restart'),
      second: lifecycle('machine/upgrade'),
    },
    {
      name: 'upgrade then restart',
      first: lifecycle('machine/upgrade'),
      second: lifecycle('machine/restart'),
    },
  ])('serializes $name', async ({ first, second }) => {
    const processor = new MessageProcessor(createSilentLogger(), 2);
    const started = deferred();
    const release = deferred();
    const marker = deferred();
    const events: string[] = [];
    try {
      processor.enqueue(first, async () => {
        started.resolve();
        await release.promise;
        events.push('first:end');
      });
      await started.promise;
      processor.enqueue(second, async () => {
        events.push('second:end');
      });
      processor.enqueue({ ...target, type: 'machine/ping', requestId: 'marker' }, async () => {
        marker.resolve();
      });
      await withTimeout(marker.promise, 1000);
      expect(events).toEqual([]);
      release.resolve();
      await processor.drain();
      expect(events).toEqual(['first:end', 'second:end']);
    } finally {
      release.resolve();
      processor.stop();
      await processor.drain();
    }
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

it.each(['page', 'watch'] as const)(
  'runs ordered history writes while the same session %s read is parked',
  async (kind) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const processor = new MessageProcessor(createSilentLogger(), 1);
    let enterRead!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterRead = resolve;
    });
    let releaseRead!: () => void;
    const reading = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let firstEntered!: () => void;
    const first = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let releaseWrite!: () => void;
    const writing = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let secondDone!: () => void;
    const second = new Promise<void>((resolve) => {
      secondDone = resolve;
    });
    const inputs: string[] = [];
    const target = {
      sessionId: 'synthetic-session' as SessionId,
      machineId: 'synthetic-machine' as MachineId,
      workspaceId: 'synthetic-workspace' as WorkspaceId,
    };
    try {
      processor.enqueue(
        {
          ...target,
          type: 'session/history-read',
          query:
            kind === 'page'
              ? { kind: 'readLatestPage', limit: 40 }
              : { kind: 'watchChanges', checkpoint: 'synthetic-checkpoint', waitMs: 15_000 },
        },
        async () => {
          enterRead();
          await reading;
        }
      );
      await entered;
      if (kind === 'watch') {
        let secondWatching!: () => void;
        const other = new Promise<void>((resolve) => {
          secondWatching = resolve;
        });
        processor.enqueue(
          {
            ...target,
            type: 'session/history-read',
            query: { kind: 'watchChanges', checkpoint: 'synthetic-checkpoint', waitMs: 15_000 },
          },
          async () => {
            secondWatching();
            await reading;
          }
        );
        await other; // A second viewer must not serialize behind the first idle watch.
        let ordinaryRead!: () => void;
        const ordinary = new Promise<void>((resolve) => {
          ordinaryRead = resolve;
        });
        processor.enqueue(
          { ...target, type: 'session/history-read', query: { kind: 'count' } },
          async () => {
            ordinaryRead();
          }
        );
        await ordinary;
      }
      processor.enqueue(
        {
          ...target,
          type: 'session/history-write',
          operation: 'accept_input_and_dispatch',
          payload: {},
        },
        async () => {
          inputs.push('first');
          firstEntered();
          await writing;
        }
      );
      processor.enqueue(
        {
          ...target,
          type: 'session/history-write',
          operation: 'accept_input_and_dispatch',
          payload: {},
        },
        async () => {
          inputs.push('second');
          secondDone();
        }
      );
      await first;
      expect(inputs).toEqual(['first']);
      releaseWrite();
      await second;
      expect(inputs).toEqual(['first', 'second']);
    } finally {
      releaseRead();
      releaseWrite();
      processor.stop();
      await processor.drain();
      vi.useRealTimers();
    }
  }
);
