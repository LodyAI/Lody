import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import type { ACPSessionId, AcpSessionNotification, SessionId } from '@lody/shared';
import type { NativeAgentWork } from './agent-client';

const mockState = vi.hoisted(() => ({
  abortController: new AbortController(),
  client: null as acp.Client | null,
  initialize: vi.fn(),
  newSession: vi.fn(),
  loadSession: vi.fn(),
  resumeSession: vi.fn(),
  listSessions: vi.fn(),
  prompt: vi.fn(),
  cancel: vi.fn(),
  closeSession: vi.fn(),
  setSessionConfigOption: vi.fn(),
}));

vi.mock('@agentclientprotocol/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentclientprotocol/sdk')>();
  return {
    ...actual,
    ClientSideConnection: class MockClientSideConnection {
      signal = mockState.abortController.signal;
      initialize = mockState.initialize;
      newSession = mockState.newSession;
      loadSession = mockState.loadSession;
      resumeSession = mockState.resumeSession;
      listSessions = mockState.listSessions;
      prompt = mockState.prompt;
      cancel = mockState.cancel;
      closeSession = mockState.closeSession;
      setSessionConfigOption = mockState.setSessionConfigOption;

      constructor(toClient: (agent: unknown) => acp.Client) {
        mockState.client = toClient(this);
      }
    },
  };
});

import { AgentClient } from './agent-client';
import type { Logger } from '../utils/logger';

function createSilentLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
    debug: () => {},
    trace: () => {},
    setLevel: () => {},
    setDebug: () => {},
    child: () => createSilentLogger(),
    close: async () => {},
  };
}

function makeNotification(
  sessionId: string,
  update: Record<string, unknown>
): acp.SessionNotification {
  return {
    sessionId,
    update,
  } as unknown as acp.SessionNotification;
}

async function emitToLiveClient(notification: acp.SessionNotification): Promise<void> {
  if (!mockState.client) throw new Error('ACP client not connected');
  await mockState.client.sessionUpdate(notification);
}

function createHarness(options?: {
  agentConfig?: { cliType: 'builtin' | 'custom' | 'registry'; agentType: string; name?: string };
}) {
  const updates: AcpSessionNotification[] = [];
  const workChanges: NativeAgentWork[] = [];
  const usageUpdates: unknown[] = [];
  const permissionRequests: unknown[] = [];
  const contextUpdates: unknown[] = [];

  const client = new AgentClient({
    sessionId: 'ag-test-session' as SessionId,
    logger: createSilentLogger(),
    terminalManager: {} as never,
    agentConfig: options?.agentConfig ?? { cliType: 'builtin', agentType: 'antigravity' },
    onUpdateMessage: (msg) => {
      updates.push(msg);
    },
    onNativeWorkChanged: (work) => {
      workChanges.push(work);
    },
    onContextWindowUsageUpdate: (usage) => {
      contextUpdates.push(usage);
    },
    onUsageUpdate: (usage) => {
      usageUpdates.push(usage);
    },
    onRequestPermission: async (_requestId, params) => {
      permissionRequests.push(params);
      return { outcome: { outcome: 'cancelled' } };
    },
  });

  return { client, updates, workChanges, usageUpdates, permissionRequests, contextUpdates };
}

function defaultInitResponse(overrides?: Record<string, unknown>): acp.InitializeResponse {
  return {
    protocolVersion: 1,
    agentInfo: { name: 'Antigravity ACP Server', version: '1.5.10' },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: {
        load: {},
        list: {},
        resume: {},
        close: {},
      },
    },
    ...overrides,
  } as acp.InitializeResponse;
}

describe('Antigravity ACP v1 compatibility and sessionActivity boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.resetAllMocks();
    mockState.abortController = new AbortController();
    mockState.client = null;
    mockState.initialize.mockResolvedValue(defaultInitResponse());
    mockState.newSession.mockResolvedValue({
      sessionId: 'agy-sess-1',
      models: {
        currentModelId: 'gemini-3-pro',
        availableModels: [{ modelId: 'gemini-3-pro', name: 'Gemini 3 Pro' }],
      },
    });
    mockState.loadSession.mockResolvedValue({});
    mockState.resumeSession.mockResolvedValue({});
    mockState.listSessions.mockResolvedValue({ sessions: [] });
    mockState.prompt.mockResolvedValue({ stopReason: 'end_turn' });
    mockState.cancel.mockResolvedValue({});
    mockState.closeSession.mockResolvedValue({});
    mockState.setSessionConfigOption.mockResolvedValue({});
  });

  afterEach(() => {
    mockState.abortController.abort();
    vi.useRealTimers();
  });

  it('enables parity for builtin antigravity and custom Antigravity ACP Server while excluding legacy antigravity-acp', async () => {
    const elicitationParams: acp.CreateElicitationRequest = {
      sessionId: 'agy-sess-1',
      mode: 'form',
      message: 'Choose an option',
      requestedSchema: {
        type: 'object',
        properties: {
          q1: {
            type: 'string',
            title: 'Which mode?',
            oneOf: [
              { const: '1', title: 'Fast' },
              { const: '2', title: 'Safe' },
            ],
          },
          q1_other: {
            type: 'string',
            title: 'Other',
          },
        },
        required: ['q1'],
      },
    } as unknown as acp.CreateElicitationRequest;

    const builtin = createHarness({
      agentConfig: { cliType: 'builtin', agentType: 'antigravity' },
    });
    await builtin.client.startSession({} as never, '/synthetic/project');
    expect(builtin.client.reportsSessionActivity()).toBe(false);
    expect(builtin.client.getNativeActivityObservation()).toBe('unknown');

    const customModern = createHarness({
      agentConfig: { cliType: 'custom', agentType: 'my-agy' },
    });
    await customModern.client.startSession({} as never, '/synthetic/project');
    expect(customModern.client.reportsSessionActivity()).toBe(false);
    expect(customModern.client.getNativeActivityObservation()).toBe('unknown');

    mockState.prompt.mockResolvedValueOnce({
      stopReason: 'end_turn',
      usage: { inputTokens: 20, outputTokens: 10, thoughtTokens: 4, totalTokens: 34 },
    });
    await emitToLiveClient(
      makeNotification('agy-sess-1', {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-custom-1',
        name: 'run_command',
        status: 'completed',
        title: 'Run echo',
        rawInput: { CommandLine: 'echo ok' },
      })
    );
    expect(customModern.updates[0]?.update).toMatchObject({
      sessionUpdate: 'tool_call',
      _meta: { lody: { toolName: 'run_command' } },
    });
    await customModern.client.unstable_createElicitation(elicitationParams);
    expect(customModern.permissionRequests).toHaveLength(1);
    const customModernQuestions = (
      customModern.permissionRequests[0] as {
        _meta?: { lody?: { elicitation?: { questions?: Array<Record<string, unknown>> } } };
      }
    )._meta?.lody?.elicitation?.questions;
    expect(customModernQuestions?.[0]).toMatchObject({
      id: 'q1',
      header: '',
      question: 'Which mode?',
    });
    await customModern.client.prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'hi' }]);
    await Promise.resolve();
    expect(customModern.usageUpdates).toHaveLength(1);

    mockState.initialize.mockResolvedValueOnce(
      defaultInitResponse({
        agentInfo: { name: 'antigravity-acp', version: '1.4.5' },
      })
    );
    const customLegacy = createHarness({
      agentConfig: { cliType: 'custom', agentType: 'legacy-agy' },
    });
    await customLegacy.client.startSession({} as never, '/synthetic/project');
    expect(customLegacy.client.reportsSessionActivity()).toBe(false);
    expect(customLegacy.client.getNativeActivityObservation()).toBe('unknown');
    await expect(
      customLegacy.client.unstable_createElicitation(elicitationParams)
    ).resolves.toEqual({ action: 'cancel' });
    const customLegacyQuestions = (
      customLegacy.permissionRequests[0] as {
        _meta?: { lody?: { elicitation?: { questions?: Array<Record<string, unknown>> } } };
      }
    )._meta?.lody?.elicitation?.questions;
    expect(customLegacyQuestions?.[0]).toMatchObject({
      header: 'Which mode?',
      question: 'Choose an option',
    });
    expect(customLegacyQuestions?.[0]?.id).toBeUndefined();
    await emitToLiveClient(
      makeNotification('agy-sess-1', {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-legacy-1',
        name: 'run_command',
        status: 'completed',
        title: 'Legacy run',
      })
    );
    expect((customLegacy.updates[0]?.update as { _meta?: unknown })._meta).toBeUndefined();
  });

  it('does not synthesize native work or poll session/list after end_turn when Core sessionActivity is absent', async () => {
    const harness = createHarness();
    await harness.client.startSession({} as never, '/synthetic/project');

    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(
        makeNotification('agy-sess-1', {
          sessionUpdate: 'tool_call',
          toolCallId: 'cmd-1',
          name: 'run_command',
          status: 'completed',
          title: 'run_command',
          rawOutput: 'Tool is running as a background task with task id: agy-sess-1/task-1',
        })
      );
      await emitToLiveClient(
        makeNotification('agy-sess-1', {
          sessionUpdate: 'tool_call',
          toolCallId: 'sub-1',
          name: 'invoke_subagent',
          status: 'completed',
          title: 'invoke_subagent',
          rawOutput: { ok: true },
        })
      );
      await emitToLiveClient(
        makeNotification('agy-sess-1', {
          sessionUpdate: 'tool_call',
          toolCallId: 'sched-1',
          name: 'schedule',
          status: 'in_progress',
          title: 'schedule',
        })
      );
      return { stopReason: 'end_turn' };
    });

    await expect(
      harness.client.prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'Run work' }])
    ).resolves.toEqual({ stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.client.getNativeWork()).toBeNull();
    expect(harness.client.hasUnsettledNativeWork()).toBe(false);
    expect(harness.workChanges).toEqual([]);
    expect(mockState.listSessions).not.toHaveBeenCalled();
    expect(mockState.loadSession).not.toHaveBeenCalled();
  });

  it('honors authoritative Core sessionActivity if an Antigravity server advertises it', async () => {
    mockState.initialize.mockResolvedValueOnce(
      defaultInitResponse({
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { load: {}, list: {}, resume: {}, close: {} },
          _meta: { lody: { sessionActivity: { version: 1 } } },
        },
      })
    );
    const harness = createHarness();
    await harness.client.startSession({} as never, '/synthetic/project');
    expect(harness.client.reportsSessionActivity()).toBe(true);

    await mockState.client?.extNotification?.('_lody/session/activity_update', {
      version: 1,
      sessionId: 'agy-sess-1',
      state: 'idle',
      backgroundTaskCount: 1,
    });
    expect(harness.client.getNativeWork()).toBe('background');
    expect(harness.client.hasUnsettledNativeWork()).toBe(true);

    await mockState.client?.extNotification?.('_lody/session/activity_update', {
      version: 1,
      sessionId: 'agy-sess-1',
      state: 'idle',
      backgroundTaskCount: 0,
    });
    expect(harness.client.getNativeWork()).toBeNull();
    expect(harness.client.hasUnsettledNativeWork()).toBe(false);
    expect(harness.workChanges).toEqual(['background', null]);
  });

  it('negotiates the realpath of a symlinked workdir with Antigravity only', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-agy-symlink-test-'));
    const realTarget = path.join(tempRoot, 'real-ws');
    const symlinkWs = path.join(tempRoot, 'symlink-ws');
    fs.mkdirSync(realTarget, { recursive: true });
    fs.symlinkSync(realTarget, symlinkWs);
    const canonicalWs = fs.realpathSync(symlinkWs);
    const cwds: string[] = [];
    mockState.newSession.mockImplementation(async (params: { cwd: string }) => {
      cwds.push(params.cwd);
      return { sessionId: 'agy-sess-1' };
    });

    try {
      const agy = createHarness();
      await agy.client.startSession({} as never, symlinkWs);
      expect(cwds[0]).toBe(canonicalWs);

      await createHarness().client.startSession({} as never, '/synthetic/does-not-exist');
      expect(cwds[1]).toBe('/synthetic/does-not-exist');

      mockState.initialize.mockResolvedValueOnce(
        defaultInitResponse({ agentInfo: { name: 'Other ACP Server', version: '1.0.0' } })
      );
      const other = createHarness({ agentConfig: { cliType: 'builtin', agentType: 'claude' } });
      await other.client.startSession({} as never, symlinkWs);
      expect(cwds[2]).toBe(symlinkWs);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
