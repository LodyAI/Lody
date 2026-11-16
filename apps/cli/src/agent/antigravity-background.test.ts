import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import type {
  ACPSessionId,
  AcpSessionNotification,
  SessionHistoryInput,
  SessionId,
} from '@lody/shared';
import { applyNotificationOnHistory } from '@lody/shared';
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
import {
  DEFAULT_ANTIGRAVITY_POLL_TIMINGS,
  ORPHANED_POST_TURN_PERMISSION_MESSAGE,
  type AntigravityPollTimings,
} from './antigravity-background';
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
    child: () => createSilentLogger(),
    close: async () => {},
  };
}

function makeUserEntry(id: string, text: string, nowMs: number): SessionHistoryInput {
  return {
    id,
    role: 'user',
    items: [{ type: 'text', text }] as unknown as SessionHistoryInput['items'],
    timestamp: new Date(nowMs).toISOString(),
    status: 'handled',
    read: true,
    finished: true,
    fileDiff: [],
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

function emitToLiveClient(notification: acp.SessionNotification): Promise<void> {
  if (!mockState.client) throw new Error('ACP client not connected');
  return mockState.client.sessionUpdate(notification);
}

function createHarness(options?: {
  agentConfig?: { cliType: 'builtin' | 'custom' | 'registry'; agentType: string; name?: string };
  timings?: Partial<AntigravityPollTimings>;
}) {
  const updates: AcpSessionNotification[] = [];
  const workChanges: NativeAgentWork[] = [];
  const usageUpdates: unknown[] = [];
  const permissionRequests: unknown[] = [];

  const client = new AgentClient({
    sessionId: 'ag-test-session' as SessionId,
    logger: createSilentLogger(),
    terminalManager: {} as never,
    agentConfig: options?.agentConfig ?? { cliType: 'builtin', agentType: 'antigravity' },
    antigravityPollTimings: {
      settleQuietMs: 4_000,
      failedWakeupToolGraceMs: 8_000,
      ...options?.timings,
    },
    onUpdateMessage: (msg) => {
      updates.push(msg);
    },
    onNativeWorkChanged: (work) => {
      workChanges.push(work);
    },
    onUsageUpdate: (usage) => {
      usageUpdates.push(usage);
    },
    onRequestPermission: async (_requestId, params) => {
      permissionRequests.push(params);
      return { outcome: { outcome: 'cancelled' } };
    },
  });

  return { client, updates, workChanges, usageUpdates, permissionRequests };
}

function defaultInitResponse(overrides?: Record<string, unknown>): acp.InitializeResponse {
  return {
    protocolVersion: 1,
    agentInfo: { name: 'Antigravity ACP Server', version: '1.5.9' },
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

describe('Antigravity ACP v1 background lifecycle and GC protection', () => {
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
    expect(builtin.client.reportsSessionActivity()).toBe(true);
    expect(builtin.client.getNativeActivityObservation()).toBe('idle');

    const customModern = createHarness({
      agentConfig: { cliType: 'custom', agentType: 'my-agy' },
    });
    await customModern.client.startSession({} as never, '/synthetic/project');
    expect(customModern.client.reportsSessionActivity()).toBe(true);
    expect(customModern.client.getNativeActivityObservation()).toBe('idle');

    // Tool normalization (`update.name` -> `_meta.lody.toolName`), elicitation bridge, and prompt usage all work on custom modern server.
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

    // Legacy `antigravity-acp` (1.4.5) must stay completely untouched.
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

  it('holds non-daemon background run_command across same-second collision, deduplicates multi-turn history, and settles after wakeup', async () => {
    const harness = createHarness();
    let currentUpdatedAt = '2026-01-01T00:00:00Z';
    let snapshot: acp.SessionNotification[] = [];

    mockState.listSessions.mockImplementation(async () => ({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: currentUpdatedAt },
      ],
    }));
    mockState.loadSession.mockImplementation(async () => {
      for (const item of snapshot) {
        await emitToLiveClient(item);
      }
      return {};
    });

    await harness.client.startSession({} as never, '/synthetic/project');

    // Turn 1: foreground tool completes normally with zero background polling.
    const turn1User = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Check version' },
    });
    const turn1Tool = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-t1',
      name: 'run_command',
      status: 'completed',
      title: 'Check node version',
      rawInput: { CommandLine: 'node -v', IsDaemon: false, WaitMsBeforeAsync: 5000 },
      rawOutput: { ExitCode: 0, Stdout: 'v22.0.0' },
    });
    const turn1Text = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Node v22 is installed.' },
    });

    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(turn1Tool);
      await emitToLiveClient(turn1Text);
      return { stopReason: 'end_turn' };
    });

    let history: SessionHistoryInput[] = [makeUserEntry('user-1', 'Check version', Date.now())];
    await harness.client.prompt('agy-sess-1' as ACPSessionId, [
      { type: 'text', text: 'Check version' },
    ]);
    history = applyNotificationOnHistory(history, harness.updates.splice(0), undefined, {
      createId: () => 'gen-1',
      now: () => new Date().toISOString(),
    });
    history = history.map((e) => (e.role === 'assistant' ? { ...e, finished: true } : e));
    expect(mockState.listSessions).not.toHaveBeenCalled();
    expect(mockState.loadSession).not.toHaveBeenCalled();

    // Turn 2: run_command stays in_progress when end_turn arrives.
    const turn2User = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Run suite' },
    });
    const turn2PreText = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Running suite...' },
    });
    const turn2ToolInProgress = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-t2',
      name: 'run_command',
      status: 'in_progress',
      title: 'Run pnpm test',
      rawInput: { CommandLine: 'pnpm test', IsDaemon: false, WaitMsBeforeAsync: 5000 },
    });

    snapshot = [turn1User, turn1Tool, turn1Text, turn2ToolInProgress, turn2User, turn2PreText];
    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(turn2PreText);
      await emitToLiveClient(turn2ToolInProgress);
      return { stopReason: 'end_turn' };
    });

    let turn2Settled = false;
    history.push(makeUserEntry('user-2', 'Run suite', Date.now()));
    const turn2Promise = harness.client
      .prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'Run suite' }])
      .then((res) => {
        turn2Settled = true;
        return res;
      });

    // Advance past sameSecondLoadCheckMs (6s) while updatedAt hasn't changed yet.
    await vi.advanceTimersByTimeAsync(6_500);
    expect(mockState.loadSession).toHaveBeenCalledTimes(1);
    expect(turn2Settled).toBe(false);
    // Live pre-end_turn updates only (2 notifications); no duplicates from same-second check or Turn 1!
    expect(harness.updates).toHaveLength(2);

    // Background command finishes and planner appends wakeup message + updated usage + title.
    currentUpdatedAt = '2026-01-01T00:00:08Z';
    const turn2ToolDone = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-t2',
      name: 'run_command',
      status: 'completed',
      title: 'Run pnpm test',
      rawInput: { CommandLine: 'pnpm test', IsDaemon: false, WaitMsBeforeAsync: 5000 },
      rawOutput: { ExitCode: 0, Stdout: '42 passed' },
      content: [{ type: 'content', content: { type: 'text', text: '42 passed' } }],
    });
    const turn2WakeupText1 = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'All 42 tests ' },
    });
    const turn2WakeupText2 = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'passed.' },
    });
    const turn2Usage = makeNotification('agy-sess-1', {
      sessionUpdate: 'usage_update',
      used: 4200,
      size: 1_000_000,
    });
    const turn2Info = makeNotification('agy-sess-1', {
      sessionUpdate: 'session_info_update',
      title: 'Should be suppressed from replay',
    });
    snapshot = [
      turn1User,
      turn1Tool,
      turn1Text,
      turn2User,
      turn2PreText,
      turn2ToolDone,
      turn2WakeupText1,
      turn2WakeupText2,
      turn2Usage,
      turn2Info,
    ];

    await vi.advanceTimersByTimeAsync(2_000);
    expect(turn2Settled).toBe(false); // Waiting settleQuietMs (4s)

    await vi.advanceTimersByTimeAsync(4_500);
    const turn2Result = await turn2Promise;
    expect(turn2Result).toEqual({ stopReason: 'end_turn' });
    expect(turn2Settled).toBe(true);

    // Apply all emitted Turn 2 updates to history and verify strict ordering & zero duplication.
    let genCounter = 2;
    history = applyNotificationOnHistory(history, harness.updates, undefined, {
      createId: () => `gen-${genCounter++}`,
      now: () => new Date().toISOString(),
    });

    expect(history).toHaveLength(4);
    expect(history[1]?.items).toEqual([
      expect.objectContaining({ type: 'tool_call', toolCallId: 'cmd-t1', status: 'completed' }),
      expect.objectContaining({ type: 'text', text: 'Node v22 is installed.' }),
    ]);
    expect(history[3]?.items).toEqual([
      expect.objectContaining({ type: 'text', text: 'Running suite...' }),
      expect.objectContaining({
        type: 'tool_call',
        toolCallId: 'cmd-t2',
        toolName: 'run_command',
        status: 'completed',
      }),
      expect.objectContaining({ type: 'text', text: 'All 42 tests passed.' }),
    ]);
  });

  it('continues holding across chained wakeup run_command and settles after failed wakeup tool in default mode', async () => {
    const harness = createHarness();
    let currentUpdatedAt = '2026-01-01T00:00:00Z';
    let snapshot: acp.SessionNotification[] = [];

    mockState.listSessions.mockImplementation(async () => ({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: currentUpdatedAt },
      ],
    }));
    mockState.loadSession.mockImplementation(async () => {
      for (const item of snapshot) {
        await emitToLiveClient(item);
      }
      return {};
    });

    await harness.client.startSession({} as never, '/synthetic/project');

    const userMsg = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Build and verify' },
    });
    const text1 = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Step 1 building.' },
    });
    const tool1Pending = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-chain-1',
      name: 'run_command',
      status: 'in_progress',
      title: 'Run pnpm build',
      rawInput: { CommandLine: 'pnpm build', IsDaemon: false },
    });

    snapshot = [userMsg, text1, tool1Pending];
    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(text1);
      await emitToLiveClient(tool1Pending);
      return { stopReason: 'end_turn' };
    });

    let chainedDone = false;
    const chainedPromise = harness.client
      .prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'Build and verify' }])
      .then((res) => {
        chainedDone = true;
        return res;
      });

    // Let end_turn settle and Iteration 1 capture baseline updatedAt before Wakeup 1 arrives.
    await vi.advanceTimersByTimeAsync(500);

    // Wakeup 1 finishes cmd-chain-1 and starts cmd-chain-2 (in_progress).
    const tool1Done = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-chain-1',
      name: 'run_command',
      status: 'completed',
      title: 'Run pnpm build',
      rawInput: { CommandLine: 'pnpm build', IsDaemon: false },
      rawOutput: { ExitCode: 0 },
    });
    const text2 = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Step 2 testing.' },
    });
    const tool2Pending = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-chain-2',
      name: 'run_command',
      status: 'in_progress',
      title: 'Run pnpm test',
      rawInput: { CommandLine: 'pnpm test', IsDaemon: false },
    });
    snapshot = [userMsg, text1, tool1Done, text2, tool2Pending];
    currentUpdatedAt = '2026-01-01T00:00:02Z';

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(6_000);
    // Must still be holding while cmd-chain-2 is in_progress even after >4s quiet!
    expect(chainedDone).toBe(false);

    // Wakeup 2 completes cmd-chain-2 and writes text3.
    const tool2Done = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-chain-2',
      name: 'run_command',
      status: 'completed',
      title: 'Run pnpm test',
      rawInput: { CommandLine: 'pnpm test', IsDaemon: false },
      rawOutput: { ExitCode: 0 },
    });
    const text3 = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Build and tests done.' },
    });
    snapshot = [userMsg, text1, tool1Done, text2, tool2Done, text3];
    currentUpdatedAt = '2026-01-01T00:00:10Z';

    await vi.advanceTimersByTimeAsync(7_000);
    await chainedPromise;
    expect(chainedDone).toBe(true);

    let seq = 1;
    const chainedHistory = applyNotificationOnHistory(
      [makeUserEntry('u-chain', 'Build and verify', Date.now())],
      harness.updates.splice(0),
      undefined,
      { createId: () => `c-${seq++}`, now: () => new Date().toISOString() }
    );
    expect(chainedHistory[1]?.items).toEqual([
      expect.objectContaining({ type: 'text', text: 'Step 1 building.' }),
      expect.objectContaining({
        type: 'tool_call',
        toolCallId: 'cmd-chain-1',
        status: 'completed',
      }),
      expect.objectContaining({ type: 'text', text: 'Step 2 testing.' }),
      expect.objectContaining({
        type: 'tool_call',
        toolCallId: 'cmd-chain-2',
        status: 'completed',
      }),
      expect.objectContaining({ type: 'text', text: 'Build and tests done.' }),
    ]);

    // Turn 2: wakeup emits a failed tool call without follow-up text (default-mode approval block).
    const failUser = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Edit after command' },
    });
    const failCmdPending = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-fail-1',
      name: 'run_command',
      status: 'in_progress',
      title: 'Run sleep 2',
      rawInput: { CommandLine: 'sleep 2', IsDaemon: false },
    });
    snapshot = [failUser, failCmdPending];
    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(failCmdPending);
      return { stopReason: 'end_turn' };
    });

    let failedSettled = false;
    const failTurnPromise = harness.client
      .prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'Edit after command' }])
      .then((res) => {
        failedSettled = true;
        return res;
      });

    // Let end_turn settle and Iteration 1 capture baseline updatedAt before failed tool wakeup arrives.
    await vi.advanceTimersByTimeAsync(500);

    const failCmdDone = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-fail-1',
      name: 'run_command',
      status: 'completed',
      title: 'Run sleep 2',
      rawInput: { CommandLine: 'sleep 2', IsDaemon: false },
      rawOutput: { ExitCode: 0 },
    });
    const blockedWrite = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'write-blocked-1',
      name: 'write_file',
      status: 'failed',
      title: 'Write blocked file',
      rawOutput: { error: 'Approval denied in default mode' },
    });
    snapshot = [failUser, failCmdDone, blockedWrite];
    currentUpdatedAt = '2026-01-01T00:00:25Z';

    await vi.advanceTimersByTimeAsync(2_000);
    // Still inside failedWakeupToolGraceMs (8s) at t+6.5s
    await vi.advanceTimersByTimeAsync(4_500);
    expect(failedSettled).toBe(false);
    // Settles after 8s failedWakeupToolGraceMs without hanging 90s
    await vi.advanceTimersByTimeAsync(4_500);
    await failTurnPromise;
    expect(failedSettled).toBe(true);
    expect(
      harness.updates.some(
        (u) => (u.update as { toolCallId?: string }).toolCallId === 'write-blocked-1'
      )
    ).toBe(true);
  });

  it('aborts Tier 1 hold immediately on Stop abortSignal and invokes cancel', async () => {
    const harness = createHarness();
    // Hang loadSession indefinitely on a second call to confirm instant abort even mid-RPC.
    let loadCount = 0;
    mockState.listSessions.mockResolvedValue({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: '2026-01-01T00:00:00Z' },
      ],
    });
    mockState.loadSession.mockImplementation(async () => {
      loadCount += 1;
      if (loadCount >= 1) {
        return await new Promise(() => {});
      }
      return {};
    });

    await harness.client.startSession({} as never, '/synthetic/project');

    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(
        makeNotification('agy-sess-1', {
          sessionUpdate: 'tool_call',
          toolCallId: 'cmd-abort-1',
          name: 'run_command',
          status: 'in_progress',
          title: 'Run sleep 60',
          rawInput: { CommandLine: 'sleep 60', IsDaemon: false },
        })
      );
      return { stopReason: 'end_turn' };
    });

    const controller = new AbortController();
    const promptPromise = harness.client.prompt(
      'agy-sess-1' as ACPSessionId,
      [{ type: 'text', text: 'Run long build' }],
      { signal: controller.signal }
    );
    const rejected = expect(promptPromise).rejects.toThrow('Agent prompt aborted');

    await vi.advanceTimersByTimeAsync(6_500);
    controller.abort();
    await rejected;

    expect(mockState.cancel).toHaveBeenCalledWith({ sessionId: 'agy-sess-1' });
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('excludes IsDaemon: true commands and daemon schedules from Tier 1 holds and Tier 2 tracking', async () => {
    const harness = createHarness();
    await harness.client.startSession({} as never, '/synthetic/project');

    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(
        makeNotification('agy-sess-1', {
          sessionUpdate: 'tool_call',
          toolCallId: 'daemon-cmd-1',
          name: 'run_command',
          status: 'in_progress',
          title: 'Start vite dev server',
          rawInput: { CommandLine: 'vite dev', IsDaemon: true, WaitMsBeforeAsync: 500 },
        })
      );
      await emitToLiveClient(
        makeNotification('agy-sess-1', {
          sessionUpdate: 'tool_call',
          toolCallId: 'daemon-cron-1',
          name: 'schedule',
          status: 'completed',
          title: 'Schedule daemon ping',
          rawInput: { CronExpression: '*/5 * * * *', IsDaemon: true, Prompt: 'Daemon ping' },
        })
      );
      return { stopReason: 'end_turn' };
    });

    const res = await harness.client.prompt('agy-sess-1' as ACPSessionId, [
      { type: 'text', text: 'Start dev server' },
    ]);
    expect(res).toEqual({ stopReason: 'end_turn' });
    expect(harness.client.getNativeWork()).toBeNull();
    expect(harness.workChanges).toEqual([]); // Never transitions to 'background' or 'running'
    expect(mockState.listSessions).not.toHaveBeenCalled();
  });

  it('holds invoke_subagent until wakeup with paragraph break, and skips hold when manage_subagents kill_all ran', async () => {
    const harness = createHarness();
    let currentUpdatedAt = '2026-01-01T00:00:00Z';
    let snapshot: acp.SessionNotification[] = [];

    mockState.listSessions.mockImplementation(async () => ({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: currentUpdatedAt },
      ],
    }));
    mockState.loadSession.mockImplementation(async () => {
      for (const item of snapshot) {
        await emitToLiveClient(item);
      }
      return {};
    });

    await harness.client.startSession({} as never, '/synthetic/project');

    const userMsg = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Delegate work' },
    });
    const subTool = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'sub-1',
      name: 'invoke_subagent',
      status: 'completed',
      title: 'Invoke research subagent',
      rawInput: { Prompt: 'Inspect docs', Role: 'Researcher', TypeName: 'research' },
    });
    const preText = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Launched subagent.' },
    });

    snapshot = [userMsg, subTool, preText];
    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(subTool);
      await emitToLiveClient(preText);
      return { stopReason: 'end_turn' };
    });

    let subTurnDone = false;
    const subTurnPromise = harness.client
      .prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'Delegate work' }])
      .then((res) => {
        subTurnDone = true;
        return res;
      });

    await vi.advanceTimersByTimeAsync(6_500);
    expect(subTurnDone).toBe(false);

    // Subagent wakeup text arrives in multiple chunks after text that lacked a trailing newline.
    const wakeupText1 = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Subagent reported ' },
    });
    const wakeupText2 = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'findings.' },
    });
    snapshot = [userMsg, subTool, preText, wakeupText1, wakeupText2];
    currentUpdatedAt = '2026-01-01T00:00:08Z';

    await vi.advanceTimersByTimeAsync(7_000);
    await subTurnPromise;
    expect(subTurnDone).toBe(true);

    let seq = 1;
    const subHistory = applyNotificationOnHistory(
      [makeUserEntry('u-sub', 'Delegate work', Date.now())],
      harness.updates.splice(0),
      undefined,
      { createId: () => `s-${seq++}`, now: () => new Date().toISOString() }
    );
    expect(subHistory[1]?.items).toEqual([
      expect.objectContaining({ type: 'tool_call', toolCallId: 'sub-1', status: 'completed' }),
      expect.objectContaining({
        type: 'text',
        text: 'Launched subagent.\n\nSubagent reported findings.',
      }),
    ]);

    // If kill_all ran in the same turn, client.prompt() settles immediately without polling.
    const listCallsBefore = mockState.listSessions.mock.calls.length;
    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(
        makeNotification('agy-sess-1', {
          sessionUpdate: 'tool_call',
          toolCallId: 'sub-2',
          name: 'invoke_subagent',
          status: 'completed',
          title: 'Invoke secondary subagent',
        })
      );
      await emitToLiveClient(
        makeNotification('agy-sess-1', {
          sessionUpdate: 'tool_call',
          toolCallId: 'kill-sub-2',
          name: 'manage_subagents',
          status: 'completed',
          title: 'Kill all subagents',
          rawInput: { Action: 'kill_all' },
        })
      );
      return { stopReason: 'end_turn' };
    });

    await expect(
      harness.client.prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'Cancel subs' }])
    ).resolves.toEqual({ stopReason: 'end_turn' });
    expect(mockState.listSessions.mock.calls.length).toBe(listCallsBefore);
  });

  it('tracks Tier 2 non-daemon schedule, promotes 30m hold to background, and drains before next user prompt', async () => {
    const harness = createHarness();
    let currentUpdatedAt = '2026-01-01T00:00:00Z';
    let snapshot: acp.SessionNotification[] = [];

    mockState.listSessions.mockImplementation(async () => ({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: currentUpdatedAt },
      ],
    }));
    mockState.loadSession.mockImplementation(async () => {
      for (const item of snapshot) {
        await emitToLiveClient(item);
      }
      return {};
    });

    await harness.client.startSession({} as never, '/synthetic/project');

    const schedUser = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Remind me in 60s' },
    });
    const schedTool = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'sched-1',
      name: 'schedule',
      status: 'in_progress',
      title: 'Schedule 60s reminder',
      rawInput: { DurationSeconds: 60, IsDaemon: false, Prompt: 'Check build status' },
    });
    snapshot = [schedUser, schedTool];

    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(schedTool);
      return { stopReason: 'end_turn' };
    });

    const schedRes = await harness.client.prompt('agy-sess-1' as ACPSessionId, [
      { type: 'text', text: 'Remind me in 60s' },
    ]);
    expect(schedRes).toEqual({ stopReason: 'end_turn' });
    // Published BEFORE client.prompt() resolved!
    expect(harness.workChanges).toEqual(['background']);
    expect(harness.client.getNativeWork()).toBe('background');
    expect(harness.client.getNativeActivityObservation()).toBe('background');

    // Wait 60s while baseline updatedAt is captured and timer is armed, then timer fires.
    await vi.advanceTimersByTimeAsync(60_000);
    const schedToolDone = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'sched-1',
      name: 'schedule',
      status: 'completed',
      title: 'Schedule 60s reminder',
      rawInput: { DurationSeconds: 60, IsDaemon: false, Prompt: 'Check build status' },
    });
    const schedWakeup = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '60s reminder fired: build is green.' },
    });
    snapshot = [schedUser, schedToolDone, schedWakeup];
    currentUpdatedAt = '2026-01-01T00:01:00Z';

    await vi.advanceTimersByTimeAsync(2_500);
    // During drain (< settleQuietMs), native work temporarily reports 'running'.
    expect(harness.workChanges).toContain('running');
    expect(
      harness.updates.some(
        (u) =>
          u.update.sessionUpdate === 'agent_message_chunk' &&
          u.update.content.type === 'text' &&
          u.update.content.text.includes('60s reminder fired')
      )
    ).toBe(true);

    // After settleQuietMs (4s), Tier 2 returns native work to null (idle).
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.client.getNativeWork()).toBeNull();
    expect(harness.workChanges[harness.workChanges.length - 1]).toBeNull();

    // Handoff at promptHoldMaxMs (30m) + drain on next user prompt
    const longUser = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Run long migration' },
    });
    const longCmd = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-long-1',
      name: 'run_command',
      status: 'in_progress',
      title: 'Run heavy migration',
      rawInput: { CommandLine: 'pnpm migrate-heavy', IsDaemon: false },
    });
    snapshot = [longUser, longCmd];
    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(longCmd);
      return { stopReason: 'end_turn' };
    });

    const longTurnPromise = harness.client.prompt('agy-sess-1' as ACPSessionId, [
      { type: 'text', text: 'Run long migration' },
    ]);
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 2_000);
    await expect(longTurnPromise).resolves.toEqual({ stopReason: 'end_turn' });
    expect(harness.client.getNativeWork()).toBe('background');

    // Sending a new user prompt while Tier 2 monitor is active drains it cleanly first.
    const listCountAtNewPrompt = mockState.listSessions.mock.calls.length;
    mockState.prompt.mockImplementationOnce(async () => {
      expect(harness.client.getNativeWork()).toBeNull();
      return { stopReason: 'end_turn' };
    });
    await expect(
      harness.client.prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'Status?' }])
    ).resolves.toEqual({ stopReason: 'end_turn' });
    expect(harness.client.getNativeWork()).toBeNull();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockState.listSessions.mock.calls.length).toBe(listCountAtNewPrompt);
  });

  it('recovers transient loadSession failures without losing updatedAt and stops cleanly after maxConsecutiveFailures', async () => {
    const harness = createHarness();
    let currentUpdatedAt = '2026-01-01T00:00:00Z';
    let loadCallCount = 0;

    mockState.listSessions.mockImplementation(async () => ({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: currentUpdatedAt },
      ],
    }));

    const schedUser = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Run transient test' },
    });
    const schedTool = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'sched-retry-1',
      name: 'schedule',
      status: 'completed',
      title: 'Schedule transient recovery timer',
      rawInput: { DurationSeconds: 10, IsDaemon: false },
    });
    const schedWakeup = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Recovered wakeup message.' },
    });

    let snapshot: acp.SessionNotification[] = [schedUser, schedTool];
    let failNextLoad = false;

    mockState.loadSession.mockImplementation(async () => {
      loadCallCount += 1;
      if (failNextLoad) {
        failNextLoad = false;
        throw new Error('Transient loadSession glitch');
      }
      for (const n of snapshot) {
        await emitToLiveClient(n);
      }
      return {};
    });

    await harness.client.startSession({} as never, '/synthetic/project');
    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(schedTool);
      return { stopReason: 'end_turn' };
    });
    await harness.client.prompt('agy-sess-1' as ACPSessionId, [
      { type: 'text', text: 'Run transient test' },
    ]);

    await vi.advanceTimersByTimeAsync(10_000);
    snapshot = [schedUser, schedTool, schedWakeup];
    currentUpdatedAt = '2026-01-01T00:00:10Z';
    failNextLoad = true;
    await vi.advanceTimersByTimeAsync(9_000);
    // Transient failure retried on next poll without losing updatedAt and delivered wakeup delta!
    expect(loadCallCount).toBeGreaterThanOrEqual(2);
    expect(
      harness.updates.some(
        (u) =>
          u.update.sessionUpdate === 'agent_message_chunk' &&
          u.update.content.type === 'text' &&
          u.update.content.text === 'Recovered wakeup message.'
      )
    ).toBe(true);
    expect(harness.client.getNativeWork()).toBeNull();

    // Persistent loadSession failures hit maxConsecutiveFailures (5) even if listSessions keeps succeeding.
    mockState.loadSession.mockRejectedValue(new Error('Persistent load failure'));
    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(
        makeNotification('agy-sess-1', {
          sessionUpdate: 'tool_call',
          toolCallId: 'sched-perm-fail',
          name: 'schedule',
          status: 'completed',
          title: 'Schedule persistent failure test',
          rawInput: { DurationSeconds: 10, IsDaemon: false },
        })
      );
      return { stopReason: 'end_turn' };
    });
    await harness.client.prompt('agy-sess-1' as ACPSessionId, [
      { type: 'text', text: 'Persistent error case' },
    ]);
    expect(harness.client.getNativeWork()).toBe('background');

    await vi.advanceTimersByTimeAsync(500);
    const failCallsStart = mockState.loadSession.mock.calls.length;
    currentUpdatedAt = '2026-01-01T00:00:30Z';
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockState.loadSession.mock.calls.length - failCallsStart).toBe(5);
    expect(harness.client.getNativeWork()).toBeNull();

    // Subsequent normal prompt works cleanly after bounded exit.
    mockState.prompt.mockResolvedValueOnce({ stopReason: 'end_turn' });
    await expect(
      harness.client.prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'Still healthy' }])
    ).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('seeds baseline from resumed session loadSession replay so historical tool calls never duplicate or hold', async () => {
    const harness = createHarness();
    let currentUpdatedAt = '2026-01-01T00:00:00Z';

    const histUser = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Previous turn' },
    });
    const histInterruptedCmd = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'hist-cmd-1',
      name: 'run_command',
      status: 'in_progress',
      title: 'Interrupted historical command',
      rawInput: { CommandLine: 'sleep 100', IsDaemon: false },
    });
    const histText = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Earlier session output.' },
    });

    let snapshot: acp.SessionNotification[] = [histUser, histInterruptedCmd, histText];

    mockState.listSessions.mockImplementation(async () => ({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: currentUpdatedAt },
      ],
    }));
    mockState.loadSession.mockImplementation(async () => {
      for (const item of snapshot) {
        await emitToLiveClient(item);
      }
      return {};
    });

    // Resumed startup replays historical notifications (including an old in_progress command).
    await harness.client.startSession(
      {} as never,
      '/synthetic/project',
      'agy-sess-1' as ACPSessionId
    );
    harness.updates.splice(0);

    // New turn after resume starts its own foreground command that stays in_progress at end_turn.
    const newUser = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Continue after resume' },
    });
    const newCmdPending = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'new-cmd-2',
      name: 'run_command',
      status: 'in_progress',
      title: 'Run post-resume check',
      rawInput: { CommandLine: 'pnpm lint', IsDaemon: false },
    });
    snapshot = [histUser, histInterruptedCmd, histText, newUser, newCmdPending];
    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(newCmdPending);
      return { stopReason: 'end_turn' };
    });

    const newTurnPromise = harness.client.prompt('agy-sess-1' as ACPSessionId, [
      { type: 'text', text: 'Continue after resume' },
    ]);

    await vi.advanceTimersByTimeAsync(500);
    const newCmdDone = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'new-cmd-2',
      name: 'run_command',
      status: 'completed',
      title: 'Run post-resume check',
      rawInput: { CommandLine: 'pnpm lint', IsDaemon: false },
      rawOutput: { ExitCode: 0 },
    });
    const newWakeupText = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Post-resume lint passed.' },
    });
    snapshot = [histUser, histInterruptedCmd, histText, newUser, newCmdDone, newWakeupText];
    currentUpdatedAt = '2026-01-01T00:00:05Z';

    await vi.advanceTimersByTimeAsync(6_500);
    await expect(newTurnPromise).resolves.toEqual({ stopReason: 'end_turn' });

    const emittedIds = harness.updates
      .map((u) => (u.update as { toolCallId?: string }).toolCallId)
      .filter((id): id is string => typeof id === 'string');
    expect(emittedIds).not.toContain('hist-cmd-1');
    expect(emittedIds).toEqual(['new-cmd-2', 'new-cmd-2']);

    const emittedTexts = harness.updates
      .filter((u) => u.update.sessionUpdate === 'agent_message_chunk')
      .map((u) => (u.update.content.type === 'text' ? u.update.content.text : ''));
    expect(emittedTexts).toEqual(['Post-resume lint passed.']);
  });

  it('holds 25s default quiet grace across slow wakeup thinking and any active non-command tool', async () => {
    const harness = createHarness({ timings: DEFAULT_ANTIGRAVITY_POLL_TIMINGS });
    let currentUpdatedAt = '2026-01-01T00:00:00Z';
    let snapshot: acp.SessionNotification[] = [];

    mockState.listSessions.mockImplementation(async () => ({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: currentUpdatedAt },
      ],
    }));
    mockState.loadSession.mockImplementation(async () => {
      for (const item of snapshot) {
        await emitToLiveClient(item);
      }
      return {};
    });

    await harness.client.startSession({} as never, '/synthetic/project');

    const userMsg = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Run scripts and summarize' },
    });
    const cmdPending = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-slow-1',
      name: 'run_command',
      status: 'in_progress',
      title: 'Run long script',
      rawInput: { CommandLine: 'sleep 2', IsDaemon: false },
    });
    snapshot = [userMsg, cmdPending];
    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(cmdPending);
      return { stopReason: 'end_turn' };
    });

    let settled = false;
    const promptPromise = harness.client
      .prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'Run scripts and summarize' }])
      .then((res) => {
        settled = true;
        return res;
      });

    await vi.advanceTimersByTimeAsync(500);

    // Wakeup runs a non-command `search_web` tool (`in_progress`) for 20s, then takes 12s thinking before writing summary.
    const cmdDone = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-slow-1',
      name: 'run_command',
      status: 'completed',
      title: 'Run long script',
      rawInput: { CommandLine: 'sleep 2', IsDaemon: false },
      rawOutput: { ExitCode: 0 },
    });
    const searchPending = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'search-slow-1',
      name: 'search_web',
      status: 'in_progress',
      title: 'Search docs',
      rawInput: { query: 'acp lifecycle' },
    });
    snapshot = [userMsg, cmdDone, searchPending];
    currentUpdatedAt = '2026-01-01T00:00:02Z';

    await vi.advanceTimersByTimeAsync(20_000);
    // Must still hold because search_web is in_progress (even though it is not run_command)!
    expect(settled).toBe(false);

    const searchDone = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'search-slow-1',
      name: 'search_web',
      status: 'completed',
      title: 'Search docs',
      rawOutput: { results: ['ok'] },
    });
    snapshot = [userMsg, cmdDone, searchDone];
    currentUpdatedAt = '2026-01-01T00:00:22Z';

    // 12 seconds of silent model thinking after search_web completes (< 25s settleQuietMs) must NOT cut off!
    await vi.advanceTimersByTimeAsync(12_000);
    expect(settled).toBe(false);

    const summaryText = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Final summary after slow thinking.' },
    });
    snapshot = [userMsg, cmdDone, searchDone, summaryText];
    currentUpdatedAt = '2026-01-01T00:00:34Z';

    // Must settle once >=25s quiet passes after the final summary chunk.
    await vi.advanceTimersByTimeAsync(28_000);
    await expect(promptPromise).resolves.toEqual({ stopReason: 'end_turn' });
    expect(settled).toBe(true);
    expect(
      harness.updates.some(
        (u) =>
          u.update.sessionUpdate === 'agent_message_chunk' &&
          u.update.content.type === 'text' &&
          u.update.content.text === 'Final summary after slow thinking.'
      )
    ).toBe(true);
  });

  it('holds on send_message and hands coalesced 2x invoke_subagent wakeups to Tier 2 after quiet grace', async () => {
    const harness = createHarness();
    let currentUpdatedAt = '2026-01-01T00:00:00Z';
    let snapshot: acp.SessionNotification[] = [];

    mockState.listSessions.mockImplementation(async () => ({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: currentUpdatedAt },
      ],
    }));
    mockState.loadSession.mockImplementation(async () => {
      for (const item of snapshot) {
        await emitToLiveClient(item);
      }
      return {};
    });

    await harness.client.startSession({} as never, '/synthetic/project');

    // Part A: send_message holds Tier 1 until subagent wakeup arrives.
    const msgUser = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Follow up with existing subagent' },
    });
    const sendTool = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'send-1',
      name: 'send_message',
      status: 'completed',
      title: 'Send message to subagent',
      rawInput: { Recipient: 'sub-conv-1', Message: 'Status update?' },
    });
    snapshot = [msgUser, sendTool];
    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(sendTool);
      return { stopReason: 'end_turn' };
    });

    let sendSettled = false;
    const sendPromise = harness.client
      .prompt('agy-sess-1' as ACPSessionId, [
        { type: 'text', text: 'Follow up with existing subagent' },
      ])
      .then((res) => {
        sendSettled = true;
        return res;
      });
    await vi.advanceTimersByTimeAsync(6_500);
    expect(sendSettled).toBe(false);

    const sendReply = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Existing subagent answered.' },
    });
    snapshot = [msgUser, sendTool, sendReply];
    currentUpdatedAt = '2026-01-01T00:00:08Z';
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(sendPromise).resolves.toEqual({ stopReason: 'end_turn' });
    expect(
      harness.updates.some(
        (u) =>
          u.update.sessionUpdate === 'agent_message_chunk' &&
          u.update.content.type === 'text' &&
          u.update.content.text === 'Existing subagent answered.'
      )
    ).toBe(true);

    // Part B: 2x invoke_subagent coalesced into 1 wakeup unlocks Tier 1 to Tier 2 instead of locking 30m!
    const multiUser = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Run two subagents' },
    });
    const subA = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'sub-a',
      name: 'invoke_subagent',
      status: 'completed',
      title: 'Invoke subagent A',
    });
    const subB = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'sub-b',
      name: 'invoke_subagent',
      status: 'completed',
      title: 'Invoke subagent B',
    });
    snapshot = [multiUser, subA, subB];
    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(subA);
      await emitToLiveClient(subB);
      return { stopReason: 'end_turn' };
    });

    let multiSettled = false;
    const multiPromise = harness.client
      .prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'Run two subagents' }])
      .then((res) => {
        multiSettled = true;
        return res;
      });

    await vi.advanceTimersByTimeAsync(500);

    // Single coalesced wakeup reports first answer; pendingSubagents drops 2 -> 1.
    const wakeup1 = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'First wakeup report.' },
    });
    snapshot = [multiUser, subA, subB, wakeup1];
    currentUpdatedAt = '2026-01-01T00:00:16Z';

    await vi.advanceTimersByTimeAsync(8_000);
    await expect(multiPromise).resolves.toEqual({ stopReason: 'end_turn' });
    expect(multiSettled).toBe(true);
    // Unblocked Composer immediately after quiet grace while Tier 2 keeps protecting subagent B!
    expect(harness.client.getNativeWork()).toBe('background');

    // Late 2nd subagent wakeup still arrives via Tier 2 and returns session to idle.
    const wakeup2 = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Second late report.' },
    });
    snapshot = [multiUser, subA, subB, wakeup1, wakeup2];
    currentUpdatedAt = '2026-01-01T00:00:30Z';

    await vi.advanceTimersByTimeAsync(8_000);
    expect(harness.client.getNativeWork()).toBeNull();
    expect(
      harness.updates.some(
        (u) =>
          u.update.sessionUpdate === 'agent_message_chunk' &&
          u.update.content.type === 'text' &&
          u.update.content.text.includes('Second late report.')
      )
    ).toBe(true);
  });

  it('detects real background placeholder outputs for run_workflow without holding synchronous WaitMsBeforeAsync=0 runs', async () => {
    const harness = createHarness();
    let currentUpdatedAt = '2026-01-01T00:00:00Z';
    let snapshot: acp.SessionNotification[] = [];

    mockState.listSessions.mockImplementation(async () => ({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: currentUpdatedAt },
      ],
    }));
    mockState.loadSession.mockImplementation(async () => {
      for (const item of snapshot) {
        await emitToLiveClient(item);
      }
      return {};
    });

    await harness.client.startSession({} as never, '/synthetic/project');

    // Synchronous run_workflow with WaitMsBeforeAsync=0 that already returned real output must NOT hold.
    const syncListCalls = mockState.listSessions.mock.calls.length;
    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(
        makeNotification('agy-sess-1', {
          sessionUpdate: 'tool_call',
          toolCallId: 'wf-sync-1',
          name: 'run_workflow',
          status: 'completed',
          title: 'Run fast workflow',
          rawInput: { Script: 'return 1', WaitMsBeforeAsync: 0 },
          rawOutput: { result: 1 },
        })
      );
      return { stopReason: 'end_turn' };
    });
    await expect(
      harness.client.prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'Fast workflow' }])
    ).resolves.toEqual({ stopReason: 'end_turn' });
    expect(mockState.listSessions.mock.calls.length).toBe(syncListCalls);

    // run_workflow with WaitMsBeforeAsync=5000 returning placeholder output must hold until wakeup replaces it.
    const wfUser = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Run async workflow' },
    });
    const wfBg = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'wf-bg-1',
      name: 'run_workflow',
      status: 'completed',
      title: 'Run multi-stage workflow',
      rawInput: { Script: 'fanout()', WaitMsBeforeAsync: 5000 },
      rawOutput: {
        output: 'Tool is running as a background task with task id: sess/wf-9',
      },
    });
    snapshot = [wfUser, wfBg];
    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(wfBg);
      return { stopReason: 'end_turn' };
    });

    let wfSettled = false;
    const wfPromise = harness.client
      .prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'Run async workflow' }])
      .then((res) => {
        wfSettled = true;
        return res;
      });

    await vi.advanceTimersByTimeAsync(6_500);
    expect(wfSettled).toBe(false);

    const wfFinalTool = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'wf-bg-1',
      name: 'run_workflow',
      status: 'completed',
      title: 'Run multi-stage workflow',
      rawInput: { Script: 'fanout()', WaitMsBeforeAsync: 5000 },
      rawOutput: { output: 'Workflow finished cleanly.' },
    });
    const wfWakeupText = makeNotification('agy-sess-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Workflow completed all stages.' },
    });
    snapshot = [wfUser, wfFinalTool, wfWakeupText];
    currentUpdatedAt = '2026-01-01T00:00:08Z';

    await vi.advanceTimersByTimeAsync(7_000);
    await expect(wfPromise).resolves.toEqual({ stopReason: 'end_turn' });
    expect(wfSettled).toBe(true);
    expect(
      harness.updates.some(
        (u) =>
          u.update.sessionUpdate === 'tool_call_update' &&
          (u.update as { toolCallId?: string; rawOutput?: { output?: string } }).toolCallId ===
            'wf-bg-1' &&
          (u.update as { rawOutput?: { output?: string } }).rawOutput?.output ===
            'Workflow finished cleanly.'
      )
    ).toBe(true);
  });

  it('canonicalizes symlinked cwd via realpath for Antigravity ACP Server while preserving non-existent and non-Antigravity workdirs', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-agy-symlink-test-'));
    const realTarget = path.join(tempRoot, 'real-ws');
    const symlinkWs = path.join(tempRoot, 'symlink-ws');
    fs.mkdirSync(realTarget, { recursive: true });
    fs.symlinkSync(realTarget, symlinkWs);
    const canonicalWs = fs.realpathSync(symlinkWs);

    const newSessionCwds: string[] = [];
    const listSessionCwds: string[] = [];
    const loadSessionCwds: string[] = [];
    mockState.newSession.mockImplementation(async (params: { cwd: string }) => {
      newSessionCwds.push(params.cwd);
      return { sessionId: 'agy-sess-1' };
    });
    mockState.listSessions.mockImplementation(async (params: { cwd?: string }) => {
      if (params.cwd) listSessionCwds.push(params.cwd);
      return {
        sessions: [
          {
            sessionId: 'agy-sess-1',
            cwd: params.cwd ?? canonicalWs,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      };
    });
    mockState.loadSession.mockImplementation(async (params: { cwd: string }) => {
      loadSessionCwds.push(params.cwd);
      return {};
    });

    try {
      // 1. Antigravity resolves symlinked workspace to canonical path across newSession / list / load.
      const agy = createHarness();
      await agy.client.startSession({} as never, symlinkWs);
      mockState.prompt.mockImplementationOnce(async () => {
        await emitToLiveClient(
          makeNotification('agy-sess-1', {
            sessionUpdate: 'tool_call',
            toolCallId: 'sched-sym-1',
            name: 'schedule',
            title: 'Schedule check',
            status: 'in_progress',
            rawInput: { DurationSeconds: 5, Prompt: 'check' },
          })
        );
        return { stopReason: 'end_turn' };
      });
      await agy.client.prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'Schedule' }]);
      await vi.advanceTimersByTimeAsync(7_000);

      expect(newSessionCwds[0]).toBe(canonicalWs);
      expect(listSessionCwds[0]).toBe(canonicalWs);
      expect(loadSessionCwds[0]).toBe(canonicalWs);

      // Clean up detached monitor on agy client before next harness replaces mockState.client.
      await agy.client.closeSession('agy-sess-1' as ACPSessionId);

      // 2. Non-existent synthetic workdir falls back verbatim without failing startup.
      const agySynthetic = createHarness();
      await agySynthetic.client.startSession({} as never, '/synthetic/does-not-exist');
      expect(newSessionCwds[1]).toBe('/synthetic/does-not-exist');

      // 3. Non-Antigravity agent keeps symlink path verbatim.
      mockState.initialize.mockResolvedValueOnce(
        defaultInitResponse({ agentInfo: { name: 'Other ACP Server', version: '1.0.0' } })
      );
      const nonAgy = createHarness({
        agentConfig: { cliType: 'builtin', agentType: 'claude' },
      });
      await nonAgy.client.startSession({} as never, symlinkWs);
      expect(newSessionCwds[2]).toBe(symlinkWs);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('recovers orphaned post-end_turn pending permission tools in Tier 1 without hanging for promptHoldMaxMs', async () => {
    const harness = createHarness({
      timings: {
        orphanedPendingToolGraceMs: 4_000,
      },
    });
    let currentUpdatedAt = '2026-01-01T00:00:00Z';
    let snapshot: acp.SessionNotification[] = [];
    const cancelRequests: unknown[] = [];

    mockState.listSessions.mockImplementation(async () => ({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: currentUpdatedAt },
      ],
    }));
    mockState.loadSession.mockImplementation(async () => {
      for (const item of snapshot) {
        await emitToLiveClient(item);
      }
      return {};
    });
    mockState.cancel.mockImplementation(async (params: unknown) => {
      cancelRequests.push(params);
      return {};
    });

    await harness.client.startSession({} as never, '/synthetic/project');

    const userTurn = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Run bg then edit' },
    });
    const bgRunStart = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-hold-1',
      name: 'run_command',
      title: 'Run background command',
      status: 'in_progress',
    });
    const bgRunDone = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-hold-1',
      name: 'run_command',
      title: 'Run background command',
      status: 'completed',
      rawOutput: { output: 'done' },
    });
    const orphanPendingWrite = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'wf-orphan-1',
      name: 'write_file',
      title: 'Write outside workspace',
      status: 'pending',
    });
    snapshot = [userTurn, bgRunStart];

    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(bgRunStart);
      return { stopReason: 'end_turn' };
    });

    let settled = false;
    const promptPromise = harness.client
      .prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'Run bg then edit' }])
      .then((res) => {
        settled = true;
        return res;
      });

    // Wakeup transitions to an unforwarded write_file in status: pending, then updatedAt freezes.
    await vi.advanceTimersByTimeAsync(2_000);
    snapshot = [userTurn, bgRunDone, orphanPendingWrite];
    currentUpdatedAt = '2026-01-01T00:00:02Z';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(false);
    expect(cancelRequests).toEqual([]);

    // Grace expires well before promptHoldMaxMs: synthetic failed update + cancel + clean settle.
    await vi.advanceTimersByTimeAsync(4_500);
    await expect(promptPromise).resolves.toEqual({ stopReason: 'end_turn' });
    expect(settled).toBe(true);
    expect(harness.client.getNativeWork()).toBeNull();
    expect(cancelRequests).toEqual([{ sessionId: 'agy-sess-1' }]);

    const failedUpdate = harness.updates.find(
      (u) =>
        u.update.sessionUpdate === 'tool_call_update' &&
        (u.update as { toolCallId?: string }).toolCallId === 'wf-orphan-1' &&
        (u.update as { status?: string }).status === 'failed'
    );
    expect(failedUpdate).toBeDefined();
    expect(JSON.stringify(failedUpdate)).toContain(ORPHANED_POST_TURN_PERMISSION_MESSAGE);
  });

  it('recovers orphaned post-end_turn pending permission tools in Tier 2 detached monitor without hanging 24h', async () => {
    const harness = createHarness({
      timings: {
        orphanedPendingToolGraceMs: 4_000,
      },
    });
    let currentUpdatedAt = '2026-01-01T00:00:00Z';
    let snapshot: acp.SessionNotification[] = [];
    const cancelRequests: unknown[] = [];

    mockState.listSessions.mockImplementation(async () => ({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: currentUpdatedAt },
      ],
    }));
    mockState.loadSession.mockImplementation(async () => {
      for (const item of snapshot) {
        await emitToLiveClient(item);
      }
      return {};
    });
    mockState.cancel.mockImplementation(async (params: unknown) => {
      cancelRequests.push(params);
      return {};
    });

    await harness.client.startSession({} as never, '/synthetic/project');

    const schedUser = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Schedule out-of-workspace edit' },
    });
    const schedCall = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'sched-tier2-orphan',
      name: 'schedule',
      title: 'Schedule out-of-workspace edit',
      status: 'in_progress',
      rawInput: { DurationSeconds: 3, Prompt: 'write outside' },
    });
    const wedgedWrite = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'wf-tier2-orphan',
      name: 'write_file',
      title: 'Write blocked file',
      status: 'pending',
    });
    snapshot = [schedUser, schedCall];

    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(schedCall);
      return { stopReason: 'end_turn' };
    });

    await expect(
      harness.client.prompt('agy-sess-1' as ACPSessionId, [
        { type: 'text', text: 'Schedule out-of-workspace edit' },
      ])
    ).resolves.toEqual({ stopReason: 'end_turn' });
    expect(harness.client.getNativeWork()).toBe('background');

    // Timer fires and stalls on unforwarded pending write_file.
    await vi.advanceTimersByTimeAsync(2_000);
    snapshot = [schedUser, schedCall, wedgedWrite];
    currentUpdatedAt = '2026-01-01T00:00:03Z';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.client.getNativeWork()).toBe('running');

    // Orphan grace expires -> synthetic failure emitted, session/cancel sent, nativeWork returns to null.
    await vi.advanceTimersByTimeAsync(4_500);
    expect(cancelRequests).toEqual([{ sessionId: 'agy-sess-1' }]);
    expect(harness.client.getNativeWork()).toBeNull();
    expect(
      harness.updates.some(
        (u) =>
          u.update.sessionUpdate === 'tool_call_update' &&
          (u.update as { toolCallId?: string; status?: string }).toolCallId === 'wf-tier2-orphan' &&
          (u.update as { status?: string }).status === 'failed' &&
          JSON.stringify(u.update).includes(ORPHANED_POST_TURN_PERMISSION_MESSAGE)
      )
    ).toBe(true);
  });

  it('keeps Tier 1 hold alive when a future server actually forwards live requestPermission after end_turn', async () => {
    const harness = createHarness({
      timings: {
        orphanedPendingToolGraceMs: 4_000,
      },
    });
    let currentUpdatedAt = '2026-01-01T00:00:00Z';
    let snapshot: acp.SessionNotification[] = [];
    const cancelRequests: unknown[] = [];

    mockState.listSessions.mockImplementation(async () => ({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: currentUpdatedAt },
      ],
    }));
    mockState.loadSession.mockImplementation(async () => {
      for (const item of snapshot) {
        await emitToLiveClient(item);
      }
      return {};
    });
    mockState.cancel.mockImplementation(async (params: unknown) => {
      cancelRequests.push(params);
      return {};
    });

    await harness.client.startSession({} as never, '/synthetic/project');

    const userTurn = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Run bg then interactive edit' },
    });
    const bgRunStart = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-hold-perm',
      name: 'run_command',
      title: 'Run command before edit',
      status: 'in_progress',
    });
    const bgRunDone = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-hold-perm',
      name: 'run_command',
      title: 'Run command before edit',
      status: 'completed',
      rawOutput: { output: 'ok' },
    });
    const pendingWithLivePerm = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'wf-live-perm',
      name: 'write_file',
      title: 'Write file',
      status: 'pending',
    });
    snapshot = [userTurn, bgRunStart];

    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(bgRunStart);
      return { stopReason: 'end_turn' };
    });

    let settled = false;
    const promptPromise = harness.client
      .prompt('agy-sess-1' as ACPSessionId, [
        { type: 'text', text: 'Run bg then interactive edit' },
      ])
      .then((res) => {
        settled = true;
        return res;
      });

    // Wakeup enters pending write_file AND forwards live requestPermission -> must NOT auto-cancel.
    await vi.advanceTimersByTimeAsync(2_000);
    snapshot = [userTurn, bgRunDone, pendingWithLivePerm];
    currentUpdatedAt = '2026-01-01T00:00:02Z';
    void mockState.client?.requestPermission({
      sessionId: 'agy-sess-1',
      toolCall: { toolCallId: 'wf-live-perm', title: 'Write file' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    } as acp.RequestPermissionRequest);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(settled).toBe(false);
    expect(cancelRequests).toEqual([]);

    // Permission granted -> write_file completes -> text emitted -> settles cleanly after quiet window.
    snapshot = [
      userTurn,
      bgRunDone,
      makeNotification('agy-sess-1', {
        sessionUpdate: 'tool_call',
        toolCallId: 'wf-live-perm',
        name: 'write_file',
        title: 'Write file',
        status: 'completed',
      }),
      makeNotification('agy-sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Edited with permission.' },
      }),
    ];
    currentUpdatedAt = '2026-01-01T00:00:10Z';

    await vi.advanceTimersByTimeAsync(6_000);
    await expect(promptPromise).resolves.toEqual({ stopReason: 'end_turn' });
    expect(settled).toBe(true);
    expect(cancelRequests).toEqual([]);
  });

  it('recovers same-second wakeup completions when updatedAt stays frozen and stops snapshot loads past wakeupPlannerGraceMs', async () => {
    const harness = createHarness({
      timings: {
        settleQuietMs: 8_000,
      },
    });
    let currentUpdatedAt = '2026-01-01T00:00:00Z';
    let snapshot: acp.SessionNotification[] = [];

    mockState.listSessions.mockImplementation(async () => ({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: currentUpdatedAt },
      ],
    }));
    mockState.loadSession.mockImplementation(async () => {
      for (const item of snapshot) {
        await emitToLiveClient(item);
      }
      return {};
    });

    await harness.client.startSession({} as never, '/synthetic/project');

    const userTurn = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Run pipeline' },
    });
    const bgCmdStart = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-same-sec',
      name: 'run_command',
      title: 'Run pipeline command',
      status: 'in_progress',
    });
    const bgCmdDone = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-same-sec',
      name: 'run_command',
      title: 'Run pipeline command',
      status: 'completed',
      rawOutput: { output: 'sum=42' },
    });
    snapshot = [userTurn, bgCmdStart];

    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(bgCmdStart);
      return { stopReason: 'end_turn' };
    });

    let settled = false;
    const promptPromise = harness.client
      .prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text: 'Run pipeline' }])
      .then((res) => {
        settled = true;
        return res;
      });

    // At t=4s: SYSTEM_MESSAGE updates updatedAt to 00:00:04Z and PLANNER_RESPONSE starts in the same second.
    await vi.advanceTimersByTimeAsync(2_000);
    snapshot = [userTurn, bgCmdDone];
    currentUpdatedAt = '2026-01-01T00:00:04Z';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(false);

    // At t=9s: PLANNER_RESPONSE finishes generating with the SAME updatedAt (created_at timestamp unchanged).
    await vi.advanceTimersByTimeAsync(5_000);
    snapshot = [
      userTurn,
      bgCmdDone,
      makeNotification('agy-sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'PIPELINE_COMPLETE_SUM_42' },
      }),
    ];

    // Active-window sameSecondLoadCheckMs (6s) + settleQuietMs (8s) recovers text cleanly without updatedAt changing.
    await vi.advanceTimersByTimeAsync(11_000);
    await expect(promptPromise).resolves.toEqual({ stopReason: 'end_turn' });
    expect(settled).toBe(true);
    expect(
      harness.updates.some(
        (u) =>
          u.update.sessionUpdate === 'agent_message_chunk' &&
          u.update.content.type === 'text' &&
          u.update.content.text === 'PIPELINE_COMPLETE_SUM_42'
      )
    ).toBe(true);

    // Long Tier 2 wait: stops calling loadSession once past wakeupPlannerGraceMs (90s) until updatedAt changes again.
    harness.updates.splice(0);
    currentUpdatedAt = '2026-01-01T00:00:25Z';
    const longSchedUser = makeNotification('agy-sess-1', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Long wait timer' },
    });
    const longSchedTool = makeNotification('agy-sess-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'sched-long-idle',
      name: 'schedule',
      title: 'Long idle timer',
      status: 'in_progress',
      rawInput: { DurationSeconds: 600, Prompt: 'check later' },
    });
    snapshot = [longSchedUser, longSchedTool];
    mockState.prompt.mockImplementationOnce(async () => {
      await emitToLiveClient(longSchedTool);
      return { stopReason: 'end_turn' };
    });
    await harness.client.prompt('agy-sess-1' as ACPSessionId, [
      { type: 'text', text: 'Long wait timer' },
    ]);
    expect(harness.client.getNativeWork()).toBe('background');

    await vi.advanceTimersByTimeAsync(95_000);
    const loadsAfterActiveWindow = mockState.loadSession.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(mockState.loadSession.mock.calls.length).toBe(loadsAfterActiveWindow);
    expect(harness.client.getNativeWork()).toBe('background');

    // When updatedAt finally changes at timer fire, loadSession resumes and recovers output cleanly.
    snapshot = [
      longSchedUser,
      longSchedTool,
      makeNotification('agy-sess-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'LONG_TIMER_DONE' },
      }),
    ];
    currentUpdatedAt = '2026-01-01T00:10:00Z';
    await vi.advanceTimersByTimeAsync(12_000);
    expect(mockState.loadSession.mock.calls.length).toBeGreaterThan(loadsAfterActiveWindow);
    expect(harness.client.getNativeWork()).toBeNull();
    expect(
      harness.updates.some(
        (u) =>
          u.update.sessionUpdate === 'agent_message_chunk' &&
          u.update.content.type === 'text' &&
          u.update.content.text === 'LONG_TIMER_DONE'
      )
    ).toBe(true);
  });
});
