import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { Logger } from '../src/utils/logger';
import {
  SessionExecutionService,
  type SessionExecutionServiceDeps,
} from '../src/session/session-execution-service';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  getMachineRoomId,
  SessionStatusFactory,
  type ACPSessionId,
  type AgentConfigMeta,
  type AgentConfigId,
  type LocalProjectId,
  type MachineId,
  type SessionGoalMessage,
  type SessionHistoryInput,
  type SessionId,
  type SessionInputBlock,
  type WorkspaceId,
} from '@lody/shared';
import type { SessionManager } from '../src/session/session-manager';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import {
  AcpAuthenticationRequiredError,
  AgentSteerNotDeliveredError,
} from '../src/agent/agent-client';
import { AcpAuthenticationManager } from '../src/agent/acp-authentication';
import { GitExecutableNotFoundError } from '../src/session/worktree/git-process-error';

const capabilityConfigId = 'config-1' as AgentConfigId;

const createLaunchConfig = (overrides: Partial<AgentConfigMeta> = {}): AgentConfigMeta => ({
  id: capabilityConfigId,
  machineId: 'machine-1',
  name: 'Test Provider',
  description: undefined,
  cliType: 'registry',
  agentType: 'codex',
  env: { TOKEN: 'shared' },
  ...overrides,
});

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

const ensureSessionDocDefaults = <T>(doc: T): T => {
  if (doc && typeof doc === 'object') {
    if (!('waitUntilSynced' in doc)) {
      Object.assign(doc, { waitUntilSynced: vi.fn(async () => {}) });
    }
  }
  return doc;
};

const runGit = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

const createDeferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createGitLocalProject = (): string => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-session-local-project-'));
  runGit(rootPath, ['init', '-b', 'main']);
  runGit(rootPath, ['config', 'user.email', 'test@example.com']);
  runGit(rootPath, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(rootPath, 'README.md'), 'main\n', 'utf8');
  runGit(rootPath, ['add', 'README.md']);
  runGit(rootPath, ['commit', '-m', 'initial']);
  runGit(rootPath, ['checkout', '-b', 'feature/remote-local']);
  fs.writeFileSync(path.join(rootPath, 'feature.txt'), 'feature\n', 'utf8');
  runGit(rootPath, ['add', 'feature.txt']);
  runGit(rootPath, ['commit', '-m', 'feature']);
  runGit(rootPath, ['checkout', 'main']);
  return rootPath;
};

const createBaseDeps = (
  overrides: Partial<SessionExecutionServiceDeps>
): SessionExecutionServiceDeps => {
  const logger = createSilentLogger();
  const sessionManager = {
    getSession: vi.fn(() => null),
    getPendingSession: vi.fn(() => null),
    createSession: vi.fn(),
    setSessionError: vi.fn(),
    terminateSession: vi.fn(),
    refreshGhTokenForSession: vi.fn(async () => {}),
  } as unknown as SessionManager;
  const workspaceDocument = {
    repo: {
      upsertDocMeta: vi.fn(async () => {}),
      getDocMeta: vi.fn(async () => undefined),
      openFlockDoc: vi.fn(async () => ({
        flock: { scan: () => [] },
      })),
    },
    getOrCreateSessionDoc: vi.fn(),
    updateAcpCapabilities: vi.fn(async () => {}),
    persistPendingChanges: vi.fn(async () => {}),
  } as unknown as LoroDocumentManager;

  const deps = {
    logger,
    sessionManager,
    workspaceDocument,
    machineId: 'machine-1',
    userId: 'owner-user',
    workspaceId: 'workspace-1' as WorkspaceId,
    preferredBaseBranch: 'main',
    touchSession: vi.fn(),
    startSessionActivePresence: vi.fn(async () => {}),
    clearSessionActivePresence: vi.fn(),
    setSessionActivePresencePhase: vi.fn(),
    beginACPReplaySuppression: vi.fn(),
    endACPReplaySuppression: vi.fn(),
    beginConversationTurn: vi.fn(() => 'turn-1'),
    activateConversationTurnForACPUpdates: vi.fn(),
    clearConversationTurn: vi.fn(),
    getActiveTurnId: vi.fn(() => undefined),
    clearActiveTurnId: vi.fn(() => {}),
    buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'hello' }] as any),
    applyAcpModeAndModel: vi.fn(async () => {}),
    createAssistantEntryForTurn: vi.fn(async () => {}),
    turnFinalization: {
      finalizeACPState: vi.fn(async () => {}),
      flushSessionUsage: vi.fn(async () => {}),
      syncSessionBranchName: vi.fn(async () => null),
      updateSessionDiffStats: vi.fn(async () => []),
      detectAndAssociatePR: vi.fn(async () => null),
      autoCommitAndPushForPR: vi.fn(async () => {}),
      notifySessionCompleted: vi.fn(async () => {}),
    },
    recordChatFailure: vi.fn(async () => {}),
    maybeGenerateAndStoreSessionTitle: vi.fn(async () => {}),
    maybeRenameSessionBranchFromPrompt: vi.fn(async () => {}),
    processMessageQueue: vi.fn(async () => {}),
    collectMachineResources: vi.fn(async () => ({
      totalMemoryGB: 1,
      usedMemoryGB: 0.5,
      freeMemoryGB: 0.5,
      totalCpus: 8,
      cpuUsagePercent: 10,
    })),
    fetchAcpCapabilities: vi.fn(async () => ({
      modes: [],
      models: [],
    })),
    evictForMemoryPressure: vi.fn(async () => ({
      availableMemoryBytes: 4 * 1024 * 1024 * 1024,
      thresholdBytes: 1024 * 1024 * 1024,
      hadMemoryPressure: false,
      stillUnderPressure: false,
      evictedSessionIds: [],
      pressureReason: null,
    })),
    ...overrides,
  };

  const repo = (deps.workspaceDocument as unknown as { repo?: Record<string, unknown> }).repo;
  if (repo && !('openFlockDoc' in repo)) {
    repo.openFlockDoc = vi.fn(async () => ({
      flock: { scan: () => [] },
    }));
  }

  const workspaceWithLaunchConfig = deps.workspaceDocument as unknown as {
    getAgentConfigForMachineLaunch?: (
      agentConfigId: AgentConfigId,
      machineId: MachineId
    ) => Promise<AgentConfigMeta | null>;
  };
  workspaceWithLaunchConfig.getAgentConfigForMachineLaunch ??= vi.fn(
    async (agentConfigId: AgentConfigId, machineId: MachineId) =>
      createLaunchConfig({ id: agentConfigId, machineId })
  );

  const workspaceWithDocFactory = deps.workspaceDocument as unknown as {
    getOrCreateSessionDoc: (...args: unknown[]) => Promise<unknown>;
  };
  const originalGetOrCreateSessionDoc = workspaceWithDocFactory.getOrCreateSessionDoc;
  workspaceWithDocFactory.getOrCreateSessionDoc = vi.fn(async (...args: unknown[]) =>
    ensureSessionDocDefaults(await originalGetOrCreateSessionDoc(...args))
  );

  return deps;
};

describe('SessionExecutionService', () => {
  it('advances one session owner through consecutive prompt handoffs', async () => {
    const steerPrompt = vi.fn(() => ({
      completion: new Promise(() => {}),
      applied: Promise.resolve({ steerId: 'steer-application', release: vi.fn() }),
    }));
    const cancel = vi.fn(async () => {});
    const agentClient = {
      isCreated: vi.fn(() => true),
      getAcknowledgedSteerCapability: vi.fn(() => ({
        provider: 'claudeCode',
        appliedNotificationMethod: 'claude/steerApplied',
        upstreamTurn: 'handoff',
        configPolicy: 'apply',
      })),
      cancel,
      steerPrompt,
      currentModel: undefined,
    };
    const sessionDoc = {
      updateHistory: vi.fn(async () => {}),
    };
    const upsertDocMeta = vi.fn(async () => {});
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      } as unknown as LoroDocumentManager,
      beginConversationTurn: vi.fn((_sessionId, userTurnId) => `assistant:${userTurnId}`),
    });
    const service = new SessionExecutionService(deps);
    const sessionId = 'session-steer' as SessionId;
    const activeSession = {
      agentClient,
      acpSessionId: 'acp-steer' as ACPSessionId,
    };
    type TestPromptRun = {
      turnId: string;
      promptOutcome: Promise<{ status: 'fulfilled' } | { status: 'rejected'; error: unknown }>;
      successor?: TestPromptRun;
      successorReady: Promise<void>;
      signalSuccessor: () => void;
    };
    const createPromptHandoffRun = (
      service as unknown as {
        createPromptHandoffRun: (options: {
          turnId: string;
          promptPromise: Promise<unknown>;
        }) => TestPromptRun;
      }
    ).createPromptHandoffRun.bind(service);
    const initialPromptRun = createPromptHandoffRun({
      turnId: 'assistant:user-1',
      promptPromise: new Promise(() => {}),
    });
    const runtime = {
      sessionId,
      turnId: 'assistant:user-1',
      userTurnId: 'user-1',
      session: activeSession,
      promptInFlight: true,
      invocation: {
        sourceTurnId: 'user-1',
        requesterUserId: 'user-1',
        inputConfig: { prompt: 'initial prompt' },
      },
      activePromptRun: initialPromptRun,
      yieldedFinalization: Promise.resolve(),
    };
    (
      service as unknown as {
        turnRuntimeBySession: Map<SessionId, typeof runtime>;
      }
    ).turnRuntimeBySession.set(sessionId, runtime);

    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-07-11T00:00:00.000Z',
        inputConfig: { prompt: 'change direction' },
      })
    ).resolves.toMatchObject({ applied: true, disposition: 'applied' });

    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledWith(
      sessionId,
      'assistant:user-1'
    );
    expect(deps.beginConversationTurn).toHaveBeenCalledWith(sessionId, 'user-2', {
      dispatchSource: 'rpc',
      sessionDoc,
    });
    expect(steerPrompt).toHaveBeenCalledWith('acp-steer', [{ type: 'text', text: 'hello' }]);
    expect(deps.applyAcpModeAndModel).toHaveBeenCalledOnce();
    expect(steerPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      upsertDocMeta.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY
    );
    expect(runtime.turnId).toBe('assistant:user-2');
    expect(runtime.userTurnId).toBe('user-2');
    expect(runtime.invocation).toEqual({
      requesterUserId: 'user-1',
      sourceTurnId: 'user-2',
      inputConfig: { prompt: 'change direction' },
    });
    expect(service.getActiveInvocationContext(sessionId)).toEqual({
      requesterUserId: 'user-1',
      sourceTurnId: 'user-2',
      inputConfig: { prompt: 'change direction' },
    });
    expect(initialPromptRun.successor?.turnId).toBe('assistant:user-2');
    expect(runtime.activePromptRun.turnId).toBe('assistant:user-2');

    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'stale-user-turn',
        userId: 'user-1',
        timestamp: '2026-07-11T00:00:00.000Z',
        inputConfig: { prompt: 'stale guide' },
      })
    ).resolves.toMatchObject({ applied: false, disposition: 'stale-turn' });
    expect(steerPrompt).toHaveBeenCalledTimes(1);

    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-2',
        userTurnId: 'user-3',
        userId: 'user-1',
        timestamp: '2026-07-11T00:00:00.000Z',
        inputConfig: { prompt: 'change direction again' },
      })
    ).resolves.toMatchObject({ applied: true, disposition: 'applied' });
    expect(steerPrompt).toHaveBeenCalledTimes(2);
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenNthCalledWith(
      2,
      sessionId,
      'assistant:user-2'
    );
    expect(runtime.turnId).toBe('assistant:user-3');
    expect(runtime.userTurnId).toBe('user-3');
    expect(runtime.activePromptRun.turnId).toBe('assistant:user-3');
    expect(service.getExecutionSnapshot(sessionId)).toMatchObject({
      activeTurnId: 'assistant:user-3',
      hasActiveTurn: true,
    });
    expect(service.getActiveUserTurnId(sessionId)).toBe('user-3');
    expect(upsertDocMeta).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        latestUserMsgId: 'user-3',
        lastHandledUserMsgId: 'user-2',
        processingUserMsgId: 'user-3',
      })
    );

    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-3',
        userTurnId: 'user-3',
        userId: 'user-1',
        timestamp: '2026-07-11T00:00:00.000Z',
        inputConfig: { prompt: 'change direction again' },
      })
    ).resolves.toMatchObject({ applied: true, disposition: 'applied' });
    expect(steerPrompt).toHaveBeenCalledTimes(2);

    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant:user-2',
      })
    ).resolves.toEqual({ success: true });
    expect(cancel).not.toHaveBeenCalled();

    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant:user-3',
      })
    ).resolves.toEqual({ success: true });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('acp-steer'));
  });

  it('completes A to B to C when yielded prompts never settle', async () => {
    const sessionId = 'session-steer-lifecycle' as SessionId;
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    const third = createDeferred<unknown>();
    const fourth = createDeferred<unknown>();
    const promptResults = [first, second, third, fourth];
    const nextPrompt = () => {
      const next = promptResults.shift();
      if (!next) {
        throw new Error('Unexpected prompt');
      }
      return next.promise;
    };
    const prompt = vi.fn(nextPrompt);
    const applicationB = createDeferred<{ steerId: string; release: () => void }>();
    const applicationC = createDeferred<{ steerId: string; release: () => void }>();
    const applicationD = createDeferred<{ steerId: string; release: () => void }>();
    const applications = [applicationB, applicationC, applicationD];
    const steerPrompt = vi.fn(() => {
      const application = applications.shift();
      if (!application) {
        throw new Error('Unexpected steer application');
      }
      return { completion: nextPrompt(), applied: application.promise };
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      getAcknowledgedSteerCapability: vi.fn(() => ({
        provider: 'claudeCode',
        appliedNotificationMethod: 'claude/steerApplied',
        upstreamTurn: 'handoff',
        configPolicy: 'apply',
      })),
      cancel: vi.fn(async () => {}),
      prompt,
      steerPrompt,
      currentModel: undefined,
    };
    const activeSession = {
      sessionId,
      acpSessionId: 'acp-steer-lifecycle' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-steer-lifecycle'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    let history: Array<Record<string, unknown>> = [
      { id: 'user-a', role: 'user', status: 'pending', read: false },
      { id: 'user-b', role: 'user', status: 'pending_apply', read: false },
      { id: 'user-c', role: 'user', status: 'pending_apply', read: false },
      { id: 'user-d', role: 'user', status: 'pending_apply', read: false },
    ];
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setLastMessageAt: vi.fn(async () => {}),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      waitUntilSynced: vi.fn(async () => {}),
    };
    let meta: Record<string, unknown> = {};
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch };
    });
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => activeSession),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({ meta })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        getOrOpenSessionCode: vi.fn(async () => null),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      beginConversationTurn: vi.fn((_sessionId: SessionId, userTurnId?: string) =>
        userTurnId ? `assistant:${userTurnId}` : 'assistant:unknown'
      ),
    });
    const service = new SessionExecutionService(deps);
    const lifecycle = service.continueSession({
      type: 'session/chat',
      sessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: 'A', cliType: 'builtin', agentType: 'claude' },
      userTurnId: 'user-a',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    const steerB = service.steerSession({
      sessionId,
      expectedTurnId: 'assistant:user-a',
      userTurnId: 'user-b',
      userId: 'user-1',
      timestamp: '2026-07-12T00:00:00.000Z',
      inputConfig: { prompt: 'B' },
    });
    await vi.waitFor(() => expect(steerPrompt).toHaveBeenCalledTimes(1));
    expect(history).toContainEqual(
      expect.objectContaining({ id: 'user-b', status: 'pending_apply' })
    );
    expect(service.getExecutionSnapshot(sessionId).activeTurnId).toBe('assistant:user-a');
    expect(deps.turnFinalization.finalizeACPState).not.toHaveBeenCalled();
    expect(deps.activateConversationTurnForACPUpdates).toHaveBeenCalledTimes(1);
    const releaseB = vi.fn();
    applicationB.resolve({ steerId: 'steer-b', release: releaseB });
    await expect(steerB).resolves.toMatchObject({ applied: true, disposition: 'applied' });
    expect(releaseB).toHaveBeenCalledOnce();
    expect(deps.activateConversationTurnForACPUpdates).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(deps.activateConversationTurnForACPUpdates).mock.invocationCallOrder[1]
    ).toBeLessThan(releaseB.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);

    const steerC = service.steerSession({
      sessionId,
      expectedTurnId: 'assistant:user-b',
      userTurnId: 'user-c',
      userId: 'user-1',
      timestamp: '2026-07-12T00:00:01.000Z',
      inputConfig: { prompt: 'C' },
    });
    await vi.waitFor(() => expect(steerPrompt).toHaveBeenCalledTimes(2));
    expect(history).toContainEqual(
      expect.objectContaining({ id: 'user-c', status: 'pending_apply' })
    );
    expect(service.getExecutionSnapshot(sessionId).activeTurnId).toBe('assistant:user-b');
    const releaseC = vi.fn();
    applicationC.resolve({ steerId: 'steer-c', release: releaseC });
    await expect(steerC).resolves.toMatchObject({ applied: true, disposition: 'applied' });
    expect(releaseC).toHaveBeenCalledOnce();

    const steerD = service.steerSession({
      sessionId,
      expectedTurnId: 'assistant:user-c',
      userTurnId: 'user-d',
      userId: 'user-1',
      timestamp: '2026-07-12T00:00:02.000Z',
      inputConfig: { prompt: 'D' },
    });
    await vi.waitFor(() => expect(steerPrompt).toHaveBeenCalledTimes(3));
    applicationD.reject(new Error('steer application failed'));
    await expect(steerD).resolves.toMatchObject({ applied: false, disposition: 'error' });
    expect(history).toContainEqual(
      expect.objectContaining({ id: 'user-d', status: 'pending_apply' })
    );
    expect(service.getExecutionSnapshot(sessionId).activeTurnId).toBe('assistant:user-c');

    expect(service.getExecutionSnapshot(sessionId)).toMatchObject({
      activeTurnId: 'assistant:user-c',
      hasActiveTurn: true,
    });
    third.resolve({});
    await lifecycle;

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(steerPrompt).toHaveBeenCalledTimes(3);
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenNthCalledWith(
      1,
      sessionId,
      'assistant:user-a'
    );
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenNthCalledWith(
      2,
      sessionId,
      'assistant:user-b'
    );
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenNthCalledWith(
      3,
      sessionId,
      'assistant:user-c'
    );
    expect(deps.turnFinalization.flushSessionUsage).toHaveBeenCalledTimes(3);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'user-a', status: 'handled' }),
        expect.objectContaining({ id: 'user-b', status: 'handled' }),
        expect.objectContaining({ id: 'user-c', status: 'handled' }),
      ])
    );
    expect(meta).toMatchObject({
      latestUserMsgId: 'user-c',
      lastHandledUserMsgId: 'user-c',
      processingUserMsgId: undefined,
    });
    expect(deps.turnFinalization.notifySessionCompleted).toHaveBeenCalledTimes(1);
    expect(deps.processMessageQueue).toHaveBeenCalledTimes(1);
    expect(service.getExecutionSnapshot(sessionId)).toMatchObject({ hasActiveTurn: false });
  });

  it('rejects steer without mutating the active turn when the agent lacks support', async () => {
    const deps = createBaseDeps({});
    const service = new SessionExecutionService(deps);
    const sessionId = 'session-no-steer' as SessionId;
    const runtime = {
      sessionId,
      turnId: 'assistant:user-1',
      session: {
        agentClient: { getAcknowledgedSteerCapability: vi.fn(() => null) },
        acpSessionId: 'acp-no-steer' as ACPSessionId,
      },
      promptInFlight: true,
    };
    (
      service as unknown as {
        turnRuntimeBySession: Map<SessionId, typeof runtime>;
      }
    ).turnRuntimeBySession.set(sessionId, runtime);

    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-07-11T00:00:00.000Z',
        inputConfig: { prompt: 'change direction' },
      })
    ).resolves.toMatchObject({ applied: false, disposition: 'unsupported' });
    expect(deps.turnFinalization.finalizeACPState).not.toHaveBeenCalled();
    expect(deps.beginConversationTurn).not.toHaveBeenCalled();
  });

  it('reports no active turn when the target prompt ends before steer submission', async () => {
    const promptBlocks = createDeferred<Array<{ type: 'text'; text: string }>>();
    const steerPrompt = vi.fn();
    const sessionId = 'session-steer-ended-before-submit' as SessionId;
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta: vi.fn(async () => {}) },
        getOrCreateSessionDoc: vi.fn(async () => ({ updateHistory: vi.fn(async () => {}) })),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(() => promptBlocks.promise),
    });
    const service = new SessionExecutionService(deps);
    const runtime = {
      sessionId,
      turnId: 'assistant:user-1',
      session: {
        agentClient: {
          getAcknowledgedSteerCapability: vi.fn(() => ({
            provider: 'claudeCode',
            appliedNotificationMethod: 'claude/steerApplied',
            upstreamTurn: 'handoff',
            configPolicy: 'apply',
          })),
          steerPrompt,
        },
        acpSessionId: 'acp-steer-ended-before-submit' as ACPSessionId,
      },
      promptInFlight: true,
    };
    (
      service as unknown as {
        turnRuntimeBySession: Map<SessionId, typeof runtime>;
      }
    ).turnRuntimeBySession.set(sessionId, runtime);

    const steer = service.steerSession({
      sessionId,
      expectedTurnId: 'assistant:user-1',
      userTurnId: 'user-2',
      userId: 'user-1',
      timestamp: '2026-07-17T00:00:00.000Z',
      inputConfig: { prompt: 'continue as a new turn' },
    });
    await vi.waitFor(() => expect(deps.buildAcpPromptBlocks).toHaveBeenCalledOnce());
    runtime.promptInFlight = false;
    promptBlocks.resolve([{ type: 'text', text: 'continue as a new turn' }]);

    await expect(steer).resolves.toMatchObject({
      applied: false,
      disposition: 'no-active-turn',
    });
    expect(deps.applyAcpModeAndModel).not.toHaveBeenCalled();
    expect(steerPrompt).not.toHaveBeenCalled();
  });

  it('rejects a Codex steer whose requested configuration differs from the active turn', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta, getDocMeta: vi.fn(async () => undefined) },
        getOrCreateSessionDoc: vi.fn(async () => ({ updateHistory: vi.fn(async () => {}) })),
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const sessionId = 'session-codex-steer-config' as SessionId;
    const findSteerConfigMismatch = vi.fn(() => 'model requested gpt-next, active gpt-current');
    const runtime = {
      sessionId,
      turnId: 'assistant:user-1',
      session: {
        agentClient: {
          getAcknowledgedSteerCapability: vi.fn(() => ({
            provider: 'codex',
            appliedNotificationMethod: 'codex/steerApplied',
            upstreamTurn: 'same',
            configPolicy: 'active',
          })),
          findSteerConfigMismatch,
        },
        acpSessionId: 'acp-codex-steer-config' as ACPSessionId,
      },
      promptInFlight: true,
    };
    (
      service as unknown as {
        turnRuntimeBySession: Map<SessionId, typeof runtime>;
      }
    ).turnRuntimeBySession.set(sessionId, runtime);

    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-07-11T00:00:00.000Z',
        inputConfig: { prompt: 'change direction', modelId: 'gpt-next' },
      })
    ).resolves.toMatchObject({
      applied: false,
      disposition: 'unsupported',
      error: expect.stringContaining('Active turn configuration differs'),
    });
    expect(findSteerConfigMismatch).toHaveBeenCalledOnce();
    expect(deps.applyAcpModeAndModel).not.toHaveBeenCalled();
    expect(deps.beginConversationTurn).not.toHaveBeenCalled();

    findSteerConfigMismatch.mockReturnValue(null);
    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-3',
        userId: 'user-1',
        timestamp: '2026-07-11T00:00:01.000Z',
        inputConfig: { prompt: 'same configuration' },
      })
    ).resolves.toMatchObject({ applied: false, disposition: 'busy' });
    expect(deps.applyAcpModeAndModel).not.toHaveBeenCalled();
    // Neither guide reached Codex, so both are handed back to dispatch instead
    // of being stranded in `pending_apply`.
    const dispatchPointerWrites = upsertDocMeta.mock.calls.filter(
      (call) => (call[1] as { latestUserMsgId?: string }).latestUserMsgId !== undefined
    );
    expect(
      dispatchPointerWrites.map((call) => (call[1] as { latestUserMsgId?: string }).latestUserMsgId)
    ).toEqual(['user-2', 'user-3']);
  });

  it('queues a steer the agent refused as the next ordinary turn', async () => {
    let history: SessionHistoryInput[] = [
      { id: 'user-1', role: 'user', status: 'handled', read: true } as SessionHistoryInput,
      {
        id: 'user-2',
        role: 'user',
        status: 'pending_apply',
        read: false,
        inputConfig: { prompt: 'do it differently' },
      } as SessionHistoryInput,
    ];
    const sessionDoc = {
      updateHistory: vi.fn(
        async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = update(history);
        }
      ),
    };
    const upsertDocMeta = vi.fn(async () => {});
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta, getDocMeta: vi.fn(async () => undefined) },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const sessionId = 'session-steer-refused' as SessionId;
    // The agent answered the acknowledged steer request with a refusal, which
    // is proof the prompt never joined the live turn.
    const steerPrompt = vi.fn(() => ({
      completion: new Promise(() => {}),
      applied: Promise.reject(
        new AgentSteerNotDeliveredError(
          'Agent refused the acknowledged steer request _session/steering: No active Codex turn to steer'
        )
      ),
    }));
    const runtime = {
      sessionId,
      turnId: 'assistant:user-1',
      userTurnId: 'user-1',
      session: {
        agentClient: {
          getAcknowledgedSteerCapability: vi.fn(() => ({
            provider: 'codex',
            appliedNotificationMethod: 'codex/steerApplied',
            upstreamTurn: 'same',
            configPolicy: 'active',
          })),
          findSteerConfigMismatch: vi.fn(() => null),
          steerPrompt,
        },
        acpSessionId: 'acp-steer-refused' as ACPSessionId,
      },
      promptInFlight: true,
      activePromptRun: { turnId: 'assistant:user-1' },
    };
    (
      service as unknown as {
        turnRuntimeBySession: Map<SessionId, typeof runtime>;
      }
    ).turnRuntimeBySession.set(sessionId, runtime);

    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-07-19T00:00:00.000Z',
        inputConfig: { prompt: 'do it differently' },
      })
    ).resolves.toMatchObject({ applied: false, disposition: 'no-active-turn' });

    expect(steerPrompt).toHaveBeenCalledOnce();
    // Durable source: the entry becomes dispatchable, so the watcher runs it
    // once the active turn ends (and again after a daemon restart).
    expect(history.find((entry) => entry.id === 'user-2')).toMatchObject({
      status: 'pending',
      read: false,
    });
    expect(history.find((entry) => entry.id === 'user-1')).toMatchObject({ status: 'handled' });
    // The load-bearing half: `sessionNeedsActiveWatch` reads meta only, so a
    // history-only entry would be dropped the moment the session goes idle.
    expect(upsertDocMeta).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ latestUserMsgId: 'user-2' })
    );
    // Ownership never moved: the refused steer must not seal the running turn.
    expect(deps.turnFinalization.finalizeACPState).not.toHaveBeenCalled();
    expect(deps.beginConversationTurn).not.toHaveBeenCalled();
  });

  it('does not requeue an undelivered steer whose turn already left the pending state', async () => {
    let history: SessionHistoryInput[] = [
      { id: 'user-2', role: 'user', status: 'processing', read: true } as SessionHistoryInput,
    ];
    const sessionDoc = {
      updateHistory: vi.fn(
        async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = update(history);
        }
      ),
    };
    const upsertDocMeta = vi.fn(async () => {});
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta, getDocMeta: vi.fn(async () => undefined) },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const sessionId = 'session-steer-duplicate' as SessionId;

    // No runtime at all: a duplicate steer request landing after the turn it
    // targeted already ran.
    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-07-19T00:00:00.000Z',
        inputConfig: { prompt: 'do it differently' },
      })
    ).resolves.toMatchObject({ applied: false, disposition: 'no-active-turn' });
    expect(history[0]).toMatchObject({ status: 'processing' });
    expect(upsertDocMeta).not.toHaveBeenCalled();
  });

  it('leaves the producer-owned dispatch pointer untouched when execution takes ownership', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const getDocMeta = vi.fn(async () => ({ meta: { latestUserMsgId: 'user-3' } }));
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta,
        },
        getOrCreateSessionDoc: vi.fn(async () => ({ updateHistory: vi.fn(async () => {}) })),
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const sessionDoc = { updateHistory: vi.fn(async () => {}) };
    const setDispatchProcessing = (
      service as unknown as {
        setDispatchProcessing: (
          sessionId: SessionId,
          doc: unknown,
          userTurnId: string
        ) => Promise<void>;
      }
    ).setDispatchProcessing.bind(service);

    await setDispatchProcessing('session-pointer' as SessionId, sessionDoc, 'user-2');

    expect(upsertDocMeta).toHaveBeenCalledWith(expect.any(String), {
      processingUserMsgId: 'user-2',
    });
    expect(getDocMeta).not.toHaveBeenCalled();
  });

  it('cannot overwrite a newer activation while an earlier turn becomes terminal', async () => {
    let releaseHistoryWrite!: () => void;
    const historyWriteBlocked = new Promise<void>((resolve) => {
      releaseHistoryWrite = resolve;
    });
    const updateHistory = vi.fn(async () => {
      await historyWriteBlocked;
    });
    const upsertDocMeta = vi.fn(async () => {});
    const getDocMeta = vi.fn(async () => ({ meta: { latestUserMsgId: 'user-new' } }));
    const service = new SessionExecutionService(
      createBaseDeps({
        workspaceDocument: {
          repo: { upsertDocMeta, getDocMeta },
        } as unknown as LoroDocumentManager,
      })
    );
    const setDispatchHandled = (
      service as unknown as {
        setDispatchHandled: (
          sessionId: SessionId,
          doc: unknown,
          userTurnId: string
        ) => Promise<void>;
      }
    ).setDispatchHandled.bind(service);

    const completion = setDispatchHandled(
      'session-terminal-pointer' as SessionId,
      { updateHistory },
      'user-old'
    );
    await vi.waitFor(() => expect(updateHistory).toHaveBeenCalledTimes(1));
    releaseHistoryWrite();
    await completion;

    expect(upsertDocMeta).toHaveBeenCalledWith(expect.any(String), {
      lastHandledUserMsgId: 'user-old',
      processingUserMsgId: undefined,
    });
    expect(getDocMeta).not.toHaveBeenCalled();
  });

  it('keeps a steer that failed after submission out of the dispatch queue', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta, getDocMeta: vi.fn(async () => undefined) },
        getOrCreateSessionDoc: vi.fn(async () => ({ updateHistory: vi.fn(async () => {}) })),
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const sessionId = 'session-steer-ambiguous' as SessionId;
    // A plain failure after submission is ambiguous — the provider may already
    // have committed the steer, so re-sending it would duplicate the message.
    const steerPrompt = vi.fn(() => ({
      completion: new Promise(() => {}),
      applied: Promise.reject(new Error('Steer steer-1 completed before application')),
    }));
    const runtime = {
      sessionId,
      turnId: 'assistant:user-1',
      userTurnId: 'user-1',
      session: {
        agentClient: {
          getAcknowledgedSteerCapability: vi.fn(() => ({
            provider: 'claudeCode',
            appliedNotificationMethod: 'claude/steerApplied',
            upstreamTurn: 'handoff',
            configPolicy: 'apply',
          })),
          steerPrompt,
        },
        acpSessionId: 'acp-steer-ambiguous' as ACPSessionId,
      },
      promptInFlight: true,
      activePromptRun: { turnId: 'assistant:user-1' },
    };
    (
      service as unknown as {
        turnRuntimeBySession: Map<SessionId, typeof runtime>;
      }
    ).turnRuntimeBySession.set(sessionId, runtime);

    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-07-19T00:00:00.000Z',
        inputConfig: { prompt: 'do it differently' },
      })
    ).resolves.toMatchObject({ applied: false, disposition: 'error' });
    expect(upsertDocMeta).not.toHaveBeenCalled();
  });

  it('notifies when a prompt completes while a persistent goal remains active', async () => {
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-user-1',
        role: 'user',
        status: 'pending',
        read: false,
      },
    ];
    const activeGoal: SessionGoalMessage = {
      type: 'goal',
      threadId: 'thread-1',
      turnId: 'assistant-goal-1',
      objective: 'Keep working until explicitly complete',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 100,
      timeUsedSeconds: 60,
      createdAt: 100,
      updatedAt: 200,
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const activeSession = {
      sessionId: 'session-goal-active' as SessionId,
      acpSessionId: 'acp-goal-active' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-goal-active'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false, latestGoal: activeGoal })),
      setStatus: vi.fn(async () => {}),
      setLastMessageAt: vi.fn(async () => {}),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    };
    const notifySessionCompleted = vi.fn(async () => {});
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => activeSession),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        getOrOpenSessionCode: vi.fn(async () => null),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      turnFinalization: {
        ...createBaseDeps({}).turnFinalization,
        notifySessionCompleted,
      },
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-goal-active' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: '/goal Keep working', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(agentClient.prompt).toHaveBeenCalled();
    expect(history[0]?.status).toBe('handled');
    expect(notifySessionCompleted).toHaveBeenCalledTimes(1);
  });

  // An adapter that swallows an upstream failure (an over-context request answered
  // with HTTP 400 is the observed case) resolves the prompt as if the turn had
  // succeeded. Without the no-output guard that walked the whole success path and
  // left the user with an unanswered message and no error anywhere.
  const runSilentPromptTurn = async (options: {
    sessionId: string;
    hasPromptOutputForTurn: boolean;
  }) => {
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-user-1',
        role: 'user',
        status: 'pending',
        read: false,
      },
    ];
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      currentModel: undefined,
    };
    const activeSession = {
      sessionId: options.sessionId as SessionId,
      acpSessionId: 'acp-silent' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-silent'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setLastMessageAt: vi.fn(async () => {}),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    };
    const notifySessionCompleted = vi.fn(async () => {});
    const upsertDocMeta = vi.fn(async () => {});
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => activeSession),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      turnFinalization: {
        ...createBaseDeps({}).turnFinalization,
        notifySessionCompleted,
      },
      observePromptOutputForTurn: vi.fn(() => options.hasPromptOutputForTurn),
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: options.sessionId as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    return {
      deps,
      sessionDoc,
      notifySessionCompleted,
      upsertDocMeta,
      agentClient,
      getHistory: () => history,
    };
  };

  it('fails a turn whose prompt completed without emitting any agent output', async () => {
    const { deps, sessionDoc, notifySessionCompleted, upsertDocMeta, agentClient, getHistory } =
      await runSilentPromptTurn({
        sessionId: 'session-silent-turn',
        hasPromptOutputForTurn: false,
      });

    expect(agentClient.prompt).toHaveBeenCalled();
    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'agent_no_output',
      expect.stringContaining('without producing any output')
    );
    expect(getHistory()[0]?.status).toBe('failed');
    // Claiming the session finished would contradict the failure shown in chat.
    expect(notifySessionCompleted).not.toHaveBeenCalled();
    // The pointer still advances: the prompt was delivered, so re-dispatching it
    // would repeat the same silent failure forever.
    expect(upsertDocMeta).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        lastHandledUserMsgId: 'turn-user-1',
        processingUserMsgId: undefined,
      })
    );
  });

  it('leaves a turn that emitted agent output on the normal completion path', async () => {
    const { deps, notifySessionCompleted, getHistory } = await runSilentPromptTurn({
      sessionId: 'session-output-turn',
      hasPromptOutputForTurn: true,
    });

    expect(deps.recordChatFailure).not.toHaveBeenCalled();
    expect(getHistory()[0]?.status).toBe('handled');
    expect(notifySessionCompleted).toHaveBeenCalledTimes(1);
  });

  it('rejects a chat turn before prompt when memory pressure persists', async () => {
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-user-1',
        role: 'user',
        status: 'pending',
        read: false,
      },
    ];
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const activeSession = {
      sessionId: 'session-1' as SessionId,
      acpSessionId: 'acp-1' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-1'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    };
    const upsertDocMeta = vi.fn(async () => {});
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => activeSession),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      evictForMemoryPressure: vi.fn(async () => ({
        availableMemoryBytes: 64 * 1024 * 1024,
        thresholdBytes: 1024 * 1024 * 1024,
        hadMemoryPressure: true,
        stillUnderPressure: true,
        evictedSessionIds: [],
        pressureReason: 'physical',
      })),
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-1' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'memory_pressure',
      expect.stringContaining('The turn was not started')
    );
    expect(history[0]?.status).toBe('failed');
    expect(agentClient.prompt).not.toHaveBeenCalled();
    expect(deps.touchSession).toHaveBeenCalled();
    expect(upsertDocMeta).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        lastHandledUserMsgId: 'turn-user-1',
        processingUserMsgId: undefined,
      })
    );
  });

  it('exposes RPC invocation identity before prepared dispatch awaits machine access', async () => {
    let resolveAccess!: (value: {
      outcome: 'indeterminate';
      cause: 'network';
      error: string;
    }) => void;
    const accessPromise = new Promise<{
      outcome: 'indeterminate';
      cause: 'network';
      error: string;
    }>((resolve) => {
      resolveAccess = resolve;
    });
    const onAccessAllowed = vi.fn(async () => {});
    const onAccessDenied = vi.fn(async () => {});
    const onAccessIndeterminate = vi.fn(async () => {});
    const sessionDoc = {} as never;
    const deps = createBaseDeps({
      beginConversationTurn: vi.fn((_sessionId: SessionId, turn?: string) =>
        turn ? `assistant:${turn}` : 'turn-1'
      ),
    });
    const service = new SessionExecutionService(deps);

    const dispatchPromise = service.dispatchPreparedSessionTurn({
      sessionId: 'session-prepared-presence' as SessionId,
      sessionDoc,
      userTurnId: 'turn-prepared-presence',
      invocation: {
        sourceTurnId: 'turn-prepared-presence',
        requesterUserId: 'user-b',
        inputConfig: { prompt: 'fast path prompt', taskToolsEnabled: true },
      },
      dispatchSource: 'rpc',
      accessPromise,
      requestPromise: new Promise<never>(() => {}),
      onAccessAllowed,
      onAccessDenied,
      onAccessIndeterminate,
    });

    expect(deps.startSessionActivePresence).toHaveBeenCalledWith(
      'session-prepared-presence',
      'initializing'
    );
    expect(deps.beginConversationTurn).toHaveBeenCalledWith(
      'session-prepared-presence',
      'turn-prepared-presence',
      { dispatchSource: 'rpc', sessionDoc, deferACPUpdateTarget: true }
    );
    expect(service.getExecutionSnapshot('session-prepared-presence' as SessionId)).toMatchObject({
      activeTurnId: 'assistant:turn-prepared-presence',
      hasActiveTurn: true,
    });
    expect(service.getActiveInvocationContext('session-prepared-presence' as SessionId)).toEqual({
      requesterUserId: 'user-b',
      sourceTurnId: 'turn-prepared-presence',
      inputConfig: { prompt: 'fast path prompt', taskToolsEnabled: true },
    });
    expect(onAccessAllowed).not.toHaveBeenCalled();

    resolveAccess({ outcome: 'indeterminate', cause: 'network', error: 'offline' });
    await dispatchPromise;

    expect(onAccessIndeterminate).toHaveBeenCalledTimes(1);
    expect(onAccessDenied).not.toHaveBeenCalled();
    expect(deps.clearSessionActivePresence).toHaveBeenCalledWith('session-prepared-presence');
    expect(service.getExecutionSnapshot('session-prepared-presence' as SessionId)).toMatchObject({
      hasActiveTurn: false,
    });
  });

  it('cancels a prepared dispatch without waiting for unresolved machine access', async () => {
    const sessionId = 'session-prepared-cancel' as SessionId;
    const userTurnId = 'turn-prepared-cancel';
    const turnId = `assistant:${userTurnId}`;
    let history: Array<Record<string, unknown>> = [
      {
        id: userTurnId,
        role: 'user',
        items: [{ type: 'text', text: 'hello' }],
        status: 'pending',
        read: false,
      },
    ];
    const sessionDoc = {
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      setStatus: vi.fn(async () => {}),
    };
    const onAccessAllowed = vi.fn(async () => {});
    const onAccessDenied = vi.fn(async () => {});
    const onAccessIndeterminate = vi.fn(async () => {});
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      beginConversationTurn: vi.fn((_sessionId: SessionId, turn?: string) =>
        turn ? `assistant:${turn}` : 'turn-1'
      ),
    });
    const service = new SessionExecutionService(deps);

    const dispatchPromise = service.dispatchPreparedSessionTurn({
      sessionId,
      sessionDoc: sessionDoc as never,
      userTurnId,
      invocation: { sourceTurnId: userTurnId, inputConfig: {} },
      dispatchSource: 'crdt',
      accessPromise: new Promise<never>(() => {}),
      requestPromise: new Promise<never>(() => {}),
      onAccessAllowed,
      onAccessDenied,
      onAccessIndeterminate,
    });

    expect(service.getExecutionSnapshot(sessionId)).toMatchObject({
      activeTurnId: turnId,
      hasActiveTurn: true,
    });
    expect(() => service.getActiveInvocationContext(sessionId)).toThrow(
      'Active invocation identity is unavailable'
    );

    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId,
      })
    ).resolves.toEqual({ success: true });
    await dispatchPromise;

    expect(onAccessAllowed).not.toHaveBeenCalled();
    expect(onAccessDenied).not.toHaveBeenCalled();
    expect(onAccessIndeterminate).not.toHaveBeenCalled();
    expect(deps.clearSessionActivePresence).toHaveBeenCalledWith(sessionId);
    expect(deps.clearConversationTurn).toHaveBeenCalledWith(sessionId, turnId);
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    expect(history[0]).toMatchObject({ id: userTurnId, status: 'canceled' });
    expect(service.getExecutionSnapshot(sessionId)).toMatchObject({
      hasActiveTurn: false,
    });
  });

  it('cancels a prepared dispatch after access is allowed without creating a second turn', async () => {
    const sessionId = 'session-prepared-request-cancel' as SessionId;
    const userTurnId = 'turn-prepared-request-cancel';
    const turnId = `assistant:${userTurnId}`;
    let preparedHistory: Array<Record<string, unknown>> = [
      {
        id: userTurnId,
        role: 'user',
        items: [{ type: 'text', text: 'hello' }],
        status: 'pending',
        read: false,
      },
    ];
    const preparedSessionDoc = {
      getHistory: vi.fn(async () => preparedHistory),
      updateHistory: vi.fn(
        async (updater: (prev: typeof preparedHistory) => typeof preparedHistory) => {
          preparedHistory = updater(preparedHistory);
        }
      ),
      setStatus: vi.fn(async () => {}),
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => {}),
      currentModel: undefined,
    };
    const activeSession = {
      sessionId,
      acpSessionId: 'acp-prepared-request-cancel' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-prepared-request-cancel'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => activeSession),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => preparedSessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      beginConversationTurn: vi.fn((_sessionId: SessionId, turn?: string) =>
        turn ? `assistant:${turn}` : 'turn-1'
      ),
    });
    let accessAllowed!: () => void;
    const accessAllowedPromise = new Promise<void>((resolve) => {
      accessAllowed = resolve;
    });
    const onAccessAllowed = vi.fn(async () => {
      accessAllowed();
    });
    const service = new SessionExecutionService(deps);

    const dispatchPromise = service.dispatchPreparedSessionTurn({
      sessionId,
      sessionDoc: preparedSessionDoc as never,
      userTurnId,
      invocation: { sourceTurnId: userTurnId, inputConfig: {} },
      dispatchSource: 'rpc',
      accessPromise: Promise.resolve({ outcome: 'allowed' as const }),
      requestPromise: new Promise<never>(() => {}),
      onAccessAllowed,
      onAccessDenied: vi.fn(async () => {}),
      onAccessIndeterminate: vi.fn(async () => {}),
    });

    await accessAllowedPromise;
    expect(onAccessAllowed).toHaveBeenCalledTimes(1);
    expect(deps.beginConversationTurn).toHaveBeenCalledWith(sessionId, userTurnId, {
      dispatchSource: 'rpc',
      sessionDoc: preparedSessionDoc,
      deferACPUpdateTarget: true,
    });

    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId,
      })
    ).resolves.toEqual({ success: true });
    await vi.waitFor(() => {
      expect(deps.clearSessionActivePresence).toHaveBeenCalledWith(sessionId);
    });

    await dispatchPromise;
    await Promise.resolve();

    expect(deps.beginConversationTurn).toHaveBeenCalledTimes(1);
    expect(agentClient.prompt).not.toHaveBeenCalled();
    expect(preparedHistory[0]).toMatchObject({ id: userTurnId, status: 'canceled' });
    expect(service.getExecutionSnapshot(sessionId)).toMatchObject({
      hasActiveTurn: false,
    });
  });

  it('marks the session idle immediately after the prompt resolves', async () => {
    const events: string[] = [];
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-user-1',
        role: 'user',
        status: 'pending',
        read: false,
      },
    ];
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => {
        events.push('prompt-resolved');
      }),
      currentModel: undefined,
    };
    const activeSession = {
      sessionId: 'session-1' as SessionId,
      acpSessionId: 'acp-1' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-1'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async (status: { type: string }) => {
        events.push(`status:${status.type}`);
      }),
      waitUntilSynced: vi.fn(async () => {}),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    };
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => activeSession),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      startSessionActivePresence: vi.fn(() => {
        events.push('active-start');
      }),
      clearSessionActivePresence: vi.fn(() => {
        events.push('active-clear');
      }),
      activateConversationTurnForACPUpdates: vi.fn(() => {
        events.push('activate-acp-target');
      }),
      syncLiveActivitySummary: vi.fn(async () => {
        events.push('live-activity-sync');
      }),
      turnFinalization: {
        ...createBaseDeps({}).turnFinalization,
        finalizeACPState: vi.fn(async () => {
          events.push('finalize-acp');
        }),
      },
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-1' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    const promptResolvedAt = events.indexOf('prompt-resolved');
    const acpTargetActivatedAt = events.indexOf('activate-acp-target');
    const activeClearedAt = events.indexOf('active-clear');
    const idleAfterPromptAt = events.indexOf('status:idle');
    const finalizeStartedAt = events.indexOf('finalize-acp');

    expect(acpTargetActivatedAt).toBeGreaterThanOrEqual(0);
    expect(promptResolvedAt).toBeGreaterThanOrEqual(0);
    expect(acpTargetActivatedAt).toBeLessThan(promptResolvedAt);
    expect(idleAfterPromptAt).toBeGreaterThan(promptResolvedAt);
    expect(finalizeStartedAt).toBeGreaterThan(idleAfterPromptAt);
    expect(activeClearedAt).toBeGreaterThan(finalizeStartedAt);
  });

  it('restores and retries a stale in-memory ACP session when the connection is closed', async () => {
    const sessionId = 'session-stale-acp' as SessionId;
    const acpSessionId = 'acp-stale' as ACPSessionId;
    const restoredAcpSessionId = 'acp-restored' as ACPSessionId;
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-user-1',
        role: 'user',
        status: 'pending',
        read: false,
      },
    ];
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => {
        throw new Error('ACP connection closed');
      }),
      currentModel: undefined,
    };
    const restoredAgentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const exec = vi.fn(async (command: string, args: string[]) => {
      const key = `${command} ${args.join(' ')}`;
      if (key === 'git rev-parse --is-inside-work-tree') return 'true\n';
      if (key === 'git rev-parse HEAD') return 'abc123\n';
      return '';
    });
    const activeSession = {
      sessionId,
      acpSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec,
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => acpSessionId),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const restoredSession = {
      ...activeSession,
      acpSessionId: restoredAcpSessionId,
      agentClient: restoredAgentClient,
      createAgent: vi.fn(async () => restoredAcpSessionId),
    };
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      waitUntilSynced: vi.fn(async () => {}),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    };
    const deps = createBaseDeps({});
    const sessionManager = deps.sessionManager as unknown as {
      getSession: ReturnType<typeof vi.fn>;
      terminateSession: ReturnType<typeof vi.fn>;
      createSession: ReturnType<typeof vi.fn>;
    };
    const workspaceDocument = deps.workspaceDocument as unknown as {
      getOrCreateSessionDoc: ReturnType<typeof vi.fn>;
    };
    sessionManager.getSession.mockReturnValue(activeSession);
    sessionManager.createSession.mockResolvedValue(restoredSession);
    workspaceDocument.getOrCreateSessionDoc.mockResolvedValue(sessionDoc);

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(agentClient.prompt).toHaveBeenCalledWith(
      'acp-stale',
      [{ type: 'text', text: 'hello' }],
      {
        signal: expect.any(AbortSignal),
      }
    );
    expect(sessionManager.terminateSession).toHaveBeenCalledWith(sessionId, true);
    expect(sessionManager.createSession).toHaveBeenCalled();
    expect(restoredAgentClient.prompt).toHaveBeenCalledWith(
      'acp-restored',
      [{ type: 'text', text: 'hello' }],
      {
        signal: expect.any(AbortSignal),
      }
    );
    expect(deps.recordChatFailure).not.toHaveBeenCalled();
    expect(history[0]?.status).toBe('handled');
  });

  it('does not write legacy code-session tags when Code Collab is enabled for new turns', async () => {
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-user-1',
        role: 'user',
        status: 'pending',
        read: false,
      },
    ];
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      const key = args.join(' ');
      if (key === 'rev-parse --is-inside-work-tree') return 'true\n';
      if (key === 'rev-parse HEAD') return 'abc123\n';
      return '';
    });
    const activeSession = {
      sessionId: 'session-1' as SessionId,
      acpSessionId: 'acp-1' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec,
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-1'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    };
    const refreshCodeCollabSharedState = vi.fn(async () => {});
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => activeSession),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      turnFinalization: {
        finalizeACPState: vi.fn(async () => {}),
        flushSessionUsage: vi.fn(async () => {}),
        syncSessionBranchName: vi.fn(async () => 'feat/test'),
        updateSessionDiffStats: vi.fn(async () => [{ filePath: 'src/a.ts', add: 1, del: 0 }]),
        refreshCodeCollabSharedState,
        detectAndAssociatePR: vi.fn(async () => ({ baseBranch: 'release/v2' })),
        autoCommitAndPushForPR: vi.fn(async () => {}),
        notifySessionCompleted: vi.fn(async () => {}),
      },
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-1' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(deps.turnFinalization.updateSessionDiffStats).toHaveBeenCalledWith(
      'session-1',
      activeSession,
      expect.objectContaining({
        baseCommitHash: 'abc123',
        preferredBaseBranch: 'release/v2',
      })
    );
    expect(deps.turnFinalization.autoCommitAndPushForPR).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredBaseBranch: 'release/v2',
      })
    );
    expect(refreshCodeCollabSharedState).toHaveBeenCalledWith('session-1');
  });

  it('starts a local project session creation', async () => {
    const localProjectId = 'local-project-1' as LocalProjectId;
    const machineId = 'machine-1' as MachineId;
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ agentConfigId: capabilityConfigId })),
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-local-code-collab',
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-local-code-collab' as SessionId,
      acpSessionId: 'acp-local-code-collab' as ACPSessionId,
      agentClient,
      getAcpCapabilities: () => ({
        modes: [{ id: 'agent', name: 'Agent' }],
        models: [{ modelId: 'gpt-5', name: 'GPT-5' }],
        configOptions: [
          {
            id: 'reasoning',
            name: 'Reasoning',
            category: 'thought_level',
            type: 'select' as const,
            currentValue: 'high',
            options: [{ value: 'high', name: 'High' }],
          },
        ],
        availableCommands: [{ name: 'review', description: 'Review changes' }],
        sessionFork: false,
        acknowledgedSteer: true,
      }),
      terminalManager: {} as unknown,
      getWorkdir: () => '/local/repo',
      getHostWorkdir: () => '/local/repo',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-local-code-collab'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async () => createdSession as unknown),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const getDocMeta = vi.fn(async (roomId: string) => {
      if (roomId !== getMachineRoomId(machineId)) return undefined;
      return {
        meta: {
          localProjects: {
            [localProjectId]: {
              id: localProjectId,
              name: 'Local Project',
              rootPath: '/local/repo',
              createdAtMs: 1,
            },
          },
        },
      };
    });
    const updateAcpCapabilities = vi.fn(async () => {});
    const deps = createBaseDeps({
      machineId,
      sessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta,
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        getAcpCapabilities: vi.fn(async () => undefined),
        updateAcpCapabilities,
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'built prompt' }] as any),
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-local-code-collab' as SessionId,
      machineId,
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'local', localProjectId },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-local-code-collab',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    expect(sessionManager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workdir: '/local/repo',
        project: { kind: 'local', localProjectId },
      })
    );
    await vi.waitFor(() =>
      expect(updateAcpCapabilities).toHaveBeenCalledWith(
        machineId,
        capabilityConfigId,
        'builtin',
        'codex',
        [{ id: 'agent', name: 'Agent' }],
        [{ modelId: 'gpt-5', name: 'GPT-5' }],
        [
          {
            id: 'reasoning',
            name: 'Reasoning',
            category: 'thought_level',
            type: 'select',
            currentValue: 'high',
            options: [{ value: 'high', name: 'High' }],
          },
        ],
        [{ name: 'review', description: 'Review changes' }],
        false,
        expect.any(String),
        // Per-model reasoning efforts: absent for this agent, which publishes no
        // legacy `model[effort]` combination list.
        undefined,
        true
      )
    );
  });

  it('rejects session creation before spawning an agent when memory pressure persists', async () => {
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-user-1',
        role: 'user',
        status: 'pending',
        read: false,
      },
    ];
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      roomId: 'session-session-1',
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-1' as SessionId,
      acpSessionId: 'acp-1' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-1'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const createSession = vi.fn(async () => createdSession as unknown);
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      evictForMemoryPressure: vi.fn(async () => ({
        availableMemoryBytes: 128 * 1024 * 1024,
        thresholdBytes: 1024 * 1024 * 1024,
        hadMemoryPressure: true,
        stillUnderPressure: true,
        evictedSessionIds: [],
        pressureReason: 'physical',
      })),
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-1' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'memory_pressure',
      expect.stringContaining('The turn was not started')
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(agentClient.prompt).not.toHaveBeenCalled();
    expect(history[0]?.status).toBe('failed');
    expect(sessionDoc.setStatus.mock.calls.map(([status]) => status)).toEqual([
      SessionStatusFactory.idle(),
      SessionStatusFactory.idle(),
    ]);
  });

  it('starts create prompt block building only after session creation registers the workspace', async () => {
    const events: string[] = [];
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-user-1',
        role: 'user',
        status: 'pending',
        read: false,
      },
    ];
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      roomId: 'session-session-create-dag',
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => {
        events.push('prompt');
        return {};
      }),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-create-dag' as SessionId,
      acpSessionId: 'acp-create-dag' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-create-dag'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    let activeSession: typeof createdSession | null = null;
    let releaseCreateSession!: () => void;
    const createSessionGate = new Promise<void>((resolve) => {
      releaseCreateSession = resolve;
    });
    const createSession = vi.fn(async () => {
      events.push('create-start');
      await createSessionGate;
      activeSession = createdSession;
      events.push('create-resolved');
      return createdSession as unknown;
    });
    const buildAcpPromptBlocks = vi.fn(async () => {
      expect(activeSession).toBe(createdSession);
      events.push('build-blocks');
      return [{ type: 'text', text: 'built prompt' }] as any;
    });
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => activeSession),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks,
    });

    const service = new SessionExecutionService(deps);
    const startPromise = service.startSession({
      type: 'session/create',
      sessionId: 'session-create-dag' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    try {
      await vi.waitFor(() => {
        expect(createSession).toHaveBeenCalledTimes(1);
        expect(events).toContain('create-start');
      });
      expect(buildAcpPromptBlocks).not.toHaveBeenCalled();
      expect(events).not.toContain('create-resolved');
      expect(agentClient.prompt).not.toHaveBeenCalled();
    } finally {
      releaseCreateSession();
    }

    await startPromise;

    expect(events.indexOf('build-blocks')).toBeGreaterThan(events.indexOf('create-resolved'));
    expect(agentClient.prompt).toHaveBeenCalledWith(
      'acp-create-dag',
      [{ type: 'text', text: 'built prompt' }],
      { signal: expect.any(AbortSignal) }
    );
  });

  it('passes file input blocks to the prompt builder when starting a session', async () => {
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-user-file',
        role: 'user',
        status: 'pending',
        read: false,
      },
    ];
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      roomId: 'session-session-file-create',
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-file-create' as SessionId,
      acpSessionId: 'acp-file-create' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-file-create'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const fileBlock = {
      type: 'file',
      fileId: 'file-12345678',
      fileName: 'trace.json',
      mimeType: 'application/json',
      sizeBytes: 1024,
      sha256: 'a'.repeat(64),
      textPreview: true,
      transport: 'r2',
      uploadedAt: 123,
    } satisfies Extract<SessionInputBlock, { type: 'file' }>;
    const buildAcpPromptBlocks = vi.fn(
      async (): Promise<ContentBlock[]> => [{ type: 'text', text: 'built prompt' }]
    );
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(async () => createdSession as unknown),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks,
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-file-create' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: {
        prompt: 'inspect the attached trace',
        inputBlocks: [{ type: 'text', text: 'inspect the attached trace' }, fileBlock],
        cliType: 'builtin',
        agentType: 'codex',
      },
      userTurnId: 'turn-user-file',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(buildAcpPromptBlocks).toHaveBeenCalledTimes(1);
    const promptArgs = buildAcpPromptBlocks.mock.calls[0]?.[0];
    expect(promptArgs).toMatchObject({
      workspaceId: 'workspace-1',
      sessionId: 'session-file-create',
    });
    expect(promptArgs?.inputBlocks).toContainEqual(fileBlock);
    const textBlocks = promptArgs?.inputBlocks.filter((block) => block.type === 'text') ?? [];
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]?.text).toContain('inspect the attached trace');
  });

  it('restores a missing session for chat using stored ACP session id', async () => {
    const meta = {
      repoFullName: 'owner/repo',
      acpSessionId: 'acp-1' as ACPSessionId,
      branchName: 'feat/resume',
      parentSessionId: 'parent-session-1' as SessionId,
      isArchived: false,
    };
    let history: unknown[] = [];
    const sessionDoc = {
      getMetaState: vi.fn(async () => meta),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
    };

    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const restoredSession = {
      sessionId: 'session-1' as SessionId,
      acpSessionId: 'acp-1' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-1'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };

    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async (config, agentStart) => {
        expect(config.sessionId).toBe('session-1');
        expect(config.resume).toBe(true);
        expect(config.githubRepo).toBe('owner/repo');
        expect(config.restoreBranchName).toBe('feat/resume');
        expect(config.parentSessionId).toBe('parent-session-1');
        expect(agentStart?.resumeSessionId).toBe('acp-1');
        return restoredSession as unknown;
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;

    const deps = createBaseDeps({
      sessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'hi' }] as any),
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-1' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(sessionDoc.setStatus).toHaveBeenCalledWith(
      SessionStatusFactory.initializing('resuming')
    );
    expect(sessionDoc.setStatus.mock.calls.map(([status]) => status)).toEqual([
      SessionStatusFactory.initializing(),
      SessionStatusFactory.initializing('resuming'),
      SessionStatusFactory.running(),
      SessionStatusFactory.idle(),
    ]);
    expect(sessionDoc.setBaseBranch).toHaveBeenCalledWith('main');
    expect(agentClient.prompt).toHaveBeenCalledWith('acp-1', [{ type: 'text', text: 'hi' }], {
      signal: expect.any(AbortSignal),
    });
    expect(deps.startSessionActivePresence).toHaveBeenCalledTimes(1);
    expect(deps.startSessionActivePresence).toHaveBeenCalledWith('session-1', 'initializing');
    expect(deps.clearSessionActivePresence).toHaveBeenCalledTimes(1);
  });

  it('replays durable history when a fresh ACP restore has no resumable session id', async () => {
    const meta = {
      repoFullName: 'owner/repo',
      isArchived: false,
    };
    let history: SessionHistoryInput[] = [
      {
        id: 'turn-startup-failed',
        role: 'user',
        timestamp: '2026-08-05T05:30:00.000Z',
        status: 'failed',
        fileDiff: [],
        items: [{ type: 'text', text: 'Build this on the two MIT packages.' }],
      },
      {
        id: 'turn-current',
        role: 'user',
        timestamp: '2026-08-05T05:31:00.000Z',
        status: 'pending',
        fileDiff: [],
        items: [{ type: 'text', text: '?' }],
      },
    ];
    const sessionDoc = {
      getMetaState: vi.fn(async () => meta),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(
        async (updater: (prev: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = updater(history);
        }
      ),
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const restoredSession = {
      sessionId: 'session-fresh-restore' as SessionId,
      acpSessionId: 'acp-fresh-restore' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-fresh-restore'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const buildAcpPromptBlocks = vi.fn(async () => [{ type: 'text', text: 'built prompt' }] as any);
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(async () => restoredSession as unknown),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks,
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-fresh-restore' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: '?', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-current',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(buildAcpPromptBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        replayPromptText: expect.stringContaining('Build this on the two MIT packages.'),
      })
    );
    expect(buildAcpPromptBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        replayPromptText: expect.not.stringContaining('[User]\n?'),
      })
    );
    expect(agentClient.prompt).toHaveBeenCalledWith(
      'acp-fresh-restore',
      [{ type: 'text', text: 'built prompt' }],
      { signal: expect.any(AbortSignal) }
    );
  });

  it('resumes a worktree without resolving its deleted recorded base branch', async () => {
    const rootPath = createGitLocalProject();
    runGit(rootPath, ['remote', 'add', 'origin', 'https://github.com/example/project.git']);
    const remoteCommit = runGit(rootPath, ['rev-parse', 'main']);
    runGit(rootPath, ['update-ref', 'refs/remotes/origin/remote-base', remoteCommit]);
    runGit(rootPath, ['checkout', '-b', 'lody-session-restore', 'refs/remotes/origin/remote-base']);
    fs.writeFileSync(path.join(rootPath, 'session-change.txt'), 'session change\n', 'utf8');
    runGit(rootPath, ['add', 'session-change.txt']);
    runGit(rootPath, ['commit', '-m', 'session change']);
    runGit(rootPath, ['update-ref', 'refs/remotes/origin/foo', remoteCommit]);
    runGit(rootPath, ['checkout', '--track', '-b', 'other', 'refs/remotes/origin/foo']);
    runGit(rootPath, ['update-ref', '-d', 'refs/remotes/origin/remote-base']);
    const localProjectId = 'local-project-restore' as LocalProjectId;
    const project = {
      kind: 'local' as const,
      localProjectId,
      branch: 'remote-base',
      githubRepoFullName: 'example/project',
      useWorktree: true,
    };
    const meta = {
      project,
      baseBranch: 'refs/remotes/origin/remote-base',
      branchName: 'lody-session-restore',
      acpSessionId: 'acp-local-restore' as ACPSessionId,
      isWorktree: true,
      isArchived: false,
    };
    let history: unknown[] = [];
    const sessionDoc = {
      getMetaState: vi.fn(async () => meta),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const restoredSession = {
      sessionId: 'session-local-restore' as SessionId,
      acpSessionId: 'acp-local-restore' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => rootPath,
      getHostWorkdir: () => rootPath,
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-local-restore'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const createSession = vi.fn(async (config) => {
      expect(config.workdir).toBe(rootPath);
      expect(config.branch).toBe('remote-base');
      expect(config.resume).toBe(true);
      expect(runGit(rootPath, ['symbolic-ref', '--short', 'HEAD'])).toBe('other');
      return restoredSession as unknown;
    });
    const upsertDocMeta = vi.fn(async () => {});
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta: {
              localProjects: {
                [localProjectId]: {
                  id: localProjectId,
                  name: 'Local Project',
                  rootPath,
                  createdAtMs: 1,
                },
              },
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'continue' }] as any),
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-local-restore' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project,
      acpSessionConfig: { prompt: 'continue', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-local-restore',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).toHaveBeenCalledOnce();
    expect(sessionDoc.setBaseBranch).not.toHaveBeenCalled();
    expect(upsertDocMeta).not.toHaveBeenCalledWith(
      'session-session-local-restore',
      expect.objectContaining({ baseBranch: expect.anything() })
    );
    expect(deps.turnFinalization.updateSessionDiffStats).toHaveBeenCalledWith(
      'session-local-restore',
      restoredSession,
      expect.objectContaining({ preferredBaseBranch: 'refs/remotes/origin/remote-base' })
    );
  });

  it('resumes a non-worktree local project on its current dirty branch without checkout', async () => {
    const rootPath = createGitLocalProject();
    runGit(rootPath, ['remote', 'add', 'origin', 'https://github.com/example/project.git']);
    const remoteCommit = runGit(rootPath, ['rev-parse', 'main']);
    runGit(rootPath, ['update-ref', 'refs/remotes/origin/foo', remoteCommit]);
    runGit(rootPath, ['checkout', '--track', '-b', 'session-branch', 'refs/remotes/origin/foo']);
    runGit(rootPath, ['checkout', 'main']);
    fs.writeFileSync(path.join(rootPath, 'README.md'), 'dirty local change\n', 'utf8');

    const localProjectId = 'local-project-tracking-restore' as LocalProjectId;
    const project = {
      kind: 'local' as const,
      localProjectId,
      branch: 'foo',
      githubRepoFullName: 'example/project',
      useWorktree: false,
    };
    let meta = {
      project,
      baseBranch: 'foo',
      branchName: 'session-branch',
      acpSessionId: 'acp-local-tracking-restore' as ACPSessionId,
      isWorktree: false,
      isArchived: false,
    };
    let history: unknown[] = [];
    const sessionDoc = {
      getMetaState: vi.fn(async () => meta),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const restoredSession = {
      sessionId: 'session-local-tracking-restore' as SessionId,
      acpSessionId: 'acp-local-tracking-restore' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => rootPath,
      getHostWorkdir: () => rootPath,
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-local-tracking-restore'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const createSession = vi.fn(async (config) => {
      expect(config.workdir).toBe(rootPath);
      expect(config.branch).toBe('foo');
      expect(config.resume).toBe(true);
      expect(runGit(rootPath, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
      expect(fs.readFileSync(path.join(rootPath, 'README.md'), 'utf8')).toBe(
        'dirty local change\n'
      );
      return restoredSession as unknown;
    });
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch };
    });
    const persistPendingChanges = vi.fn(async () => {});
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta: {
              localProjects: {
                [localProjectId]: {
                  id: localProjectId,
                  name: 'Local Project',
                  rootPath,
                  createdAtMs: 1,
                },
              },
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
        persistPendingChanges,
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'continue' }] as any),
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-local-tracking-restore' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project,
      acpSessionConfig: { prompt: 'continue', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-local-tracking-restore',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).toHaveBeenCalledOnce();
    expect(sessionDoc.setBaseBranch).not.toHaveBeenCalled();
    expect(upsertDocMeta).not.toHaveBeenCalledWith(
      'session-session-local-tracking-restore',
      expect.objectContaining({ baseBranch: expect.anything() })
    );
    expect(persistPendingChanges).not.toHaveBeenCalledWith('session-local-base-ref');
    expect(deps.turnFinalization.updateSessionDiffStats).toHaveBeenCalledWith(
      'session-local-tracking-restore',
      restoredSession,
      expect.objectContaining({ preferredBaseBranch: 'foo' })
    );
  });

  it('releases ACP replay suppression when a restore turn is interrupted before prompt', async () => {
    let createStarted!: () => void;
    const createStartedPromise = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    let resolveCreateSession!: (session: unknown) => void;
    const createSessionPromise = new Promise<unknown>((resolve) => {
      resolveCreateSession = resolve;
    });
    let meta: Record<string, unknown> = {};
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch };
    });
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({
        repoFullName: 'owner/repo',
        acpSessionId: 'acp-restore-interrupt' as ACPSessionId,
        isArchived: false,
      })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => []),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-restore-interrupt',
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const restoredSession = {
      sessionId: 'session-restore-interrupt' as SessionId,
      acpSessionId: 'acp-restore-interrupt' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-restore-interrupt'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(() => {
        createStarted();
        return createSessionPromise;
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn(() => 'assistant-restore-interrupt'),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta,
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      processMessageQueue: vi.fn(async () => {}),
    });

    const service = new SessionExecutionService(deps);
    const continuePromise = service.continueSession({
      type: 'session/chat',
      sessionId: 'session-restore-interrupt' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-restore-interrupt',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    await createStartedPromise;
    expect(deps.beginACPReplaySuppression).toHaveBeenCalledTimes(1);

    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId: 'session-restore-interrupt' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant-restore-interrupt',
      })
    ).resolves.toEqual({ success: true });
    await continuePromise;

    expect(deps.endACPReplaySuppression).toHaveBeenCalledTimes(1);
    expect(agentClient.prompt).not.toHaveBeenCalled();
    expect(deps.processMessageQueue).not.toHaveBeenCalled();

    resolveCreateSession(restoredSession);
    await vi.waitFor(() => {
      expect(restoredSession.terminate).toHaveBeenCalledWith(true);
    });
  });

  it('creates and starts a new session turn', async () => {
    const sessionDoc = {
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-2',
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-2' as SessionId,
      acpSessionId: 'acp-2' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-2'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async () => createdSession as unknown),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const upsertDocMeta = vi.fn(async () => {});
    const deps = createBaseDeps({
      sessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'built prompt' }] as any),
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-2' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-create-1',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
      parentSessionId: 'parent-session-2' as SessionId,
    });

    expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'parent-session-2',
        requesterUserId: 'user-2',
      })
    );
    expect(sessionDoc.setStatus.mock.calls.map(([status]) => status).slice(0, 3)).toEqual([
      SessionStatusFactory.initializing(),
      SessionStatusFactory.initializing('git-clone'),
      SessionStatusFactory.running(),
    ]);
    expect(agentClient.prompt).toHaveBeenCalledWith(
      'acp-2',
      [{ type: 'text', text: 'built prompt' }],
      { signal: expect.any(AbortSignal) }
    );
    expect(deps.turnFinalization.notifySessionCompleted).toHaveBeenCalledWith(
      'session-2',
      'user-2',
      'turn-1'
    );
    expect(deps.startSessionActivePresence).toHaveBeenCalledTimes(1);
    expect(deps.startSessionActivePresence).toHaveBeenCalledWith('session-2', 'initializing');
    expect(deps.clearSessionActivePresence).toHaveBeenCalledTimes(1);
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(
      SessionStatusFactory.initializing(),
      expect.objectContaining({
        latestUserMsgId: 'turn-create-1',
        baseBranch: 'main',
      })
    );
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-2', {
      processingUserMsgId: 'turn-create-1',
    });
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-2', {
      lastHandledUserMsgId: 'turn-create-1',
      processingUserMsgId: undefined,
    });
  });

  it('checks out the requested local project branch on the target machine before creating a session', async () => {
    const rootPath = createGitLocalProject();
    const localProjectId = 'local-project-branch' as LocalProjectId;
    const project = {
      kind: 'local' as const,
      localProjectId,
      branch: 'feature/remote-local',
    };
    const sessionDoc = {
      // This is the metadata createSessionResult writes before it dispatches
      // session/create. It identifies the project but has no ACP session yet.
      getMetaState: vi.fn(async () => ({
        id: 'session-local-project-branch' as SessionId,
        machineId: 'machine-1' as MachineId,
        createdAt: '2026-08-24T00:00:00.000Z',
        userId: 'user-1',
        status: SessionStatusFactory.idle(),
        isArchived: false,
        cliType: 'builtin' as const,
        agentType: 'codex' as const,
        agentConfigId: capabilityConfigId,
        project,
        latestUserMsgId: 'turn-local-branch',
      })),
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-local-project-branch',
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-local-project-branch' as SessionId,
      acpSessionId: 'acp-local-project-branch' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => rootPath,
      getHostWorkdir: () => rootPath,
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-local-project-branch'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const createSession = vi.fn(async (config) => {
      expect(config.workdir).toBe(rootPath);
      expect(config.branch).toBe('feature/remote-local');
      expect(runGit(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature/remote-local');
      return createdSession as unknown;
    });
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      if (patch.baseBranch === 'refs/heads/feature/remote-local') {
        expect(runGit(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
      }
    });
    const persistPendingChanges = vi.fn(async () => {
      expect(runGit(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    });
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta: {
              localProjects: {
                [localProjectId]: {
                  id: localProjectId,
                  name: 'Local Project',
                  rootPath,
                  createdAtMs: 1,
                },
              },
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        getOrOpenSessionCode: vi.fn(async () => null),
        updateAcpCapabilities: vi.fn(async () => {}),
        persistPendingChanges,
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'hello' }] as any),
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-local-project-branch' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-local-branch',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(
      SessionStatusFactory.initializing(),
      expect.not.objectContaining({ baseBranch: expect.anything() })
    );
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-local-project-branch', {
      baseBranch: 'refs/heads/feature/remote-local',
    });
    expect(persistPendingChanges).toHaveBeenCalledWith('session-local-base-ref');
    expect(deps.recordChatFailure).not.toHaveBeenCalled();
  });

  it('does not reuse a diverged tracking branch for a new local project session', async () => {
    const rootPath = createGitLocalProject();
    runGit(rootPath, ['remote', 'add', 'origin', 'https://github.com/example/project.git']);
    const remoteCommit = runGit(rootPath, ['rev-parse', 'main']);
    runGit(rootPath, ['update-ref', 'refs/remotes/origin/foo', remoteCommit]);
    runGit(rootPath, ['checkout', '--track', '-b', 'foo', 'refs/remotes/origin/foo']);
    fs.writeFileSync(path.join(rootPath, 'old-session.txt'), 'old session\n', 'utf8');
    runGit(rootPath, ['add', 'old-session.txt']);
    runGit(rootPath, ['commit', '-m', 'old session']);

    const localProjectId = 'local-project-diverged-tracking' as LocalProjectId;
    const sessionDoc = {
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-local-project-diverged-tracking',
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-local-project-diverged-tracking' as SessionId,
      acpSessionId: 'acp-local-project-diverged-tracking' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => rootPath,
      getHostWorkdir: () => rootPath,
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-local-project-diverged-tracking'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const createSession = vi.fn(async (config) => {
      expect(config.branch).not.toBe('foo');
      expect(runGit(rootPath, ['rev-parse', 'HEAD'])).toBe(remoteCommit);
      expect(fs.existsSync(path.join(rootPath, 'old-session.txt'))).toBe(false);
      return createdSession as unknown;
    });
    const persistPendingChanges = vi.fn(async () => {
      expect(runGit(rootPath, ['symbolic-ref', '--short', 'HEAD'])).toBe('foo');
    });
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => ({
            meta: {
              localProjects: {
                [localProjectId]: {
                  id: localProjectId,
                  name: 'Local Project',
                  rootPath,
                  createdAtMs: 1,
                },
              },
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        getOrOpenSessionCode: vi.fn(async () => null),
        updateAcpCapabilities: vi.fn(async () => {}),
        persistPendingChanges,
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'hello' }] as any),
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-local-project-diverged-tracking' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: {
        kind: 'local',
        localProjectId,
        branch: 'lody:branch:remote:origin:foo',
      },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-local-diverged-tracking',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).toHaveBeenCalledOnce();
    expect(persistPendingChanges).toHaveBeenCalledWith('session-local-base-ref');
    expect(deps.recordChatFailure).not.toHaveBeenCalled();
  });

  it('fails a local project branch switch on a dirty target worktree', async () => {
    const rootPath = createGitLocalProject();
    fs.writeFileSync(path.join(rootPath, 'dirty.txt'), 'dirty\n', 'utf8');
    const localProjectId = 'local-project-dirty' as LocalProjectId;
    const sessionDoc = {
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-local-project-dirty',
    };
    const createSession = vi.fn();
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => ({
            meta: {
              localProjects: {
                [localProjectId]: {
                  id: localProjectId,
                  name: 'Dirty Local Project',
                  rootPath,
                  createdAtMs: 1,
                },
              },
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        getOrOpenSessionCode: vi.fn(async () => null),
        updateAcpCapabilities: vi.fn(async () => {}),
        persistPendingChanges: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-local-project-dirty' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'local', localProjectId, branch: 'feature/remote-local' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-local-dirty',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).not.toHaveBeenCalled();
    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'turn_pre_prompt_failed',
      expect.stringContaining('Cannot switch branches with local changes')
    );
  });

  it('uses the current dirty branch when initializing an existing direct local session', async () => {
    const rootPath = createGitLocalProject();
    fs.writeFileSync(path.join(rootPath, 'dirty.txt'), 'dirty\n', 'utf8');
    const localProjectId = 'local-project-existing-dirty' as LocalProjectId;
    const project = {
      kind: 'local' as const,
      localProjectId,
      branch: 'feature/remote-local',
    };
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({
        project,
        acpSessionId: 'acp-local-project-existing-dirty' as ACPSessionId,
      })),
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-local-project-existing-dirty',
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-local-project-existing-dirty' as SessionId,
      acpSessionId: 'acp-local-project-existing-dirty' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => rootPath,
      getHostWorkdir: () => rootPath,
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-local-project-existing-dirty'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const createSession = vi.fn(async (config) => {
      expect(config.project).toEqual({ kind: 'local', localProjectId });
      expect(config.branch).toBeUndefined();
      expect(runGit(rootPath, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
      expect(fs.readFileSync(path.join(rootPath, 'dirty.txt'), 'utf8')).toBe('dirty\n');
      return createdSession as unknown;
    });
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => ({
            meta: {
              localProjects: {
                [localProjectId]: {
                  id: localProjectId,
                  name: 'Existing Dirty Local Project',
                  rootPath,
                  createdAtMs: 1,
                },
              },
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        getOrOpenSessionCode: vi.fn(async () => null),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-local-project-existing-dirty' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-local-existing-dirty',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).toHaveBeenCalledOnce();
    expect(deps.recordChatFailure).not.toHaveBeenCalled();
    expect(runGit(rootPath, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(fs.readFileSync(path.join(rootPath, 'dirty.txt'), 'utf8')).toBe('dirty\n');
  });

  it('records an actionable diagnostic when Git is unavailable for a GitHub worktree', async () => {
    const sessionDoc = {
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-github-git-missing',
    };
    const gitError = new GitExecutableNotFoundError(
      Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    );
    const createSession = vi.fn(async () => {
      throw new Error('[github---owner---repo] Failed to clone bare repository', {
        cause: gitError,
      });
    });
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(async () => {}),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-github-git-missing' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-github-git-missing',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'turn_pre_prompt_failed',
      '[github---owner---repo] Failed to clone bare repository',
      'git_executable_not_found'
    );
    expect(deps.buildAcpPromptBlocks).not.toHaveBeenCalled();
  });

  it('fails a local project worktree when the requested base branch no longer exists', async () => {
    const rootPath = createGitLocalProject();
    const localProjectId = 'local-project-missing-worktree-branch' as LocalProjectId;
    const sessionDoc = {
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-local-project-missing-worktree-branch',
    };
    const createSession = vi.fn();
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => ({
            meta: {
              localProjects: {
                [localProjectId]: {
                  id: localProjectId,
                  name: 'Local Project',
                  rootPath,
                  createdAtMs: 1,
                },
              },
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        getOrOpenSessionCode: vi.fn(async () => null),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-local-project-missing-worktree-branch' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: {
        kind: 'local',
        localProjectId,
        branch: 'feature/deleted',
        useWorktree: true,
      },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-local-missing-worktree-branch',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).not.toHaveBeenCalled();
    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'turn_pre_prompt_failed',
      expect.stringContaining('Local project branch not found: feature/deleted')
    );
  });

  it('does not prompt a startSession turn that was cancelled before the first prompt runs', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = {
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(async () => [
        {
          id: 'turn-create-cancelled',
          role: 'user',
          timestamp: new Date().toISOString(),
          status: 'canceled',
          read: true,
          userId: 'user-2',
          items: [{ type: 'text', text: 'hello' }],
          fileDiff: [],
        },
      ]),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-create-cancelled',
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-create-cancelled' as SessionId,
      acpSessionId: 'acp-create-cancelled' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-create-cancelled'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async () => createdSession as unknown),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'built prompt' }] as any),
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-create-cancelled' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-create-cancelled',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    expect(sessionManager.createSession).not.toHaveBeenCalled();
    expect(createdSession.terminate).not.toHaveBeenCalled();
    expect(agentClient.prompt).not.toHaveBeenCalled();
    expect(deps.turnFinalization.finalizeACPState).not.toHaveBeenCalled();
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
  });

  it('terminates a pending start session when the owner fiber is interrupted during creation', async () => {
    let createStarted!: () => void;
    const createStartedPromise = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    let resolveCreateSession!: (session: unknown) => void;
    const createSessionPromise = new Promise<unknown>((resolve) => {
      resolveCreateSession = resolve;
    });
    let meta: Record<string, unknown> = {};
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch };
    });
    const sessionDoc = {
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-create-interrupt',
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-create-interrupt' as SessionId,
      acpSessionId: 'acp-create-interrupt' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-create-interrupt'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(() => {
        createStarted();
        return createSessionPromise;
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn(() => 'assistant-create-interrupt'),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta,
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'built prompt' }] as any),
      processMessageQueue: vi.fn(async () => {}),
    });

    const service = new SessionExecutionService(deps);
    const startPromise = service.startSession({
      type: 'session/create',
      sessionId: 'session-create-interrupt' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-create-interrupt',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    await createStartedPromise;
    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId: 'session-create-interrupt' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant-create-interrupt',
      })
    ).resolves.toEqual({ success: true });
    expect(createdSession.terminate).not.toHaveBeenCalled();

    await startPromise;

    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
    expect(deps.processMessageQueue).not.toHaveBeenCalled();
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-create-interrupt', {
      lastHandledUserMsgId: 'turn-create-interrupt',
      processingUserMsgId: undefined,
    });

    resolveCreateSession(createdSession);
    await vi.waitFor(() => {
      expect(createdSession.terminate).toHaveBeenCalledWith(true);
    });
    expect(agentClient.prompt).not.toHaveBeenCalled();
  });

  it('releases active presence and marks dispatch failed when start session creation fails', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = {
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-create-fail',
    };
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async () => {
        throw new Error('docker failed');
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-create-fail' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-create-fail',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    expect(deps.startSessionActivePresence).toHaveBeenCalledTimes(1);
    expect(deps.clearSessionActivePresence).toHaveBeenCalledTimes(1);
    expect(deps.beginConversationTurn).toHaveBeenCalledTimes(1);
    expect(deps.createAssistantEntryForTurn).toHaveBeenCalledWith(
      'session-create-fail',
      sessionDoc,
      'turn-1',
      undefined,
      'turn-create-fail'
    );
    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'turn_pre_prompt_failed',
      'docker failed'
    );
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(
      SessionStatusFactory.initializing(),
      expect.objectContaining({ latestUserMsgId: 'turn-create-fail' })
    );
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
  });

  it('reports authentication required when a first turn cannot create its session', async () => {
    const sessionDoc = {
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-create-auth',
    };
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async () => {
        throw new AcpAuthenticationRequiredError([{ id: 'oauth-personal', name: 'Google' }]);
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-create-auth' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: { prompt: 'hello', cliType: 'registry', agentType: 'antigravity-acp' },
      userTurnId: 'turn-create-auth',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    // The generic pre-prompt reason would leave the client with no way to sign in.
    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'acp_auth_required',
      'Authentication required'
    );
  });

  it.each([
    {
      name: 'reports an ordinary restore failure',
      errors: [new Error('restore failed')],
      expectedReason: 'session_restore_failed',
      expectedMessage: 'restore failed',
      resumeSessionId: undefined,
    },
    {
      name: 'reports authentication required from the initial restore',
      errors: [new AcpAuthenticationRequiredError([])],
      expectedReason: 'acp_auth_required',
      expectedMessage: 'Authentication required',
      resumeSessionId: undefined,
    },
    {
      name: 'reports authentication required from fallback restore',
      errors: [
        new Error('acp_resume_failed: session unavailable'),
        new AcpAuthenticationRequiredError([]),
      ],
      expectedReason: 'acp_auth_required',
      expectedMessage: 'Authentication required',
      resumeSessionId: 'acp-existing' as ACPSessionId,
    },
  ])('$name', async ({ errors, expectedReason, expectedMessage, resumeSessionId }) => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({
        repoFullName: 'owner/repo',
        isArchived: false,
      })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => []),
      updateHistory: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async () => {
        const error = errors.shift();
        if (!error) throw new Error('Unexpected restore attempt');
        throw error;
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-restore-fail' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: {
        prompt: 'hello',
        cliType: 'builtin',
        agentType: 'kimi',
        resume: resumeSessionId,
      },
      userTurnId: 'turn-restore-fail',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(deps.startSessionActivePresence).toHaveBeenCalledTimes(1);
    expect(deps.clearSessionActivePresence).toHaveBeenCalledTimes(1);
    expect(deps.beginConversationTurn).toHaveBeenCalledTimes(1);
    expect(deps.createAssistantEntryForTurn).toHaveBeenCalledWith(
      'session-restore-fail',
      sessionDoc,
      'turn-1',
      undefined,
      'turn-restore-fail'
    );
    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      expectedReason,
      expectedMessage
    );
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-restore-fail', {
      lastHandledUserMsgId: 'turn-restore-fail',
      processingUserMsgId: undefined,
    });
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
    expect(deps.turnFinalization.flushSessionUsage).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'generic startup error',
      error: new Error('pending init failed'),
      expectedReason: 'session_init_failed' as const,
      expectedMessage: 'pending init failed',
    },
    {
      name: 'non-auth ACP error',
      error: Object.assign(new Error('Invalid params'), { code: -32602 }),
      expectedReason: 'session_init_failed' as const,
      expectedMessage: 'Invalid params',
    },
    {
      name: 'authentication-required ACP error',
      error: new AcpAuthenticationRequiredError([{ type: 'terminal' as const, args: ['--login'] }]),
      expectedReason: 'acp_auth_required' as const,
      expectedMessage: 'Authentication required',
    },
  ])(
    'reports pending session initialization failure through the owner effect path: $name',
    async ({ error, expectedReason, expectedMessage }) => {
      const upsertDocMeta = vi.fn(async () => {});
      const sessionDoc = {
        getMetaState: vi.fn(async () => ({ isArchived: false })),
        setStatus: vi.fn(async () => {}),
        setBaseBranch: vi.fn(async () => {}),
        getHistory: vi.fn(async () => []),
        updateHistory: vi.fn(async () => {}),
      };
      const session = {
        sessionId: 'session-pending-init-fail' as SessionId,
        acpSessionId: null,
        agentClient: {
          isCreated: vi.fn(() => false),
        },
        terminalManager: {} as unknown,
        getWorkdir: () => '/tmp',
        getHostWorkdir: () => '/tmp',
        getParentSessionId: () => undefined,
        exec: vi.fn(async () => ''),
        terminate: vi.fn(async () => {}),
        updateGitIdentity: vi.fn(),
        createAgent: vi.fn(async () => 'acp-pending-init-fail'),
        applyExecutionPlaneLimits: vi.fn(async () => {}),
      };
      const sessionManager = {
        getSession: vi.fn(() => session),
        getPendingSession: vi.fn(() => Promise.reject(error)),
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        refreshGhTokenForSession: vi.fn(async () => {}),
      } as unknown as SessionManager;
      const deps = createBaseDeps({
        sessionManager,
        workspaceDocument: {
          repo: {
            upsertDocMeta,
            getDocMeta: vi.fn(async () => undefined),
          },
          getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
          updateAcpCapabilities: vi.fn(async () => {}),
        } as unknown as LoroDocumentManager,
      });

      const service = new SessionExecutionService(deps);
      await service.continueSession({
        type: 'session/chat',
        sessionId: 'session-pending-init-fail' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
        acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
        userTurnId: 'turn-pending-init-fail',
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      });

      expect(deps.recordChatFailure).toHaveBeenCalledWith(
        sessionDoc,
        expectedReason,
        expectedMessage
      );
      expect(upsertDocMeta).toHaveBeenCalledWith('session-session-pending-init-fail', {
        lastHandledUserMsgId: 'turn-pending-init-fail',
        processingUserMsgId: undefined,
      });
      expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
    }
  );

  it('marks chat dispatch as failed when prompt execution throws after processing starts', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => []),
      updateHistory: vi.fn(async () => {}),
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      prompt: vi.fn(async () => {
        throw new Error('prompt failed');
      }),
      currentModel: undefined,
    };
    const session = {
      sessionId: 'session-chat-1' as SessionId,
      acpSessionId: 'acp-chat-1' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-chat-1'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;

    const deps = createBaseDeps({
      sessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-chat-1' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-chat-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-chat-1', {
      lastHandledUserMsgId: 'turn-chat-1',
      processingUserMsgId: undefined,
    });
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
  });

  it('records ACP string error data as the visible chat failure message', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => []),
      updateHistory: vi.fn(async () => {}),
    };
    const acpError = Object.assign(new Error('Invalid params'), {
      code: -32602,
      data: 'No goal is currently set. Use `/goal <objective>` to create one.',
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      prompt: vi.fn(async () => {
        throw acpError;
      }),
      currentModel: undefined,
    };
    const session = {
      sessionId: 'session-acp-data' as SessionId,
      acpSessionId: 'acp-data-1' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-data-1'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;

    const deps = createBaseDeps({
      sessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        getOrOpenSessionCode: vi.fn(async () => null),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-acp-data' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'pause the goal', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-acp-data',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'acp_invalid_params',
      'No goal is currently set. Use `/goal <objective>` to create one.'
    );
  });

  it('records a visible failure when a chat turn fails before prompt starts', async () => {
    const events: string[] = [];
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => []),
      updateHistory: vi.fn(async () => {}),
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const session = {
      sessionId: 'session-pre-prompt-fail' as SessionId,
      acpSessionId: 'acp-pre-prompt-fail' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-pre-prompt-fail'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;

    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn(() => 'assistant-pre-prompt-fail'),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      createAssistantEntryForTurn: vi.fn(async () => {
        events.push('assistant-entry');
      }),
      startSessionActivePresence: vi.fn(() => {
        events.push('active-start');
      }),
      clearSessionActivePresence: vi.fn(() => {
        events.push('active-clear');
      }),
      clearConversationTurn: vi.fn(() => {
        events.push('conversation-clear');
      }),
      recordChatFailure: vi.fn(async () => {
        events.push('record-failure');
      }),
      buildAcpPromptBlocks: vi.fn(async () => {
        events.push('build-prompt');
        throw new Error('prompt build failed');
      }),
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-pre-prompt-fail' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-pre-prompt-fail',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(events.slice(0, 4)).toEqual([
      'active-start',
      'assistant-entry',
      'build-prompt',
      'active-clear',
    ]);
    expect(events.indexOf('record-failure')).toBeLessThan(events.indexOf('conversation-clear'));
    expect(agentClient.prompt).not.toHaveBeenCalled();
    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'turn_pre_prompt_failed',
      'prompt build failed'
    );
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-pre-prompt-fail', {
      lastHandledUserMsgId: 'turn-pre-prompt-fail',
      processingUserMsgId: undefined,
    });
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
  });

  it('interrupts the owner fiber and releases scoped active presence when cancelled before prompt starts', async () => {
    const events: string[] = [];
    let buildStarted!: () => void;
    const buildStartedPromise = new Promise<void>((resolve) => {
      buildStarted = resolve;
    });
    let meta: Record<string, unknown> = {};
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch };
    });
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => []),
      updateHistory: vi.fn(async () => {}),
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const session = {
      sessionId: 'session-pre-prompt-interrupt' as SessionId,
      acpSessionId: 'acp-pre-prompt-interrupt' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-pre-prompt-interrupt'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn(() => 'assistant-pre-prompt-interrupt'),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta,
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      createAssistantEntryForTurn: vi.fn(async () => {
        events.push('assistant-entry');
      }),
      startSessionActivePresence: vi.fn(() => {
        events.push('active-start');
      }),
      clearSessionActivePresence: vi.fn(() => {
        events.push('active-clear');
      }),
      buildAcpPromptBlocks: vi.fn(async () => {
        events.push('build-prompt');
        buildStarted();
        await new Promise<never>(() => {});
      }),
      processMessageQueue: vi.fn(async () => {}),
    });

    const service = new SessionExecutionService(deps);
    const continuePromise = service.continueSession({
      type: 'session/chat',
      sessionId: 'session-pre-prompt-interrupt' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-pre-prompt-interrupt',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    await buildStartedPromise;
    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId: 'session-pre-prompt-interrupt' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant-pre-prompt-interrupt',
      })
    ).resolves.toEqual({ success: true });
    await continuePromise;

    expect(events).toEqual(['active-start', 'assistant-entry', 'build-prompt', 'active-clear']);
    expect(agentClient.prompt).not.toHaveBeenCalled();
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
    expect(deps.processMessageQueue).not.toHaveBeenCalled();
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-pre-prompt-interrupt', {
      lastHandledUserMsgId: 'turn-pre-prompt-interrupt',
      processingUserMsgId: undefined,
    });
  });

  it('stops a turn before prompt starts when the matching active turn is cancelled', async () => {
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => []),
      updateHistory: vi.fn(async () => {}),
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const session = {
      sessionId: 'session-chat-cancelled' as SessionId,
      acpSessionId: 'acp-chat-cancelled' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-chat-cancelled'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    let activeTurnId: string | undefined;
    let service: SessionExecutionService;
    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn(() => {
        activeTurnId = 'assistant-turn-1';
        return activeTurnId;
      }),
      getActiveTurnId: vi.fn(() => activeTurnId),
      clearActiveTurnId: vi.fn((_sessionId, turnId) => {
        if (activeTurnId === turnId) {
          activeTurnId = undefined;
        }
      }),
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => ({
            meta: {},
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => {
        await service.cancelSession({
          type: 'session/cancel',
          sessionId: 'session-chat-cancelled' as SessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          turnId: 'assistant-turn-1',
        });
        return [{ type: 'text', text: 'hello' }] as any;
      }),
    });

    service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-chat-cancelled' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-chat-cancelled',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(agentClient.prompt).not.toHaveBeenCalled();
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
  });

  it('routes prompt-in-flight cancellation through the turn owner finalizer', async () => {
    let meta: Record<string, unknown> = {};
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-prompt-cancel',
        role: 'user',
        items: [{ type: 'text', text: 'hello' }],
        status: 'pending',
        read: false,
      },
    ];
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch };
    });
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    };
    let activeTurnId: string | undefined;
    let service: SessionExecutionService;
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => {
        const result = await service.cancelSession({
          type: 'session/cancel',
          sessionId: 'session-prompt-cancel' as SessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          turnId: 'assistant-prompt-cancel',
        });
        expect(result).toEqual({ success: true });
        throw new Error('agent cancelled prompt');
      }),
      currentModel: undefined,
    };
    const session = {
      sessionId: 'session-prompt-cancel' as SessionId,
      acpSessionId: 'acp-prompt-cancel' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-prompt-cancel'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn(() => {
        activeTurnId = 'assistant-prompt-cancel';
        return activeTurnId;
      }),
      getActiveTurnId: vi.fn(() => activeTurnId),
      clearActiveTurnId: vi.fn((_sessionId, turnId) => {
        if (activeTurnId === turnId) {
          activeTurnId = undefined;
        }
      }),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta,
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'hello' }] as any),
      processMessageQueue: vi.fn(async () => {}),
    });
    vi.mocked(deps.turnFinalization.finalizeACPState).mockImplementation(async () => {
      expect(history[0]).toMatchObject({ id: 'turn-prompt-cancel', status: 'canceled' });
    });

    service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-prompt-cancel' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-prompt-cancel',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(agentClient.cancel).toHaveBeenCalledWith('acp-prompt-cancel');
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
    expect(deps.processMessageQueue).not.toHaveBeenCalled();
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    expect(history[0]).toMatchObject({ id: 'turn-prompt-cancel', status: 'canceled' });
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-prompt-cancel', {
      lastHandledUserMsgId: 'turn-prompt-cancel',
      processingUserMsgId: undefined,
    });
  });

  it('does not wait for ACP cancel before interrupting an in-flight prompt', async () => {
    let meta: Record<string, unknown> = {};
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch };
    });
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => []),
      updateHistory: vi.fn(async () => {}),
    };
    let activeTurnId: string | undefined;
    let promptStarted!: () => void;
    const promptStartedPromise = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    let promptSignal: AbortSignal | undefined;
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(() => new Promise<never>(() => {})),
      prompt: vi.fn(
        (_acpSessionId: ACPSessionId, _blocks: unknown[], options?: { signal?: AbortSignal }) => {
          promptSignal = options?.signal;
          promptStarted();
          return new Promise<never>((_resolve, reject) => {
            if (promptSignal?.aborted) {
              reject(new Error('Agent prompt aborted'));
              return;
            }
            promptSignal?.addEventListener(
              'abort',
              () => {
                reject(new Error('Agent prompt aborted'));
              },
              { once: true }
            );
          });
        }
      ),
      currentModel: undefined,
    };
    const session = {
      sessionId: 'session-prompt-cancel-immediate' as SessionId,
      acpSessionId: 'acp-prompt-cancel-immediate' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-prompt-cancel-immediate'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn(() => {
        activeTurnId = 'assistant-prompt-cancel-immediate';
        return activeTurnId;
      }),
      getActiveTurnId: vi.fn(() => activeTurnId),
      clearActiveTurnId: vi.fn((_sessionId, turnId) => {
        if (activeTurnId === turnId) {
          activeTurnId = undefined;
        }
      }),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta,
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'hello' }] as any),
      processMessageQueue: vi.fn(async () => {}),
    });

    const service = new SessionExecutionService(deps);
    const startPromise = service.continueSession({
      type: 'session/chat',
      sessionId: 'session-prompt-cancel-immediate' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-prompt-cancel-immediate',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    await promptStartedPromise;
    const result = await Promise.race([
      service.cancelSession({
        type: 'session/cancel',
        sessionId: 'session-prompt-cancel-immediate' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant-prompt-cancel-immediate',
      }),
      new Promise<{ success: false; error: string }>((resolve) => {
        setTimeout(() => resolve({ success: false, error: 'timeout' }), 100);
      }),
    ]);

    expect(result).toEqual({ success: true });
    expect(promptSignal?.aborted).toBe(true);
    expect(agentClient.cancel).toHaveBeenCalledWith('acp-prompt-cancel-immediate');
    await startPromise;
    expect(deps.processMessageQueue).not.toHaveBeenCalled();
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-prompt-cancel-immediate', {
      lastHandledUserMsgId: 'turn-prompt-cancel-immediate',
      processingUserMsgId: undefined,
    });
  });

  it('flushes cancellation when a cancelled prompt resolves before finalization starts', async () => {
    let meta: Record<string, unknown> = {};
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch };
    });
    const sessionDoc = {
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(async () => []),
      updateHistory: vi.fn(async () => {}),
    };
    let activeTurnId: string | undefined;
    let service: SessionExecutionService;
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => {
        const result = await service.cancelSession({
          type: 'session/cancel',
          sessionId: 'session-prompt-cancel-resolved' as SessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          turnId: 'assistant-prompt-cancel-resolved',
        });
        expect(result).toEqual({ success: true });
        return {};
      }),
      currentModel: undefined,
    };
    const session = {
      sessionId: 'session-prompt-cancel-resolved' as SessionId,
      acpSessionId: 'acp-prompt-cancel-resolved' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-prompt-cancel-resolved'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn(() => {
        activeTurnId = 'assistant-prompt-cancel-resolved';
        return activeTurnId;
      }),
      getActiveTurnId: vi.fn(() => activeTurnId),
      clearActiveTurnId: vi.fn((_sessionId, turnId) => {
        if (activeTurnId === turnId) {
          activeTurnId = undefined;
        }
      }),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta,
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'hello' }] as any),
      processMessageQueue: vi.fn(async () => {}),
    });

    service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-prompt-cancel-resolved' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-prompt-cancel-resolved',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(agentClient.cancel).toHaveBeenCalledWith('acp-prompt-cancel-resolved');
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
    expect(deps.turnFinalization.notifySessionCompleted).not.toHaveBeenCalled();
    expect(deps.processMessageQueue).not.toHaveBeenCalled();
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-prompt-cancel-resolved', {
      lastHandledUserMsgId: 'turn-prompt-cancel-resolved',
      processingUserMsgId: undefined,
    });
  });

  it('accepts a stop request during turn finalization and skips completion follow-up', async () => {
    let meta: Record<string, unknown> = {};
    let history: unknown[] = [
      {
        id: 'turn-finalizing-user',
        role: 'user',
        timestamp: new Date().toISOString(),
        status: 'pending',
        items: [{ type: 'text', text: 'hello' }],
        fileDiff: [],
      },
    ];
    const sessionDoc = {
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      roomId: 'session-session-finalizing-cancel',
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-finalizing-cancel' as SessionId,
      acpSessionId: 'acp-finalizing-cancel' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-finalizing-cancel'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => createdSession),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async () => createdSession as unknown),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch };
    });
    let service: SessionExecutionService;
    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn(() => 'assistant-finalizing-turn'),
      getActiveTurnId: vi.fn(() => undefined),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta,
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'hello' }] as any),
      turnFinalization: {
        finalizeACPState: vi.fn(async () => {
          const result = await service.cancelSession({
            type: 'session/cancel',
            sessionId: 'session-finalizing-cancel' as SessionId,
            machineId: 'machine-1',
            workspaceId: 'workspace-1' as WorkspaceId,
            turnId: 'assistant-finalizing-turn',
          });
          expect(result).toEqual({ success: true });
        }),
        flushSessionUsage: vi.fn(async () => {}),
        syncSessionBranchName: vi.fn(async () => null),
        updateSessionDiffStats: vi.fn(async () => []),
        detectAndAssociatePR: vi.fn(async () => null),
        autoCommitAndPushForPR: vi.fn(async () => {}),
        notifySessionCompleted: vi.fn(async () => {}),
      },
      processMessageQueue: vi.fn(async () => {}),
    });

    service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-finalizing-cancel' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-finalizing-user',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    expect(agentClient.cancel).not.toHaveBeenCalled();
    expect(deps.turnFinalization.notifySessionCompleted).not.toHaveBeenCalled();
    expect(deps.processMessageQueue).not.toHaveBeenCalled();
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-finalizing-cancel', {
      lastHandledUserMsgId: 'turn-finalizing-user',
      processingUserMsgId: undefined,
    });
  });

  it('cancels an active auto prompt during turn finalization', async () => {
    let meta: Record<string, unknown> = {};
    let history: unknown[] = [
      {
        id: 'turn-finalizing-auto-prompt-user',
        role: 'user',
        timestamp: new Date().toISOString(),
        status: 'pending',
        items: [{ type: 'text', text: 'hello' }],
        fileDiff: [],
      },
    ];
    let autoPromptStarted!: () => void;
    const autoPromptStartedPromise = new Promise<void>((resolve) => {
      autoPromptStarted = resolve;
    });
    let abortObserved = false;
    const sessionDoc = {
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(async () => history),
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      roomId: 'session-session-finalizing-auto-prompt-cancel',
    };
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const createdSession = {
      sessionId: 'session-finalizing-auto-prompt-cancel' as SessionId,
      acpSessionId: 'acp-finalizing-auto-prompt-cancel' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-finalizing-auto-prompt-cancel'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => createdSession),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async () => createdSession as unknown),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch };
    });
    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn(() => 'assistant-finalizing-auto-prompt-turn'),
      getActiveTurnId: vi.fn(() => undefined),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta,
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'hello' }] as any),
      turnFinalization: {
        finalizeACPState: vi.fn(async () => {}),
        flushSessionUsage: vi.fn(async () => {}),
        syncSessionBranchName: vi.fn(async () => null),
        updateSessionDiffStats: vi.fn(async () => []),
        detectAndAssociatePR: vi.fn(async () => null),
        autoCommitAndPushForPR: vi.fn(async (ctx) => {
          if (!ctx.abortSignal) {
            throw new Error('missing abort signal');
          }
          ctx.onAutoPromptStart?.();
          autoPromptStarted();
          await new Promise<void>((resolve) => {
            if (ctx.abortSignal?.aborted) {
              abortObserved = true;
              resolve();
              return;
            }
            ctx.abortSignal?.addEventListener(
              'abort',
              () => {
                abortObserved = true;
                resolve();
              },
              { once: true }
            );
          });
          ctx.onAutoPromptEnd?.();
        }),
        notifySessionCompleted: vi.fn(async () => {}),
      },
      processMessageQueue: vi.fn(async () => {}),
    });

    const service = new SessionExecutionService(deps);
    const startPromise = service.startSession({
      type: 'session/create',
      sessionId: 'session-finalizing-auto-prompt-cancel' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-finalizing-auto-prompt-user',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    await autoPromptStartedPromise;
    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId: 'session-finalizing-auto-prompt-cancel' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant-finalizing-auto-prompt-turn',
      })
    ).resolves.toEqual({ success: true });
    await startPromise;

    expect(abortObserved).toBe(true);
    expect(agentClient.cancel).toHaveBeenCalledWith('acp-finalizing-auto-prompt-cancel');
    expect(deps.turnFinalization.notifySessionCompleted).not.toHaveBeenCalled();
    expect(deps.processMessageQueue).not.toHaveBeenCalled();
  });

  it('fails startSession when the agent client is missing instead of silently finalizing', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = {
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-4',
    };
    const createdSession = {
      sessionId: 'session-4' as SessionId,
      acpSessionId: 'acp-4' as ACPSessionId,
      agentClient: undefined,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-4'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async () => createdSession as unknown),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'built prompt' }] as any),
    });

    const service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-4' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-create-4',
      userId: 'user-4',
      userName: 'User 4',
      userEmail: 'user4@example.com',
    });

    expect(deps.turnFinalization.notifySessionCompleted).not.toHaveBeenCalled();
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(
      SessionStatusFactory.initializing(),
      expect.objectContaining({ latestUserMsgId: 'turn-create-4' })
    );
  });

  it('cancels an active session and reports success', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = {
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
    };
    const session = {
      acpSessionId: 'acp-3' as ACPSessionId,
      agentClient: {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
      },
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      getActiveTurnId: vi.fn(() => 'assistant-turn-1'),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta: {
              latestUserMsgId: 'turn-cancel-1',
              processingUserMsgId: 'turn-cancel-1',
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    const result = await service.cancelSession({
      type: 'session/cancel',
      sessionId: 'session-3' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      turnId: 'assistant-turn-1',
    });

    expect(result).toEqual({ success: true });
    expect(session.agentClient.cancel).toHaveBeenCalledWith('acp-3');
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-3', {
      lastHandledUserMsgId: 'turn-cancel-1',
      processingUserMsgId: undefined,
    });
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-3', {
      lastCanceledTurn: undefined,
    });
  });

  it('keeps cancel successful when cancellation finalization side effects fail', async () => {
    const sessionDoc = {
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {
        throw new Error('status write failed');
      }),
      updateHistory: vi.fn(async () => {}),
    };
    const session = {
      acpSessionId: 'acp-cancel-finalizer-fail' as ACPSessionId,
      agentClient: {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
      },
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      getActiveTurnId: vi.fn(() => 'assistant-turn-finalizer-fail'),
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => ({
            meta: {
              latestUserMsgId: 'turn-cancel-finalizer-fail',
              processingUserMsgId: 'turn-cancel-finalizer-fail',
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    const result = await service.cancelSession({
      type: 'session/cancel',
      sessionId: 'session-cancel-finalizer-fail' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      turnId: 'assistant-turn-finalizer-fail',
    });

    expect(result).toEqual({ success: true });
    expect(session.agentClient.cancel).toHaveBeenCalledWith('acp-cancel-finalizer-fail');
    expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
  });

  it('ignores a cancel request for a stale turn id', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = {
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
    };
    const session = {
      acpSessionId: 'acp-stale-cancel' as ACPSessionId,
      agentClient: {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
      },
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      getActiveTurnId: vi.fn(() => 'assistant-turn-2'),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta: {
              latestUserMsgId: 'turn-running-2',
              processingUserMsgId: 'turn-running-2',
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    const result = await service.cancelSession({
      type: 'session/cancel',
      sessionId: 'session-stale-cancel' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      turnId: 'assistant-turn-1',
    });

    expect(result).toEqual({ success: true });
    expect(session.agentClient.cancel).not.toHaveBeenCalled();
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-stale-cancel', {
      lastCanceledTurn: undefined,
    });
  });

  it('keeps a newer queued turn pending when cancelling the currently running turn', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = {
      getHistory: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
    };
    const session = {
      acpSessionId: 'acp-queued-cancel' as ACPSessionId,
      agentClient: {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
      },
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      refreshGhTokenForSession: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      getActiveTurnId: vi.fn(() => 'assistant-turn-1'),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta: {
              latestUserMsgId: 'turn-queued-2',
              processingUserMsgId: 'turn-running-1',
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    const result = await service.cancelSession({
      type: 'session/cancel',
      sessionId: 'session-queued-cancel' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      turnId: 'assistant-turn-1',
    });

    expect(result).toEqual({ success: true });
    expect(session.agentClient.cancel).toHaveBeenCalledWith('acp-queued-cancel');
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-queued-cancel', {
      lastHandledUserMsgId: 'turn-running-1',
      processingUserMsgId: undefined,
    });
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-queued-cancel', {
      lastCanceledTurn: undefined,
    });
  });

  it('preserves authentication success and auth methods when the follow-up probe still needs auth', async () => {
    const authenticate = vi
      .spyOn(AcpAuthenticationManager.prototype, 'authenticate')
      .mockResolvedValue({ success: true, disposition: 'authenticated' });
    const fetchAcpCapabilities = vi.fn(async () => {
      throw new AcpAuthenticationRequiredError([{ type: 'terminal', args: ['--login'] }]);
    });
    const service = new SessionExecutionService(
      createBaseDeps({
        fetchAcpCapabilities,
        workspaceDocument: {
          getAgentConfigForMachineLaunch: vi.fn(async () =>
            createLaunchConfig({
              cliType: 'builtin',
              agentType: 'kimi',
              env: {},
              runtimeOverrides: { kimiPath: '/test/kimi' },
            })
          ),
          updateAcpCapabilities: vi.fn(async () => {}),
        } as unknown as LoroDocumentManager,
      })
    );

    try {
      const result = await service.authenticateMachineAcp({
        type: 'machine/acp-authenticate',
        machineId: 'machine-1' as MachineId,
        workspaceId: 'workspace-1' as WorkspaceId,
        requestId: 'auth-1',
        action: 'start',
        configId: capabilityConfigId,
      });

      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          disposition: 'authenticated',
          capabilitiesRefreshed: false,
          authRequired: true,
          authMethods: [{ type: 'terminal', args: ['--login'] }],
          error: 'Authentication required',
        })
      );
    } finally {
      authenticate.mockRestore();
    }
  });

  it('launches authentication only from the daemon-authoritative persisted config', async () => {
    const authenticate = vi
      .spyOn(AcpAuthenticationManager.prototype, 'authenticate')
      .mockResolvedValue({ success: true, disposition: 'cancelled' });
    const persistedConfig = createLaunchConfig({
      cliType: 'custom',
      agentType: 'persisted-custom',
      customAcp: { command: '/opt/trusted/custom-acp', args: ['--stdio'] },
      env: { TRUSTED_TOKEN: 'from-local-config' },
      runtimeOverrides: undefined,
    });
    const getAgentConfigForMachineLaunch = vi.fn(async () => persistedConfig);
    const service = new SessionExecutionService(
      createBaseDeps({
        workspaceDocument: {
          getAgentConfigForMachineLaunch,
          updateAcpCapabilities: vi.fn(async () => {}),
        } as unknown as LoroDocumentManager,
      })
    );

    try {
      await expect(
        service.authenticateMachineAcp({
          type: 'machine/acp-authenticate',
          machineId: 'machine-1' as MachineId,
          workspaceId: 'workspace-1' as WorkspaceId,
          requestId: 'auth-persisted-custom',
          action: 'start',
          configId: capabilityConfigId,
        })
      ).resolves.toEqual(
        expect.objectContaining({
          success: true,
          disposition: 'cancelled',
          agentType: 'persisted-custom',
        })
      );
      expect(getAgentConfigForMachineLaunch).toHaveBeenCalledWith(capabilityConfigId, 'machine-1');
      expect(authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          cliType: 'custom',
          agentType: 'persisted-custom',
          customAcp: { command: '/opt/trusted/custom-acp', args: ['--stdio'] },
          env: { TRUSTED_TOKEN: 'from-local-config' },
        })
      );
    } finally {
      authenticate.mockRestore();
    }
  });

  it('refuses authentication when the config is not persisted on the target machine', async () => {
    const authenticate = vi.spyOn(AcpAuthenticationManager.prototype, 'authenticate');
    const service = new SessionExecutionService(
      createBaseDeps({
        workspaceDocument: {
          getAgentConfigForMachineLaunch: vi.fn(async () => null),
        } as unknown as LoroDocumentManager,
      })
    );

    try {
      await expect(
        service.authenticateMachineAcp({
          type: 'machine/acp-authenticate',
          machineId: 'machine-1' as MachineId,
          workspaceId: 'workspace-1' as WorkspaceId,
          requestId: 'auth-missing-config',
          action: 'start',
          configId: 'missing-config' as AgentConfigId,
        })
      ).resolves.toEqual(
        expect.objectContaining({
          success: false,
          disposition: 'error',
          error: expect.stringContaining('Provider config not found or invalid'),
        })
      );
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      authenticate.mockRestore();
    }
  });

  it('bounds the post-authentication capability proof inside the renderer deadline', async () => {
    vi.useFakeTimers();
    const authenticate = vi
      .spyOn(AcpAuthenticationManager.prototype, 'authenticate')
      .mockResolvedValue({ success: true, disposition: 'authenticated' });
    const fetchAcpCapabilities = vi.fn(
      (...args: unknown[]) =>
        new Promise<never>((_resolve, reject) => {
          const signal = (args[5] as { signal?: AbortSignal } | undefined)?.signal;
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })
    );
    const service = new SessionExecutionService(createBaseDeps({ fetchAcpCapabilities }));

    try {
      const resultPromise = service.authenticateMachineAcp({
        type: 'machine/acp-authenticate',
        machineId: 'machine-1' as MachineId,
        workspaceId: 'workspace-1' as WorkspaceId,
        requestId: 'auth-refresh-timeout',
        action: 'start',
        configId: capabilityConfigId,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      await expect(resultPromise).resolves.toEqual(
        expect.objectContaining({
          success: true,
          disposition: 'authenticated',
          capabilitiesRefreshed: false,
          error: 'Authentication succeeded, but capability verification timed out',
        })
      );
      expect(fetchAcpCapabilities).toHaveBeenCalledOnce();
    } finally {
      authenticate.mockRestore();
      vi.useRealTimers();
    }
  });

  it('forwards a browser authorization code to the active login process', async () => {
    const submitAuthorizationCode = vi
      .spyOn(AcpAuthenticationManager.prototype, 'submitAuthorizationCode')
      .mockReturnValue({ success: true, disposition: 'input-accepted' });
    const service = new SessionExecutionService(createBaseDeps({}));

    try {
      await expect(
        service.authenticateMachineAcp({
          type: 'machine/acp-authenticate',
          machineId: 'machine-1' as MachineId,
          workspaceId: 'workspace-1' as WorkspaceId,
          requestId: 'auth-input-1',
          action: 'submit-code',
          authenticationRequestId: 'auth-1',
          authorizationCode: 'browser-code',
        })
      ).resolves.toEqual(expect.objectContaining({ success: true, disposition: 'input-accepted' }));
      expect(submitAuthorizationCode).toHaveBeenCalledWith('auth-1', 'browser-code');
    } finally {
      submitAuthorizationCode.mockRestore();
    }
  });

  it('forwards a Custom ACP form response to the active authentication request', async () => {
    const submitAuthenticationInput = vi
      .spyOn(AcpAuthenticationManager.prototype, 'submitAuthenticationInput')
      .mockReturnValue({ success: true, disposition: 'input-accepted' });
    const service = new SessionExecutionService(createBaseDeps({}));
    const authenticationInput = JSON.stringify({
      action: 'accept',
      content: { account: 'work', code: 'secret-code' },
    });

    try {
      await expect(
        service.authenticateMachineAcp({
          type: 'machine/acp-authenticate',
          machineId: 'machine-1' as MachineId,
          workspaceId: 'workspace-1' as WorkspaceId,
          requestId: 'auth-input-2',
          action: 'submit-input',
          authenticationRequestId: 'auth-custom',
          interactionId: 'form-1',
          authenticationInput,
        })
      ).resolves.toEqual(expect.objectContaining({ success: true, disposition: 'input-accepted' }));
      expect(submitAuthenticationInput).toHaveBeenCalledWith(
        'auth-custom',
        'form-1',
        authenticationInput
      );
    } finally {
      submitAuthenticationInput.mockRestore();
    }
  });

  it('refreshes machine ACP capabilities and persists them to machine meta', async () => {
    const capability = {
      cliType: 'registry' as const,
      agentType: 'deepseek',
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
      provenance: 'runtime' as const,
      sourceVersion: 'registry:deepseek:unknown',
      modes: [],
      models: [{ modelId: 'kimi-k3', name: 'Kimi K3' }],
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select' as const,
          currentValue: 'kimi-k3',
          options: [{ value: 'kimi-k3', name: 'Kimi K3' }],
        },
        {
          id: 'reasoning_effort',
          name: 'Thinking',
          category: 'thought_level',
          type: 'select' as const,
          currentValue: 'max',
          options: ['low', 'high', 'max'].map((value) => ({ value, name: value })),
        },
      ],
      modelReasoningEfforts: { 'kimi-k3': ['low', 'high', 'max'] },
      sessionFork: false,
      acknowledgedSteer: true,
      sessionForkWorktree: false,
      fetchedAt: 1,
    };
    const updateAcpCapabilities = vi.fn(async () => capability);
    const fetchAcpCapabilities = vi.fn(async () => ({
      modes: [],
      models: capability.models,
      configOptions: capability.configOptions,
      availableCommands: [{ name: 'review', description: 'Review changes' }],
      sessionFork: false,
      acknowledgedSteer: true,
      modelReasoningEfforts: capability.modelReasoningEfforts,
    }));

    const deps = createBaseDeps({
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(),
        updateAcpCapabilities,
        getAgentConfigForMachineLaunch: vi.fn(async () =>
          createLaunchConfig({
            agentType: 'deepseek',
            env: { ACP_PROVIDER_TOKEN: 'secret-token' },
          })
        ),
      } as unknown as LoroDocumentManager,
      fetchAcpCapabilities,
    });

    const service = new SessionExecutionService(deps);
    const result = await service.refreshMachineAcpCapabilities({
      type: 'machine/acp-capabilities-refresh',
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      configId: capabilityConfigId,
    });

    expect(fetchAcpCapabilities).toHaveBeenCalledWith(
      'registry',
      'deepseek',
      { ACP_PROVIDER_TOKEN: 'secret-token' },
      undefined,
      undefined,
      expect.objectContaining({
        onManagedRuntimeProgress: expect.any(Function),
      })
    );
    expect(updateAcpCapabilities).toHaveBeenCalledWith(
      'machine-1',
      capabilityConfigId,
      'registry',
      'deepseek',
      [],
      capability.models,
      capability.configOptions,
      [{ name: 'review', description: 'Review changes' }],
      false,
      'registry:deepseek:unknown',
      capability.modelReasoningEfforts,
      true,
      { signal: expect.any(AbortSignal) }
    );
    expect(result).toEqual(
      expect.objectContaining({
        type: 'machine/acp-capabilities-refresh_response',
        machineId: 'machine-1',
        configId: capabilityConfigId,
        cliType: 'registry',
        agentType: 'deepseek',
        success: true,
        capability,
      })
    );
  });

  it('deduplicates concurrent ACP capability refreshes for the same config and launch inputs', async () => {
    let release: () => void = () => {};
    const fetched = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchAcpCapabilities = vi.fn(async () => {
      await fetched;
      return { modes: [], models: [] };
    });
    const updateAcpCapabilities = vi.fn(async () => {});

    const deps = createBaseDeps({
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(),
        getOrOpenSessionCode: vi.fn(async () => null),
        updateAcpCapabilities,
      } as unknown as LoroDocumentManager,
      fetchAcpCapabilities,
    });

    const service = new SessionExecutionService(deps);
    const request = {
      type: 'machine/acp-capabilities-refresh' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      configId: capabilityConfigId,
    };

    const first = service.refreshMachineAcpCapabilities(request);
    const second = service.refreshMachineAcpCapabilities(request);
    const third = service.refreshMachineAcpCapabilities(request);
    release();
    const [a, b, c] = await Promise.all([first, second, third]);

    expect(fetchAcpCapabilities).toHaveBeenCalledTimes(1);
    expect(updateAcpCapabilities).toHaveBeenCalledTimes(1);
    expect(a).toEqual(expect.objectContaining({ success: true }));
    expect(b).toEqual(expect.objectContaining({ success: true }));
    expect(c).toEqual(expect.objectContaining({ success: true }));
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('keeps shared capability work alive until its last consumer cancels', async () => {
    let releaseFetch!: () => void;
    const fetched = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    let sharedSignal!: AbortSignal;
    const fetchAcpCapabilities = vi.fn(async (...args: unknown[]) => {
      const options = args[5] as { signal: AbortSignal };
      sharedSignal = options.signal;
      markFetchStarted();
      await fetched;
      return { modes: [], models: [] };
    });
    const updateAcpCapabilities = vi.fn(async () => {});
    const service = new SessionExecutionService(
      createBaseDeps({
        fetchAcpCapabilities,
        workspaceDocument: {
          repo: {
            upsertDocMeta: vi.fn(async () => {}),
            getDocMeta: vi.fn(async () => undefined),
          },
          getOrCreateSessionDoc: vi.fn(),
          getOrOpenSessionCode: vi.fn(async () => null),
          updateAcpCapabilities,
        } as unknown as LoroDocumentManager,
      })
    );
    const request = {
      type: 'machine/acp-capabilities-refresh' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      configId: capabilityConfigId,
    };
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = service.refreshMachineAcpCapabilities(request, {
      signal: firstController.signal,
    });
    const second = service.refreshMachineAcpCapabilities(request, {
      signal: secondController.signal,
    });
    await fetchStarted;

    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(sharedSignal.aborted).toBe(false);

    releaseFetch();
    await expect(second).resolves.toEqual(expect.objectContaining({ success: true }));
    expect(updateAcpCapabilities).toHaveBeenCalledTimes(1);
  });

  it('aborts capability probing when its last consumer cancels', async () => {
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    let markProbeAborted!: () => void;
    const probeAborted = new Promise<void>((resolve) => {
      markProbeAborted = resolve;
    });
    const fetchAcpCapabilities = vi.fn(async (...args: unknown[]) => {
      const options = args[5] as { signal: AbortSignal };
      markFetchStarted();
      await new Promise<void>((_resolve, reject) => {
        const handleAbort = () => {
          markProbeAborted();
          reject(new DOMException('probe cancelled', 'AbortError'));
        };
        options.signal.addEventListener('abort', handleAbort, { once: true });
        if (options.signal.aborted) handleAbort();
      });
      throw new Error('unreachable');
    });
    const updateAcpCapabilities = vi.fn(async () => {});
    const service = new SessionExecutionService(
      createBaseDeps({
        fetchAcpCapabilities,
        workspaceDocument: {
          repo: {
            upsertDocMeta: vi.fn(async () => {}),
            getDocMeta: vi.fn(async () => undefined),
          },
          getOrCreateSessionDoc: vi.fn(),
          getOrOpenSessionCode: vi.fn(async () => null),
          updateAcpCapabilities,
        } as unknown as LoroDocumentManager,
      })
    );
    const controller = new AbortController();
    const refresh = service.refreshMachineAcpCapabilities(
      {
        type: 'machine/acp-capabilities-refresh',
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        configId: capabilityConfigId,
      },
      { signal: controller.signal }
    );
    await fetchStarted;

    controller.abort();
    await expect(refresh).rejects.toMatchObject({ name: 'AbortError' });
    await probeAborted;
    expect(updateAcpCapabilities).not.toHaveBeenCalled();
  });

  it('starts a new capability probe while an aborted generation is still cleaning up', async () => {
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let markFirstAborted!: () => void;
    const firstAborted = new Promise<void>((resolve) => {
      markFirstAborted = resolve;
    });
    let releaseFirstCleanup!: () => void;
    const firstCleanup = new Promise<void>((resolve) => {
      releaseFirstCleanup = resolve;
    });
    let markFirstFinished!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      markFirstFinished = resolve;
    });
    let callCount = 0;
    const fetchAcpCapabilities = vi.fn(async (...args: unknown[]) => {
      const options = args[5] as { signal: AbortSignal };
      callCount += 1;
      if (callCount === 2) {
        return { modes: [], models: [] };
      }
      markFirstStarted();
      await new Promise<void>((resolve) => {
        const handleAbort = () => {
          markFirstAborted();
          resolve();
        };
        options.signal.addEventListener('abort', handleAbort, { once: true });
        if (options.signal.aborted) handleAbort();
      });
      await firstCleanup;
      markFirstFinished();
      throw new DOMException('old probe cancelled', 'AbortError');
    });
    const service = new SessionExecutionService(createBaseDeps({ fetchAcpCapabilities }));
    const request = {
      type: 'machine/acp-capabilities-refresh' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      configId: capabilityConfigId,
    };
    const controller = new AbortController();

    const first = service.refreshMachineAcpCapabilities(request, {
      signal: controller.signal,
    });
    await firstStarted;
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await firstAborted;

    await expect(service.refreshMachineAcpCapabilities(request)).resolves.toEqual(
      expect.objectContaining({ success: true })
    );
    expect(fetchAcpCapabilities).toHaveBeenCalledTimes(2);

    releaseFirstCleanup();
    await firstFinished;
  });

  it('does not deduplicate ACP refreshes for configs sharing the same provider', async () => {
    let release: () => void = () => {};
    const fetched = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchAcpCapabilities = vi.fn(async () => {
      await fetched;
      return { modes: [], models: [] };
    });
    const service = new SessionExecutionService(createBaseDeps({ fetchAcpCapabilities }));
    const request = {
      type: 'machine/acp-capabilities-refresh' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      configId: capabilityConfigId,
    };

    const first = service.refreshMachineAcpCapabilities(request);
    const second = service.refreshMachineAcpCapabilities({
      ...request,
      configId: 'config-2' as AgentConfigId,
    });
    await vi.waitFor(() => expect(fetchAcpCapabilities).toHaveBeenCalledTimes(2));
    release();
    await Promise.all([first, second]);
  });

  it('does not deduplicate ACP refreshes across authoritative config revisions', async () => {
    let releaseFirst: () => void = () => {};
    let releaseSecond: () => void = () => {};
    const firstFetched = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondFetched = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let callCount = 0;
    const fetchAcpCapabilities = vi.fn(async () => {
      const which = ++callCount;
      await (which === 1 ? firstFetched : secondFetched);
      return { modes: [], models: [] };
    });

    const getAgentConfigForMachineLaunch = vi
      .fn()
      .mockResolvedValueOnce(createLaunchConfig({ env: { TOKEN: 'A' } }))
      .mockResolvedValueOnce(createLaunchConfig({ env: { TOKEN: 'B' } }));
    const deps = createBaseDeps({
      fetchAcpCapabilities,
      workspaceDocument: {
        getAgentConfigForMachineLaunch,
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const baseRequest = {
      type: 'machine/acp-capabilities-refresh' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      configId: capabilityConfigId,
    };

    const first = service.refreshMachineAcpCapabilities(baseRequest);
    const second = service.refreshMachineAcpCapabilities(baseRequest);

    releaseFirst();
    releaseSecond();
    await Promise.all([first, second]);

    expect(fetchAcpCapabilities).toHaveBeenCalledTimes(2);
    expect(fetchAcpCapabilities).toHaveBeenCalledWith(
      'registry',
      'codex',
      { TOKEN: 'A' },
      undefined,
      undefined,
      expect.objectContaining({
        onManagedRuntimeProgress: expect.any(Function),
      })
    );
    expect(fetchAcpCapabilities).toHaveBeenCalledWith(
      'registry',
      'codex',
      { TOKEN: 'B' },
      undefined,
      undefined,
      expect.objectContaining({
        onManagedRuntimeProgress: expect.any(Function),
      })
    );
  });

  it('clears the ACP refresh dedupe slot after a fetch failure so subsequent calls retry', async () => {
    let fail = true;
    const fetchAcpCapabilities = vi.fn(async () => {
      if (fail) {
        throw new Error('probe failed');
      }
      return { modes: [], models: [] };
    });
    const deps = createBaseDeps({ fetchAcpCapabilities });
    const service = new SessionExecutionService(deps);
    const request = {
      type: 'machine/acp-capabilities-refresh' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      configId: capabilityConfigId,
    };

    const failed = await service.refreshMachineAcpCapabilities(request);
    expect(failed).toEqual(expect.objectContaining({ success: false, error: 'probe failed' }));

    fail = false;
    const second = await service.refreshMachineAcpCapabilities(request);
    expect(second).toEqual(expect.objectContaining({ success: true }));
    expect(fetchAcpCapabilities).toHaveBeenCalledTimes(2);
  });
});
