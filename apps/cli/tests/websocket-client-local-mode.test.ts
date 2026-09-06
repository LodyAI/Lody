import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MachineId,
  ServerToClient,
  SessionId,
  SessionCreateRequest,
  WorkspaceId,
  MachineAcpAuthenticateRequest,
} from '@lody/shared';

vi.mock('@/utils/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/const')>();
  return {
    ...actual,
    LODY_AUTH_URL: undefined,
    LODY_AUTH_SITE_URL: undefined,
  };
});

vi.mock('../src/lib/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/workspace')>();
  return {
    ...actual,
    registerMachineAccessForCliToken: vi.fn(async () => ({
      success: true,
      existing: false,
      sharedWithTeam: false,
    })),
  };
});

import { MachineRuntime } from '../src/lib/machine-runtime';
import { MessageHandler } from '../src/lib/message-handler';
import type { SessionManager } from '../src/session/session-manager';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { Logger } from '../src/utils/logger';
import { createTestCloudPort } from './test-cloud-port';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

function createRuntimeForLocalModeTest(maxConcurrentSessions = 30) {
  const logger = createSilentLogger();
  const sessionManager = {
    initialize: vi.fn(async () => {}),
    on: vi.fn(),
    setRequestPermissionHandler: vi.fn(),
    getSession: vi.fn(),
    finishSession: vi.fn(),
    cleanUp: vi.fn(async () => {}),
    setSessionError: vi.fn(),
    terminateSession: vi.fn(),
    hasSession: vi.fn(),
    createSession: vi.fn(),
    releaseGitHubRepoOwner: vi.fn(),
  };

  const workspaceDocument = {
    sessions: new Map<SessionId, unknown>(),
    restoreMachineDocument: vi.fn(async () => {}),
    watchMachineDocumentExistence: vi.fn(() => {}),
    registerMachine: vi.fn(async () => {}),
    configureMachineMonitor: vi.fn(() => {}),
    clearMachineMonitorProvider: vi.fn(() => {}),
    repo: {
      watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      getDocMeta: vi.fn(async () => undefined),
    },
    onMetaRoomSynced: vi.fn(() => vi.fn()),
    onStreamsOnline: vi.fn(() => vi.fn()),
  };

  const runtime = new MachineRuntime({
    sessionManagerFactory: () => sessionManager as unknown as SessionManager,
    workspaceDocument: workspaceDocument as unknown as LoroDocumentManager,
    handlerConfig: {
      token: 'token',
      workspaceId: 'workspace-1' as WorkspaceId,
      userId: 'user-1',
      machineId: 'machine-1' as MachineId,
      machineName: 'machine-name',
      cliVersion: '0.0.0-test',
      cloudPort: createTestCloudPort(),
    },
    logger,
    maxConcurrentSessions,
  });

  return { runtime, logger, sessionManager };
}

describe('MachineRuntime local-only mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses the initialized runtime on repeated initialize calls', async () => {
    const { runtime, sessionManager } = createRuntimeForLocalModeTest();

    const first = await runtime.initialize();
    const second = await runtime.initialize();

    expect(first.sessionManager).toBe(second.sessionManager);
    expect(first.messageHandler).toBe(second.messageHandler);
    expect(sessionManager.initialize).toHaveBeenCalledTimes(1);

    await runtime.cleanup();
  });

  it('keeps the RPC listener dormant until remote services are authorized', async () => {
    const { runtime } = createRuntimeForLocalModeTest();
    const order: string[] = [];
    let releaseRegistration: (() => void) | null = null;
    const registrationGate = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    const registerMachineSpy = vi
      .spyOn(MessageHandler.prototype, 'registerMachine')
      .mockImplementation(async function registerMachineMock() {
        order.push('registerMachine:start');
        await registrationGate;
        order.push('registerMachine:end');
      });
    const ensureMachineRegisteredSpy = vi
      .spyOn(MessageHandler.prototype, 'ensureMachineRegistered')
      .mockImplementation(async function ensureMachineRegisteredMock() {
        order.push('ensureMachineRegistered');
      });
    const startMachineRpcServerSpy = vi
      .spyOn(MessageHandler.prototype, 'startMachineRpcServer')
      .mockImplementation(function startMachineRpcServerMock() {
        order.push('startMachineRpcServer');
      });
    const startSessionDispatchWatcherSpy = vi
      .spyOn(MessageHandler.prototype, 'startSessionDispatchWatcher')
      .mockImplementation(async function startSessionDispatchWatcherMock() {
        order.push('startSessionDispatchWatcher');
      });

    try {
      const initializePromise = runtime.initialize();
      await vi.waitFor(() => {
        expect(order).toEqual(['registerMachine:start']);
      });

      releaseRegistration?.();
      await initializePromise;

      expect(order).toEqual([
        'registerMachine:start',
        'registerMachine:end',
        'ensureMachineRegistered',
        'startSessionDispatchWatcher',
      ]);

      void runtime.getMessageHandler()?.activateRemoteServices();
      expect(order).toEqual([
        'registerMachine:start',
        'registerMachine:end',
        'ensureMachineRegistered',
        'startSessionDispatchWatcher',
        'startMachineRpcServer',
      ]);
    } finally {
      releaseRegistration?.();
      registerMachineSpy.mockRestore();
      ensureMachineRegisteredSpy.mockRestore();
      startMachineRpcServerSpy.mockRestore();
      startSessionDispatchWatcherSpy.mockRestore();
    }
  });

  it('returns local create response before long-running execution finishes', async () => {
    const { runtime } = createRuntimeForLocalModeTest();

    await runtime.initialize();

    const handler = runtime.getMessageHandler();
    if (!handler) {
      throw new Error('Message handler should be initialized');
    }

    let finishExecution: (() => void) | null = null;
    const executionDone = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });

    const originalHandleMessage = handler.handleMessage.bind(handler);
    const handleMessageSpy = vi
      .spyOn(handler, 'handleMessage')
      .mockImplementation(async (message, context) => {
        if (message.type !== 'session/create' || context?.source !== 'local') {
          await originalHandleMessage(message, context);
          return;
        }

        context.send({
          type: 'session/create_response',
          sessionId: message.sessionId,
          success: true,
        });
        await executionDone;
      });

    const localCreateMessage: SessionCreateRequest = {
      type: 'session/create',
      sessionId: 'session-1' as SessionId,
      machineId: 'machine-1' as MachineId,
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: {
        prompt: 'hello',
        cliType: 'builtin',
        agentType: 'codex',
      },
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    };

    const responsePromise = runtime.dispatchLocalMessageForResponse(localCreateMessage);
    const quickResponse = await Promise.race([
      responsePromise,
      new Promise<ServerToClient[]>((_, reject) => {
        setTimeout(() => reject(new Error('timed_out_waiting_for_quick_local_response')), 250);
      }),
    ]);

    expect(
      quickResponse.some(
        (message) =>
          message.type === 'session/create_response' &&
          message.sessionId === localCreateMessage.sessionId &&
          message.success === true
      )
    ).toBe(true);

    finishExecution?.();
    await handleMessageSpy.mock.results[0]?.value;
    await runtime.cleanup();
  });
});

describe('trusted local authentication cancellation', () => {
  const start = (requestId: string): MachineAcpAuthenticateRequest => ({
    type: 'machine/acp-authenticate',
    machineId: 'machine-1',
    workspaceId: 'workspace-1',
    configId: 'config-1',
    accountProfileId: 'profile-1',
    requestId,
    action: 'start',
  });
  const cancel = (requestId: string): MachineAcpAuthenticateRequest => ({
    ...start(`cancel-${requestId}`),
    action: 'cancel',
    authenticationRequestId: requestId,
  });
  const blocker: SessionCreateRequest = {
    type: 'session/create',
    sessionId: 'unrelated-session',
    machineId: 'machine-1',
    workspaceId: 'workspace-1',
    acpSessionConfig: { prompt: 'synthetic blocker', cliType: 'builtin', agentType: 'codex' },
    userId: 'user-1',
    userName: 'User',
    userEmail: 'user@example.test',
  };

  async function setup() {
    const { runtime } = createRuntimeForLocalModeTest(1);
    const { messageHandler } = await runtime.initialize();
    return { runtime, handler: messageHandler };
  }

  it('settles a queued start before an unrelated blocker releases and never invokes its handler', async () => {
    const { runtime, handler } = await setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const handledStarts: string[] = [];
    vi.spyOn(handler, 'handleMessage').mockImplementation(async (message) => {
      if (message.type === 'session/create') {
        entered.resolve();
        await release.promise;
      } else if (message.type === 'machine/acp-authenticate' && message.action === 'start') {
        handledStarts.push(message.requestId);
      }
    });
    try {
      const held = runtime.dispatchLocalMessageForResponse(blocker);
      await entered.promise;
      const pending = runtime.dispatchLocalMessageForResponse(start('queued'));
      await runtime.dispatchLocalMessageForResponse(cancel('queued'));
      expect(await pending).toEqual([
        expect.objectContaining({ requestId: 'queued', success: true, disposition: 'cancelled' }),
      ]);
      expect(handledStarts).toEqual([]);
      release.resolve();
      await held;
      await runtime.cleanup();
      expect(handledStarts).toEqual([]);
    } finally {
      release.resolve();
      await runtime.cleanup();
    }
  });

  it('rejects a duplicate start without replacing the active cancellation signal', async () => {
    const { runtime, handler } = await setup();
    const entered = Promise.withResolvers<AbortSignal>();
    const handledStarts: string[] = [];
    vi.spyOn(handler, 'handleMessage').mockImplementation(async (message, context) => {
      if (message.type !== 'machine/acp-authenticate' || message.action !== 'start') return;
      const signal = context?.authenticationSignal;
      if (!signal || context.source !== 'local') throw new Error('Missing trusted auth signal');
      handledStarts.push(message.requestId);
      entered.resolve(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
      context.send({
        type: 'machine/acp-authenticate_response',
        machineId: message.machineId,
        requestId: message.requestId,
        agentType: 'codex',
        success: true,
        disposition: 'cancelled',
      });
    });
    try {
      const pending = runtime.dispatchLocalMessageForResponse(start('active'));
      const signal = await entered.promise;
      expect(signal.aborted).toBe(false);
      expect(await runtime.dispatchLocalMessageForResponse(start('active'))).toEqual([
        expect.objectContaining({ success: false, disposition: 'error' }),
      ]);
      await runtime.dispatchLocalMessageForResponse(cancel('active'));
      expect(signal.aborted).toBe(true);
      expect(await pending).toEqual([
        expect.objectContaining({ requestId: 'active', disposition: 'cancelled' }),
      ]);
      expect(handledStarts).toEqual(['active']);
    } finally {
      await runtime.cleanup();
    }
  });

  it('keeps retry ownership after a cancelled queued start leaves the processor', async () => {
    const { runtime, handler } = await setup();
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const retryEntered = Promise.withResolvers<AbortSignal>();
    const handledStarts: string[] = [];
    vi.spyOn(handler, 'handleMessage').mockImplementation(async (message, context) => {
      if (message.type === 'session/create') {
        blocked.resolve();
        await release.promise;
      } else if (message.type === 'machine/acp-authenticate' && message.action === 'start') {
        const signal = context?.authenticationSignal;
        if (!signal) throw new Error('Missing retry signal');
        handledStarts.push(message.requestId);
        retryEntered.resolve(signal);
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true })
        );
      }
    });
    try {
      const held = runtime.dispatchLocalMessageForResponse(blocker);
      await blocked.promise;
      const first = runtime.dispatchLocalMessageForResponse(start('retry'));
      await runtime.dispatchLocalMessageForResponse(cancel('retry'));
      expect(await first).toEqual([expect.objectContaining({ disposition: 'cancelled' })]);
      const retry = runtime.dispatchLocalMessageForResponse(start('retry'));
      release.resolve();
      await held;
      const retrySignal = await retryEntered.promise;
      expect(retrySignal.aborted).toBe(false);
      await runtime.dispatchLocalMessageForResponse(cancel('retry'));
      expect(retrySignal.aborted).toBe(true);
      await retry;
      expect(handledStarts).toEqual(['retry']);
    } finally {
      release.resolve();
      await runtime.cleanup();
    }
  });

  it('aborts active and queued authentication starts during cleanup', async () => {
    const { runtime, handler } = await setup();
    const entered = Promise.withResolvers<AbortSignal>();
    const handledStarts: string[] = [];
    vi.spyOn(handler, 'handleMessage').mockImplementation(async (message, context) => {
      if (message.type !== 'machine/acp-authenticate' || message.action !== 'start') return;
      const signal = context?.authenticationSignal;
      if (!signal) throw new Error('Missing cleanup signal');
      handledStarts.push(message.requestId);
      entered.resolve(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
    });
    const active = runtime.dispatchLocalMessageForResponse(start('active-cleanup'));
    const signal = await entered.promise;
    const queued = runtime.dispatchLocalMessageForResponse(start('queued-cleanup'));
    try {
      await runtime.cleanup();
      expect(signal.aborted).toBe(true);
      expect(await queued).toEqual([
        expect.objectContaining({ requestId: 'queued-cleanup', disposition: 'cancelled' }),
      ]);
      await active;
      expect(handledStarts).toEqual(['active-cleanup']);
    } finally {
      await runtime.cleanup();
    }
  });
});
