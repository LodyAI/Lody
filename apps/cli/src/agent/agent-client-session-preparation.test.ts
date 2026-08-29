import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId, SessionId, WorkspaceId } from '@lody/shared';
import type { Logger } from '@/utils/logger';

const connectionMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  newSession: vi.fn(),
  loadSession: vi.fn(),
  resumeSession: vi.fn(),
  setSessionConfigOption: vi.fn(),
  unstable_forkSession: vi.fn(),
  closeSession: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('@agentclientprotocol/sdk', () => ({
  PROTOCOL_VERSION: 1,
  ClientSideConnection: class {
    readonly initialize = connectionMocks.initialize;
    readonly newSession = connectionMocks.newSession;
    readonly loadSession = connectionMocks.loadSession;
    readonly resumeSession = connectionMocks.resumeSession;
    readonly setSessionConfigOption = connectionMocks.setSessionConfigOption;
    readonly unstable_forkSession = connectionMocks.unstable_forkSession;
    readonly closeSession = connectionMocks.closeSession;
    readonly cancel = connectionMocks.cancel;
  },
}));

import { AgentClient } from './agent-client';

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(() => logger),
    close: vi.fn(async () => undefined),
  };
  return logger;
}

describe('AgentClient session preparation gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionMocks.initialize.mockResolvedValue({ agentCapabilities: {} });
    connectionMocks.newSession.mockResolvedValue({ sessionId: 'acp-session-1' });
  });

  it('initializes before the claim and starts the ACP session only with the claimed workdir', async () => {
    const target = deferred<{ workdir: string }>();
    const stages: string[] = [];
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-1' as SessionId,
      terminalManager: {} as never,
      onStartupStage: (event) => stages.push(event.type),
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    const startPromise = client.startSession(
      {} as never,
      '/provisional',
      undefined,
      {},
      undefined,
      async () => await target.promise
    );

    await vi.waitFor(() => expect(stages).toEqual(['initialize_start', 'initialize_end']));
    expect(connectionMocks.initialize).toHaveBeenCalledTimes(1);
    expect(connectionMocks.newSession).not.toHaveBeenCalled();
    expect(stages).toEqual(['initialize_start', 'initialize_end']);

    target.resolve({ workdir: '/claimed' });
    await expect(startPromise).resolves.toEqual({ sessionId: 'acp-session-1' });
    expect(connectionMocks.newSession).toHaveBeenCalledWith({
      cwd: '/claimed',
      mcpServers: [],
    });
    expect(stages).toEqual([
      'initialize_start',
      'initialize_end',
      'new_session_start',
      'new_session_end',
    ]);
  });

  it('starts initial and replacement sessions with selected config option values', async () => {
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-grok' as SessionId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'grok' },
      configOptionValues: { permission_mode: 'always-approve' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    await client.startSession({} as never, '/workdir');

    expect(connectionMocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: { clientIdentifier: 'lody:session-grok' },
      })
    );
    expect(connectionMocks.newSession).toHaveBeenCalledWith({
      cwd: '/workdir',
      mcpServers: [],
      _meta: {
        clientIdentifier: 'lody:session-grok',
        lody: {
          sessionConfig: {
            version: 1,
            configOptionValues: { permission_mode: 'always-approve' },
          },
        },
      },
    });

    connectionMocks.newSession.mockResolvedValueOnce({ sessionId: 'acp-session-2' });
    await client.prepareReplacementSession();

    expect(connectionMocks.newSession).toHaveBeenLastCalledWith({
      cwd: '/workdir',
      mcpServers: [],
      _meta: {
        clientIdentifier: 'lody:session-grok',
        lody: {
          sessionConfig: {
            version: 1,
            configOptionValues: { permission_mode: 'always-approve' },
          },
        },
      },
    });
  });

  it('sends initial config without provider-specific startup fields', async () => {
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-neutral-config' as SessionId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'codex' },
      configOptionValues: { approval_policy: 'never' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    await client.startSession({} as never, '/workdir');

    expect(connectionMocks.newSession).toHaveBeenCalledWith({
      cwd: '/workdir',
      mcpServers: [],
      _meta: {
        lody: {
          sessionConfig: {
            version: 1,
            configOptionValues: { approval_policy: 'never' },
          },
        },
      },
    });
  });

  it('carries successful live config changes into replacement session startup', async () => {
    connectionMocks.setSessionConfigOption.mockResolvedValue({ configOptions: [] });
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-grok-switch' as SessionId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'grok' },
      configOptionValues: { permission_mode: 'ask' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    await client.startSession({} as never, '/workdir');
    await client.setSessionConfigOption(
      'acp-session-1' as never,
      'permission_mode',
      'always-approve'
    );

    connectionMocks.newSession.mockResolvedValueOnce({ sessionId: 'acp-session-2' });
    await client.prepareReplacementSession();
    expect(connectionMocks.newSession).toHaveBeenLastCalledWith({
      cwd: '/workdir',
      mcpServers: [],
      _meta: {
        clientIdentifier: 'lody:session-grok-switch',
        lody: {
          sessionConfig: {
            version: 1,
            configOptionValues: { permission_mode: 'always-approve' },
          },
        },
      },
    });

    await client.setSessionConfigOption('acp-session-1' as never, 'permission_mode', 'ask');
    connectionMocks.newSession.mockResolvedValueOnce({ sessionId: 'acp-session-3' });
    await client.prepareReplacementSession();
    expect(connectionMocks.newSession).toHaveBeenLastCalledWith({
      cwd: '/workdir',
      mcpServers: [],
      _meta: {
        clientIdentifier: 'lody:session-grok-switch',
        lody: {
          sessionConfig: {
            version: 1,
            configOptionValues: { permission_mode: 'ask' },
          },
        },
      },
    });
  });

  it('carries agent-originated config updates into replacement session startup', async () => {
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-agent-config-update' as SessionId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'codex' },
      configOptionValues: { collaboration_mode: 'plan', reasoning_effort: 'high' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    await client.startSession({} as never, '/workdir');
    await client.sessionUpdate({
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'collaboration_mode',
            category: 'collaboration_mode',
            type: 'select',
            name: 'Collaboration mode',
            currentValue: 'default',
            options: [],
          },
          {
            id: 'reasoning_effort',
            category: 'thought_level',
            type: 'select',
            name: 'Reasoning effort',
            currentValue: 'low',
            options: [],
          },
        ],
      },
    } as never);

    connectionMocks.newSession.mockResolvedValueOnce({ sessionId: 'acp-session-2' });
    await client.prepareReplacementSession();

    expect(connectionMocks.newSession).toHaveBeenLastCalledWith({
      cwd: '/workdir',
      mcpServers: [],
      _meta: {
        lody: {
          sessionConfig: {
            version: 1,
            configOptionValues: {
              collaboration_mode: 'default',
              reasoning_effort: 'low',
            },
          },
        },
      },
    });
  });

  it('loads sessions with selected config option values', async () => {
    connectionMocks.initialize.mockResolvedValue({
      agentCapabilities: { loadSession: true },
    });
    connectionMocks.loadSession.mockResolvedValue({});
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-grok-load' as SessionId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'grok' },
      configOptionValues: { permission_mode: 'always-approve' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    await client.startSession({} as never, '/workdir', 'stored-grok-session' as never);

    expect(connectionMocks.loadSession).toHaveBeenCalledWith({
      sessionId: 'stored-grok-session',
      cwd: '/workdir',
      mcpServers: [],
      _meta: {
        clientIdentifier: 'lody:session-grok-load',
        lody: {
          sessionConfig: {
            version: 1,
            configOptionValues: { permission_mode: 'always-approve' },
          },
        },
      },
    });
  });

  it('injects Lody MCP into DeepSeek Harness sessions', async () => {
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-deepseek' as SessionId,
      workspaceId: 'workspace-1' as WorkspaceId,
      machineId: 'machine-1' as MachineId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'deepseek' },
      taskToolsEnabled: true,
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    await client.startSession({} as never, '/workdir');

    expect(connectionMocks.newSession).toHaveBeenCalledWith({
      cwd: '/workdir',
      mcpServers: [
        expect.objectContaining({
          name: 'lody',
          command: process.execPath,
          args: expect.arrayContaining(['__internal', 'lody-mcp-server']),
          env: expect.arrayContaining([
            { name: 'LODY_MCP_SESSION_ID', value: 'session-deepseek' },
            { name: 'LODY_MCP_WORKSPACE_ID', value: 'workspace-1' },
            { name: 'LODY_MCP_MACHINE_ID', value: 'machine-1' },
            { name: 'LODY_MCP_WORKDIR', value: '/workdir' },
            { name: 'LODY_MCP_TASK_TOOLS_ENABLED', value: '1' },
          ]),
        }),
      ],
    });
  });

  it('aborts while waiting for a claim without creating an ACP session', async () => {
    const target = deferred<{ workdir: string }>();
    const startupAbort = deferred<never>();
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-aborted' as SessionId,
      terminalManager: {} as never,
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    const startPromise = client.startSession(
      {} as never,
      '/provisional',
      undefined,
      {},
      startupAbort.promise,
      async () => await target.promise
    );
    await vi.waitFor(() => expect(connectionMocks.initialize).toHaveBeenCalledTimes(1));

    const abortError = new Error('preparation cancelled');
    abortError.name = 'AbortError';
    startupAbort.reject(abortError);

    await expect(startPromise).rejects.toBe(abortError);
    expect(connectionMocks.newSession).not.toHaveBeenCalled();
  });

  it('prepares a turn-addressed fork before adopting it', async () => {
    connectionMocks.initialize.mockResolvedValue({
      agentCapabilities: {
        sessionCapabilities: { fork: {}, close: {} },
        _meta: { lody: { forkAtTurn: { version: 1 } } },
      },
    });
    connectionMocks.unstable_forkSession.mockResolvedValue({ sessionId: 'acp-session-2' });
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-fork' as SessionId,
      terminalManager: {} as never,
      configOptionValues: { interaction_mode: 'plan' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });
    await client.startSession({} as never, '/workdir');

    const prepared = await client.prepareReplacementSession('provider-turn-1');

    expect(prepared).toEqual({ sessionId: 'acp-session-2' });
    expect(connectionMocks.unstable_forkSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'acp-session-1',
        cwd: '/workdir',
        _meta: {
          lody: {
            forkAtTurn: { version: 1, turnId: 'provider-turn-1' },
            sessionConfig: {
              version: 1,
              configOptionValues: { interaction_mode: 'plan' },
            },
          },
        },
      })
    );
    await client.cancel('acp-session-1' as never);
    expect(connectionMocks.cancel).toHaveBeenCalledWith({ sessionId: 'acp-session-1' });

    client.adoptPreparedSession(prepared);
    await client.closeDetachedSession('acp-session-1' as never);
    expect(connectionMocks.closeSession).toHaveBeenCalledWith({ sessionId: 'acp-session-1' });
  });

  it('prepares a fresh provider session for editing the first user message', async () => {
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-first' as SessionId,
      terminalManager: {} as never,
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });
    await client.startSession({} as never, '/workdir');
    connectionMocks.newSession.mockResolvedValueOnce({ sessionId: 'acp-session-2' });

    await expect(client.prepareReplacementSession()).resolves.toEqual({
      sessionId: 'acp-session-2',
    });
    expect(connectionMocks.newSession).toHaveBeenLastCalledWith({
      cwd: '/workdir',
      mcpServers: [],
    });
  });
});
