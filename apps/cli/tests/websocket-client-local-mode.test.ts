import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MachineId,
  ServerToClient,
  SessionId,
  SessionCreateRequest,
  WorkspaceId,
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

function createRuntimeForLocalModeTest() {
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
