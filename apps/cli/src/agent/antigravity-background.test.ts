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
    setDebug: () => {},
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

async function emitToLiveClient(notification: acp.SessionNotification): Promise<void> {
  if (!mockState.client) throw new Error('ACP client not connected');
  await mockState.client.sessionUpdate(notification);
}

function createHarness(options?: {
  agentConfig?: { cliType: 'builtin' | 'custom' | 'registry'; agentType: string; name?: string };
  timings?: Partial<AntigravityPollTimings>;
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
    antigravityPollTimings: options?.timings,
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
    // Ends any post-turn monitor through the connection's own abort signal.
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

  /** A fake `agy` transcript: `session/list` reports `updatedAt`, `session/load` replays `items`. */
  function installTranscript() {
    const transcript = {
      items: [] as acp.SessionNotification[],
      updatedAt: '2026-01-01T00:00:00Z',
    };
    mockState.listSessions.mockImplementation(async () => ({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: transcript.updatedAt },
      ],
    }));
    mockState.loadSession.mockImplementation(async () => {
      for (const item of transcript.items) await emitToLiveClient(item);
      return {};
    });
    return transcript;
  }

  const n = (update: Record<string, unknown>) => makeNotification('agy-sess-1', update);
  const user = (text: string) =>
    n({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
  const say = (text: string) =>
    n({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  const tool = (
    toolCallId: string,
    name: string,
    status: string,
    extra: Record<string, unknown> = {}
  ) => n({ sessionUpdate: 'tool_call', toolCallId, name, status, title: name, ...extra });

  function promptOnce(live: acp.SessionNotification[]) {
    mockState.prompt.mockImplementationOnce(async () => {
      for (const item of live) await emitToLiveClient(item);
      return { stopReason: 'end_turn' };
    });
  }

  function send(harness: ReturnType<typeof createHarness>, text: string) {
    return harness.client.prompt('agy-sess-1' as ACPSessionId, [{ type: 'text', text }]);
  }

  function texts(updates: readonly AcpSessionNotification[]): string[] {
    return updates.flatMap((u) =>
      u.update.sessionUpdate === 'agent_message_chunk' && u.update.content.type === 'text'
        ? [u.update.content.text]
        : []
    );
  }

  it('ends the turn at end_turn, protects a background command from GC, and replays its wakeup once', async () => {
    const harness = createHarness();
    const transcript = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    // A turn with only foreground tools never polls.
    const t1Tool = tool('cmd-1', 'run_command', 'completed', { rawOutput: { Stdout: 'v22' } });
    promptOnce([t1Tool, say('Node v22 is installed.')]);
    await send(harness, 'Check version');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockState.listSessions).not.toHaveBeenCalled();
    expect(harness.client.getNativeWork()).toBeNull();

    let history: SessionHistoryInput[] = [makeUserEntry('user-1', 'Check version', Date.now())];
    let ids = 0;
    const apply = () => {
      history = applyNotificationOnHistory(history, harness.updates.splice(0), undefined, {
        createId: () => `gen-${ids++}`,
        now: () => new Date().toISOString(),
      });
    };
    apply();
    history = history.map((e) => (e.role === 'assistant' ? { ...e, finished: true } : e));

    // The background command is still running when agy ends the prompt; the turn ends anyway.
    const preText = say('Running suite...');
    const running = tool('cmd-2', 'run_command', 'in_progress', {
      rawInput: { CommandLine: 'pnpm test' },
    });
    transcript.items = [
      user('Check version'),
      t1Tool,
      say('Node v22 is installed.'),
      user('Run suite'),
      preText,
      running,
    ];
    promptOnce([preText, running]);
    history.push(makeUserEntry('user-2', 'Run suite', Date.now()));
    await expect(send(harness, 'Run suite')).resolves.toEqual({ stopReason: 'end_turn' });
    expect(harness.client.getNativeWork()).toBe('background');

    // An unchanged snapshot replays nothing, and the active command keeps protection past the quiet window.
    await vi.advanceTimersByTimeAsync(DEFAULT_ANTIGRAVITY_POLL_TIMINGS.settleQuietMs + 10_000);
    expect(harness.updates).toHaveLength(2);
    expect(harness.client.getNativeWork()).toBe('background');

    // The command finishes and agy wakes the model; its reply arrives split into chunks.
    transcript.items = [
      ...transcript.items.slice(0, 5),
      tool('cmd-2', 'run_command', 'completed', {
        rawInput: { CommandLine: 'pnpm test' },
        rawOutput: { Stdout: '42 passed' },
      }),
      say('All 42 tests '),
      say('passed.'),
      n({ sessionUpdate: 'usage_update', used: 4200, size: 1_000_000 }),
      n({ sessionUpdate: 'session_info_update', title: 'not replayed' }),
    ];
    transcript.updatedAt = '2026-01-01T00:01:00Z';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.client.getNativeWork()).toBe('running');
    expect(texts(harness.updates.slice(2))).toEqual(['All 42 tests ', 'passed.']);
    expect(harness.contextUpdates).toEqual([{ used: 4200, size: 1_000_000 }]);
    expect(harness.updates.some((u) => u.update.sessionUpdate === 'session_info_update')).toBe(
      false
    );

    // Later polls of the same snapshot add nothing; the monitor releases after the quiet window.
    await vi.advanceTimersByTimeAsync(DEFAULT_ANTIGRAVITY_POLL_TIMINGS.settleQuietMs + 5_000);
    expect(harness.client.getNativeWork()).toBeNull();
    const listCalls = mockState.listSessions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockState.listSessions.mock.calls.length).toBe(listCalls);
    expect(harness.workChanges).toEqual(['background', 'running', 'background', null]);

    apply();
    expect(history).toHaveLength(4);
    expect(history[3]?.items).toEqual([
      expect.objectContaining({ type: 'text', text: 'Running suite...' }),
      expect.objectContaining({ type: 'tool_call', toolCallId: 'cmd-2', status: 'completed' }),
      expect.objectContaining({ type: 'text', text: 'All 42 tests passed.' }),
    ]);
  });

  it('finds a wakeup reply even when agy leaves updatedAt at the second its step started', async () => {
    const harness = createHarness();
    const transcript = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    const running = tool('cmd-1', 'run_command', 'in_progress');
    transcript.items = [user('Go'), running];
    promptOnce([running]);
    await send(harness, 'Go');
    await vi.advanceTimersByTimeAsync(2_000);

    transcript.items = [
      user('Go'),
      tool('cmd-1', 'run_command', 'completed', { rawOutput: { Stdout: 'ok' } }),
      say('Done.'),
    ];
    await vi.advanceTimersByTimeAsync(
      DEFAULT_ANTIGRAVITY_POLL_TIMINGS.activeLoadIntervalMs + 2_000
    );
    expect(texts(harness.updates)).toEqual(['Done.']);
  });

  it('keeps a pending schedule protected until it fires, then joins its reply chunks', async () => {
    const harness = createHarness();
    const transcript = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    // agy reports the timer as in_progress until it fires.
    const timer = tool('sched-1', 'schedule', 'in_progress', {
      rawInput: { DurationSeconds: 600 },
    });
    transcript.items = [user('Remind me'), say('Timer set.'), timer];
    promptOnce([say('Timer set.'), timer]);
    await send(harness, 'Remind me');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(harness.client.getNativeWork()).toBe('background');

    transcript.items = [
      user('Remind me'),
      say('Timer set.'),
      tool('sched-1', 'schedule', 'completed', { rawInput: { DurationSeconds: 600 } }),
      say('TIMER_WAK'),
      say('E_9921'),
    ];
    transcript.updatedAt = '2026-01-01T00:10:00Z';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(texts(harness.updates).join('')).toBe('Timer set.TIMER_WAKE_9921');
  });

  it('waits the longer dispatch window for subagents and separates their wakeup reply into a paragraph', async () => {
    const harness = createHarness();
    const transcript = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    // invoke_subagent completes on dispatch; its result only arrives by waking the model.
    const dispatch = tool('sub-1', 'invoke_subagent', 'completed', { rawOutput: { ok: true } });
    transcript.items = [user('Research'), dispatch, say('Dispatched.')];
    promptOnce([dispatch, say('Dispatched.')]);
    await send(harness, 'Research');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(harness.client.getNativeWork()).toBe('background');

    transcript.items = [...transcript.items, say('The answer is 42.')];
    transcript.updatedAt = '2026-01-01T00:05:00Z';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(texts(harness.updates)).toEqual(['Dispatched.', '\n\nThe answer is 42.']);

    await vi.advanceTimersByTimeAsync(
      DEFAULT_ANTIGRAVITY_POLL_TIMINGS.asyncDispatchQuietMs + 5_000
    );
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('does not protect daemon processes', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');
    promptOnce([tool('dev-1', 'run_command', 'in_progress', { rawInput: { IsDaemon: true } })]);
    await send(harness, 'Start the dev server');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockState.listSessions).not.toHaveBeenCalled();
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('pauses around config changes and stops before the next prompt so live output is never captured as replay', async () => {
    const harness = createHarness();
    const transcript = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    const timer = tool('sched-1', 'schedule', 'in_progress');
    transcript.items = [user('Wait'), timer];
    promptOnce([timer]);
    await send(harness, 'Wait');
    await vi.advanceTimersByTimeAsync(2_000);

    // A live notification streamed by the config RPC must reach Lody, not a snapshot capture.
    mockState.setSessionConfigOption.mockImplementationOnce(async () => {
      await emitToLiveClient(n({ sessionUpdate: 'current_mode_update', currentModeId: 'auto' }));
      return { configOptions: [] };
    });
    await harness.client.setSessionConfigOption('agy-sess-1' as ACPSessionId, 'mode', 'auto');
    expect(harness.updates.some((u) => u.update.sessionUpdate === 'current_mode_update')).toBe(
      true
    );
    const callsAfterConfig = mockState.listSessions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockState.listSessions.mock.calls.length).toBeGreaterThan(callsAfterConfig);
    expect(harness.client.getNativeWork()).toBe('background');

    // A new prompt stops the monitor; a turn without background work does not restart it.
    transcript.items = [user('Wait'), timer, user('Hi'), say('Hello')];
    promptOnce([say('Hello')]);
    await send(harness, 'Hi');
    expect(harness.client.getNativeWork()).toBeNull();
    const callsAfterPrompt = mockState.listSessions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockState.listSessions.mock.calls.length).toBe(callsAfterPrompt);
  });

  it('never re-emits history replayed when a session resumes', async () => {
    const harness = createHarness();
    const transcript = installTranscript();
    const history = [
      user('Previous turn'),
      tool('old-1', 'run_command', 'in_progress'),
      say('Earlier output.'),
    ];
    transcript.items = history;
    await harness.client.startSession(
      {} as never,
      '/synthetic/project',
      'agy-sess-1' as ACPSessionId
    );
    harness.updates.splice(0);

    const running = tool('new-1', 'run_command', 'in_progress');
    transcript.items = [...history, user('Continue'), running];
    promptOnce([running]);
    await send(harness, 'Continue');
    transcript.items = [
      ...history,
      user('Continue'),
      tool('new-1', 'run_command', 'completed', { rawOutput: { ExitCode: 0 } }),
      say('Lint passed.'),
    ];
    transcript.updatedAt = '2026-01-01T00:00:05Z';
    await vi.advanceTimersByTimeAsync(4_000);

    const toolIds = harness.updates.flatMap((u) => {
      const id = (u.update as { toolCallId?: unknown }).toolCallId;
      return typeof id === 'string' ? [id] : [];
    });
    expect(toolIds).toEqual(['new-1', 'new-1']);
    expect(texts(harness.updates)).toEqual(['Lint passed.']);
  });

  it('fails a post-turn tool whose permission request agy never forwards, and leaves forwarded ones waiting', async () => {
    const harness = createHarness();
    const transcript = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    const timer = tool('sched-1', 'schedule', 'in_progress');
    transcript.items = [user('Later'), timer];
    promptOnce([timer]);
    await send(harness, 'Later');

    // The wakeup tries two edits that need approval; only one request reaches Lody.
    transcript.items = [
      user('Later'),
      tool('sched-1', 'schedule', 'completed'),
      tool('write-1', 'write_file', 'pending'),
      tool('write-2', 'write_file', 'pending'),
    ];
    transcript.updatedAt = '2026-01-01T00:00:03Z';
    await vi.advanceTimersByTimeAsync(2_000);
    await harness.client.requestPermission({
      sessionId: 'agy-sess-1',
      toolCall: { toolCallId: 'write-2' },
      options: [],
    } as unknown as acp.RequestPermissionRequest);
    await vi.advanceTimersByTimeAsync(
      DEFAULT_ANTIGRAVITY_POLL_TIMINGS.orphanedPendingToolGraceMs + 2_000
    );

    const failed = harness.updates.filter(
      (u) => u.update.sessionUpdate === 'tool_call_update' && u.update.status === 'failed'
    );
    expect(failed.map((u) => (u.update as { toolCallId: string }).toolCallId)).toEqual(['write-1']);
    expect(JSON.stringify(failed[0]?.update)).toContain(ORPHANED_POST_TURN_PERMISSION_MESSAGE);
    expect(mockState.cancel).toHaveBeenCalledTimes(1);
  });

  it('negotiates the realpath of a symlinked workdir with Antigravity only', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-agy-symlink-test-'));
    const realTarget = path.join(tempRoot, 'real-ws');
    const symlinkWs = path.join(tempRoot, 'symlink-ws');
    fs.mkdirSync(realTarget, { recursive: true });
    fs.symlinkSync(realTarget, symlinkWs);
    const canonicalWs = fs.realpathSync(symlinkWs);
    const cwds = { new: [] as string[], list: [] as string[], load: [] as string[] };
    mockState.newSession.mockImplementation(async (params: { cwd: string }) => {
      cwds.new.push(params.cwd);
      return { sessionId: 'agy-sess-1' };
    });
    mockState.listSessions.mockImplementation(async (params: { cwd: string }) => {
      cwds.list.push(params.cwd);
      return { sessions: [{ sessionId: 'agy-sess-1', cwd: params.cwd, updatedAt: 'x' }] };
    });
    mockState.loadSession.mockImplementation(async (params: { cwd: string }) => {
      cwds.load.push(params.cwd);
      return {};
    });

    try {
      const agy = createHarness();
      await agy.client.startSession({} as never, symlinkWs);
      promptOnce([tool('sched-1', 'schedule', 'in_progress')]);
      await send(agy, 'Schedule');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(cwds.new[0]).toBe(canonicalWs);
      expect(cwds.list[0]).toBe(canonicalWs);
      expect(cwds.load[0]).toBe(canonicalWs);
      await agy.client.cancel('agy-sess-1' as ACPSessionId);

      // A missing workdir is passed through unchanged.
      await createHarness().client.startSession({} as never, '/synthetic/does-not-exist');
      expect(cwds.new[1]).toBe('/synthetic/does-not-exist');

      // Other agents keep the path they were given.
      mockState.initialize.mockResolvedValueOnce(
        defaultInitResponse({ agentInfo: { name: 'Other ACP Server', version: '1.0.0' } })
      );
      const other = createHarness({ agentConfig: { cliType: 'builtin', agentType: 'claude' } });
      await other.client.startSession({} as never, symlinkWs);
      expect(cwds.new[2]).toBe(symlinkWs);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
