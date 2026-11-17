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
import {
  DEFAULT_ANTIGRAVITY_POLL_TIMINGS,
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

  /** A fake agy session: `session/list` reports `updatedAt`; Lody must never call `session/load`. */
  function installTranscript() {
    const transcript = { updatedAt: '2026-01-01T00:00:00Z' };
    mockState.listSessions.mockImplementation(async () => ({
      sessions: [
        { sessionId: 'agy-sess-1', cwd: '/synthetic/project', updatedAt: transcript.updatedAt },
      ],
    }));
    let wakeups = 0;
    /** agy wakes the model: `updatedAt` moves, then stays still. */
    const wakeUp = () => {
      wakeups += 1;
      transcript.updatedAt = `2026-01-01T01:00:${String(wakeups).padStart(2, '0')}Z`;
    };
    return { wakeUp };
  }

  const n = (update: Record<string, unknown>) => makeNotification('agy-sess-1', update);
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

  const { listPollIntervalMs, wakeupQuietMs } = DEFAULT_ANTIGRAVITY_POLL_TIMINGS;
  /** Long enough for a wakeup to be seen by `session/list` and then go quiet. */
  const WAKEUP_DONE = listPollIntervalMs * 2 + wakeupQuietMs;

  it('ends the turn at end_turn and keeps the process protected until the background work has woken agy', async () => {
    const harness = createHarness();
    const { wakeUp } = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    // A turn with only foreground tools never polls.
    promptOnce([tool('cmd-1', 'run_command', 'completed', { rawOutput: { Stdout: 'v22' } })]);
    await send(harness, 'Check version');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockState.listSessions).not.toHaveBeenCalled();
    expect(harness.client.getNativeWork()).toBeNull();

    // The command still runs when agy ends the prompt; the turn ends anyway.
    promptOnce([
      tool('cmd-2', 'run_command', 'in_progress', { rawInput: { CommandLine: 'pnpm test' } }),
    ]);
    await expect(send(harness, 'Run suite')).resolves.toEqual({ stopReason: 'end_turn' });
    expect(harness.client.getNativeWork()).toBe('background');

    // A long silent command stays protected well past the idle GC timeout.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(harness.client.getNativeWork()).toBe('background');

    // It finishes and agy wakes the model: running while the transcript moves, then released.
    wakeUp();
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);
    expect(harness.client.getNativeWork()).toBe('running');
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toBeNull();
    expect(harness.workChanges).toEqual(['background', 'running', 'background', null]);

    const listCalls = mockState.listSessions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockState.listSessions.mock.calls.length).toBe(listCalls);
    // agy restarts the session's MCP servers on every load.
    expect(mockState.loadSession).not.toHaveBeenCalled();
  });

  it('waits for one wakeup per pending item, counting dispatched subagents', async () => {
    const harness = createHarness();
    const { wakeUp } = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    // invoke_subagent completes on dispatch; each result arrives only by waking the model.
    promptOnce([
      tool('sub-1', 'invoke_subagent', 'completed', { rawOutput: { ok: true } }),
      tool('sub-2', 'invoke_subagent', 'completed', { rawOutput: { ok: true } }),
      say('Dispatched.'),
    ]);
    await send(harness, 'Research');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(harness.client.getNativeWork()).toBe('background');

    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toBe('background');

    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('protects a pending schedule until the 24-hour cap when it never wakes agy', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    // agy keeps a timer in_progress until it fires.
    promptOnce([
      tool('sched-1', 'schedule', 'in_progress', { rawInput: { DurationSeconds: 86_400 * 2 } }),
    ]);
    await send(harness, 'Remind me in two days');
    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
    expect(harness.client.getNativeWork()).toBe('background');
    await vi.advanceTimersByTimeAsync(60 * 60_000 + listPollIntervalMs);
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('keeps protecting when session/list keeps failing rather than releasing early', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');
    mockState.listSessions.mockRejectedValue(new Error('transport hiccup'));

    promptOnce([tool('cmd-1', 'run_command', 'in_progress')]);
    await send(harness, 'Run');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(harness.client.getNativeWork()).toBe('background');
  });

  it('does not protect daemon processes or failed tools', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');
    promptOnce([
      tool('dev-1', 'run_command', 'in_progress', { rawInput: { IsDaemon: true } }),
      tool('sub-1', 'invoke_subagent', 'failed'),
    ]);
    await send(harness, 'Start the dev server');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockState.listSessions).not.toHaveBeenCalled();
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('keeps protecting earlier background work after the user sends another message', async () => {
    const harness = createHarness();
    const { wakeUp } = installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([tool('cmd-1', 'run_command', 'in_progress')]);
    await send(harness, 'Run suite');
    await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);

    // The next turn has no background work of its own; the command is still running.
    promptOnce([say('README read.')]);
    await send(harness, 'Read the README');
    expect(harness.client.getNativeWork()).toBe('background');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(harness.client.getNativeWork()).toBe('background');

    wakeUp();
    await vi.advanceTimersByTimeAsync(WAKEUP_DONE);
    expect(harness.client.getNativeWork()).toBeNull();

    // Once released, a later turn inherits nothing.
    promptOnce([say('Welcome')]);
    await send(harness, 'Thanks');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.client.getNativeWork()).toBeNull();
  });

  it('negotiates the realpath of a symlinked workdir with Antigravity only', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-agy-symlink-test-'));
    const realTarget = path.join(tempRoot, 'real-ws');
    const symlinkWs = path.join(tempRoot, 'symlink-ws');
    fs.mkdirSync(realTarget, { recursive: true });
    fs.symlinkSync(realTarget, symlinkWs);
    const canonicalWs = fs.realpathSync(symlinkWs);
    const cwds = { new: [] as string[], list: [] as string[] };
    mockState.newSession.mockImplementation(async (params: { cwd: string }) => {
      cwds.new.push(params.cwd);
      return { sessionId: 'agy-sess-1' };
    });
    mockState.listSessions.mockImplementation(async (params: { cwd: string }) => {
      cwds.list.push(params.cwd);
      return { sessions: [{ sessionId: 'agy-sess-1', cwd: params.cwd, updatedAt: 'x' }] };
    });

    try {
      const agy = createHarness();
      await agy.client.startSession({} as never, symlinkWs);
      promptOnce([tool('sched-1', 'schedule', 'in_progress')]);
      await send(agy, 'Schedule');
      await vi.advanceTimersByTimeAsync(listPollIntervalMs * 2);
      expect(cwds.new[0]).toBe(canonicalWs);
      expect(cwds.list[0]).toBe(canonicalWs);

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

  it('preserves unsettled native work on closeSession and connection abort instead of flipping to idle', async () => {
    const closeHarness = createHarness();
    installTranscript();
    await closeHarness.client.startSession({} as never, '/synthetic/project');
    promptOnce([tool('cmd-1', 'run_command', 'in_progress')]);
    await send(closeHarness, 'Run');
    expect(closeHarness.client.getNativeWork()).toBe('background');
    expect(closeHarness.client.hasUnsettledNativeWork()).toBe(true);

    await closeHarness.client.closeSession('agy-sess-1' as ACPSessionId);
    await Promise.resolve();
    expect(closeHarness.client.getNativeWork()).toBe('background');
    expect(closeHarness.client.hasUnsettledNativeWork()).toBe(true);
    expect(closeHarness.workChanges).toEqual(['background']);

    mockState.abortController = new AbortController();
    const abortHarness = createHarness();
    installTranscript();
    await abortHarness.client.startSession({} as never, '/synthetic/project');
    promptOnce([tool('cmd-2', 'run_command', 'in_progress')]);
    await send(abortHarness, 'Run');
    expect(abortHarness.client.getNativeWork()).toBe('background');

    mockState.abortController.abort();
    await Promise.resolve();
    expect(abortHarness.client.getNativeWork()).toBe('background');
    expect(abortHarness.client.hasUnsettledNativeWork()).toBe(true);
    expect(abortHarness.workChanges).toEqual(['background']);
  });

  it('retains unsettled marker when the 24-hour protection cap releases GC until a new turn starts', async () => {
    const harness = createHarness();
    installTranscript();
    await harness.client.startSession({} as never, '/synthetic/project');

    promptOnce([
      tool('sched-1', 'schedule', 'in_progress', { rawInput: { DurationSeconds: 86_400 * 2 } }),
    ]);
    await send(harness, 'Remind me in two days');
    await vi.advanceTimersByTimeAsync(
      DEFAULT_ANTIGRAVITY_POLL_TIMINGS.maxDurationMs + listPollIntervalMs
    );
    expect(harness.client.getNativeWork()).toBeNull();
    expect(harness.client.hasUnsettledNativeWork()).toBe(true);

    promptOnce([say('Done.')]);
    await send(harness, 'Status');
    expect(harness.client.hasUnsettledNativeWork()).toBe(false);
  });
});
