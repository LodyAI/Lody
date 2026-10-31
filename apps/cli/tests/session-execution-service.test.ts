import { LodyOperationCoordinator } from '../src/orchestration/operation-coordinator';
import { MessageHandler } from '../src/lib/message-handler';
import { CloudE2eeMemberRemoved, CloudE2eeDeviceRevoked } from '../src/lib/cloud-e2ee-errors';
import { encodeStreamsRoomAdditionalData } from 'loro-repo/transport/streams';
import { bindTestPresenceApplication } from './presence-application-fixture';
import { Lody } from '../src/lib/lody';
import type { MachineRuntimeOptions } from '../src/lib/machine-runtime';
import type { CliE2eeWorkspaceLegacy } from '../src/lib/e2ee/workspace-legacy';
import { makeCliE2eeCustody } from '../src/lib/e2ee/custody';
import {
  retainCliE2eeWorkspaceBinding,
  cliE2eeIdentityDirectory,
} from '../src/lib/e2ee/workspace-legacy';
import { makeNodeE2eeCustody } from '@lody/e2ee-core/adapters/node-custody';
import {
  Bytes,
  signGenesisRecord,
  prepareDeviceAdmission,
  prepareJoinRequest,
  signLedgerRecord,
  prepareLedgerCommand,
  verifyLedger,
  extendLedger,
  hashRecordBytes,
  prepareEpochEnvelope,
  machineSharingContentScope,
  scopedDocumentKey,
  decodeRecord,
  sealMachineSharingPolicy,
  verifyMachineSharingGeneration,
  machineSharingDigest,
} from '@lody/e2ee-core/protocol';
import { makeStreamsUpdateBinding } from '@lody/e2ee-core/adapters/loro-streams';
import { createTestCloudPort } from './test-cloud-port';
import { makeEncryptedAgentExecution, lazyExecutionJournal } from '../src/lib/e2ee/agent-execution';
import { RealtimeJournal } from '../src/lib/e2ee/realtime-journal';
import { AcpStartupProcessError } from '../src/agent/acp-startup-monitor';
import * as quotaRunner from '../src/agent/acp-runner';
import { ProviderQuotaRefreshCache } from '../src/session/provider-quota-refresh-cache';
import { createSessionBackend } from '@/session/session-backend';
import type { MachineAccessVerification } from '@/session/session-access-retry';
import {
  projectTurnAttention,
  type TurnOutcomeFact,
  type TurnResultAudience,
} from '@lody/shared/notifications';
import {
  RequestError,
  type ContentBlock,
  type PromptRequest,
  type PromptResponse,
} from '@agentclientprotocol/sdk';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  ACP_CAPABILITY_REFRESH_CACHE_TTL_MS,
  buildSessionTurnInputConfig,
  getMachineRoomId,
  getSessionRoomId,
  inputBlocksToHistoryItems,
  SessionStatusFactory,
  type AcpCapabilityCacheEntry,
  type ACPSessionId,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRoleId,
  type ChatFailedReason,
  type LocalProjectId,
  type MachineFlockKey,
  type ProjectRef,
  type MachineId,
  type SessionGoalMessage,
  type SessionHistoryInput,
  type SessionId,
  type SessionInputBlock,
  type SessionMeta,
  type SessionStatus,
  type WorkspaceId,
} from '@lody/shared';
import { pendingEventFromAgentEditEvidence } from '../src/lib/code-collab/code-collab-v2-diff-evidence';
import { TurnPostProcessingService } from '../src/session/turn-post-processing-service';
import Database from 'better-sqlite3';
import { Data, Effect, Fiber, Result } from 'effect';
import type { LoroRepo } from 'loro-repo';
import { execFileSync } from 'node:child_process';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AcpAuthenticationManager } from '../src/agent/acp-authentication';
import { AcpAuthenticationRequiredError, AgentClient } from '../src/agent/agent-client';
import * as codexProfiles from '../src/agent/codex-profile-store';
import * as piDiscovery from '../src/agent/pi-extensions';
import { markAssistantTurnFinished } from '../src/lib/assistant-turn-finalize';
import { MachineDocument, SessionDocument, type LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionActivePresencePhase } from '../src/lib/loro/session-active-presence';
import { SessionActivePresenceControllerLegacy } from '../src/lib/loro/session-active-presence-legacy';
import { operationInboxLegacy } from '../src/orchestration/inbox/legacy';
import { InboxExecutionRejected } from '../src/orchestration/inbox/admission-failure';
import { LodyOperationStore } from '../src/orchestration/operation-store';
import { applyAcpSessionRunConfig } from '../src/session/acp-session-config-applier';
import { Session } from '../src/session/session';
import {
  findNextDispatchableUserTurn,
  resolveDispatchTurnInput,
} from '../src/session/session-dispatch-logic';
import { SessionEditAndResendService } from '../src/session/session-edit-and-resend-service';
import {
  SessionExecutionService,
  type SessionExecutionServiceDeps,
} from '../src/session/session-execution-service';
import type { SessionManager } from '../src/session/session-manager';
import {
  jitterSessionStartRetryDelay,
  recordIncompleteStartCleanup,
  takeSessionStartRetry,
  type SessionStartStage,
} from '../src/session/session-start-stage';
import type { SessionConfig } from '../src/session/types';
import { GitExecutableNotFoundError } from '../src/session/worktree/git-process-error';
import type { Logger } from '../src/utils/logger';
import { withHistoryPort } from './history-port-fixture';

/** Shape of an Effect tagged error without a message, as the lock errors once were. */
class MessagelessStartFailure extends Data.TaggedError('MessagelessStartFailure')<{
  cause: unknown;
}> {}

/** The OS refusing a fork, as `spawnSync` reports it. */
const temporarySpawnFailure = () =>
  Object.assign(new Error('spawnSync /usr/bin/git EAGAIN'), { code: 'EAGAIN' });
import { composeTestSessionDoc } from './session-doc-fixture';

const capabilityConfigId = 'config-1' as AgentConfigId;

/**
 * A minimal synced conversation: enough for `buildReplayPromptFromHistory` to
 * produce a non-empty replay, so restore paths that trade a resumable ACP
 * session for a fresh one can prove they carried the context across.
 */
const PRIOR_CONVERSATION_HISTORY: SessionHistoryInput[] = [
  {
    id: 'turn-earlier-user',
    role: 'user',
    status: 'handled',
    items: [{ type: 'text', text: 'remember the number 42' }],
  } as SessionHistoryInput,
  {
    id: 'turn-earlier-assistant',
    role: 'assistant',
    items: [{ type: 'text', text: 'Noted: 42.' }],
  } as SessionHistoryInput,
];

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
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

type SessionMetaTestRepo = {
  getDocMeta?: (roomId: string) => Promise<{ meta?: unknown } | undefined>;
  upsertDocMeta?: (roomId: string, patch: Partial<SessionMeta>) => Promise<void>;
};

const fixtureSessionMeta = new WeakMap<object, Partial<SessionMeta>>();

const ensureSessionDocDefaults = <T>(
  doc: T,
  repo?: SessionMetaTestRepo,
  sessionIdHint?: unknown
): T => {
  if (doc && typeof doc === 'object') {
    const target = doc as unknown as Record<string, unknown> & { sessionId?: string };
    const fixtureMeta = fixtureSessionMeta.get(target) ?? {};
    fixtureSessionMeta.set(target, fixtureMeta);
    const sessionId =
      target.sessionId ?? (typeof sessionIdHint === 'string' ? sessionIdHint : undefined);
    const roomId = sessionId ? getSessionRoomId(sessionId as SessionId) : undefined;
    const originalGetMetaState = target.getMetaState;
    const readMeta = async (): Promise<SessionMeta | undefined> => {
      const local =
        typeof originalGetMetaState === 'function'
          ? ((await originalGetMetaState.call(target)) as SessionMeta | undefined)
          : undefined;
      const fromRepo = !local && roomId ? await repo?.getDocMeta?.(roomId) : undefined;
      const base = local ?? (fromRepo?.meta as SessionMeta | undefined);
      return base || Object.keys(fixtureMeta).length > 0 ? { ...base, ...fixtureMeta } : undefined;
    };
    const writeMeta = async (patch: Partial<SessionMeta>) => {
      if (roomId) await repo?.upsertDocMeta?.(roomId, patch);
      Object.assign(fixtureMeta, patch);
    };
    target.waitUntilSynced ??= vi.fn(async () => true);
    target.flushLocalWrites ??= async () => {};
    target.getMetaState ??= readMeta;
    target.getSteerTurnStatuses ??= async () => (await readMeta())?.steerTurnStatuses;
    target.replaceSteerTurnStatuses ??= async (statuses: SessionMeta['steerTurnStatuses']) =>
      writeMeta({ steerTurnStatuses: statuses });
    target.getSteerOperationRecord ??= async (operationId: string) =>
      (await readMeta())?.steerOperationLedger?.[operationId];
    target.getSteerOperationLedger ??= async () => (await readMeta())?.steerOperationLedger;
    target.setSteerOperationRecord ??= async (
      operationId: string,
      record: NonNullable<SessionMeta['steerOperationLedger']>[string] | undefined
    ) => {
      const ledger = { ...((await readMeta())?.steerOperationLedger ?? {}) };
      if (record) ledger[operationId] = record;
      else delete ledger[operationId];
      await writeMeta({ steerOperationLedger: ledger });
    };
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
  overrides: Partial<SessionExecutionServiceDeps> & {
    startSessionActivePresence?: (
      sessionId: SessionId,
      phase?: SessionActivePresencePhase | null
    ) => void;
  }
): SessionExecutionServiceDeps & {
  startSessionActivePresence: (
    sessionId: SessionId,
    phase?: SessionActivePresencePhase | null
  ) => void;
} => {
  const logger = createSilentLogger();
  const sessionManager = {
    getSession: vi.fn(() => null),
    getPendingSession: vi.fn(() => null),
    createSession: vi.fn(),
    abandonPendingSessionCreate: vi.fn(() => false),
    setSessionError: vi.fn(),
    terminateSession: vi.fn(),
    retireSessionForReconfiguration: vi.fn(async () => {}),
    validateSessionCredentials: vi.fn(async () => {}),
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
    startSessionActivePresence: vi.fn(() => {}),
    holdSessionActivePresence: (id: SessionId, phase?: SessionActivePresencePhase | null) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          deps.startSessionActivePresence(id, phase);
        }),
        () => Effect.sync(() => deps.clearSessionActivePresence(id))
      ).pipe(Effect.as({ awaitInitializationStall: Effect.never })),
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
    syncSessionBranchName: vi.fn(async () => null),
    turnFinalization: {
      finalizeACPState: vi.fn(async () => {}),
      flushSessionUsage: vi.fn(async () => {}),
      updateSessionDiffStats: vi.fn(async () => []),
      detectAndAssociatePR: vi.fn(async () => null),
      syncWorkspaceGitState: vi.fn(async () => {}),
      onTurnOutcome: vi.fn(async () => {}),
    },
    recordChatFailure: vi.fn(async () => {}),
    recordSessionStopFailure: vi.fn(async () => {}),
    maybeGenerateAndStoreSessionTitle: vi.fn(async () => {}),
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
    // Undefined means "cannot name the version a probe would stamp", so the
    // default suite keeps probing; cache tests resolve a real version.
    resolveAcpCapabilitySourceVersion: vi.fn(async () => undefined),
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

  deps.sessionManager.detachSession ??= vi.fn();
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

  const workspaceWithCapabilityCache = deps.workspaceDocument as unknown as {
    getAcpCapabilities?: (
      machineId: MachineId,
      agentConfigId: AgentConfigId
    ) => Promise<AcpCapabilityCacheEntry | undefined>;
  };
  workspaceWithCapabilityCache.getAcpCapabilities ??= vi.fn(async () => undefined);

  const workspaceWithDocFactory = deps.workspaceDocument as unknown as {
    getOrCreateSessionDoc: (...args: unknown[]) => Promise<unknown>;
  };
  const originalGetOrCreateSessionDoc = workspaceWithDocFactory.getOrCreateSessionDoc;
  workspaceWithDocFactory.getOrCreateSessionDoc = vi.fn(async (...args: unknown[]) =>
    ensureSessionDocDefaults(
      await originalGetOrCreateSessionDoc(...args),
      (deps.workspaceDocument as unknown as { repo?: SessionMetaTestRepo }).repo,
      args[0]
    )
  );

  deps.workspaceDocument.getRemoteStreamsGeneration ??= () => undefined;
  return deps;
};

describe('SessionExecutionService', () => {
  it('rejects a result continuation without a durable Inbox batch before owning a turn', async () => {
    const service = new SessionExecutionService(createBaseDeps({}));
    const sessionId = 'unowned-inbox' as SessionId;
    await expect(
      service.continueSession(
        {
          type: 'session/chat',
          sessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          userTurnId: 'no-batch',
          userId: 'user-1',
          userName: 'User',
          userEmail: 'user@example.com',
          acpSessionConfig: { cliType: 'builtin', agentType: 'codex', prompt: 'old continuation' },
        },
        { dispatchSource: 'inbox' }
      )
    ).rejects.toThrow('INBOX_BATCH_REQUIRED');
    expect(service.getExecutionSnapshot(sessionId).hasActiveTurn).toBe(false);
    expect(service.getActiveInvocationContext(sessionId)).toBeUndefined();
  });
  it('cancels an active descendant and prevents late turns while the tree is stopped', async () => {
    const sessionId = 'collaboration-child' as SessionId;
    const rootId = 'collaboration-root' as SessionId;
    let stopped = false;
    let history: SessionHistoryInput[] = [
      {
        id: 'collaboration-user',
        role: 'user',
        status: 'pending',
        items: [{ type: 'text', text: 'work' }],
      },
    ];
    let started!: () => void;
    let finish!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const promptFinished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const prompts: string[] = [];
    const agentClient = {
      isCreated: () => true,
      currentModel: undefined,
      prompt: async () => {
        prompts.push('work');
        started();
        await promptFinished;
        return {};
      },
      cancel: async () => {
        finish();
      },
    };
    const activeSession = {
      sessionId,
      acpSessionId: 'acp-collaboration' as ACPSessionId,
      agentClient,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: async () => '',
      terminate: async () => {},
      updateGitIdentity: () => {},
      applyExecutionPlaneLimits: async () => {},
      terminalManager: {},
    };
    const sessionDoc = withHistoryPort({
      getMetaState: async () => ({ id: sessionId, openedBySessionId: rootId }),
      setStatus: async () => {},
      setLastMessageAt: async () => {},
      getHistory: () => history,
      updateHistory: async (update: (value: SessionHistoryInput[]) => SessionHistoryInput[]) => {
        history = update(history);
      },
    });
    const deps = createBaseDeps({
      beginConversationTurn: (_id, userTurnId) => `assistant:${userTurnId}`,
      sessionManager: {
        getSession: () => activeSession,
        getPendingSession: () => null,
        createSession: async () => activeSession,
        setSessionError: () => {},
        terminateSession: async () => {},
        validateSessionCredentials: async () => {},
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: {
          getDocMeta: async (roomId: string) => ({
            meta:
              roomId === getSessionRoomId(rootId)
                ? { id: rootId, collaborationStopped: stopped }
                : { id: sessionId, openedBySessionId: rootId },
          }),
          upsertDocMeta: async () => {},
        },
        getOrCreateSessionDoc: async () => sessionDoc,
        getOrOpenSessionCode: async () => null,
        updateAcpCapabilities: async () => {},
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const message = {
      type: 'session/chat' as const,
      sessionId,
      machineId: 'machine-1' as MachineId,
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: {
        prompt: 'work',
        cliType: 'builtin' as const,
        agentType: 'codex',
        chainDepth: 1,
      },
      userTurnId: 'collaboration-user',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    };
    const running = service.continueSession(message);
    await promptStarted;
    stopped = true;
    await service.reconcileCollaborationStops();
    await running;
    expect(service.getExecutionSnapshot(sessionId).hasActiveTurn).toBe(false);
    expect(history.find((turn) => turn.id === 'collaboration-user')?.status).toBe('canceled');
    history.push({
      id: 'late-user',
      role: 'user',
      status: 'pending',
      items: [{ type: 'text', text: 'late' }],
    });
    await service.continueSession({ ...message, userTurnId: 'late-user' });
    expect(history.find((turn) => turn.id === 'late-user')?.status).toBe('canceled');
    expect(prompts).toEqual(['work']);
  });

  it('scans the saved Pi profile and rejects missing or non-Pi providers', async () => {
    const deps = createBaseDeps({});
    let config: AgentConfigMeta | null = createLaunchConfig({
      cliType: 'builtin',
      agentType: 'pi',
      env: { PI_CODING_AGENT_DIR: '/saved/profile' },
    });
    deps.workspaceDocument.getAgentConfigForMachineLaunch = async () => config;
    const scan = vi
      .spyOn(piDiscovery, 'discoverManagedPiExtensions')
      .mockImplementation(async (env) => ({
        version: 1,
        agentDir: env?.PI_CODING_AGENT_DIR ?? '/default/profile',
        extensions: [],
        warnings: [],
      }));
    const service = new SessionExecutionService(deps);
    try {
      expect(await service.listMachinePiExtensions(capabilityConfigId)).toMatchObject({
        success: true,
        discovery: { agentDir: '/saved/profile' },
      });
      config = createLaunchConfig();
      expect(await service.listMachinePiExtensions(capabilityConfigId)).toMatchObject({
        success: false,
      });
      config = null;
      expect(await service.listMachinePiExtensions(capabilityConfigId)).toMatchObject({
        success: false,
      });
      expect(await service.listMachinePiExtensions()).toMatchObject({
        success: true,
        discovery: { agentDir: '/default/profile' },
      });
    } finally {
      scan.mockRestore();
    }
  });
  it('cancels only the named native child and rejects a stale parent turn', async () => {
    const runningChildren = new Set(['child-1', 'child-2']);
    const sessionManager = {
      getSession: () => ({
        agentClient: {
          isCreated: () => true,
          cancelSubagent: async (id: string) => {
            runningChildren.delete(id);
          },
        },
      }),
    } as unknown as SessionManager;
    const deps = createBaseDeps({ sessionManager, getActiveTurnId: () => 'parent-1' });
    // A child control must never enter the parent Stop/history mutation path.
    deps.workspaceDocument.getOrCreateSessionDoc = async () => {
      throw new Error('Parent Stop was invoked');
    };
    const service = new SessionExecutionService(deps);
    const request = {
      type: 'session/cancel' as const,
      sessionId: 'session-1' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      turnId: 'parent-1',
      subagentTaskId: 'child-1',
    };
    expect(await service.cancelSession({ ...request, turnId: 'old-parent' })).toMatchObject({
      success: false,
    });
    expect([...runningChildren]).toEqual(['child-1', 'child-2']);
    expect(await service.cancelSession(request)).toEqual({ success: true });
    expect([...runningChildren]).toEqual(['child-2']);
    expect(deps.getActiveTurnId(request.sessionId)).toBe('parent-1');
  });
  it('advances one session owner through consecutive prompt handoffs', async () => {
    const frozenInput = {
      prompt: 'ROLE_INSTRUCTION\n\nchange direction',
      inputBlocks: [{ type: 'text' as const, text: 'change direction' }],
    };
    const steerPrompt = vi.fn(() => ({
      completion: new Promise(() => {}),
      outcome: Promise.resolve({
        outcome: 'applied' as const,
        application: { steerId: 'steer-application', release: vi.fn() },
      }),
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
    const sessionDoc = withHistoryPort({
      updateHistory: vi.fn(async () => {}),
    });
    const upsertDocMeta = vi.fn(async () => {});
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta, getDocMeta: vi.fn(async () => undefined) },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: async ({ inputBlocks }) =>
        inputBlocks.filter((block) => block.type === 'text'),
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
        inputConfig: frozenInput,
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
    expect(steerPrompt).toHaveBeenCalledWith('acp-steer', [
      { type: 'text', text: frozenInput.prompt },
    ]);
    expect(deps.applyAcpModeAndModel).toHaveBeenCalledOnce();
    expect(steerPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      upsertDocMeta.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY
    );
    expect(runtime.turnId).toBe('assistant:user-2');
    expect(runtime.userTurnId).toBe('user-2');
    expect(runtime.invocation).toEqual({
      requesterUserId: 'user-1',
      sourceTurnId: 'user-2',
      inputConfig: frozenInput,
    });
    expect(service.getActiveInvocationContext(sessionId)).toEqual({
      notificationOriginTurnIds: [],
      notificationProvenancePending: true,
      requesterUserId: 'user-1',
      sourceTurnId: 'user-2',
      inputConfig: frozenInput,
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
      return {
        completion: nextPrompt(),
        outcome: application.promise.then((lease) => ({
          outcome: 'applied' as const,
          application: lease,
        })),
      };
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setLastMessageAt: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      waitUntilSynced: vi.fn(async () => {}),
    });
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
        validateSessionCredentials: vi.fn(async () => {}),
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
    const lifecycle = service.continueSession(
      {
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
      },
      {}
    );

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
    await expect(steerD).resolves.toMatchObject({
      applied: false,
      disposition: 'delivery-unknown',
    });
    expect(history).toContainEqual(
      expect.objectContaining({ id: 'user-d', status: 'delivery_unknown' })
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
      lastHandledUserMsgId: 'user-c',
      processingUserMsgId: undefined,
    });
    await service.drainInboxExecutions();
    expect(deps.turnFinalization.onTurnOutcome).toHaveBeenCalledTimes(1);
    expect(deps.processMessageQueue).toHaveBeenCalledTimes(1);
    expect(service.getExecutionSnapshot(sessionId)).toMatchObject({ hasActiveTurn: false });
  });

  it.each(['applied', 'not-applied'] as const)(
    'waits for a handoff steer verdict that trails the yielded prompt (%s)',
    async (verdict) => {
      // Claude answers the yielded prompt first and confirms the steer only when
      // the SDK replays it; the steered prompt is the next turn, not drain work.
      const sessionId = 'session-steer-trailing-verdict' as SessionId;
      const yielded = createDeferred<unknown>();
      const steered = createDeferred<unknown>();
      const unsettled = new Set<Promise<unknown>>();
      const track = (promise: Promise<unknown>) => {
        unsettled.add(promise);
        const release = () => unsettled.delete(promise);
        void promise.then(release, release);
        return promise;
      };
      const outcome = createDeferred<
        | { outcome: 'applied'; application: { release: () => void } }
        | { outcome: 'not-applied'; error: unknown }
      >();
      const prompt = vi.fn(() => track(yielded.promise));
      const steerPrompt = vi.fn(() => ({
        completion: track(steered.promise),
        outcome: outcome.promise,
      }));
      const agentClient = {
        isCreated: vi.fn(() => true),
        getAcknowledgedSteerCapability: vi.fn(() => ({
          provider: 'claudeCode',
          appliedNotificationMethod: 'claude/steerApplied',
          upstreamTurn: 'handoff',
          configPolicy: 'apply',
        })),
        get pendingPromptCompletion(): Promise<void> | null {
          return unsettled.size > 0
            ? Promise.allSettled([...unsettled]).then(() => undefined)
            : null;
        },
        cancel: vi.fn(async () => {}),
        prompt,
        steerPrompt,
        currentModel: undefined,
      };
      const terminate = vi.fn(async () => {});
      const activeSession = {
        sessionId,
        acpSessionId: 'acp-steer-trailing-verdict' as ACPSessionId,
        agentClient,
        terminalManager: {} as unknown,
        getWorkdir: () => '/tmp',
        getHostWorkdir: () => '/tmp',
        getParentSessionId: () => undefined,
        exec: vi.fn(async () => ''),
        terminate,
        updateGitIdentity: vi.fn(),
        createAgent: vi.fn(async () => 'acp-steer-trailing-verdict'),
        applyExecutionPlaneLimits: vi.fn(async () => {}),
      };
      let history: Array<Record<string, unknown>> = [
        { id: 'user-a', role: 'user', status: 'pending', read: false },
        { id: 'user-b', role: 'user', status: 'pending_apply', read: false },
      ];
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => ({ isArchived: false })),
        setStatus: vi.fn(async () => {}),
        setLastMessageAt: vi.fn(async () => {}),
        getHistory: vi.fn(() => history),
        updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
          history = updater(history);
        }),
        waitUntilSynced: vi.fn(async () => {}),
      });
      let meta: Record<string, unknown> = {};
      const deps = createBaseDeps({
        sessionManager: {
          getSession: vi.fn(() => activeSession),
          getPendingSession: vi.fn(() => null),
          createSession: vi.fn(),
          setSessionError: vi.fn(),
          terminateSession: vi.fn(),
          validateSessionCredentials: vi.fn(async () => {}),
        } as unknown as SessionManager,
        workspaceDocument: {
          repo: {
            upsertDocMeta: vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
              meta = { ...meta, ...patch };
            }),
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
      const lifecycle = service.continueSession(
        {
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
        },
        {}
      );

      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      const steerB = service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-a',
        userTurnId: 'user-b',
        userId: 'user-1',
        timestamp: '2026-09-19T00:00:00.000Z',
        inputConfig: { prompt: 'B' },
      });
      await vi.waitFor(() => expect(steerPrompt).toHaveBeenCalledTimes(1));

      // The yielded prompt answers before the adapter reports the verdict.
      yielded.resolve({ stopReason: 'end_turn' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(service.getExecutionSnapshot(sessionId)).toMatchObject({
        activeTurnId: 'assistant:user-a',
        hasActiveTurn: true,
      });

      if (verdict === 'applied') {
        const release = vi.fn();
        outcome.resolve({ outcome: 'applied', application: { release } });
        await expect(steerB).resolves.toMatchObject({ applied: true, disposition: 'applied' });
        expect(release).toHaveBeenCalledOnce();
        await vi.waitFor(() =>
          expect(service.getExecutionSnapshot(sessionId)).toMatchObject({
            activeTurnId: 'assistant:user-b',
            hasActiveTurn: true,
          })
        );
        expect(deps.processMessageQueue).not.toHaveBeenCalled();

        steered.resolve({ stopReason: 'end_turn' });
        await lifecycle;
        expect(deps.turnFinalization.finalizeACPState).toHaveBeenNthCalledWith(
          2,
          sessionId,
          'assistant:user-b'
        );
        expect(history).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 'user-a', status: 'handled' }),
            expect.objectContaining({ id: 'user-b', status: 'handled' }),
          ])
        );
        expect(meta).toMatchObject({ lastHandledUserMsgId: 'user-b' });
      } else {
        // A prompt-transport refusal is only proven once its own prompt settles.
        steered.resolve({ stopReason: 'end_turn' });
        outcome.resolve({ outcome: 'not-applied', error: new Error('steer refused') });
        await expect(steerB).resolves.toMatchObject({
          applied: false,
          disposition: 'no-active-turn',
        });
        await lifecycle;
        expect(meta).toMatchObject({
          lastHandledUserMsgId: 'user-a',
          steerTurnStatuses: { 'user-b': 'pending' },
        });
        expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(1);
      }

      expect(terminate).not.toHaveBeenCalled();
      expect(deps.processMessageQueue).toHaveBeenCalledTimes(1);
      expect(service.getExecutionSnapshot(sessionId)).toMatchObject({ hasActiveTurn: false });
    }
  );

  it('rejects steer without mutating the active turn when the agent lacks support', async () => {
    const deps = createBaseDeps({});
    vi.mocked(deps.workspaceDocument.getOrCreateSessionDoc).mockResolvedValue(
      withHistoryPort({ updateHistory: vi.fn(async () => {}) }) as never
    );
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
        repo: { upsertDocMeta: vi.fn(async () => {}), getDocMeta: vi.fn(async () => undefined) },
        getOrCreateSessionDoc: vi.fn(async () =>
          withHistoryPort({ updateHistory: vi.fn(async () => {}) })
        ),
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
        getOrCreateSessionDoc: vi.fn(async () =>
          withHistoryPort({ updateHistory: vi.fn(async () => {}) })
        ),
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
    const promoted = Object.assign(
      {},
      ...upsertDocMeta.mock.calls.map((call) => (call[1] as Partial<SessionMeta>).steerTurnStatuses)
    );
    expect(promoted).toEqual({ 'user-2': 'pending', 'user-3': 'pending' });
  });

  it.each(['before', 'during-build'] as const)(
    'promotes a user-Stop steer before provider submission (Stop: %s)',
    async (cancelStage) => {
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
      const sessionDoc = withHistoryPort({
        updateHistory: vi.fn(
          async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
            history = update(history);
          }
        ),
      });
      const upsertDocMeta = vi.fn(async () => {});
      const deps = createBaseDeps({
        workspaceDocument: {
          repo: { upsertDocMeta, getDocMeta: vi.fn(async () => undefined) },
          getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        } as unknown as LoroDocumentManager,
      });
      const service = new SessionExecutionService(deps);
      const sessionId = 'session-steer-refused-before-provider' as SessionId;
      const steerPrompt = vi.fn(() => ({
        completion: new Promise(() => {}),
        outcome: Promise.resolve({
          outcome: 'not-applied' as const,
          error: new Error('Codex adapter reported not-applied'),
        }),
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
        cancelRequested: cancelStage === 'before',
        pendingInputOnCancel: 'promote' as const,
      };
      vi.mocked(deps.buildAcpPromptBlocks).mockImplementation(async () => {
        if (cancelStage === 'during-build') runtime.cancelRequested = true;
        return [{ type: 'text', text: 'do it differently' }];
      });
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

      expect(steerPrompt).not.toHaveBeenCalled();
      expect(history.find((entry) => entry.id === 'user-2')).toMatchObject({
        status: cancelStage === 'before' ? 'pending_apply' : 'pending',
        read: false,
      });
      expect(history.find((entry) => entry.id === 'user-1')).toMatchObject({ status: 'handled' });
      expect(upsertDocMeta).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ steerTurnStatuses: { 'user-2': 'pending' } })
      );
      expect(deps.turnFinalization.finalizeACPState).not.toHaveBeenCalled();
      expect(deps.beginConversationTurn).not.toHaveBeenCalled();
    }
  );

  it('does not submit a steer when Stop wins during the submitted marker write', async () => {
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
    const submittedWriteStarted = createDeferred<void>();
    const releaseSubmittedWrite = createDeferred<void>();
    let lastOperation: unknown;
    const setSteerOperationRecord = vi.fn(async (_operationId: string, record: unknown) => {
      if (
        record &&
        typeof record === 'object' &&
        'phase' in record &&
        record.phase === 'submitted'
      ) {
        submittedWriteStarted.resolve();
        await releaseSubmittedWrite.promise;
      }
      lastOperation = record;
    });
    const sessionDoc = withHistoryPort({
      setSteerOperationRecord,
      updateHistory: vi.fn(
        async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = update(history);
        }
      ),
    });
    const upsertDocMeta = vi.fn(async () => {});
    const steerPrompt = vi.fn(() => ({
      completion: new Promise(() => {}),
      outcome: Promise.resolve({
        outcome: 'applied' as const,
        application: { steerId: 'steer-after-stop', release: vi.fn() },
      }),
    }));
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      pendingPromptCompletion: null,
      getAcknowledgedSteerCapability: vi.fn(() => ({
        provider: 'codex',
        appliedNotificationMethod: 'codex/steerApplied',
        upstreamTurn: 'same',
        configPolicy: 'active',
      })),
      findSteerConfigMismatch: vi.fn(() => null),
      steerPrompt,
    };
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta, getDocMeta: vi.fn(async () => undefined) },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const sessionId = 'session-steer-stop-during-marker' as SessionId;
    const runtime = {
      sessionId,
      turnId: 'assistant:user-1',
      userTurnId: 'user-1',
      session: { agentClient, acpSessionId: 'acp-steer-stop' as ACPSessionId },
      promptInFlight: true,
      activePromptRun: { turnId: 'assistant:user-1' },
      cancelRequested: false,
      pendingInputOnCancel: 'preserve' as const,
    };
    (
      service as unknown as {
        turnRuntimeBySession: Map<SessionId, typeof runtime>;
      }
    ).turnRuntimeBySession.set(sessionId, runtime);

    const steering = service.steerSession({
      sessionId,
      expectedTurnId: 'assistant:user-1',
      userTurnId: 'user-2',
      userId: 'user-1',
      timestamp: '2026-09-14T00:00:00.000Z',
      inputConfig: { prompt: 'do it differently' },
    });
    await submittedWriteStarted.promise;

    await expect(
      service.cancelSession(
        {
          type: 'session/cancel',
          sessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          turnId: 'assistant:user-1',
        },
        { pendingInput: 'preserve' }
      )
    ).resolves.toEqual({ success: true });
    releaseSubmittedWrite.resolve();

    await expect(steering).resolves.toMatchObject({
      applied: false,
      disposition: 'stale-turn',
    });
    expect(steerPrompt).not.toHaveBeenCalled();
    expect(history.find((entry) => entry.id === 'user-2')).toMatchObject({
      status: 'pending_apply',
      read: false,
    });
    expect(lastOperation).toMatchObject({
      phase: 'settled',
      delivery: 'not_applied',
      status: 'pending',
      cancellationPolicy: 'preserve',
    });
  });

  it.each([false, true])(
    'recovers a not-applied steer after ESC (meta write failure: %s)',
    async (failMetaWrite) => {
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
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => ({ isArchived: false })),
        setStatus: vi.fn(async () => {}),
        getHistory: vi.fn(() => history),
        updateHistory: vi.fn(
          async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
            history = update(history);
          }
        ),
      });
      let meta: Record<string, unknown> = { latestUserMsgId: 'user-1' };
      let failurePending = failMetaWrite;
      const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
        if (
          (patch.steerTurnStatuses as Record<string, string> | undefined)?.['user-2'] ===
            'pending' &&
          failurePending
        ) {
          failurePending = false;
          throw new Error('Injected activation write failure');
        }
        meta = { ...meta, ...patch };
      });
      const outcome = createDeferred<{ outcome: 'not-applied'; error: Error }>();
      const steerSubmitted = createDeferred();
      const steerPrompt = vi.fn(() => {
        steerSubmitted.resolve();
        return {
          completion: new Promise(() => {}),
          outcome: outcome.promise,
        };
      });
      const agentClient = {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
        prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
        pendingPromptCompletion: null,
        currentModel: undefined,
        getAcknowledgedSteerCapability: vi.fn(() => ({
          provider: 'codex',
          appliedNotificationMethod: 'codex/steerApplied',
          upstreamTurn: 'same',
          configPolicy: 'active',
        })),
        findSteerConfigMismatch: vi.fn(() => null),
        steerPrompt,
      };
      const session = {
        sessionId: 'session-steer-refused' as SessionId,
        acpSessionId: 'acp-steer-refused' as ACPSessionId,
        agentClient,
        terminalManager: {} as unknown,
        getWorkdir: () => '/tmp',
        getHostWorkdir: () => '/tmp',
        getParentSessionId: () => undefined,
        exec: vi.fn(async () => ''),
        terminate: vi.fn(async () => {}),
        updateGitIdentity: vi.fn(),
        createAgent: vi.fn(async () => 'acp-steer-refused'),
        applyExecutionPlaneLimits: vi.fn(async () => {}),
      };
      const deps = createBaseDeps({
        sessionManager: {
          getSession: vi.fn(() => session),
          getPendingSession: vi.fn(() => null),
          createSession: vi.fn(),
          setSessionError: vi.fn(),
          terminateSession: vi.fn(),
          validateSessionCredentials: vi.fn(async () => {}),
        } as unknown as SessionManager,
        workspaceDocument: {
          repo: { upsertDocMeta, getDocMeta: vi.fn(async () => ({ meta })) },
          getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        } as unknown as LoroDocumentManager,
      });
      const service = new SessionExecutionService(deps);
      const sessionId = 'session-steer-refused' as SessionId;
      const runtime = {
        sessionId,
        turnId: 'assistant:user-1',
        userTurnId: 'user-1',
        session: { agentClient, acpSessionId: 'acp-steer-refused' as ACPSessionId },
        promptInFlight: true,
        activePromptRun: { turnId: 'assistant:user-1' },
        cancelRequested: false,
        pendingInputOnCancel: 'preserve' as const,
      };
      (
        service as unknown as {
          turnRuntimeBySession: Map<SessionId, typeof runtime>;
        }
      ).turnRuntimeBySession.set(sessionId, runtime);

      const steerRequest = {
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-07-19T00:00:00.000Z',
        inputConfig: { prompt: 'do it differently' },
      };
      const steering = service.steerSession(steerRequest);
      await steerSubmitted.promise;
      await service.cancelSession(
        {
          type: 'session/cancel',
          sessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          turnId: 'assistant:user-1',
        },
        { pendingInput: 'promote' }
      );
      outcome.resolve({
        outcome: 'not-applied',
        error: new Error('Codex adapter reported not-applied after interrupt'),
      });

      await expect(steering).resolves.toMatchObject({
        applied: false,
        disposition: failMetaWrite ? 'promotion-failed' : 'no-active-turn',
        ...(failMetaWrite ? { error: 'Injected activation write failure' } : {}),
      });
      expect(history.find((entry) => entry.id === 'user-2')).toMatchObject({
        status: 'pending',
        read: false,
      });
      if (failMetaWrite) {
        expect(meta.latestUserMsgId).toBe('user-1');
        // Retrying proven non-delivery repairs the activation of an already
        // pending entry. It never submits a second provider steer after Stop.
        await expect(service.steerSession(steerRequest)).resolves.toMatchObject({
          applied: false,
          disposition: 'no-active-turn',
        });
      }
      expect(meta.latestUserMsgId).toBe('user-1');
      expect(meta.steerTurnStatuses).toEqual({ 'user-2': 'pending' });
      expect(deps.turnFinalization.finalizeACPState).not.toHaveBeenCalled();
      expect(deps.beginConversationTurn).not.toHaveBeenCalled();

      (
        service as unknown as {
          turnRuntimeBySession: Map<SessionId, typeof runtime>;
        }
      ).turnRuntimeBySession.delete(sessionId);
      const nextMessage = {
        type: 'session/chat' as const,
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        project: undefined,
        acpSessionConfig: {
          prompt: 'do it differently',
          cliType: 'builtin' as const,
          agentType: 'codex',
        },
        userTurnId: 'user-2',
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      };
      await service.continueSession(nextMessage);
      expect(agentClient.prompt).toHaveBeenCalledOnce();
      expect(history.find((entry) => entry.id === 'user-2')).toMatchObject({ status: 'handled' });
    }
  );

  it('preserves pending steer input when an internal cancellation wins before delivery', async () => {
    let history: SessionHistoryInput[] = [
      {
        id: 'user-2',
        role: 'user',
        status: 'pending_apply',
        read: false,
        inputConfig: { prompt: 'do it differently' },
      } as SessionHistoryInput,
    ];
    const sessionDoc = withHistoryPort({
      updateHistory: vi.fn(
        async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = update(history);
        }
      ),
    });
    const upsertDocMeta = vi.fn(async () => {});
    const outcome = createDeferred<{
      outcome: 'not-applied';
      error: Error;
    }>();
    const steerSubmitted = createDeferred();
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      pendingPromptCompletion: null,
      getAcknowledgedSteerCapability: vi.fn(() => ({
        provider: 'codex',
        appliedNotificationMethod: 'codex/steerApplied',
        upstreamTurn: 'same',
        configPolicy: 'active',
      })),
      findSteerConfigMismatch: vi.fn(() => null),
      steerPrompt: vi.fn(() => {
        steerSubmitted.resolve();
        return { completion: new Promise(() => {}), outcome: outcome.promise };
      }),
    };
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta, getDocMeta: vi.fn(async () => undefined) },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const sessionId = 'session-internal-cancel-steer' as SessionId;
    const runtime = {
      sessionId,
      turnId: 'assistant:user-1',
      userTurnId: 'user-1',
      session: { agentClient, acpSessionId: 'acp-internal-cancel' as ACPSessionId },
      promptInFlight: true,
      activePromptRun: { turnId: 'assistant:user-1' },
      cancelRequested: false,
      pendingInputOnCancel: 'preserve' as const,
    };
    (
      service as unknown as {
        turnRuntimeBySession: Map<SessionId, typeof runtime>;
      }
    ).turnRuntimeBySession.set(sessionId, runtime);

    const steering = service.steerSession({
      sessionId,
      expectedTurnId: 'assistant:user-1',
      userTurnId: 'user-2',
      userId: 'user-1',
      timestamp: '2026-09-14T00:00:00.000Z',
      inputConfig: { prompt: 'do it differently' },
    });
    await steerSubmitted.promise;
    await service.cancelSession(
      {
        type: 'session/cancel',
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant:user-1',
      },
      { pendingInput: 'preserve' }
    );
    outcome.resolve({ outcome: 'not-applied', error: new Error('provider declined') });

    await expect(steering).resolves.toMatchObject({
      applied: false,
      disposition: 'stale-turn',
    });
    runtime.promptInFlight = false;
    await expect(
      service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-09-14T00:00:00.000Z',
        inputConfig: { prompt: 'do it differently' },
      })
    ).resolves.toMatchObject({ applied: false, disposition: 'stale-turn' });
    expect(history[0]).toMatchObject({ status: 'pending_apply' });
    expect(upsertDocMeta).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ latestUserMsgId: 'user-2' })
    );
  });

  it('does not requeue an undelivered steer whose turn already left the pending state', async () => {
    let history: SessionHistoryInput[] = [
      { id: 'user-2', role: 'user', status: 'processing', read: true } as SessionHistoryInput,
    ];
    const sessionDoc = withHistoryPort({
      getHistory: () => history,
      updateHistory: vi.fn(
        async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = update(history);
        }
      ),
    });
    let meta: Partial<SessionMeta> = {};
    const upsertDocMeta = vi.fn(async (_room: string, patch: Partial<SessionMeta>) => {
      meta = { ...meta, ...patch };
    });
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta, getDocMeta: vi.fn(async () => ({ meta })) },
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
    await service.reconcileSteerHistory(sessionId, sessionDoc);
    expect(history[0]).toMatchObject({ status: 'processing' });
    expect(meta.steerTurnStatuses).toEqual({});
  });

  it('leaves the producer-owned dispatch pointer untouched when execution takes ownership', async () => {
    let meta: Partial<SessionMeta> = { latestUserMsgId: 'user-3' };
    const upsertDocMeta = vi.fn(async (_room: string, patch: Partial<SessionMeta>) => {
      meta = { ...meta, ...patch };
    });
    const getDocMeta = vi.fn(async () => ({ meta }));
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta,
        },
        getOrCreateSessionDoc: vi.fn(async () =>
          withHistoryPort({ updateHistory: vi.fn(async () => {}) })
        ),
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const sessionDoc = withHistoryPort({ updateHistory: vi.fn(async () => {}) });
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
    expect(meta).toMatchObject({ latestUserMsgId: 'user-3', processingUserMsgId: 'user-2' });
  });

  it('cannot overwrite a newer activation while an earlier turn becomes terminal', async () => {
    let releaseHistoryWrite!: () => void;
    const historyWriteBlocked = new Promise<void>((resolve) => {
      releaseHistoryWrite = resolve;
    });
    const updateHistory = vi.fn(async () => {
      await historyWriteBlocked;
    });
    let meta: Partial<SessionMeta> = { latestUserMsgId: 'user-new' };
    const upsertDocMeta = vi.fn(async (_room: string, patch: Partial<SessionMeta>) => {
      meta = { ...meta, ...patch };
    });
    const getDocMeta = vi.fn(async () => ({ meta }));
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
      withHistoryPort({ updateHistory }),
      'user-old'
    );
    await vi.waitFor(() => expect(updateHistory).toHaveBeenCalledTimes(1));
    releaseHistoryWrite();
    await completion;

    expect(upsertDocMeta).toHaveBeenCalledWith(expect.any(String), {
      lastHandledUserMsgId: 'user-old',
      processingUserMsgId: undefined,
    });
    expect(meta).toMatchObject({ latestUserMsgId: 'user-new', lastHandledUserMsgId: 'user-old' });
  });

  it('keeps a steer that failed after submission out of the dispatch queue', async () => {
    let meta: Partial<SessionMeta> = { latestUserMsgId: 'user-3' };
    const upsertDocMeta = vi.fn(async (_room: string, patch: Partial<SessionMeta>) => {
      meta = { ...meta, ...patch };
    });
    const deps = createBaseDeps({
      workspaceDocument: {
        repo: { upsertDocMeta, getDocMeta: vi.fn(async () => ({ meta })) },
        getOrCreateSessionDoc: vi.fn(async () =>
          withHistoryPort({ updateHistory: vi.fn(async () => {}) })
        ),
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const sessionId = 'session-steer-ambiguous' as SessionId;
    // A plain failure after submission is ambiguous — the provider may already
    // have committed the steer, so re-sending it would duplicate the message.
    const steerPrompt = vi.fn(() => ({
      completion: new Promise(() => {}),
      outcome: Promise.resolve({
        outcome: 'unknown' as const,
        error: new Error('Steer steer-1 completed before application'),
      }),
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
    ).resolves.toMatchObject({ applied: false, disposition: 'delivery-unknown' });
    expect(meta).toMatchObject({
      latestUserMsgId: 'user-3',
      steerTurnStatuses: { 'user-2': 'delivery_unknown' },
    });
    expect(
      findNextDispatchableUserTurn(
        [{ id: 'user-2', role: 'user', status: 'delivery_unknown' } as SessionHistoryInput],
        meta as SessionMeta
      )
    ).toBeNull();
  });

  it.each([
    ['document', 'stop'],
    ['blocks', 'stop'],
    ['config', 'stop'],
    ['document', 'complete'],
    ['blocks', 'complete'],
    ['config', 'complete'],
  ] as const)('releases the steer lane during stalled %s on %s', async (stage, ending) => {
    const sessionId = 'session-steer-waits' as SessionId;
    let meta: Partial<SessionMeta> = {
      latestUserMsgId: 'newer-input',
      lastMissingHistoryUserMsgId: 'missing-input',
    };
    const repo = {
      getDocMeta: async () => ({ meta }),
      upsertDocMeta: async (_room: string, patch: Partial<SessionMeta>) => {
        meta = { ...meta, ...patch };
      },
    };
    const sessionDoc = new SessionDocument(
      repo as never,
      sessionId,
      async () => {},
      createSilentLogger()
    );
    composeTestSessionDoc(sessionDoc, {
      history: ['guide', 'queued-guide'].map((id) => ({
        id,
        role: 'user',
        status: 'pending_apply',
        timestamp: '2026-09-16T00:00:00Z',
        items: [{ type: 'text', text: id }],
        inputConfig: { prompt: id },
      })),
    });
    const entered = createDeferred();
    const release = createDeferred();
    const prompt = createDeferred();
    const mutations: string[] = [];
    const prepared: string[] = [];
    const block = async () => {
      entered.resolve();
      await release.promise;
    };
    const agentClient = {
      isCreated: () => true,
      cancel: async () => {},
      pendingPromptCompletion: null,
      getAcknowledgedSteerCapability: () => ({ configPolicy: 'apply', upstreamTurn: 'handoff' }),
      steerPrompt: () => {
        throw new Error('A stopped preparation must never submit');
      },
      setSessionMode: async () => {
        mutations.push('mode');
        if (stage === 'config') await block();
      },
      unstable_setSessionModel: async () => {
        mutations.push('model');
      },
    };
    const session = { sessionId, acpSessionId: 'acp-waits' as ACPSessionId, agentClient };
    const deps = createBaseDeps({
      workspaceDocument: {
        repo,
        getOrCreateSessionDoc: async () => {
          if (stage === 'document') await block();
          return sessionDoc;
        },
      } as unknown as LoroDocumentManager,
      buildAcpPromptBlocks: async ({ inputBlocks }) => {
        prepared.push(JSON.stringify(inputBlocks));
        if (stage === 'blocks') await block();
        return [{ type: 'text', text: 'guide' }];
      },
      applyAcpModeAndModel: async (_session, config, options) => {
        await applyAcpSessionRunConfig({
          session: session as never,
          config,
          signal: options?.signal,
          logger: createSilentLogger(),
        });
      },
    });
    const service = new SessionExecutionService(deps);
    const run = service['createPromptHandoffRun']({
      turnId: 'assistant:source',
      promptPromise: prompt.promise,
    });
    const runtime = {
      sessionId,
      turnId: run.turnId,
      userTurnId: 'source',
      session,
      promptStarted: true,
      promptInFlight: true,
      cancelRequested: false,
      pendingInputOnCancel: 'preserve',
    };
    service['turnRuntimeBySession'].set(sessionId, runtime as never);
    const tail = service['awaitPromptHandoffTail'](runtime as never, run);
    const request = {
      sessionId,
      expectedTurnId: run.turnId,
      userTurnId: 'guide',
      userId: 'user',
      timestamp: '2026-09-16T00:00:00Z',
      inputConfig: { prompt: 'guide', modeId: 'mode', modelId: 'model' },
    };
    const steering = service.steerSession(request);
    await entered.promise;
    const queued = service.steerSession({ ...request, userTurnId: 'queued-guide' });
    if (ending === 'stop') {
      await service.cancelSession(
        {
          type: 'session/cancel',
          sessionId,
          turnId: run.turnId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
        },
        { pendingInput: 'promote' }
      );
    }
    prompt.resolve();
    await expect(steering).resolves.toMatchObject({ applied: false, recoveryOwned: true });
    await expect(queued).resolves.toMatchObject({ applied: false, recoveryOwned: true });
    const releaseRewrite = service.tryAcquireSessionRewriteBarrier(sessionId);
    expect(releaseRewrite).not.toBeNull();
    releaseRewrite?.();
    expect(meta).toMatchObject({
      latestUserMsgId: 'newer-input',
      lastMissingHistoryUserMsgId: 'missing-input',
      steerTurnStatuses: { guide: 'pending', 'queued-guide': 'pending' },
    });
    expect(prepared).toHaveLength(stage === 'document' ? 0 : 1);
    release.resolve();
    await tail;
    expect(mutations).toEqual(stage === 'config' ? ['mode'] : []);
    await service.reconcileSteerHistory(sessionId, sessionDoc);
    expect(
      findNextDispatchableUserTurn(
        (await sessionDoc.sessionData.history.readAll()) as SessionHistoryInput[],
        meta as SessionMeta
      )?.id
    ).toBe('guide');
  });

  it.each(['not-applied', 'applied', 'unknown'] as const)(
    'projects a late %s verdict by exact identity when history arrives after Stop',
    async (outcome) => {
      const sessionId = 'late-steer-history' as SessionId;
      let meta: Partial<SessionMeta> = { latestUserMsgId: 'C', lastHandledUserMsgId: 'A' };
      const repo = {
        getDocMeta: async () => ({ meta }),
        upsertDocMeta: async (_room: string, patch: Partial<SessionMeta>) => {
          meta = { ...meta, ...patch };
        },
      };
      const sessionDoc = new SessionDocument(
        repo as never,
        sessionId,
        async () => {},
        createSilentLogger()
      );
      composeTestSessionDoc(sessionDoc);
      const submitted = createDeferred();
      const verdict = createDeferred<import('../src/agent/agent-client').SteerOutcomeResult>();
      let released = false;
      const agentClient = {
        isCreated: () => true,
        cancel: async () => {},
        pendingPromptCompletion: null,
        getAcknowledgedSteerCapability: () => ({ configPolicy: 'active', upstreamTurn: 'same' }),
        findSteerConfigMismatch: () => null,
        steerPrompt: () => {
          submitted.resolve();
          return { completion: new Promise(() => {}), outcome: verdict.promise };
        },
      };
      const deps = createBaseDeps({
        workspaceDocument: {
          repo,
          getOrCreateSessionDoc: async () => sessionDoc,
        } as unknown as LoroDocumentManager,
      });
      const service = new SessionExecutionService(deps);
      service['turnRuntimeBySession'].set(sessionId, {
        sessionId,
        turnId: 'assistant:A',
        userTurnId: 'A',
        session: { sessionId, agentClient, acpSessionId: 'acp' },
        promptStarted: true,
        promptInFlight: true,
        activePromptRun: { turnId: 'assistant:A' },
        cancelRequested: false,
      } as never);
      const steering = service.steerSession({
        sessionId,
        expectedTurnId: 'assistant:A',
        userTurnId: 'B',
        userId: 'user',
        timestamp: '2026-09-16T00:00:00Z',
        inputConfig: { prompt: 'guide' },
      });
      await submitted.promise;
      await service.cancelSession(
        {
          type: 'session/cancel',
          sessionId,
          turnId: 'assistant:A',
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
        },
        { pendingInput: 'promote' }
      );
      verdict.resolve(
        outcome === 'applied'
          ? {
              outcome,
              application: {
                steerId: 'steer-B',
                release: () => {
                  released = true;
                },
              },
            }
          : { outcome, error: new Error('Synthetic verdict') }
      );
      await steering;
      expect(released).toBe(outcome === 'applied');
      expect(meta.steerOperationLedger?.['steer:B']).toMatchObject({
        operationId: 'steer:B',
        userTurnId: 'B',
        expectedTurnId: 'assistant:A',
        phase: 'settled',
        delivery:
          outcome === 'not-applied' ? 'not_applied' : outcome === 'applied' ? 'applied' : 'unknown',
      });
      const expected =
        outcome === 'not-applied'
          ? 'pending'
          : outcome === 'applied'
            ? 'canceled'
            : 'delivery_unknown';
      expect(meta).toMatchObject({ latestUserMsgId: 'C', steerTurnStatuses: { B: expected } });
      const restarted = new SessionExecutionService(deps);
      await sessionDoc.sessionData.commands.appendTurn({
        id: 'B',
        role: 'user',
        status: 'pending_apply',
        timestamp: '2026-09-16T00:00:00Z',
        items: [{ type: 'text', text: 'guide' }],
      });
      await restarted.reconcileSteerHistory(sessionId, sessionDoc);
      expect(await sessionDoc.sessionData.history.readTurn('B')).toMatchObject({
        state: 'ready',
        turn: { status: outcome === 'not-applied' ? 'seen' : expected },
      });
      expect(meta.latestUserMsgId).toBe('C');
      expect(
        findNextDispatchableUserTurn(
          (await sessionDoc.sessionData.history.readAll()) as SessionHistoryInput[],
          meta as SessionMeta
        )?.id
      ).toBe(outcome === 'not-applied' ? 'B' : undefined);
      expect(meta.steerTurnStatuses).toEqual(outcome === 'not-applied' ? { B: 'pending' } : {});
    }
  );

  it('recovers provider-confirmed steer delivery without degrading it to unknown', async () => {
    const sessionId = 'recover-applied-steer' as SessionId;
    let meta: Partial<SessionMeta> = {
      latestUserMsgId: 'newer-user',
      steerTurnStatuses: { 'steer-user': 'processing' },
      steerOperationLedger: {
        'steer:steer-user': {
          operationId: 'steer:steer-user',
          userTurnId: 'steer-user',
          expectedTurnId: 'assistant:previous-user',
          cancellationPolicy: 'promote',
          phase: 'submitted',
          delivery: 'applied',
          status: 'processing',
          updatedAt: 10,
        },
      },
    };
    const repo = {
      getDocMeta: async () => ({ meta }),
      upsertDocMeta: async (_roomId: string, patch: Partial<SessionMeta>) => {
        meta = { ...meta, ...patch };
      },
    };
    const sessionDoc = new SessionDocument(
      repo as never,
      sessionId,
      async () => {},
      createSilentLogger()
    );
    composeTestSessionDoc(sessionDoc, {
      history: [
        {
          id: 'steer-user',
          role: 'user',
          timestamp: '2026-09-30T00:00:00.000Z',
          status: 'pending_apply',
          items: [{ type: 'text', text: 'continue the accepted steer' }],
        } as SessionHistoryInput,
      ],
    });
    const service = new SessionExecutionService(
      createBaseDeps({
        workspaceDocument: {
          repo,
          getOrCreateSessionDoc: async () => sessionDoc,
        } as unknown as LoroDocumentManager,
      })
    );

    await service.reconcileSteerHistory(sessionId, sessionDoc);

    expect(meta.steerOperationLedger?.['steer:steer-user']).toMatchObject({
      phase: 'settled',
      delivery: 'applied',
      status: 'handled',
    });
    expect(meta.steerTurnStatuses).toEqual({});
    expect(await sessionDoc.sessionData.history.readTurn('steer-user')).toMatchObject({
      state: 'ready',
      turn: { status: 'handled' },
    });
    expect(meta.latestUserMsgId).toBe('newer-user');
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false, latestGoal: activeGoal })),
      setStatus: vi.fn(async () => {}),
      setLastMessageAt: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    });
    const onTurnOutcome = vi.fn(async () => {});
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => activeSession),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
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
        onTurnOutcome,
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
    await service.drainInboxExecutions();
    expect(onTurnOutcome).toHaveBeenCalledTimes(1);
  });

  it('restores the ACP process before prompting when the turn Git identity changed', async () => {
    const sessionId = 'session-requester-switch' as SessionId;
    let history: Array<Record<string, unknown>> = [
      { id: 'turn-user-2', role: 'user', status: 'pending', read: false },
    ];
    const oldPrompt = vi.fn(async () => ({}));
    const oldSession = {
      sessionId,
      acpSessionId: 'acp-owner' as ACPSessionId,
      agentClient: {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
        prompt: oldPrompt,
        currentModel: undefined,
      },
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-owner'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({
        isArchived: false,
        acpSessionId: 'acp-owner' as ACPSessionId,
      })),
      setStatus: vi.fn(async () => {}),
      setLastMessageAt: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    });
    const terminateSession = vi.fn(async () => {});
    const createSession = vi.fn();
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => oldSession),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession,
        validateSessionCredentials: vi.fn(async () => {}),
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
    });

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: 'continue', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-user-2',
      userId: 'user-2',
      userName: 'Teammate',
      userEmail: 'teammate@example.com',
    });

    expect(terminateSession).not.toHaveBeenCalled();
    expect(oldSession.terminate).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(oldPrompt).toHaveBeenCalledOnce();
    expect(oldSession.updateGitIdentity).toHaveBeenCalledWith(
      'Teammate',
      'teammate@example.com',
      'user-2',
      { preferMachineIdentity: false, personalIdentityEnabled: false }
    );
  });

  // An adapter that swallows an upstream failure (an over-context request answered
  // with HTTP 400 is the observed case) resolves the prompt as if the turn had
  // succeeded. Without the no-output guard that walked the whole success path and
  // left the user with an unanswered message and no error anywhere.
  const runSilentPromptTurn = async (options: {
    sessionId: string;
    userTurnId?: string;
    workspaceId?: WorkspaceId;
    requesterUserId?: string;
    inputAuthor?: SessionHistoryInput['author'];
    earlierInputAuthor?: SessionHistoryInput['author'];
    attempts?: number;
    hasPromptEventsForTurn: boolean;
    content?: boolean | 'unobservable';
    dispatchSource?: 'rpc' | 'crdt' | 'queue' | 'goal';
    promptFailure?: unknown;
    notificationAudience?: TurnResultAudience;
    onTurnOutcome?: (fact: TurnOutcomeFact) => Promise<void>;
    onTurnClaimed?: () => Promise<boolean>;
    onTurnStarted?: () => Promise<boolean>;
    encryptedExecution?: ReturnType<typeof makeEncryptedAgentExecution>;
    prepared?: boolean;
    create?: boolean;
    onPrompt?: (service: SessionExecutionService) => Promise<void>;
    /** Requested by the turn message; untrusted input. */
    project?: ProjectRef;
    /** Synced Session meta; writable by any member. */
    meta?: Record<string, unknown>;
    /** Machine-held configuration of the live Session process. */
    liveConfig?: { project?: ProjectRef; parentSessionId?: SessionId };
    /** No live process: the turn restores one; started configurations are recorded. */
    restore?: SessionConfig[];
  }) => {
    let history: Array<Record<string, unknown>> = [
      ...(options.earlierInputAuthor
        ? [
            {
              id: 'older-input',
              role: 'user',
              status: 'handled',
              author: options.earlierInputAuthor,
            },
          ]
        : []),
      {
        id: options.userTurnId ?? 'turn-user-1',
        role: 'user',
        author: options.inputAuthor,
        status: 'pending',
        read: false,
      },
    ];
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => {
        await options.onPrompt?.(service);
        if (options.promptFailure) throw options.promptFailure;
        return { stopReason: 'end_turn' };
      }),
      currentModel: undefined,
    };
    const activeSession = {
      sessionId: options.sessionId as SessionId,
      acpSessionId: 'acp-silent' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => options.liveConfig?.parentSessionId,
      getExecutionScope: () => options.liveConfig ?? {},
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-silent'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    let status = SessionStatusFactory.idle();
    let restored = false;
    const sessionDoc = withHistoryPort({
      // Read at call time, so a test can change synced metadata mid-turn.
      getMetaState: vi.fn(async () => ({ isArchived: false, ...options.meta })),
      setStatus: vi.fn(async (next: typeof status) => {
        status = next;
      }),
      setLastMessageAt: vi.fn(async () => {}),
      waitUntilSynced: async () => {},
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    });
    const failureMessages: string[] = [];
    const notificationFacts: TurnOutcomeFact[] = [];
    const onTurnOutcome = vi.fn(async (fact: TurnOutcomeFact) => {
      await options.onTurnOutcome?.(fact);
      notificationFacts.push(fact);
    });
    const finalizationOwners: boolean[] = [];
    const upsertDocMeta = vi.fn(async () => {});
    const deps = createBaseDeps({
      workspaceId: options.workspaceId ?? 'workspace-1',
      encryptedExecution: options.encryptedExecution,
      recordChatFailure: vi.fn(async (_doc, _reason, message) => {
        if (message) failureMessages.push(message);
      }),
      beginConversationTurn: vi.fn(
        (_sessionId: SessionId, parentTurnId?: string) => `assistant:${parentTurnId ?? 'unbound'}`
      ),
      createAssistantEntryForTurn: vi.fn(async (_sessionId, _sessionDoc, turnId) => {
        const entry = { id: turnId, role: 'assistant', finished: false, endedAt: undefined };
        history = history.some((item) => item.id === turnId)
          ? history.map((item) => (item.id === turnId ? entry : item))
          : [...history, entry];
      }),
      sessionManager: {
        getSession: vi.fn(() => (options.restore && !restored ? null : activeSession)),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(async (config: SessionConfig) => {
          // Like SessionManager, preparation rereads the Project group from synced metadata.
          const current = options.meta?.projectRun as SessionConfig['projectRun'];
          if (current) await config.authorizeExecutionInputs?.({ projectRun: current });
          options.restore?.push({ ...config, projectRun: current ?? config.projectRun });
          restored = true;
          return activeSession;
        }),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
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
        onTurnOutcome,
        finalizeACPState: vi.fn(async (_sessionId, turnId) => {
          finalizationOwners.push(
            service.getExecutionSnapshot(options.sessionId as SessionId).hasActiveTurn
          );
          history = markAssistantTurnFinished(history as SessionHistoryInput[], {
            turnId,
            endedAt: 42,
          });
        }),
      },
      observePromptContentForTurn: vi.fn(() =>
        options.content === 'unobservable'
          ? undefined
          : (options.content ?? options.hasPromptEventsForTurn)
      ),
      hasPromptEventsForTurn: vi.fn(() => options.hasPromptEventsForTurn),
    });

    const service = new SessionExecutionService(deps);
    for (let attempt = 0; attempt < (options.attempts ?? 1); attempt += 1) {
      const message = {
        type: 'session/chat' as const,
        sessionId: options.sessionId as SessionId,
        machineId: 'machine-1',
        workspaceId: options.workspaceId ?? 'workspace-1',
        project: options.project,
        acpSessionConfig: { prompt: 'hi', cliType: 'builtin' as const, agentType: 'codex' },
        userTurnId: options.userTurnId ?? 'turn-user-1',
        userId: options.requesterUserId ?? 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      };
      if (options.prepared) {
        await service.dispatchPreparedSessionTurn({
          sessionId: message.sessionId,
          sessionDoc,
          userTurnId: message.userTurnId,
          invocation: {
            sourceTurnId: message.userTurnId,
            requesterUserId: message.userId,
            inputConfig: message.acpSessionConfig,
          },
          dispatchSource: options.dispatchSource ?? 'crdt',
          accessPromise: Promise.resolve({ outcome: 'allowed' }),
          requestPromise: Promise.resolve(
            options.create
              ? { mode: 'create', request: { ...message, type: 'session/create' } }
              : { mode: 'continue', request: message }
          ),
          onAccessAllowed: async () => {},
          onAccessDenied: async () => {},
          onAccessIndeterminate: async () => {},
        });
      } else {
        await service.continueSession(message, {
          notificationAudience: options.notificationAudience ?? { kind: 'user' },
          ...(options.dispatchSource ? { dispatchSource: options.dispatchSource } : {}),
          ...(options.onTurnClaimed ? { onTurnClaimed: options.onTurnClaimed } : {}),
          ...(options.onTurnStarted ? { onTurnStarted: options.onTurnStarted } : {}),
        });
      }
    }

    await service.drainInboxExecutions();
    return withHistoryPort({
      deps,
      sessionDoc,
      notificationFacts,
      failureMessages,
      upsertDocMeta,
      agentClient,
      getHistory: () => history,
      getStatus: () => status,
      finalizationOwners,
      service,
    });
  };

  const encryptedExecutionFixture = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'encrypted-execution-'));
    const filename = path.join(directory, 'execution.sqlite');
    const gate = (
      authorization: 'authorized' | 'denied' | 'expired' = 'authorized',
      file = filename,
      workspaceId = 'workspace-1'
    ) =>
      makeEncryptedAgentExecution({
        genesis: 'genesis',
        workspaceId,
        targetMachineId: 'machine-1',
        journal: lazyExecutionJournal(file, () => 100),
        resolveVerifiedOriginal: () =>
          Effect.succeed({
            requesterDevice: 'ab'.repeat(32),
            requesterCryptoUserId: 'user-1',
            expiresAt: authorization === 'expired' ? 100 : 1000,
          }),
        authorizeExecution: () =>
          Effect.succeed(
            authorization === 'denied'
              ? { _tag: 'Denied', reason: 'not-authorized' }
              : { _tag: 'Authorized' }
          ),
      });
    const intent = {
      workspaceId: 'workspace-1',
      sessionId: 'encrypted-session',
      userTurnId: 'turn-user-1',
      requesterUserId: 'user-1',
    };
    return {
      directory,
      filename,
      gate,
      intent,
      close: () => fs.rmSync(directory, { recursive: true, force: true }),
    };
  };

  const runProductionSignedTurn = async (
    mode:
      | 'account'
      | 'snapshot'
      | 'delayed'
      | 'expired'
      | 'revoked-device'
      | 'guest'
      | 'removed-member'
      | 'same-member'
      | 'other-member'
      | 'other-member-shared'
      | 'other-member-closed'
      | 'backfill-member-removed'
      | 'backfill-device-revoked'
      | 'backfill-network'
  ) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-native-execution-'));
    vi.stubEnv('LODY_DATA_DIR', directory);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-28T02:00:00Z'));
    const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
    const accountId = 'synthetic-account';
    const workspaceId = 'workspace-1' as WorkspaceId;
    const sessionId = 'production-session' as SessionId;
    // The real encrypted UI writes runtime.accountId, not the ledger's crypto user ID.
    const user = accountId;
    const backfillFailure = mode.startsWith('backfill-');
    const terminalBackfill =
      mode === 'backfill-member-removed' || mode === 'backfill-device-revoked';
    const removalReleased = Promise.withResolvers<void>();
    const snapshotOnly =
      mode === 'snapshot' || mode === 'delayed' || mode === 'expired' || backfillFailure;
    const deniedSigner =
      mode === 'revoked-device' ||
      mode === 'guest' ||
      mode === 'removed-member' ||
      mode === 'other-member' ||
      mode === 'other-member-closed';
    const identity = cliE2eeIdentityDirectory(accountId, workspaceId);
    const noKeyring = async () => {
      throw new Error('synthetic missing keyring');
    };
    const wrapKey = Buffer.alloc(32, 7);
    let lody: Lody | undefined;
    const { LoroDoc, LoroMap } = await import('loro-crdt');
    const source = new LoroDoc();
    const submitted: string[] = [];
    const invocations: Array<{ requesterUserId: string } | undefined> = [];
    const presence = bindTestPresenceApplication(createSilentLogger());
    const execute = <A, E>(effect: Effect.Effect<A, E, import('effect').Scope.Scope>) =>
      Effect.runPromise(Effect.scoped(effect));
    try {
      const fixture = await execute(
        Effect.gen(function* () {
          const ownerCustody = yield* makeNodeE2eeCustody({
            directory: path.join(directory, 'owner'),
            wrapper: {
              protection: 'os-keystore',
              wrap: async (value) => {
                const nonce = randomBytes(12);
                const cipher = createCipheriv('aes-256-gcm', wrapKey, nonce);
                return Buffer.concat([
                  nonce,
                  cipher.update(value),
                  cipher.final(),
                  cipher.getAuthTag(),
                ]);
              },
              unwrap: async (value) => {
                const cipher = createDecipheriv('aes-256-gcm', wrapKey, value.subarray(0, 12));
                cipher.setAuthTag(value.subarray(-16));
                return {
                  result: Buffer.concat([
                    cipher.update(value.subarray(12, -16)),
                    cipher.final(),
                  ]).toString(),
                  shouldReEncrypt: false,
                };
              },
            },
          });
          const prepared = yield* ownerCustody.prepareDevice();
          const membershipId = Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10)));
          const genesis = yield* signGenesisRecord({
            signer: prepared,
            encryptionPublicKey: prepared.enc,
            initialKey: Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(20))),
            userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(30))),
            membershipId,
          });
          const owner = yield* ownerCustody.retainDevice(genesis.genesis, prepared);
          const custody = yield* makeCliE2eeCustody({
            directory: path.join(identity, 'custody'),
            keyring: noKeyring,
          });
          const machine = yield* custody.createDevice(genesis.genesis);
          let view = Result.getOrThrow(
            verifyLedger({
              anchor: genesis.genesis,
              records: [genesis.record],
              checkpoint: { length: 1, head: hashRecordBytes(genesis.record) },
            })
          );
          const admission = yield* prepareDeviceAdmission({
            genesis: genesis.genesis,
            membershipId,
            signer: machine,
            encryptionPublicKey: machine.enc,
            kind: 'machine',
            machineId: 'machine-1',
          });
          const record = yield* signLedgerRecord(
            Result.getOrThrow(prepareLedgerCommand(view, owner.publicKey, admission)),
            owner
          );
          view = Result.getOrThrow(
            extendLedger(view, [record], { length: 2, head: hashRecordBytes(record) })
          );
          const records = [genesis.record, record];
          const append = Effect.fnUntraced(function* (
            command: Parameters<typeof prepareLedgerCommand>[2]
          ) {
            const next = yield* signLedgerRecord(
              Result.getOrThrow(prepareLedgerCommand(view, owner.publicKey, command)),
              owner
            );
            records.push(next);
            view = Result.getOrThrow(
              extendLedger(view, [next], { length: records.length, head: hashRecordBytes(next) })
            );
          });
          let originalSigner:
            | typeof owner
            | Effect.Success<ReturnType<typeof ownerCustody.prepareDevice>> = owner;
          const senderMemberId = Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(40)));
          if (deniedSigner || mode === 'same-member' || mode === 'other-member-shared') {
            const other = yield* ownerCustody.prepareDevice();
            originalSigner = other;
            if (mode === 'revoked-device' || mode === 'same-member') {
              yield* append(
                yield* prepareDeviceAdmission({
                  genesis: genesis.genesis,
                  membershipId,
                  signer: other,
                  encryptionPublicKey: other.enc,
                  kind: 'personal',
                })
              );
            } else {
              const request = yield* prepareJoinRequest({
                genesis: genesis.genesis,
                requestId: Result.getOrThrow(Bytes.requestId(new Uint8Array(16).fill(50))),
                userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(60))),
                encryptionPublicKey: other.enc,
                expiresAt: null,
                signer: other,
              });
              yield* append({ _tag: 'AdmitMember', membershipId: senderMemberId, request });
            }
          }
          yield* custody.prepareDeviceCredential(genesis.genesis, machine.publicKey);
          const frame = yield* prepareEpochEnvelope({
            context: {
              genesis: genesis.genesis,
              epoch: Result.getOrThrow(Bytes.epochNumber(0)),
              sender: owner.publicKey,
              recipient: machine.publicKey,
            },
            key: Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(20))),
            signer: owner,
            ledger: () => Effect.succeed(view),
          });
          const binding = yield* makeStreamsUpdateBinding({
            genesis: genesis.genesis,
            resource: 'doc:session-production-session',
            model: 'loro',
            writeEpoch: 'current',
            signer: originalSigner,
            ledger: () => Effect.succeed(view),
            readEpochKey: () => Effect.fromResult(Bytes.epochKey(new Uint8Array(32).fill(20))),
          });
          const inputConfig = { prompt: 'hi', cliType: 'builtin', agentType: 'codex' };
          const row = source.getList('history').insertContainer(0, new LoroMap());
          row.set('id', 'turn-user-1');
          row.set('role', 'user');
          row.set('userId', user);
          row.set('timestamp', new Date().toISOString());
          row.set('status', 'pending');
          row.set('inputConfig', inputConfig);
          row.set('items', [{ type: 'text', text: 'hi' }]);
          if (backfillFailure) {
            const next = source.getList('history').insertContainer(1, new LoroMap());
            for (const [key, value] of Object.entries({
              id: 'turn-user-2',
              role: 'user',
              userId: user,
              timestamp: new Date().toISOString(),
              status: 'pending',
              inputConfig,
              items: [{ type: 'text', text: 'hi' }],
            }))
              next.set(key, value);
          }
          source.commit();
          const update = source.export({ mode: 'update' });
          const plaintext = new Uint8Array(update.length + 4);
          new DataView(plaintext.buffer).setUint32(0, update.length, false);
          plaintext.set(update, 4);
          const context = {
            protocol: 'loro-streams-crdt-payload-protection',
            version: 2,
            kind: 'update_batch',
          } as const;
          const envelopePrefix = Uint8Array.of(76, 83, 67, 69, 2, 1, 0, 1, 0, 0, 3);
          const protocolPrefix = new TextEncoder().encode(
            'loro-streams-crdt-payload-protection/v2\0'
          );
          const envelopeAAD = new Uint8Array(protocolPrefix.length + envelopePrefix.length);
          envelopeAAD.set(protocolPrefix);
          envelopeAAD.set(envelopePrefix, protocolPrefix.length);
          const aad = encodeStreamsRoomAdditionalData(
            `lody-e2ee:${hex(genesis.genesis.toBytes())}`,
            { kind: 'doc', docId: 'session-production-session' },
            envelopeAAD
          );
          const sealed = yield* binding.seal({ context, plaintext, additionalData: () => aad });
          const message = new Uint8Array(4 + envelopePrefix.length + sealed.sealed.length);
          new DataView(message.buffer).setUint32(0, message.length - 4, false);
          message.set(envelopePrefix, 4);
          message.set(sealed.sealed, 4 + envelopePrefix.length);
          const snapshotBinding = yield* makeStreamsUpdateBinding({
            genesis: genesis.genesis,
            resource: 'doc:session-production-session',
            model: 'loro',
            writeEpoch: 'current',
            signer: machine,
            ledger: () => Effect.succeed(view),
            readEpochKey: () => Effect.fromResult(Bytes.epochKey(new Uint8Array(32).fill(20))),
          });
          const snapshotPrefix = Uint8Array.from(envelopePrefix);
          snapshotPrefix[5] = 2;
          snapshotPrefix[10] = 4;
          const snapshotEnvelopeAAD = new Uint8Array(envelopeAAD);
          snapshotEnvelopeAAD.set(snapshotPrefix, protocolPrefix.length);
          const snapshotAAD = encodeStreamsRoomAdditionalData(
            `lody-e2ee:${hex(genesis.genesis.toBytes())}`,
            { kind: 'doc', docId: 'session-production-session' },
            snapshotEnvelopeAAD
          );
          const snapshotContext = {
            ...context,
            kind: 'snapshot',
            continuationOffset: '00000000000000000000',
          } as const;
          const snapshot = yield* snapshotBinding.seal({
            context: snapshotContext,
            plaintext: source.export({ mode: 'snapshot' }),
            additionalData: () => snapshotAAD,
          });
          if (mode === 'revoked-device')
            yield* append({ _tag: 'RevokeDevice', target: originalSigner.publicKey });
          if (mode === 'guest')
            yield* append({ _tag: 'SetRole', membershipId: senderMemberId, role: 'guest' });
          if (mode === 'removed-member')
            yield* append({ _tag: 'DeclareCapabilities', capabilities: [1] });
          if (mode === 'removed-member')
            yield* append({ _tag: 'RemoveMember', membershipId: senderMemberId });
          const sharingScope = {
            workspaceId,
            genesisHash: hex(genesis.genesis.toBytes()),
            machineId: 'machine-1',
            ownerMembershipId: hex(membershipId.toBytes()),
            generation: hex(machine.publicKey.toBytes()),
          };
          const sharingPolicy = {
            ...sharingScope,
            sharedWithTeam: mode === 'other-member-shared',
            projects: [],
            revision: 1,
            previousDigest: null,
            requestId: '81'.repeat(16),
            signer: hex(owner.publicKey.toBytes()),
            issuedAt: Date.now(),
          };
          const leaf = yield* scopedDocumentKey(
            Result.getOrThrow(machineSharingContentScope(sharingScope, 0)),
            Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(20)))
          );
          const sharingFrame = yield* sealMachineSharingPolicy({
            machineGeneration: Result.getOrThrow(
              verifyMachineSharingGeneration({
                ledger: view,
                machineId: 'machine-1',
                device: machine.publicKey,
                admissionChain: records
                  .map((original, index) => ({ record: original, length: index + 1 }))
                  .filter(({ record: original }) => {
                    const body = Result.getOrThrow(decodeRecord(original)).body;
                    return (
                      body.type === 'ordinary' &&
                      body.operation.type === 'admitDevice' &&
                      body.operation.kind === 'machine'
                    );
                  }),
              })
            ),
            policy: sharingPolicy,
            epoch: 0,
            documentKey: leaf,
            signer: owner,
            ledger: () => Effect.succeed(view),
          });
          const sharingVersion = {
            ...sharingScope,
            revision: 1,
            previousDigest: null,
            requestId: sharingPolicy.requestId,
            digest: Result.getOrThrow(machineSharingDigest(sharingFrame)),
            frameHex: hex(sharingFrame),
          };
          return {
            sharingVersion,
            genesis,
            snapshot,
            snapshotAAD,
            snapshotContext,
            records,
            checkpoint: {
              length: records.length,
              headHash: hex(hashRecordBytes(records.at(-1) ?? genesis.record).toBytes()),
            },
            frame,
            sender: hex(owner.publicKey.toBytes()),
            machine: hex(machine.publicKey.toBytes()),
            sealed,
            context,
            aad,
            message,
          };
        })
      );
      await retainCliE2eeWorkspaceBinding(accountId, {
        workspaceId,
        genesisHash: hex(fixture.genesis.genesis.toBytes()),
        genesisRecordHex: hex(fixture.genesis.record),
      });
      fs.writeFileSync(
        path.join(identity, 'activation.json'),
        JSON.stringify({
          genesisHash: hex(fixture.genesis.genesis.toBytes()),
          signingPublicKey: fixture.machine,
        })
      );
      const historyReads: string[] = [];
      let originalAvailable = mode !== 'delayed' && !backfillFailure;
      const recoveredRooms: string[] = [];
      const cloud = {
        ...(mode === 'other-member-shared' || mode === 'other-member-closed'
          ? {
              machineSharing: {
                readHead: async () => ({
                  workspaceId,
                  genesisHash: fixture.sharingVersion.genesisHash,
                  machineId: 'machine-1',
                  ownerMembershipId: fixture.sharingVersion.ownerMembershipId,
                  generation: fixture.sharingVersion.generation,
                  revision: 1,
                  digest: fixture.sharingVersion.digest,
                  status: 'active' as const,
                }),
                readVersion: async () => fixture.sharingVersion,
                readRequest: async () => null,
                commit: async () => {
                  throw new Error('unexpected machine policy write');
                },
              },
            }
          : {}),
        readExecutionOriginPage: async (input: { docId: string }) => {
          recoveredRooms.push(input.docId);
          if (!originalAvailable && mode === 'backfill-member-removed')
            throw new CloudE2eeMemberRemoved();
          if (!originalAvailable && mode === 'backfill-device-revoked')
            throw new CloudE2eeDeviceRevoked();
          if (!originalAvailable && mode === 'backfill-network')
            throw new Error('synthetic network failure');
          return {
            messages: originalAvailable ? [fixture.message] : [],
            before: '0',
            atStart: true,
          };
        },
        getHistory: async (request: { credential: string }) => {
          historyReads.push(request.credential);
          return {
            startIndex: 0,
            recordsHex: fixture.records.map(hex),
            position: `p1:workspace-1:${fixture.records.length}:fixture`,
            nextCursor: null,
            checkpoint: fixture.checkpoint,
          };
        },
        mailboxCall: async (method: string, input: { slot?: unknown }) => {
          if (method === 'fetch')
            return {
              items: [{ sender: fixture.sender, frameHex: hex(fixture.frame) }],
              next: null,
            };
          if (method === 'status')
            return { ...(input.slot as object), revision: 0, status: 'EnvelopeStored' };
          if (method === 'report') return null;
          throw new Error('unexpected mailbox request');
        },
      };
      lody = await Lody.create({
        logger: createSilentLogger(),
        workspaceId,
        contentMode: 'e2ee',
        genesisHash: hex(fixture.genesis.genesis.toBytes()),
        token: 'synthetic-token',
        userId: accountId,
        machineId: 'machine-1',
        machineName: 'Synthetic',
        cloudPort: createTestCloudPort({ kind: 'cloud', e2ee: cloud as never }),
        memoryPressure: {} as never,
        ...(terminalBackfill
          ? {
              onEncryptedMemberRemoved: async () => {
                await removalReleased.promise;
              },
            }
          : {}),
        machineLifecycleCapability: {
          launchMode: 'foreground',
          canRemoteRestart: false,
          canRemoteUpgrade: false,
          reason: 'not_daemon',
        },
      });
      const composed = lody as unknown as {
        runtime: { options: MachineRuntimeOptions };
        encryptedWorkspace: CliE2eeWorkspaceLegacy;
      };
      const host = composed.encryptedWorkspace;
      await host.refresh();
      const sessionDoc = await lody.documentManager.getOrCreateSessionDoc(sessionId);
      const protection = host.content.resolve({
        kind: 'doc',
        docId: 'session-production-session',
      });
      if (protection.mode !== 'protected' || !sessionDoc.handle)
        throw new Error('missing signed session');
      if (!snapshotOnly)
        await protection.config.provider.open({
          ...fixture.sealed,
          context: fixture.context,
          additionalData: fixture.aad,
        });
      // First connection/restart can reconstruct the state from a snapshot
      // without ever opening the author's signed creation update locally.
      if (!snapshotOnly) sessionDoc.handle.doc.import(source.export({ mode: 'update' }));
      else {
        const snapshot = await protection.config.provider.open({
          ...fixture.snapshot,
          context: fixture.snapshotContext,
          additionalData: fixture.snapshotAAD,
        });
        sessionDoc.handle.doc.import(snapshot);
        snapshot.fill(0);
      }
      const dispatch = (userTurnId = 'turn-user-1') =>
        runSilentPromptTurn({
          sessionId,
          workspaceId,
          requesterUserId: user,
          userTurnId,
          hasPromptEventsForTurn: true,
          prepared: true,
          encryptedExecution: composed.runtime.options.handlerConfig.encryptedExecution,
          onPrompt: async (service) => {
            submitted.push('hi');
            invocations.push(service.getActiveInvocationContext(sessionId as SessionId));
          },
        });
      if (backfillFailure) {
        expect(
          await Effect.runPromise(host.authorizeExecution(workspaceId, fixture.sender))
        ).toMatchObject({ _tag: 'Authorized' });
        const waiting = await dispatch();
        expect(submitted).toEqual([]);
        expect(recoveredRooms).toEqual(['session-production-session']);
        expect(
          await Effect.runPromise(host.authorizeExecution(workspaceId, fixture.sender))
        ).toMatchObject({ _tag: terminalBackfill ? 'Denied' : 'Authorized' });
        if (terminalBackfill)
          await expect(host.status()).rejects.toThrow(
            mode === 'backfill-member-removed' ? 'e2ee_member_removed' : 'e2ee_device_revoked'
          );
        if (!terminalBackfill) {
          expect(waiting.getHistory()[0]?.status).toBe('pending');
          expect(waiting.failureMessages).toEqual([]);
        }
        originalAvailable = true;
        await protection.config.provider
          .open({ ...fixture.sealed, context: fixture.context, additionalData: fixture.aad })
          .catch(() => undefined);
        const later = await dispatch('turn-user-2');
        expect(submitted).toEqual(terminalBackfill ? [] : ['hi']);
        if (!terminalBackfill) expect(later.getHistory()[0]?.status).toBe('handled');
        return;
      }
      if (mode === 'delayed' || mode === 'expired') {
        if (mode === 'expired') vi.setSystemTime(Date.parse('2026-10-28T02:15:00Z'));
        const waiting = await dispatch();
        expect(submitted).toEqual([]);
        if (mode === 'expired') {
          expect(waiting.getHistory()[0]?.status).toBe('failed');
          expect(waiting.failureMessages[0]).toContain('expired');
          expect(recoveredRooms).toEqual([]);
          return;
        }
        expect(waiting.getHistory()[0]?.status).toBe('pending');
        expect(waiting.failureMessages).toEqual([]);
        originalAvailable = true;
      }
      const before = historyReads.length;
      const result = await dispatch();
      expect(submitted).toEqual(deniedSigner ? [] : ['hi']);
      // Only a turn verified as signed by the machine owner's own membership may
      // lend its identity to derived work (MCP, iOS control). A shared member's
      // turn gets none, whatever display userId its history row claims.
      if (!deniedSigner)
        expect(invocations[0]?.requesterUserId).toBe(
          mode === 'other-member-shared' ? undefined : user
        );
      expect(result.getHistory()[0]?.status).toBe(deniedSigner ? 'failed' : 'handled');
      expect(result.failureMessages).toEqual(
        mode === 'other-member' || mode === 'other-member-closed'
          ? [expect.stringContaining('e2ee_machine_not_shared')]
          : deniedSigner
            ? [expect.stringContaining('not authorized')]
            : []
      );
      expect(recoveredRooms).toEqual(
        !snapshotOnly
          ? []
          : mode === 'delayed'
            ? ['session-production-session', 'session-production-session']
            : ['session-production-session']
      );
      expect(historyReads.length).toBeGreaterThan(before);
      expect(
        historyReads.every(
          (credential) => credential.length > 0 && credential !== 'synthetic-token'
        )
      ).toBe(true);
    } finally {
      removalReleased.resolve();
      if (lody)
        await (
          lody as unknown as { encryptedWorkspace: CliE2eeWorkspaceLegacy }
        ).encryptedWorkspace.removalCleanup();
      if (mode === 'backfill-device-revoked')
        expect(fs.existsSync(path.join(identity, 'custody'))).toBe(true);
      await lody?.documentManager.cleanUp();
      await presence.closeLegacy();
      source.free();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };

  it('executes the real UI account ID through production Lody construction without injected authorization', () =>
    runProductionSignedTurn('account'));
  it.each([
    'snapshot',
    'delayed',
    'expired',
    'same-member',
    'other-member',
    'other-member-shared',
    'other-member-closed',
    'revoked-device',
    'guest',
    'removed-member',
    'backfill-member-removed',
    'backfill-device-revoked',
    'backfill-network',
  ] as const)(
    'executes a signed durable turn through production Lody construction (%s)',
    runProductionSignedTurn
  );

  describe('encrypted shared-project scope', () => {
    const local = (id: string): ProjectRef => ({
      kind: 'local',
      localProjectId: id as LocalProjectId,
    });
    // A member granted only project p1 on this machine; the owner-signed policy decides.
    const sharedOnly = (f: ReturnType<typeof encryptedExecutionFixture>, asked: unknown[][]) =>
      makeEncryptedAgentExecution({
        genesis: 'genesis',
        workspaceId: 'workspace-1',
        targetMachineId: 'machine-1',
        journal: lazyExecutionJournal(f.filename, () => 100),
        resolveVerifiedOriginal: () =>
          Effect.succeed({
            requesterDevice: 'ab'.repeat(32),
            requesterCryptoUserId: 'member',
            expiresAt: 1000,
          }),
        authorizeExecution: (_workspaceId, _device, localProjectId) => {
          asked.push([localProjectId]);
          return Effect.succeed(
            localProjectId === undefined || localProjectId === 'p1'
              ? { _tag: 'Authorized' }
              : { _tag: 'Denied', reason: 'e2ee_machine_not_shared' }
          );
        },
      });
    it.each([
      ['the requested project', { project: local('p2') }],
      [
        'a live process whose request names a shared project',
        {
          project: local('p1'),
          liveConfig: { project: local('p2') },
        },
      ],
      ['Session meta while the request omits the project', { meta: { project: local('p2') } }],
      ['a new conversation', { project: local('p2'), create: true }],
      [
        'a Project group member',
        {
          meta: {
            projectRun: {
              id: 'group',
              name: 'Group',
              root: 'group',
              members: {
                member: {
                  o: 0,
                  src: { kind: 'local', machineId: 'machine-1', localProjectId: 'p2' },
                  placement: { kind: 'root', dir: 'p2' },
                  path: 'p2',
                  base: 'main',
                },
              },
            },
          },
        },
      ],
    ] as const)('never prompts a member on an unshared project from %s', async (_name, scope) => {
      const f = encryptedExecutionFixture();
      const asked: unknown[][] = [];
      const submissions: string[] = [];
      try {
        const result = await runSilentPromptTurn({
          sessionId: 'shared-project-session',
          hasPromptEventsForTurn: true,
          prepared: true,
          encryptedExecution: sharedOnly(f, asked),
          ...scope,
          onPrompt: async () => {
            submissions.push('hi');
          },
        });
        expect(submissions).toEqual([]);
        expect(asked).toContainEqual(['p2']);
        expect(result.failureMessages).toEqual([
          expect.stringContaining('e2ee_machine_not_shared'),
        ]);
      } finally {
        f.close();
      }
    });
    it('restores from the metadata it authorized, even if synced metadata changes meanwhile', async () => {
      const f = encryptedExecutionFixture();
      const meta: Record<string, unknown> = {};
      const started: SessionConfig[] = [];
      const asked: unknown[][] = [];
      const shared = sharedOnly(f, asked);
      // The member rewrites synced metadata while the claim is authorizing.
      const gate = {
        ...shared,
        claim: (intent: Parameters<typeof shared.claim>[0]) =>
          Effect.sync(() => {
            meta.project = local('p2');
          }).pipe(Effect.andThen(shared.claim(intent))),
      };
      try {
        const result = await runSilentPromptTurn({
          sessionId: 'shared-project-session',
          hasPromptEventsForTurn: true,
          prepared: true,
          encryptedExecution: gate,
          meta,
          restore: started,
        });
        expect(asked).toEqual([[undefined]]);
        // Before the fix the restore re-read the rewritten metadata and resolved p2.
        expect(result.failureMessages.join('\n')).not.toContain('p2');
        expect(started).toHaveLength(1);
        expect(started[0]?.project).toBeUndefined();
      } finally {
        f.close();
      }
    });
    it('refuses a Project group member added to synced metadata after authorization', async () => {
      const f = encryptedExecutionFixture();
      const group = (...ids: string[]) => ({
        id: 'group',
        name: 'Group',
        root: 'group',
        members: Object.fromEntries(
          ids.map((id, o) => [
            id,
            {
              o,
              src: { kind: 'local', machineId: 'machine-1', localProjectId: id },
              placement: { kind: 'root', dir: id },
              path: id,
              base: 'main',
            },
          ])
        ),
      });
      const meta: Record<string, unknown> = { projectRun: group('p1') };
      const started: SessionConfig[] = [];
      const asked: unknown[][] = [];
      const shared = sharedOnly(f, asked);
      const gate = {
        ...shared,
        claim: (intent: Parameters<typeof shared.claim>[0]) =>
          shared.claim(intent).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                meta.projectRun = group('p1', 'p2');
              })
            )
          ),
      };
      try {
        const result = await runSilentPromptTurn({
          sessionId: 'shared-project-session',
          hasPromptEventsForTurn: true,
          prepared: true,
          encryptedExecution: gate,
          meta,
          restore: started,
        });
        expect(asked).toEqual([['p1']]);
        // Before the fix the session manager adopted the reread group, including p2.
        expect(started).toEqual([]);
        expect(result.failureMessages.join('\n')).toContain('e2ee_machine_not_shared');
      } finally {
        f.close();
      }
    });
    it('still prompts on the shared project and in a projectless conversation', async () => {
      for (const scope of [{ project: local('p1') }, {}]) {
        const f = encryptedExecutionFixture();
        const submissions: string[] = [];
        try {
          await runSilentPromptTurn({
            sessionId: 'shared-project-session',
            hasPromptEventsForTurn: true,
            prepared: true,
            encryptedExecution: sharedOnly(f, []),
            ...scope,
            onPrompt: async () => {
              submissions.push('hi');
            },
          });
          expect(submissions).toEqual(['hi']);
        } finally {
          f.close();
        }
      }
    });
  });

  it('keeps a snapshot turn pending until its original signed update becomes available', async () => {
    const f = encryptedExecutionFixture();
    let originalAvailable = false;
    const submitted: string[] = [];
    const gate = makeEncryptedAgentExecution({
      genesis: 'genesis',
      workspaceId: 'workspace-1',
      targetMachineId: 'machine-1',
      journal: lazyExecutionJournal(f.filename, () => 100),
      resolveVerifiedOriginal: () =>
        Effect.succeed(
          originalAvailable
            ? { requesterDevice: 'ab'.repeat(32), requesterCryptoUserId: 'user-1', expiresAt: 1000 }
            : ({ state: 'pending-evidence', expiresAt: Date.now() + 1000 } as const)
        ),
      authorizeExecution: () => Effect.succeed({ _tag: 'Authorized' }),
    });
    try {
      const pending = await runSilentPromptTurn({
        sessionId: 'snapshot-pending',
        prepared: true,
        encryptedExecution: gate,
        onPrompt: async () => {
          submitted.push('hi');
        },
      });
      expect(submitted).toEqual([]);
      expect(pending.failureMessages).toEqual([]);
      expect(pending.getHistory()[0]?.status).toBe('pending');
      originalAvailable = true;
      const retried = await runSilentPromptTurn({
        sessionId: 'snapshot-pending',
        prepared: true,
        encryptedExecution: gate,
        hasPromptEventsForTurn: true,
        onPrompt: async () => {
          submitted.push('hi');
        },
      });
      expect(submitted).toEqual(['hi']);
      expect(retried.getHistory()[0]?.status).toBe('handled');
    } finally {
      f.close();
    }
  });

  it('shares the encrypted execution claim across RPC, durable dispatch and restart', async () => {
    const f = encryptedExecutionFixture();
    const started = createDeferred<void>();
    const finished = createDeferred<void>();
    const submissions: string[] = [];
    const onPrompt = async () => {
      submissions.push('hi');
      started.resolve();
      await finished.promise;
    };
    const first = runSilentPromptTurn({
      sessionId: 'encrypted-session',
      hasPromptEventsForTurn: true,
      attempts: 2,
      dispatchSource: 'rpc',
      encryptedExecution: f.gate(),
      onPrompt,
    });
    try {
      await started.promise;
      const duplicate = await runSilentPromptTurn({
        sessionId: 'encrypted-session',
        hasPromptEventsForTurn: true,
        prepared: true,
        encryptedExecution: f.gate(),
        onPrompt,
      });
      expect(submissions).toEqual(['hi']);
      expect(duplicate.failureMessages).toEqual([expect.stringContaining('Result unknown')]);
      finished.resolve();
      const completed = await first;
      expect(completed.getHistory()[0]?.status).toBe('handled');
      expect(completed.failureMessages).toEqual([]);
      const restart = await runSilentPromptTurn({
        sessionId: 'encrypted-session',
        hasPromptEventsForTurn: true,
        prepared: true,
        encryptedExecution: f.gate(),
        onPrompt,
      });
      expect(submissions).toEqual(['hi']);
      expect(restart.failureMessages).toEqual([expect.stringContaining('already finished')]);
      expect(
        new RealtimeJournal(f.filename, () => 100).read({
          genesis: 'genesis',
          workspaceId: 'workspace-1',
          targetMachineId: 'machine-1',
          requestId: 'agent-start:turn-user-1',
        })?.state
      ).toBe('completed');
    } finally {
      finished.resolve();
      await first;
      f.close();
    }
  });

  it('leaves a claimed encrypted turn uncertain after restart without replaying it', async () => {
    const f = encryptedExecutionFixture();
    const submissions: string[] = [];
    try {
      expect((await Effect.runPromise(f.gate().claim(f.intent))).state).toBe('claimed');
      const recovered = await runSilentPromptTurn({
        sessionId: 'encrypted-session',
        hasPromptEventsForTurn: true,
        prepared: true,
        encryptedExecution: f.gate(),
        onPrompt: async () => {
          submissions.push('hi');
        },
      });
      expect(submissions).toEqual([]);
      expect(recovered.failureMessages).toEqual([expect.stringContaining('Result unknown')]);
      expect(recovered.getHistory()[0]?.status).toBe('failed');
    } finally {
      f.close();
    }
  });

  it.each(['denied', 'expired'] as const)(
    'does not start a %s encrypted turn from durable history',
    async (authorization) => {
      const f = encryptedExecutionFixture();
      const submissions: string[] = [];
      try {
        const result = await runSilentPromptTurn({
          sessionId: 'encrypted-session',
          hasPromptEventsForTurn: true,
          prepared: true,
          create: true,
          encryptedExecution: f.gate(authorization),
          onPrompt: async () => {
            submissions.push('hi');
          },
        });
        expect(submissions).toEqual([]);
        expect(result.failureMessages).toEqual([
          expect.stringContaining(authorization === 'denied' ? 'not authorized' : 'expired'),
        ]);
        expect(result.getHistory()[0]?.status).toBe('failed');
        expect(
          result.service.getExecutionSnapshot('encrypted-session' as SessionId).hasActiveTurn
        ).toBe(false);
      } finally {
        f.close();
      }
    }
  );

  it('does not retry an encrypted prompt whose submission disconnected before output', async () => {
    const f = encryptedExecutionFixture();
    const submissions: string[] = [];
    try {
      const result = await runSilentPromptTurn({
        sessionId: 'encrypted-session',
        hasPromptEventsForTurn: false,
        prepared: true,
        encryptedExecution: f.gate(),
        promptFailure: new Error('ACP connection closed'),
        onPrompt: async () => {
          submissions.push('hi');
        },
      });
      expect(submissions).toEqual(['hi']);
      expect((await Effect.runPromise(f.gate().claim(f.intent))).state).toBe('uncertain');
      expect(
        result.service.getExecutionSnapshot('encrypted-session' as SessionId).hasActiveTurn
      ).toBe(false);
    } finally {
      f.close();
    }
  });

  it('contains a broken encrypted journal while ordinary and healthy dispatch continue', async () => {
    const f = encryptedExecutionFixture();
    const submissions: string[] = [];
    fs.writeFileSync(f.filename, 'damaged execution evidence');
    try {
      const broken = await runSilentPromptTurn({
        sessionId: 'encrypted-session',
        hasPromptEventsForTurn: true,
        prepared: true,
        encryptedExecution: f.gate(),
        onPrompt: async () => {
          submissions.push('broken');
        },
      });
      const ordinary = await runSilentPromptTurn({
        sessionId: 'ordinary-session',
        hasPromptEventsForTurn: true,
        prepared: true,
        onPrompt: async () => {
          submissions.push('ordinary');
        },
      });
      const healthy = await runSilentPromptTurn({
        sessionId: 'healthy-session',
        workspaceId: 'workspace-2',
        hasPromptEventsForTurn: true,
        prepared: true,
        encryptedExecution: f.gate(
          'authorized',
          path.join(f.directory, 'healthy.sqlite'),
          'workspace-2'
        ),
        onPrompt: async () => {
          submissions.push('healthy');
        },
      });
      expect(submissions).toEqual(['ordinary', 'healthy']);
      expect(ordinary.getHistory()[0]?.status).toBe('handled');
      expect(healthy.getHistory()[0]?.status).toBe('handled');
      expect(broken.getHistory()[0]?.status).toBe('failed');
      expect(fs.readFileSync(f.filename, 'utf8')).toBe('damaged execution evidence');
    } finally {
      f.close();
    }
  });

  it.each([
    { output: true, outcome: { kind: 'succeeded' } },
    { output: false, outcome: { kind: 'failed', code: 'no_agent_output' } },
  ])(
    'publishes the trusted terminal fact with the frozen requester ($outcome.kind)',
    async ({ output, outcome }) => {
      const { notificationFacts, getHistory } = await runSilentPromptTurn({
        sessionId: 'notification-source',
        hasPromptEventsForTurn: output,
      });
      expect(notificationFacts).toEqual([
        {
          scope: { workspaceId: 'workspace-1', recipientId: 'user-1' },
          sessionId: 'notification-source',
          assistantTurnId: 'assistant:turn-user-1',
          originTurnIds: ['turn-user-1'],
          turnId: 'turn-user-1',
          audience: { kind: 'user' },
          outcome,
        },
      ]);
      expect(getHistory()[0]?.status).toBe(output ? 'handled' : 'failed');
    }
  );

  it('preserves delegated audience on the terminal fact without substituting the host owner', async () => {
    const audience = {
      kind: 'agent',
      sessionId: 'parent' as SessionId,
      turnId: 'parent-input',
    } as const;
    const { notificationFacts } = await runSilentPromptTurn({
      sessionId: 'notification-child',
      hasPromptEventsForTurn: true,
      notificationAudience: audience,
    });
    expect(notificationFacts).toEqual([
      {
        scope: { workspaceId: 'workspace-1', recipientId: 'user-1' },
        sessionId: 'notification-child',
        assistantTurnId: 'assistant:turn-user-1',
        originTurnIds: [],
        turnId: 'turn-user-1',
        audience,
        outcome: { kind: 'succeeded' },
      },
    ]);
  });

  it('publishes provider failure separately from successful completion', async () => {
    const { notificationFacts, getHistory } = await runSilentPromptTurn({
      sessionId: 'notification-failure',
      hasPromptEventsForTurn: true,
      promptFailure: new Error('synthetic provider failure'),
    });
    expect(notificationFacts).toEqual([
      {
        scope: { workspaceId: 'workspace-1', recipientId: 'user-1' },
        sessionId: 'notification-failure',
        assistantTurnId: 'assistant:turn-user-1',
        originTurnIds: ['turn-user-1'],
        turnId: 'turn-user-1',
        audience: { kind: 'user' },
        outcome: { kind: 'failed', code: 'session_chat_failed' },
      },
    ]);
    expect(getHistory()[0]?.status).toBe('failed');
  });

  it('retains disconnected execution as unknown instead of claiming success', async () => {
    const { notificationFacts } = await runSilentPromptTurn({
      sessionId: 'notification-disconnected',
      hasPromptEventsForTurn: true,
      promptFailure: new Error('Connection is disposed'),
    });
    expect(notificationFacts.map((fact) => fact.outcome)).toEqual([
      { kind: 'unknown', code: 'agent_disconnected' },
    ]);
  });

  it('a failed notification is attempted once without replaying the completed provider turn', async () => {
    const attempts: TurnOutcomeFact[] = [];
    const { notificationFacts, getHistory, agentClient } = await runSilentPromptTurn({
      sessionId: 'notification-store-failure',
      hasPromptEventsForTurn: true,
      onTurnOutcome: async (fact) => {
        attempts.push(fact);
        throw new Error('synthetic notification failure');
      },
    });
    expect(notificationFacts).toEqual([]);
    expect(attempts.map((fact) => fact.outcome)).toEqual([{ kind: 'succeeded' }]);
    expect(getHistory()[0]?.status).toBe('handled');
    expect(agentClient.prompt).toHaveBeenCalledOnce();
  });

  it('fails a turn whose prompt completed without emitting any agent output', async () => {
    const { deps, sessionDoc, notificationFacts, upsertDocMeta, agentClient, getHistory } =
      await runSilentPromptTurn({
        sessionId: 'session-silent-turn',
        hasPromptEventsForTurn: false,
      });

    expect(agentClient.prompt).toHaveBeenCalled();
    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'agent_no_output',
      expect.stringContaining('without producing any output')
    );
    expect(getHistory()[0]?.status).toBe('failed');
    // Claiming the session finished would contradict the failure shown in chat.
    expect(notificationFacts.some((fact) => fact.outcome.kind === 'succeeded')).toBe(false);
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

  it('publishes a single successful output fact', async () => {
    const { deps, getHistory, notificationFacts } = await runSilentPromptTurn({
      sessionId: 'session-output-turn',
      hasPromptEventsForTurn: true,
    });

    expect(deps.recordChatFailure).not.toHaveBeenCalled();
    expect(getHistory()[0]?.status).toBe('handled');
    expect(notificationFacts).toHaveLength(1);
    expect(notificationFacts[0]?.outcome).toEqual({ kind: 'succeeded' });
  });

  it.each([
    {
      content: false as const,
      status: 'failed',
      outcome: { kind: 'failed', code: 'no_agent_output' },
    },
    { content: 'unobservable' as const, status: 'handled', outcome: { kind: 'succeeded' } },
  ])(
    'settles content independently of replay evidence ($content)',
    async ({ content, status, outcome }) => {
      const result = await runSilentPromptTurn({
        sessionId: 'independent-observations',
        hasPromptEventsForTurn: true,
        content,
      });
      expect(result.getHistory()[0]?.status).toBe(status);
      expect(result.notificationFacts.map((fact) => fact.outcome)).toEqual([outcome]);
      expect(
        result.service.getExecutionSnapshot('independent-observations' as SessionId).hasActiveTurn
      ).toBe(false);
    }
  );

  it.each(['agent', 'human'] as const)(
    'uses the exact %s-authored input for completion notifications',
    async (kind) => {
      const agentAuthor = {
        v: 1,
        kind: 'agent',
        sessionId: 'sender-session',
        turnId: 'sender-turn',
        name: 'Agent',
      } as const;
      const { deps, notificationFacts, getHistory, getStatus, finalizationOwners } =
        await runSilentPromptTurn({
          sessionId: `session-notify-${kind}`,
          hasPromptEventsForTurn: true,
          notificationAudience:
            kind === 'agent'
              ? { kind: 'agent', sessionId: 'sender-session' as SessionId, turnId: 'sender-turn' }
              : { kind: 'user' },
          inputAuthor: kind === 'agent' ? agentAuthor : { v: 1, kind: 'human', userId: 'user-1' },
          earlierInputAuthor: kind === 'human' ? agentAuthor : undefined,
        });
      const completed = getHistory().find((entry) => entry.id === 'turn-user-1');
      expect(completed?.status).toBe('handled');
      expect(getHistory().find((entry) => entry.id === 'assistant:turn-user-1')?.finished).toBe(
        true
      );
      expect(finalizationOwners).toEqual([true]);
      expect(getStatus()).toEqual(SessionStatusFactory.idle());
      expect(deps.recordChatFailure).not.toHaveBeenCalled();
      expect(notificationFacts[0]?.audience.kind).toBe(kind === 'human' ? 'user' : 'agent');
    }
  );

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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    });
    const upsertDocMeta = vi.fn(async () => {});
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => activeSession),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
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
        inputConfig: { prompt: 'fast path prompt' },
      },
      dispatchSource: 'rpc',
      accessPromise,
      requestPromise: new Promise<never>(() => {}),
      onAccessAllowed,
      onAccessDenied,
      onAccessIndeterminate,
    });

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
      notificationOriginTurnIds: [],
      notificationProvenancePending: true,
      requesterUserId: 'user-b',
      sourceTurnId: 'turn-prepared-presence',
      inputConfig: { prompt: 'fast path prompt' },
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
    const sessionDoc = withHistoryPort({
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      setStatus: vi.fn(async () => {}),
    });
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
    const preparedSessionDoc = withHistoryPort({
      getHistory: vi.fn(() => preparedHistory),
      updateHistory: vi.fn(
        async (updater: (prev: typeof preparedHistory) => typeof preparedHistory) => {
          preparedHistory = updater(preparedHistory);
        }
      ),
      setStatus: vi.fn(async () => {}),
    });
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
        validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async (status: { type: string }) => {
        events.push(`status:${status.type}`);
      }),
      waitUntilSynced: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    });
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => activeSession),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
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
      setSessionActivePresencePhase: vi.fn((_sessionId, phase) => {
        events.push(`phase:${phase}`);
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
    const finalizingAt = events.indexOf('phase:finalizing');
    expect(finalizingAt).toBeGreaterThan(promptResolvedAt);
    expect(idleAfterPromptAt).toBeGreaterThan(finalizingAt);
    expect(events.filter((event) => event === 'phase:finalizing')).toEqual(['phase:finalizing']);
  });

  it.each([true, false] as const)(
    'retries a disconnected turn only with an observable empty event stream (observable=%s)',
    async (observable) => {
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
      const submittedSessions: string[] = [];
      const agentClient = {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
        prompt: vi.fn(async () => {
          // Submission can succeed before the transport reports failure.
          submittedSessions.push(acpSessionId);
          throw new Error('ACP connection closed');
        }),
        currentModel: undefined,
      };
      const restoredAgentClient = {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
        prompt: vi.fn(async () => {
          submittedSessions.push(restoredAcpSessionId);
          return {};
        }),
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
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => ({ isArchived: false })),
        setStatus: vi.fn(async () => {}),
        waitUntilSynced: vi.fn(async () => {}),
        getHistory: vi.fn(() => history),
        updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
          history = updater(history);
        }),
      });
      const deps = createBaseDeps({ hasPromptEventsForTurn: observable ? () => false : undefined });
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

      expect(service.getExecutionSnapshot(sessionId).hasActiveTurn).toBe(false);
      expect(submittedSessions).toEqual(
        observable ? [acpSessionId, restoredAcpSessionId] : [acpSessionId]
      );
      expect(history[0]?.status).toBe(observable ? 'handled' : 'failed');
    }
  );

  it('closes the ACP session gracefully when a turn fails on expired credentials', async () => {
    const sessionId = 'session-auth-expired' as SessionId;
    const acpSessionId = 'acp-auth-expired' as ACPSessionId;
    let history: Array<Record<string, unknown>> = [
      { id: 'turn-user-1', role: 'user', status: 'pending', read: false },
    ];
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => {
        // Providers report an expired OAuth credential as a plain ACP internal
        // error; the remedy text is theirs and is not guaranteed to be present.
        throw {
          code: -32603,
          message: 'Internal error',
          data: { details: 'OAuth session expired' },
        };
      }),
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      waitUntilSynced: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    });
    const deps = createBaseDeps({});
    const sessionManager = deps.sessionManager as unknown as {
      getSession: ReturnType<typeof vi.fn>;
      terminateSession: ReturnType<typeof vi.fn>;
    };
    const workspaceDocument = deps.workspaceDocument as unknown as {
      getOrCreateSessionDoc: ReturnType<typeof vi.fn>;
    };
    sessionManager.getSession.mockReturnValue(activeSession);
    workspaceDocument.getOrCreateSessionDoc.mockResolvedValue(sessionDoc);

    const service = new SessionExecutionService(deps);
    await service.continueSession({
      type: 'session/chat',
      sessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: undefined,
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'claude' },
      userTurnId: 'turn-user-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(deps.recordChatFailure).toHaveBeenCalledWith(
      sessionDoc,
      'acp_auth_required',
      'OAuth session expired'
    );
    // Forcing the kill here skips `session/close`, and adapters that flush their
    // transcript on close would lose the artifact `loadSession` needs — so the
    // next turn after signing back in would have nothing left to resume into.
    expect(sessionManager.terminateSession).toHaveBeenCalledWith(sessionId, false);
  });

  it.each(['pending', 'rejecting'] as const)(
    'bounds a workspace-reading Code Collab refresh and recovers (%s)',
    async (refreshOutcome) => {
      vi.useFakeTimers();
      try {
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
        const sessionDoc = withHistoryPort({
          getMetaState: vi.fn(async () => ({ isArchived: false })),
          setStatus: vi.fn(async () => {}),
          setBaseBranch: vi.fn(async () => {}),
          getHistory: vi.fn(() => history),
          updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
            history = updater(history);
          }),
        });
        let releaseRefresh = () => {};
        const refreshGate = new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        const refreshStarted = createDeferred<void>();
        const refreshCodeCollabSharedState = async () => {
          refreshStarted.resolve();
          if (refreshOutcome === 'rejecting') throw new Error('Synthetic refresh failure');
          await refreshGate;
        };
        const presence = new Set<SessionId>();
        const deps = createBaseDeps({
          startSessionActivePresence: (id) => {
            presence.add(id);
          },
          clearSessionActivePresence: (id) => {
            presence.delete(id);
          },
          sessionManager: {
            getSession: vi.fn(() => activeSession),
            getPendingSession: vi.fn(() => null),
            createSession: vi.fn(),
            setSessionError: vi.fn(),
            terminateSession: vi.fn(),
            validateSessionCredentials: vi.fn(async () => {}),
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
            updateSessionDiffStats: vi.fn(async () => [{ filePath: 'src/a.ts', add: 1, del: 0 }]),
            refreshCodeCollabSharedState,
            detectAndAssociatePR: vi.fn(async () => ({ baseBranch: 'release/v2' })),
            syncWorkspaceGitState: vi.fn(async () => {}),
            onTurnOutcome: vi.fn(async () => {}),
          },
        });

        const service = new SessionExecutionService(deps);
        const first = service.continueSession({
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

        await refreshStarted.promise;
        await vi.advanceTimersByTimeAsync(20_000);
        await first;
        releaseRefresh();
        expect(deps.turnFinalization.updateSessionDiffStats).toHaveBeenCalledWith(
          'session-1',
          activeSession,
          expect.objectContaining({
            baseCommitHash: 'abc123',
            preferredBaseBranch: 'release/v2',
          })
        );
        expect(service.getExecutionSnapshot('session-1' as SessionId).hasActiveTurn).toBe(false);
        expect(presence.size).toBe(0);
        history.push({ id: 'turn-user-2', role: 'user', status: 'pending', read: false });
        await service.continueSession({
          type: 'session/chat',
          sessionId: 'session-1' as SessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
          acpSessionConfig: { prompt: 'next', cliType: 'builtin', agentType: 'codex' },
          userTurnId: 'turn-user-2',
          userId: 'user-1',
          userName: 'User',
          userEmail: 'user@example.com',
        });
        expect(history.find((entry) => entry.id === 'turn-user-2')?.status).toBe('handled');
        expect(service.getExecutionSnapshot('session-1' as SessionId).hasActiveTurn).toBe(false);
        releaseRefresh();
        await service.drainInboxExecutions();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it.each(
    (
      [
        // name, project kind, worktree, child, prior ACP, resume, rename expected
        ['direct local', 'local', false, false, false, false, false],
        ['new local worktree', 'local', true, false, false, false, true],
        ['new GitHub worktree', 'github', true, false, false, false, true],
        ['local child Tab', 'local', true, true, false, false, false],
        ['GitHub child Tab', 'github', true, true, false, false, false],
        ['previous local worktree', 'local', true, false, true, false, false],
        ['previous GitHub worktree', 'github', true, false, true, false, false],
        ['explicit local resume', 'local', true, false, false, true, false],
        ['explicit GitHub resume', 'github', true, false, false, true, false],
      ] as const
    ).flatMap(([name, kind, worktree, child, prior, resume, rename]) =>
      (rename
        ? [
            'allocated',
            'collision',
            'namespace collision',
            'descriptive',
            'reserved-prefix descriptive',
            'other session',
            'detached',
            'probe failure',
          ]
        : ['allocated']
      ).flatMap((branchState) =>
        ['codex', 'kimi'].flatMap((titleAgentType) =>
          [true, false].map((sessionTitle) => ({
            name,
            kind,
            worktree,
            child,
            prior,
            resume,
            rename:
              rename && ['allocated', 'collision', 'namespace collision'].includes(branchState),
            branchState,
            sessionTitle,
            titleAgentType,
          }))
        )
      )
    )
  )(
    'starts $name on $branchState with $titleAgentType title capability $sessionTitle and the appropriate first-task prompt',
    async ({
      kind,
      worktree,
      child,
      prior,
      resume,
      rename,
      branchState,
      sessionTitle,
      titleAgentType,
    }) => {
      const generatedTitles: string[] = [];
      const allocatedBranch = kind === 'github' ? 'session/session-' : 'lody/session-loca';
      const initialBranch =
        branchState === 'collision'
          ? `${allocatedBranch}-2`
          : branchState === 'namespace collision'
            ? allocatedBranch.replace('/', '-2/')
            : branchState === 'descriptive'
              ? 'feature/local-start'
              : branchState === 'reserved-prefix descriptive'
                ? 'lody/fix-checkout'
                : branchState === 'other session'
                  ? 'session/87654321'
                  : branchState === 'detached'
                    ? ''
                    : allocatedBranch;
      let checkoutBranch = initialBranch;
      let publishedBranch: string | undefined;
      let branchAtPrompt: string | undefined;
      let deliveredPrompt: ContentBlock[] = [];
      const localProjectId = 'local-project-1' as LocalProjectId;
      const machineId = 'machine-1' as MachineId;
      const parentSessionId = child ? ('parent-session' as SessionId) : undefined;
      const project =
        kind === 'github'
          ? { kind: 'github' as const, repoFullName: 'owner/repo' }
          : { kind: 'local' as const, localProjectId, useWorktree: worktree };
      const existingAcpSessionId = prior ? ('acp-previous' as ACPSessionId) : undefined;
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => ({
          agentConfigId: capabilityConfigId,
          acpSessionId: existingAcpSessionId,
        })),
        getHistory: vi.fn(() => []),
        setStatus: vi.fn(async () => {}),
        setProject: vi.fn(async () => {}),
        setBaseBranch: vi.fn(async () => {}),
        updateHistory: vi.fn(async () => {}),
        roomId: 'session-session-local-code-collab',
      });
      const agentClient = {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
        prompt: vi.fn(async (_sessionId: string, blocks: ContentBlock[]) => {
          deliveredPrompt = blocks;
          branchAtPrompt = publishedBranch;
          checkoutBranch = 'feature/local-finished';
          return {};
        }),
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
          sessionTitle,
          sessionFork: false,
          acknowledgedSteer: true,
        }),
        terminalManager: {} as unknown,
        getWorkdir: () => '/local/repo',
        getHostWorkdir: () => '/local/repo',
        getParentSessionId: () => parentSessionId,
        exec: vi.fn(async (_command: string, args: string[]) => {
          if (args.join(' ') === 'branch --show-current') {
            if (branchState === 'probe failure') throw new Error('synthetic Git probe failure');
            return checkoutBranch;
          }
          return '';
        }),
        terminate: vi.fn(async () => {}),
        updateGitIdentity: vi.fn(),
        createAgent: vi.fn(async () => 'acp-local-code-collab'),
        applyExecutionPlaneLimits: vi.fn(async () => {}),
      };
      let sessionStarted = false;
      const sessionManager = {
        getSession: vi.fn(() => (sessionStarted ? createdSession : null)),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(async () => {
          sessionStarted = true;
          return createdSession as unknown;
        }),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
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
        syncSessionBranchName: async () => {
          publishedBranch = checkoutBranch;
          return publishedBranch;
        },
        maybeGenerateAndStoreSessionTitle: async () => {
          generatedTitles.push('Local title');
        },
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
        buildAcpPromptBlocks: async ({ inputBlocks }) =>
          inputBlocks.flatMap((block): ContentBlock[] =>
            block.type === 'text' ? [{ type: 'text', text: block.text }] : []
          ),
      });

      const service = new SessionExecutionService(deps);
      await service.startSession({
        type: 'session/create',
        sessionId: 'session-local-code-collab' as SessionId,
        machineId,
        workspaceId: 'workspace-1' as WorkspaceId,
        project,
        parentSessionId,
        acpSessionConfig: {
          prompt: 'hello',
          cliType: 'builtin',
          agentType: titleAgentType,
          ...(resume ? { resume: 'acp-requested' } : {}),
        },
        userTurnId: 'turn-local-code-collab',
        userId: 'user-2',
        userName: 'User 2',
        userEmail: 'user2@example.com',
      });

      const text = deliveredPrompt
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      expect(text.startsWith('hello')).toBe(true);
      expect(text.includes('Before starting this task, rename the branch')).toBe(rename);
      expect(text.includes('gh pr create')).toBe(kind === 'github');
      expect(text).toContain('Use the available Lody MCP tools when relevant');
      expect(branchAtPrompt).toBe(initialBranch);
      if (rename) expect(text).toContain(`git branch -m ${initialBranch} <name>`);
      expect(publishedBranch).toBe('feature/local-finished');
      expect(generatedTitles).toEqual(
        sessionTitle && titleAgentType !== 'codex' ? [] : ['Local title']
      );
      expect(sessionManager.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          ...(kind === 'local' ? { workdir: '/local/repo' } : {}),
          project,
        })
      );
      await vi.waitFor(() =>
        expect(updateAcpCapabilities).toHaveBeenCalledWith(
          machineId,
          capabilityConfigId,
          'builtin',
          titleAgentType,
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
          undefined,
          false,
          expect.any(String),
          // Per-model reasoning efforts: absent for this agent, which publishes no
          // legacy `model[effort]` combination list.
          undefined,
          true,
          // Goal actions: the fixture client advertises no goal extension.
          undefined,
          { sessionTitle }
        )
      );
      if (rename) {
        await service.continueSession({
          type: 'session/chat',
          sessionId: 'session-local-code-collab' as SessionId,
          machineId,
          workspaceId: 'workspace-1' as WorkspaceId,
          project,
          acpSessionConfig: {
            prompt: 'Continue the task',
            cliType: 'builtin',
            agentType: titleAgentType,
          },
          userTurnId: 'turn-local-followup',
          userId: 'user-2',
          userName: 'User 2',
          userEmail: 'user2@example.com',
        });
        expect(deliveredPrompt).toEqual([{ type: 'text', text: 'Continue the task' }]);
      }
    }
  );

  it('rejects session creation before spawning an agent when memory pressure persists', async () => {
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-user-1',
        role: 'user',
        status: 'pending',
        read: false,
      },
    ];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      roomId: 'session-session-1',
    });
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
        validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      roomId: 'session-session-create-dag',
    });
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
        validateSessionCredentials: vi.fn(async () => {}),
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

  it('delivers attachments and first-task instructions together to a new worktree agent', async () => {
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-user-file',
        role: 'user',
        status: 'pending',
        read: false,
      },
    ];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      roomId: 'session-session-file-create',
    });
    let deliveredPrompt: ContentBlock[] = [];
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async (_sessionId: string, blocks: ContentBlock[]) => {
        deliveredPrompt = blocks;
        return {};
      }),
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
      exec: vi.fn(async (_command: string, args: string[]) =>
        args.join(' ') === 'branch --show-current' ? 'session/session-' : ''
      ),
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
    const buildAcpPromptBlocks: SessionExecutionServiceDeps['buildAcpPromptBlocks'] = async ({
      inputBlocks,
    }) =>
      inputBlocks.flatMap((block): ContentBlock[] => {
        if (block.type === 'text') return [{ type: 'text', text: block.text }];
        if (block.type === 'file')
          return [{ type: 'text', text: `Attached file: ${block.fileName}` }];
        return [];
      });
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(async () => createdSession as unknown),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
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
      project: { kind: 'github', repoFullName: 'owner/repo' },
      acpSessionConfig: {
        prompt: 'CONFIG_INSTRUCTION\n\nROLE_INSTRUCTION\n\ninspect the attached trace',
        inputBlocks: [{ type: 'text', text: 'inspect the attached trace' }, fileBlock],
        cliType: 'builtin',
        agentType: 'codex',
      },
      userTurnId: 'turn-user-file',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(deliveredPrompt).toEqual([
      { type: 'text', text: 'Attached file: trace.json' },
      { type: 'text', text: expect.stringContaining('inspect the attached trace') },
    ]);
    expect(deliveredPrompt[1]).toMatchObject({
      text: expect.stringContaining(
        'Before starting this task, rename the branch session/session-'
      ),
    });
    const executionText = (deliveredPrompt[1] as Extract<ContentBlock, { type: 'text' }>).text;
    for (const instruction of [
      'CONFIG_INSTRUCTION',
      'ROLE_INSTRUCTION',
      'inspect the attached trace',
    ]) {
      expect(executionText.split(instruction)).toHaveLength(2);
    }
  });

  it.each(['create', 'continue', 'restore'] as const)(
    'retains frozen execution input after a failed start retried through %s',
    async (retryPath) => {
      const sessionId = 'session-frozen-retry' as SessionId;
      const userTurnId = 'turn-frozen';
      const fileBlock: SessionInputBlock = {
        type: 'file',
        fileId: 'file-12345678',
        fileName: 'trace.json',
        mimeType: 'application/json',
        sizeBytes: 1024,
        sha256: 'a'.repeat(64),
        textPreview: true,
        transport: 'r2',
        uploadedAt: 123,
      };
      const inputConfig = buildSessionTurnInputConfig({
        inputBlocks: [{ type: 'text', text: 'TASK_TEXT' }, fileBlock],
        prompt: 'CONFIG_INSTRUCTION\n\nROLE_INSTRUCTION\n\nTASK_TEXT',
        cliType: 'builtin',
        agentType: 'codex',
        agentRoleId: 'role-frozen' as AgentRoleId,
        agentRoleRevision: 7,
        agentRoleSnapshot: { id: 'role-frozen', revision: 7, name: 'Reviewer', emoji: '' },
      });
      let meta: Partial<SessionMeta> = { id: sessionId, isArchived: false };
      const repo = {
        getDocMeta: async () => ({ meta }),
        upsertDocMeta: async (_room: string, patch: Partial<SessionMeta>) => {
          meta = { ...meta, ...patch };
        },
      };
      const sessionDoc = new SessionDocument(
        repo as never,
        sessionId,
        async () => {},
        createSilentLogger()
      );
      composeTestSessionDoc(sessionDoc, {
        history: [
          {
            id: userTurnId,
            role: 'user',
            userId: 'user-1',
            status: 'pending',
            timestamp: '2026-10-08T00:00:00.000Z',
            items: inputBlocksToHistoryItems(inputConfig.inputBlocks ?? []),
            inputConfig,
          },
        ],
      });
      const requests: ContentBlock[][] = [];
      const agentClient = {
        isCreated: () => true,
        cancel: async () => {},
        prompt: async (_id: string, blocks: ContentBlock[]) => {
          requests.push(blocks);
          if (requests.length === 1) throw new Error('synthetic first-attempt failure');
          return { stopReason: 'end_turn' };
        },
      };
      const session = {
        sessionId,
        acpSessionId: 'acp-frozen' as ACPSessionId,
        agentClient,
        terminalManager: {},
        getWorkdir: () => '/tmp',
        getHostWorkdir: () => '/tmp',
        getParentSessionId: () => undefined,
        exec: async () => '',
        terminate: async () => {},
        updateGitIdentity: () => {},
        createAgent: async () => 'acp-frozen',
        applyExecutionPlaneLimits: async () => {},
      };
      let live = false;
      const deps = createBaseDeps({
        sessionManager: {
          getSession: () => (live ? session : null),
          getPendingSession: () => null,
          createSession: async () => {
            live = true;
            return session;
          },
          setSessionError: () => {},
          terminateSession: async () => {
            live = false;
          },
          validateSessionCredentials: async () => {},
        } as unknown as SessionManager,
        workspaceDocument: {
          repo,
          getOrCreateSessionDoc: async () => sessionDoc,
          updateAcpCapabilities: async () => {},
        } as unknown as LoroDocumentManager,
        // Attachment I/O is a port; execute the real turn and observe provider payloads.
        buildAcpPromptBlocks: async ({ inputBlocks }) =>
          inputBlocks.flatMap((block): ContentBlock[] => {
            if (block.type === 'text') return [{ type: 'text', text: block.text }];
            if (block.type === 'file')
              return [
                { type: 'resource_link', uri: `file:///${block.fileId}`, name: block.fileName },
              ];
            throw new Error('Unexpected fixture block');
          }),
      });
      const service = new SessionExecutionService(deps);
      const readRequest = async () => {
        const read = await sessionDoc.sessionData.history.readTurn(userTurnId);
        const turn = read.state === 'ready' ? read.turn : undefined;
        if (!turn?.inputConfig) throw new Error('Frozen turn missing');
        expect(turn.inputConfig).toEqual(inputConfig);
        return {
          sessionId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          userTurnId,
          userId: 'user-1',
          userName: 'User',
          userEmail: 'user@example.com',
          acpSessionConfig: { ...inputConfig, ...resolveDispatchTurnInput(turn) },
        };
      };
      await service.startSession({ ...(await readRequest()), type: 'session/create' });
      expect(requests).toHaveLength(1);
      expect(service.getExecutionSnapshot(sessionId)).toMatchObject({ hasActiveTurn: false });
      // A fresh executor has no in-memory prompt cache; only the persisted turn survives.
      const retryService = new SessionExecutionService(deps);
      live = retryPath === 'continue';
      if (retryPath === 'create') {
        await retryService.startSession({ ...(await readRequest()), type: 'session/create' });
      } else {
        await retryService.continueSession({ ...(await readRequest()), type: 'session/chat' });
      }
      await readRequest(); // Frozen config remains intact after both attempts.
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        const text = request
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        for (const instruction of ['CONFIG_INSTRUCTION', 'ROLE_INSTRUCTION', 'TASK_TEXT']) {
          expect(text.split(instruction)).toHaveLength(2);
        }
        expect(request.filter((block) => block.type === 'resource_link')).toEqual([
          { type: 'resource_link', uri: 'file:///file-12345678', name: 'trace.json' },
        ]);
      }
      expect(await sessionDoc.sessionData.history.readTurn(userTurnId)).toMatchObject({
        state: 'ready',
        turn: { items: [{ type: 'text', text: 'TASK_TEXT' }, fileBlock] },
      });
    }
  );

  it.each([
    { scenario: 'missing process', live: false, memory: undefined },
    {
      scenario: 'changed memory identity',
      live: true,
      memory: { providerId: 'nowledge-mem', memoryId: 'reviewer' },
    },
    { scenario: 'unlinked memory identity', live: true, memory: undefined },
  ])('restores ACP with frozen configuration after $scenario', async ({ live, memory }) => {
    const codexAuth = {
      mode: 'chatgpt' as const,
      profileId: '60a84cb4-50fd-4590-9f69-6055ffef0c57',
    };
    const meta = {
      agentConfigId: capabilityConfigId,
      repoFullName: 'owner/repo',
      acpSessionId: 'acp-1' as ACPSessionId,
      branchName: 'feat/resume',
      parentSessionId: 'parent-session-1' as SessionId,
      isArchived: false,
    };
    let history: unknown[] = [];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => meta),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
    });

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

    let retired = !live;
    const oldSession = {
      ...restoredSession,
      getMemoryBinding: () => ({ providerId: 'nowledge-mem', memoryId: 'previous' }),
      agentClient: {
        ...agentClient,
        prompt: async () => {
          throw new Error('Old memory process must not receive the new prompt');
        },
      },
    };
    const sessionManager = {
      getSession: vi.fn(() => (retired ? null : oldSession)),
      retireSessionForReconfiguration: async (session: unknown) => {
        expect(session).toBe(oldSession);
        retired = true;
      },
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async (config, agentStart) => {
        expect(retired).toBe(true);
        expect(config.memory).toEqual(memory);
        expect(config.sessionId).toBe('session-1');
        expect(config.resume).toBe(true);
        expect(config.githubRepo).toBe('owner/repo');
        expect(config.restoreBranchName).toBe('feat/resume');
        expect(config.parentSessionId).toBe('parent-session-1');
        expect(config.agentConfigId).toBe(capabilityConfigId);
        expect(config.codexAuth).toEqual(codexAuth);
        expect(agentStart?.resumeSessionId).toBe('acp-1');
        return restoredSession as unknown;
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;

    const deps = createBaseDeps({
      sessionManager,
      workspaceDocument: {
        getAgentConfigById: async () =>
          createLaunchConfig({ cliType: 'builtin', agentType: 'codex', env: {}, codexAuth }),
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
      acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex', memory },
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => meta),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(
        async (updater: (prev: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = updater(history);
        }
      ),
    });
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
        validateSessionCredentials: vi.fn(async () => {}),
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

  it('waits for late-syncing history before replacing an unresumable ACP session', async () => {
    // Reproduces the daemon-restart race: the turn is delivered over RPC before
    // the history CRDT catches up, so the first read sees only the new turn.
    // Replacing the agent against that read would answer as if the earlier
    // conversation never happened.
    const meta = { repoFullName: 'owner/repo', isArchived: false };
    const currentTurn: SessionHistoryInput = {
      id: 'turn-current',
      role: 'user',
      timestamp: '2026-09-08T05:31:00.000Z',
      status: 'pending',
      fileDiff: [],
      items: [{ type: 'text', text: 'and now?' }],
    };
    const earlierTurn: SessionHistoryInput = {
      id: 'turn-earlier',
      role: 'user',
      timestamp: '2026-09-08T05:30:00.000Z',
      status: 'handled',
      fileDiff: [],
      items: [{ type: 'text', text: 'Build this on the two MIT packages.' }],
    };
    let history: SessionHistoryInput[] = [currentTurn];
    let notifyMirror: (() => void) | undefined;
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => meta),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(
        async (updater: (prev: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = updater(history);
        }
      ),
      mirror: {
        subscribe: (listener: () => void) => {
          notifyMirror = listener;
          // Deliver the backlog on the next microtask, the way a room join
          // does — no timers, so the wait resolves on the signal alone.
          queueMicrotask(() => {
            history = [earlierTurn, currentTurn];
            notifyMirror?.();
          });
          return () => {
            notifyMirror = undefined;
          };
        },
      },
      // `subscribeSessionChanges` needs the session-data surface; the fake drives
      // the late-sync signal through the raw Mirror's subscribe.
      sessionData: {
        history: {
          count: async () => 0,
          readAt: async () => ({ state: 'missing' as const }),
          readTurn: async () => ({ state: 'missing' as const }),
          readRange: async () => [],
          readDirectory: async () => [],
          observe: () => ({ initial: Promise.resolve([]), unsubscribe: () => {} }),
        },
        commands: {},
        durability: { waitDurable: async () => {} },
      },
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      currentModel: undefined,
    };
    const restoredSession = {
      sessionId: 'session-late-history' as SessionId,
      acpSessionId: 'acp-replacement' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-replacement'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const createSession = vi
      .fn(async () => restoredSession as unknown)
      .mockImplementationOnce(async () => {
        throw new Error('[ACP_RESUME_FAILED] loadSession: session artifact missing');
      });
    const buildAcpPromptBlocks = vi.fn(async () => [{ type: 'text', text: 'built prompt' }] as any);
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
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
      sessionId: 'session-late-history' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: {
        prompt: 'and now?',
        cliType: 'builtin',
        agentType: 'codex',
        resume: 'acp-existing' as ACPSessionId,
      },
      userTurnId: 'turn-current',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(deps.recordChatFailure).not.toHaveBeenCalled();
    expect(buildAcpPromptBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        replayPromptText: expect.stringContaining('Build this on the two MIT packages.'),
      })
    );
    expect(agentClient.prompt).toHaveBeenCalledWith(
      'acp-replacement',
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => meta),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
    });
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
        validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => meta),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
    });
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
        validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({
        repoFullName: 'owner/repo',
        acpSessionId: 'acp-restore-interrupt' as ACPSessionId,
        isArchived: false,
      })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => []),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-restore-interrupt',
    });
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
      validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-2',
    });
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
      validateSessionCredentials: vi.fn(async () => {}),
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
      acpSessionConfig: {
        // Execution prompt carries Config/Role instructions; the blocks keep the authored task.
        prompt: 'CONFIG_INSTRUCTION\n\nROLE_INSTRUCTION\n\nhello',
        inputBlocks: [{ type: 'text', text: 'hello' }],
        cliType: 'builtin',
        agentType: 'codex',
      },
      userTurnId: 'turn-create-1',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
      parentSessionId: 'parent-session-2' as SessionId,
    });

    expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
    // The local title generator names the authored task, never the composed instructions.
    expect(deps.maybeGenerateAndStoreSessionTitle).toHaveBeenCalledWith(
      'session-2',
      'builtin',
      'codex',
      'hello',
      undefined,
      undefined,
      undefined
    );
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
    expect(deps.turnFinalization.onTurnOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-2',
        scope: { workspaceId: 'workspace-1', recipientId: 'user-2' },
        assistantTurnId: 'turn-1',
        outcome: { kind: 'succeeded' },
      })
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
    const sessionDoc = withHistoryPort({
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
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-local-project-branch',
    });
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
        validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-local-project-diverged-tracking',
    });
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
        validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-local-project-dirty',
    });
    const createSession = vi.fn();
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({
        project,
        acpSessionId: 'acp-local-project-existing-dirty' as ACPSessionId,
      })),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-local-project-existing-dirty',
    });
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
        validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-github-git-missing',
    });
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
        validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-local-project-missing-worktree-branch',
    });
    const createSession = vi.fn();
    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn(() => null),
        createSession,
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => [
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
    });
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
      validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-create-interrupt',
    });
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
      validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-create-fail',
    });
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async () => {
        throw new Error('docker failed');
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-create-auth',
    });
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async () => {
        throw new AcpAuthenticationRequiredError([{ id: 'oauth-personal', name: 'Google' }]);
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
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

  it.each<{
    name: string;
    error: unknown;
    expectedReason: ChatFailedReason;
    expectedMessage: string;
    expectedCode?: string;
    expectedTerminateForce?: boolean;
    stage?: SessionStartStage;
  }>([
    {
      name: 'JSON-RPC internal error',
      error: new RequestError(-32603, 'Internal error', {
        details: 'workspace routing discovery failed',
      }),
      expectedReason: 'acp_internal_error',
      expectedMessage: 'workspace routing discovery failed',
      expectedTerminateForce: true,
    },
    {
      name: 'authentication required error',
      error: new AcpAuthenticationRequiredError([{ id: 'oauth-personal', name: 'Google' }]),
      expectedReason: 'acp_auth_required',
      expectedMessage: 'Authentication required',
      expectedTerminateForce: false,
    },
    {
      name: 'agent disconnect',
      error: new Error('Connection is disposed'),
      expectedReason: 'agent_disconnected',
      expectedMessage: 'The agent process disconnected unexpectedly. Please try again.',
      expectedTerminateForce: true,
    },
    {
      name: 'startup transport failure with npm diagnostics',
      error: new AcpStartupProcessError({
        sessionId: 'synthetic-startup',
        command: 'npx',
        args: [],
        stderrTail: 'npm error EBADDEVENGINES: requires Node >=22.23.4',
        cause: new Error('ACP connection closed'),
      }),
      stage: 'agent-start',
      expectedReason: 'turn_pre_prompt_failed',
      expectedMessage:
        'Starting the agent failed: [ACP_STARTUP_FAILED] ACP agent process failed before startup completed (command=npx): ACP connection closed; stderr tail: npm error EBADDEVENGINES: requires Node >=22.23.4',
    },
    {
      name: 'ordinary non-ACP failure',
      error: new Error('docker failed'),
      expectedReason: 'turn_pre_prompt_failed',
      expectedMessage: 'docker failed',
    },
    {
      name: 'missing Git executable',
      error: new GitExecutableNotFoundError(new Error('spawn git ENOENT')),
      expectedReason: 'turn_pre_prompt_failed',
      expectedMessage: 'Git is unavailable: Lody could not find the Git executable in PATH.',
      expectedCode: 'git_executable_not_found',
    },
    {
      name: 'message-less failure while preparing the worktree',
      error: new MessagelessStartFailure({ cause: new Error("Operation timed out after '5s'") }),
      stage: 'worktree',
      expectedReason: 'turn_pre_prompt_failed',
      expectedMessage:
        "Preparing the worktree failed: MessagelessStartFailure: Operation timed out after '5s'",
    },
    {
      // A setup script is not known to be safe to run twice, so nothing repeats it.
      name: 'temporary system error while the worktree setup script ran',
      error: temporarySpawnFailure(),
      stage: 'worktree-setup',
      expectedReason: 'turn_pre_prompt_failed',
      expectedMessage: 'Running the worktree setup script failed: spawnSync /usr/bin/git EAGAIN',
    },
  ])('records exactly one visible chat_failed for a pre-prompt $name', async (testCase) => {
    let history: SessionHistoryInput[] = [];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => history),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(
        async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = update(history);
        }
      ),
      roomId: 'session-session-pre-prompt-fail',
    });
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async (config: SessionConfig) => {
        if (testCase.stage) config.onStartStage?.(testCase.stage);
        throw testCase.error;
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      // Append through the history port the same system turn the real
      // `recordChatFailure` writes, so the assertions read visible history
      // instead of counting mock calls.
      recordChatFailure: vi.fn(
        async (_sessionDoc: unknown, reason: string, message?: string, code?: string) => {
          await sessionDoc.updateHistory?.((entries: SessionHistoryInput[]) => [
            ...entries,
            {
              id: `system-notice-${entries.length}`,
              role: 'system',
              timestamp: '2026-09-10T00:00:00.000Z',
              fileDiff: [],
              items: [
                {
                  type: 'system_notice',
                  name: 'chat_failed',
                  meta: { reason, ...(code ? { code } : {}), message },
                },
              ],
            } as SessionHistoryInput,
          ]);
        }
      ),
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
      sessionId: 'session-pre-prompt-fail' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-pre-prompt-fail',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    const notices = history
      .flatMap((entry) => entry.items ?? [])
      .filter((item) => item.type === 'system_notice' && item.name === 'chat_failed');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.meta).toMatchObject({
      reason: testCase.expectedReason,
      message: testCase.expectedMessage,
    });
    expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
    if (testCase.expectedCode) {
      expect(notices[0]?.meta).toMatchObject({ code: testCase.expectedCode });
    }
    if (testCase.expectedTerminateForce === undefined) {
      expect(sessionManager.terminateSession).not.toHaveBeenCalled();
    } else {
      expect(sessionManager.terminateSession).toHaveBeenCalledWith(
        'session-pre-prompt-fail',
        testCase.expectedTerminateForce
      );
    }
    expect(sessionManager.setSessionError).toHaveBeenCalledWith(
      'session-pre-prompt-fail',
      'execution_error'
    );
  });

  it('records exactly one visible chat_failed when an ACP error hits after the prompt started', async () => {
    let history: SessionHistoryInput[] = [];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(
        async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = update(history);
        }
      ),
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      prompt: vi.fn(async () => {
        throw new RequestError(-32603, 'Internal error', {
          details: 'model exploded mid-turn',
        });
      }),
      currentModel: undefined,
    };
    const session = {
      sessionId: 'session-mid-turn-acp' as SessionId,
      acpSessionId: 'acp-mid-turn' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {}),
      updateGitIdentity: vi.fn(),
      createAgent: vi.fn(async () => 'acp-mid-turn'),
      applyExecutionPlaneLimits: vi.fn(async () => {}),
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      recordChatFailure: vi.fn(
        async (_sessionDoc: unknown, reason: string, message?: string, code?: string) => {
          await sessionDoc.updateHistory?.((entries: SessionHistoryInput[]) => [
            ...entries,
            {
              id: `system-notice-${entries.length}`,
              role: 'system',
              timestamp: '2026-09-10T00:00:00.000Z',
              fileDiff: [],
              items: [
                {
                  type: 'system_notice',
                  name: 'chat_failed',
                  meta: { reason, ...(code ? { code } : {}), message },
                },
              ],
            } as SessionHistoryInput,
          ]);
        }
      ),
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
    await service.continueSession({
      type: 'session/chat',
      sessionId: 'session-mid-turn-acp' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-mid-turn-acp',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    const notices = history
      .flatMap((entry) => entry.items ?? [])
      .filter((item) => item.type === 'system_notice' && item.name === 'chat_failed');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.meta).toMatchObject({
      reason: 'acp_internal_error',
      message: 'model exploded mid-turn',
    });
  });

  it('records no chat_failed when a pending session create is cancelled before failing', async () => {
    let createStarted!: () => void;
    const createStartedPromise = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    let rejectCreateSession!: (error: unknown) => void;
    const createSessionPromise = new Promise<unknown>((_resolve, reject) => {
      rejectCreateSession = reject;
    });
    let history: SessionHistoryInput[] = [];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => history),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(
        async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = update(history);
        }
      ),
      roomId: 'session-session-create-cancel',
    });
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(() => {
        createStarted();
        return createSessionPromise;
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn(() => 'assistant-create-cancel'),
      recordChatFailure: vi.fn(
        async (_sessionDoc: unknown, reason: string, message?: string, code?: string) => {
          await sessionDoc.updateHistory?.((entries: SessionHistoryInput[]) => [
            ...entries,
            {
              id: `system-notice-${entries.length}`,
              role: 'system',
              timestamp: '2026-09-10T00:00:00.000Z',
              fileDiff: [],
              items: [
                {
                  type: 'system_notice',
                  name: 'chat_failed',
                  meta: { reason, ...(code ? { code } : {}), message },
                },
              ],
            } as SessionHistoryInput,
          ]);
        }
      ),
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
    const startPromise = service.startSession({
      type: 'session/create',
      sessionId: 'session-create-cancel' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-create-cancel',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    await createStartedPromise;
    await expect(
      service.cancelSession({
        type: 'session/cancel',
        sessionId: 'session-create-cancel' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant-create-cancel',
      })
    ).resolves.toEqual({ success: true });

    rejectCreateSession(
      new RequestError(-32603, 'Internal error', { details: 'create raced a cancel' })
    );
    await startPromise;

    const notices = history
      .flatMap((entry) => entry.items ?? [])
      .filter((item) => item.type === 'system_notice' && item.name === 'chat_failed');
    expect(notices).toHaveLength(0);
  });

  const createRetryFixture = (createSession: (config: SessionConfig) => Promise<unknown>) => {
    let history: SessionHistoryInput[] = [];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => history),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(
        async (update: (entries: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = update(history);
        }
      ),
      roomId: 'session-session-start-retry',
    });
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(createSession),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    let backoffStarted!: () => void;
    const backoff = new Promise<void>((resolve) => {
      backoffStarted = resolve;
    });
    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn(() => 'assistant-start-retry'),
      setSessionActivePresencePhase: vi.fn(
        (_sessionId: SessionId, _phase: SessionActivePresencePhase, detail?: string) => {
          if (detail === 'Retrying after a temporary system error') backoffStarted();
        }
      ),
      recordChatFailure: vi.fn(async (_sessionDoc: unknown, reason: string, message?: string) => {
        await sessionDoc.updateHistory?.((entries: SessionHistoryInput[]) => [
          ...entries,
          {
            id: `system-notice-${entries.length}`,
            role: 'system',
            timestamp: '2026-10-16T00:00:00.000Z',
            fileDiff: [],
            items: [{ type: 'system_notice', name: 'chat_failed', meta: { reason, message } }],
          } as SessionHistoryInput,
        ]);
      }),
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
    const start = () =>
      service.startSession({
        type: 'session/create',
        sessionId: 'session-start-retry' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
        userTurnId: 'turn-start-retry',
        userId: 'user-2',
        userName: 'User 2',
        userEmail: 'user2@example.com',
      });
    const notices = () =>
      history
        .flatMap((entry) => entry.items ?? [])
        .filter((item) => item.type === 'system_notice' && item.name === 'chat_failed');
    return { service, sessionManager, backoff, start, notices };
  };

  it('repeats a new start as a resume once its worktree setup has finished', async () => {
    vi.useFakeTimers();
    const resumeFlags: Array<boolean | undefined> = [];
    const { sessionManager, start, notices } = createRetryFixture(async (config) => {
      resumeFlags.push(config.resume);
      config.onStartStage?.('agent-start');
      throw resumeFlags.length === 1 ? temporarySpawnFailure() : new Error('agent crashed');
    });
    const execution = start();
    await vi.advanceTimersByTimeAsync(16000);
    await execution;
    vi.useRealTimers();

    // The second attempt skips the setup script that the first one already ran.
    expect(resumeFlags).toEqual([undefined, true]);
    expect(sessionManager.createSession).toHaveBeenCalledTimes(2);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.meta).toMatchObject({
      reason: 'turn_pre_prompt_failed',
      message: 'Starting the agent failed: agent crashed',
    });
  });

  it('does not carry a start step into the next attempt', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { notices, start } = createRetryFixture(async (config) => {
      calls += 1;
      if (calls === 1) {
        config.onStartStage?.('agent-start');
        throw temporarySpawnFailure();
      }
      // Fails before reporting any step of its own.
      throw new Error('pending create was replaced');
    });
    const execution = start();
    await vi.advanceTimersByTimeAsync(16000);
    await execution;
    vi.useRealTimers();

    expect(notices()[0]?.meta).toMatchObject({
      reason: 'turn_pre_prompt_failed',
      message: 'pending create was replaced',
    });
  });

  it('does not retry a start whose cleanup left resources unreleased', async () => {
    vi.useFakeTimers();
    const { sessionManager, notices, start } = createRetryFixture(async (config) => {
      config.onStartStage?.('agent-start');
      const failure = temporarySpawnFailure();
      // SessionManager marks this when terminate or credential release fails.
      recordIncompleteStartCleanup(failure);
      throw failure;
    });
    const execution = start();
    await vi.advanceTimersByTimeAsync(16000);
    await execution;
    vi.useRealTimers();

    expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
    expect(notices()[0]?.meta).toMatchObject({
      reason: 'turn_pre_prompt_failed',
      message: 'Starting the agent failed: spawnSync /usr/bin/git EAGAIN',
    });
  });

  it('makes no further start attempt after Stop during the retry delay', async () => {
    vi.useFakeTimers();
    const { service, sessionManager, backoff, start, notices } = createRetryFixture(
      async (config) => {
        config.onStartStage?.('worktree');
        throw temporarySpawnFailure();
      }
    );
    const execution = start();
    await backoff;
    const cancelling = service.cancelSession({
      type: 'session/cancel',
      sessionId: 'session-start-retry' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      turnId: 'assistant-start-retry',
    });
    await vi.advanceTimersByTimeAsync(16000);
    await expect(cancelling).resolves.toEqual({ success: true });
    await execution;
    vi.useRealTimers();

    expect(sessionManager.createSession).toHaveBeenCalledTimes(1);
    expect(notices()).toHaveLength(0);
  });

  it.each<{
    name: string;
    errors: unknown[];
    expectedReason: ChatFailedReason;
    expectedMessage: unknown;
    resumeSessionId: ACPSessionId | undefined;
    history: SessionHistoryInput[];
    /** How many times the restore path may reach `createSession`. */
    expectedCreateSessionCalls: number;
    /** Start step each attempt reports before failing. */
    stage?: SessionStartStage;
  }>([
    {
      name: 'reports an ordinary restore failure',
      errors: [new Error('restore failed')],
      expectedReason: 'session_restore_failed',
      expectedMessage: 'restore failed',
      resumeSessionId: undefined,
      history: [],
      expectedCreateSessionCalls: 1,
    },
    {
      name: 'reports authentication required from the initial restore',
      errors: [new AcpAuthenticationRequiredError([])],
      expectedReason: 'acp_auth_required',
      expectedMessage: 'Authentication required',
      resumeSessionId: undefined,
      history: [],
      expectedCreateSessionCalls: 1,
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
      history: PRIOR_CONVERSATION_HISTORY,
      expectedCreateSessionCalls: 2,
    },
    {
      name: 'reports a wrapped authentication failure from fallback restore',
      errors: [
        new Error('acp_resume_failed: session unavailable'),
        new Error('[ACP_RESUME_FAILED] newSession: Internal error', {
          cause: new RequestError(-32603, 'Internal error', { details: 'OAuth session expired' }),
        }),
      ],
      expectedReason: 'acp_auth_required',
      expectedMessage: '[ACP_RESUME_FAILED] newSession: Internal error',
      resumeSessionId: 'acp-existing' as ACPSessionId,
      history: PRIOR_CONVERSATION_HISTORY,
      expectedCreateSessionCalls: 2,
    },
    {
      // Classification reads `formatErrorMessage`, which a message-less wrapper leaves
      // empty; its cause's text must not switch the restore to the replay fallback.
      name: 'does not classify a message-less wrapper by its cause text',
      errors: [
        new MessagelessStartFailure({ cause: new Error('acp_resume_failed: session unavailable') }),
      ],
      stage: 'agent-start',
      expectedReason: 'session_restore_failed',
      expectedMessage:
        'Starting the agent failed: MessagelessStartFailure: acp_resume_failed: session unavailable',
      resumeSessionId: 'acp-existing' as ACPSessionId,
      history: PRIOR_CONVERSATION_HISTORY,
      expectedCreateSessionCalls: 1,
    },
    {
      // Failure text reaches synced history, so an object cause is never dumped into it.
      name: 'names only the type of a message-less failure with an object cause',
      errors: [new MessagelessStartFailure({ cause: { headers: { authorization: 'secret' } } })],
      stage: 'worktree',
      expectedReason: 'session_restore_failed',
      expectedMessage: 'Preparing the worktree failed: MessagelessStartFailure',
      resumeSessionId: undefined,
      history: [],
      expectedCreateSessionCalls: 1,
    },
    {
      name: 'refuses a context-free fallback when history has not synced',
      errors: [new Error('acp_resume_failed: session unavailable')],
      expectedReason: 'session_restore_failed',
      expectedMessage: expect.stringContaining('has not synced the earlier conversation'),
      resumeSessionId: 'acp-existing' as ACPSessionId,
      history: [],
      // The fallback must not even be attempted: creating it would persist a
      // fresh acpSessionId over the one that still points at the agent's
      // transcript, for a session we cannot carry any context into.
      expectedCreateSessionCalls: 1,
    },
    {
      name: 'reports authentication required when the resume failure wraps an auth error',
      errors: [
        // The SDK's own rejection shape: an `Error` subclass whose `data` a
        // flattened cause dump drops, so the wrapper must be walked per link.
        new Error('[ACP_RESUME_FAILED] loadSession: Internal error', {
          cause: new RequestError(-32603, 'Internal error', {
            details: 'OAuth session expired',
          }),
        }),
      ],
      expectedReason: 'acp_auth_required',
      expectedMessage: '[ACP_RESUME_FAILED] loadSession: Internal error',
      resumeSessionId: 'acp-existing' as ACPSessionId,
      history: PRIOR_CONVERSATION_HISTORY,
      // Signing in again makes the original ACP session resumable, so the
      // resume pointer must survive: no replacement session is created.
      expectedCreateSessionCalls: 1,
    },
    {
      name: 'names the start step and type of a message-less restore failure',
      errors: [new MessagelessStartFailure({ cause: new Error("Operation timed out after '5s'") })],
      stage: 'worktree',
      expectedReason: 'session_restore_failed',
      expectedMessage:
        "Preparing the worktree failed: MessagelessStartFailure: Operation timed out after '5s'",
      resumeSessionId: undefined,
      history: [],
      expectedCreateSessionCalls: 1,
    },
    {
      name: 'retries a temporary system error and reports the last failure',
      errors: [temporarySpawnFailure(), temporarySpawnFailure(), new Error('restore failed')],
      stage: 'worktree',
      expectedReason: 'session_restore_failed',
      expectedMessage: 'Preparing the worktree failed: restore failed',
      resumeSessionId: undefined,
      history: [],
      expectedCreateSessionCalls: 3,
    },
    {
      name: 'stops retrying a temporary system error after three attempts',
      errors: [temporarySpawnFailure(), temporarySpawnFailure(), temporarySpawnFailure()],
      stage: 'agent-start',
      expectedReason: 'session_restore_failed',
      expectedMessage: 'Starting the agent failed: spawnSync /usr/bin/git EAGAIN',
      resumeSessionId: undefined,
      history: [],
      expectedCreateSessionCalls: 3,
    },
    {
      name: 'never repeats a restore whose worktree setup script failed',
      errors: [temporarySpawnFailure()],
      stage: 'worktree-setup',
      expectedReason: 'session_restore_failed',
      expectedMessage: 'Running the worktree setup script failed: spawnSync /usr/bin/git EAGAIN',
      resumeSessionId: undefined,
      history: [],
      expectedCreateSessionCalls: 1,
    },
    {
      name: 'keeps the auth message without a start step',
      errors: [new AcpAuthenticationRequiredError([])],
      stage: 'agent-start',
      expectedReason: 'acp_auth_required',
      expectedMessage: 'Authentication required',
      resumeSessionId: undefined,
      history: [],
      expectedCreateSessionCalls: 1,
    },
  ])('$name', async (testCase) => {
    vi.useFakeTimers();
    const { errors, expectedReason, expectedMessage, resumeSessionId, history } = testCase;
    const expectedCreateSessionCalls = testCase.expectedCreateSessionCalls;
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({
        repoFullName: 'owner/repo',
        isArchived: false,
      })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async () => {}),
    });
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(async (config: SessionConfig) => {
        if (testCase.stage) config.onStartStage?.(testCase.stage);
        const error = errors.shift();
        if (!error) throw new Error('Unexpected restore attempt');
        throw error;
      }),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
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
    const execution = service.continueSession({
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

    // Past the 30s replayable-history wait a context-free fallback runs out.
    await vi.advanceTimersByTimeAsync(31_000);
    await execution;
    vi.useRealTimers();

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
    expect(sessionManager.createSession).toHaveBeenCalledTimes(expectedCreateSessionCalls);
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
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => ({ isArchived: false })),
        setStatus: vi.fn(async () => {}),
        setBaseBranch: vi.fn(async () => {}),
        getHistory: vi.fn(() => []),
        updateHistory: vi.fn(async () => {}),
      });
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
        validateSessionCredentials: vi.fn(async () => {}),
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
    const branchProbe = createDeferred<string | null>();
    const persisted: Record<string, unknown> = {};
    const upsertDocMeta = vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(persisted, patch);
    });
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => []),
      updateHistory: vi.fn(async () => {}),
    });
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
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;

    const deps = createBaseDeps({
      syncSessionBranchName: () => branchProbe.promise,
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

    // Failure must settle while the optional branch probe is still blocked.
    expect(persisted).toMatchObject({
      lastHandledUserMsgId: 'turn-chat-1',
      processingUserMsgId: undefined,
    });
    branchProbe.resolve(null);
  });

  it.each([
    {
      name: 'ACP string error data',
      error: Object.assign(new Error('Invalid params'), {
        code: -32602,
        data: 'No goal is currently set. Use `/goal <objective>` to create one.',
      }),
      expectedFailure: [
        'acp_invalid_params',
        'No goal is currently set. Use `/goal <objective>` to create one.',
      ] as const,
    },
    {
      name: 'remote compact transport error',
      error: new Error(
        'Error running remote compact task: Connection failed: error sending request'
      ),
      expectedFailure: null,
    },
  ])('settles context compaction after a provider prompt rejects ($name)', async (testCase) => {
    const upsertDocMeta = vi.fn(async () => {});
    let history: SessionHistoryInput[] = [
      {
        id: 'turn-1',
        role: 'assistant',
        timestamp: '2026-09-10T00:00:00.000Z',
        fileDiff: [],
        items: [
          {
            type: 'tool_call',
            toolCallId: 'compact-1',
            title: 'Context compacting',
            status: 'in_progress',
            activityKind: 'context_compaction',
          },
        ],
      },
    ];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(
        async (updater: (current: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          history = updater(history);
        }
      ),
    });
    const agentClient = {
      isCreated: vi.fn(() => true),
      prompt: vi.fn(async () => {
        throw testCase.error;
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
      validateSessionCredentials: vi.fn(async () => {}),
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
      turnFinalization: {
        ...createBaseDeps({}).turnFinalization,
        finalizeACPState: vi.fn(async (_sessionId, turnId) => {
          history = markAssistantTurnFinished(history, { turnId, endedAt: 42 });
        }),
      },
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

    if (testCase.expectedFailure) {
      expect(deps.recordChatFailure).toHaveBeenCalledWith(sessionDoc, ...testCase.expectedFailure);
    } else {
      expect(deps.recordChatFailure).not.toHaveBeenCalled();
    }
    expect(history[0]).toMatchObject({
      finished: true,
      items: [expect.objectContaining({ toolCallId: 'compact-1', status: 'failed' })],
    });
  });

  it('records a visible failure when a chat turn fails before prompt starts', async () => {
    const events: string[] = [];
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => []),
      updateHistory: vi.fn(async () => {}),
    });
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
      validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => []),
      updateHistory: vi.fn(async () => {}),
    });
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
      validateSessionCredentials: vi.fn(async () => {}),
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

  it.each(
    (['Stop', 'access revocation', 'Edit & Resend'] as const).flatMap((cancellation) =>
      [false, true].map((restored) => ({ cancellation, restored }))
    )
  )(
    '$cancellation during config preserves the intended ACP process lifetime (restored: $restored)',
    async ({ cancellation, restored }) => {
      const firstConfigStarted = createDeferred();
      const firstConfigResolved = createDeferred();
      const firstConfigFinished = createDeferred();
      const terminationStarted = createDeferred();
      const processExited = createDeferred();
      const configMutations: string[] = [];
      const prompts: Array<{ process: number; sessionId: string }> = [];
      let firstConfigSignal: AbortSignal | undefined;
      const sessionId = 'session-pre-prompt-interrupt' as SessionId;
      const userTurnId = 'turn-pre-prompt-interrupt';
      let meta: Record<string, unknown> = {
        id: sessionId,
        machineId: 'machine-1',
        userId: 'user-1',
        cliType: 'builtin',
        agentType: 'codex',
        acpSessionId: 'acp-original',
        isArchived: false,
      };
      const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
        meta = { ...meta, ...patch };
      });
      const repo = { upsertDocMeta, getDocMeta: vi.fn(async () => ({ meta })) };
      const sessionDoc = new SessionDocument(
        repo as never,
        sessionId,
        async () => {},
        createSilentLogger()
      );
      composeTestSessionDoc(sessionDoc, {
        history: [
          {
            id: userTurnId,
            role: 'user',
            userId: 'user-1',
            timestamp: '2026-09-15T00:00:00.000Z',
            status: 'pending',
            read: false,
            items: [{ type: 'text', text: 'A' }],
            fileDiff: [],
            finished: true,
            inputConfig: { prompt: 'A', cliType: 'builtin', agentType: 'codex' },
          },
        ],
      });
      let processNumber = 0;
      const createSession = () => {
        const process = ++processNumber;
        const sessions = new Set([process === 1 ? 'acp-original' : 'acp-restored']);
        const child = { exitCode: null as number | null };
        const session = new Session(
          {
            sessionId,
            workspaceId: 'workspace-1' as WorkspaceId,
            machineId: 'machine-1',
            requesterUserId: 'user-1',
            userName: 'User',
            userEmail: 'user@example.com',
            agentCliType: 'builtin',
            agentType: 'codex',
          },
          createSilentLogger(),
          '/tmp'
        );
        // Only the OS process boundary is controlled. Production terminate must
        // wait for exit and clear both the client and ACP identity before release.
        Object.assign(session, {
          agentProcess: {
            child,
            terminate: async () => {
              terminationStarted.resolve();
              await processExited.promise;
              sessions.clear();
              child.exitCode = 0;
            },
            onExit: () => () => {},
          },
        });
        const assertLive = (id: string) => {
          if (!sessions.has(id)) throw new Error('ACP session belongs to an exited process');
        };
        session.acpSessionId = (process === 1 ? 'acp-original' : 'acp-restored') as ACPSessionId;
        session.agentClient = {
          isCreated: () => child.exitCode === null,
          currentModel: undefined,
          getAvailableCommands: () => [],
          getConfigOptions: () => [],
          setSessionConfigOption: async (id: string, _configId: string, value: unknown) => {
            assertLive(id);
            configMutations.push(String(value));
            if (value === 'A config #1') {
              firstConfigStarted.resolve();
              await firstConfigResolved.promise;
            }
          },
          prompt: async (id: string) => {
            assertLive(id);
            prompts.push({ process, sessionId: id });
            return { stopReason: 'end_turn' };
          },
          prepareReplacementSession: async () => {
            assertLive('acp-original');
            sessions.add('acp-prepared');
            return { sessionId: 'acp-prepared' };
          },
          adoptPreparedSession: ({ sessionId: id }: { sessionId: string }) => assertLive(id),
          closeDetachedSession: async (id: string) => sessions.delete(id),
        } as unknown as AgentClient;
        return session;
      };
      const session = createSession();
      let residentSession: Session | null = restored ? null : session;
      const sessionManager = {
        getSession: vi.fn(() => residentSession),
        getPendingSession: vi.fn(() => null),
        createSession: vi.fn(async () => {
          residentSession = session;
          return session;
        }),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager;
      const deps = createBaseDeps({
        sessionManager,
        beginConversationTurn: vi.fn(
          (_sessionId, sourceTurnId) => `assistant:${sourceTurnId ?? 'unknown'}`
        ),
        workspaceDocument: {
          repo,
          getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
          updateAcpCapabilities: vi.fn(async () => {}),
          persistPendingChanges: vi.fn(async () => {}),
        } as unknown as LoroDocumentManager,
        buildAcpPromptBlocks: vi.fn(async ({ inputBlocks }) => inputBlocks as ContentBlock[]),
        processMessageQueue: vi.fn(async () => {}),
      });
      deps.applyAcpModeAndModel = vi.fn(async (targetSession, config, context) => {
        if (context.basedOnUserTurnId === 'turn-pre-prompt-interrupt') {
          firstConfigSignal = context.signal;
        }
        try {
          await applyAcpSessionRunConfig({
            session: targetSession,
            config,
            logger: createSilentLogger(),
            signal: context.signal,
          });
        } finally {
          if (context.basedOnUserTurnId === userTurnId) firstConfigFinished.resolve();
        }
      });

      const service = new SessionExecutionService(deps);
      const firstMessage = {
        type: 'session/chat',
        sessionId: 'session-pre-prompt-interrupt' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        project: undefined,
        acpSessionConfig: {
          prompt: 'hello',
          cliType: 'builtin',
          agentType: 'codex',
          configOptionValues: {
            first: 'A config #1',
            second: 'A config #2',
          },
        },
        userTurnId: 'turn-pre-prompt-interrupt',
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      } as const;
      const continuePromise = service.continueSession(firstMessage);

      await firstConfigStarted.promise;
      if (cancellation === 'Edit & Resend') {
        // An accidental termination must fail at adoption, not hang this test.
        processExited.resolve();
        const editService = new SessionEditAndResendService({
          workspaceDocument: deps.workspaceDocument,
          sessionManager,
          executionService: service,
          userResolver: {} as never,
          logger: createSilentLogger(),
          workspaceId: 'workspace-1',
          machineId: 'machine-1',
          enqueueDispatch: () => {},
        });
        await expect(
          editService.editAndResend({
            sessionId,
            expectedUserTurnId: userTurnId,
            replacementUserTurnId: 'turn-after-interrupt',
            requestedByUserId: 'user-1',
            timestamp: '2026-09-15T00:00:01.000Z',
            inputConfig: { prompt: 'B', cliType: 'builtin', agentType: 'codex' },
          })
        ).resolves.toMatchObject({ success: true });
        expect(session.agentClient).not.toBeNull();
        expect(session.acpSessionId).toBe('acp-prepared');
        expect(meta.acpSessionId).toBe('acp-prepared');
      } else {
        await expect(
          service.cancelSession(
            {
              type: 'session/cancel',
              sessionId: firstMessage.sessionId,
              machineId: 'machine-1',
              workspaceId: 'workspace-1' as WorkspaceId,
              turnId: 'assistant:turn-pre-prompt-interrupt',
            },
            {
              pendingInput: cancellation === 'Stop' ? 'promote' : 'preserve',
              prePromptSession: 'discard',
            }
          )
        ).resolves.toEqual({ success: true });
        await terminationStarted.promise;
        expect(service.getExecutionSnapshot(sessionId).hasActiveTurn).toBe(true);
        processExited.resolve();
      }
      await continuePromise;
      if (cancellation !== 'Edit & Resend') {
        expect(session.agentClient).toBeNull();
        expect(session.acpSessionId).toBeNull();
        residentSession = createSession();
      }

      const nextMessage = {
        ...firstMessage,
        userTurnId: 'turn-after-interrupt',
        acpSessionConfig: {
          ...firstMessage.acpSessionConfig,
          prompt: 'B',
          configOptionValues: { first: 'B config #1' },
        },
      };
      await service.continueSession(nextMessage);
      expect(configMutations).toEqual(['A config #1', 'B config #1']);
      expect(prompts).toEqual([
        {
          process: cancellation === 'Edit & Resend' ? 1 : 2,
          sessionId: cancellation === 'Edit & Resend' ? 'acp-prepared' : 'acp-restored',
        },
      ]);
      expect(firstConfigSignal?.aborted).toBe(true);

      firstConfigResolved.resolve();
      await firstConfigFinished.promise;
      expect(configMutations).toEqual(['A config #1', 'B config #1']);
      expect(service.getExecutionSnapshot(sessionId).hasActiveTurn).toBe(false);
      sessionDoc.mirror?.dispose();
    }
  );

  it('stops a turn before prompt starts when the matching active turn is cancelled', async () => {
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => []),
      updateHistory: vi.fn(async () => {}),
    });
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
      validateSessionCredentials: vi.fn(async () => {}),
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

  const cancelCompletions = [
    'native-terminal',
    'late-steer-ack',
    'late-steer-write-failure',
    'stalled-steer-request',
    'terminated',
    'termination-failed',
    'cancel-unacknowledged',
    'cancel-rejected',
    'late-cancel-rejected',
    'notice-write-pending',
    'notice-write-rejected',
  ] as const;
  it.each(cancelCompletions)('retains cancelled ownership (%s)', async (completion) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lateApplied =
      completion === 'late-steer-ack' || completion === 'late-steer-write-failure';
    const nativeCompletion =
      completion === 'native-terminal' || completion === 'late-cancel-rejected' || lateApplied;
    const terminationFails =
      completion === 'termination-failed' ||
      completion === 'notice-write-pending' ||
      completion === 'notice-write-rejected';
    const stopFailures: Array<{
      turnId: string;
      phase: 'cancel' | 'timeout' | 'terminate';
      message: string;
    }> = [];
    const pendingNotice = createDeferred();
    let meta: Record<string, unknown> = {};
    let history: Array<Record<string, unknown>> = [
      {
        id: 'turn-prompt-cancel',
        role: 'user',
        items: [{ type: 'text', text: '/compact' }],
        status: 'pending',
        read: false,
      },
      {
        id: 'assistant-prompt-cancel',
        role: 'assistant',
        timestamp: '2026-09-10T00:00:00.000Z',
        fileDiff: [],
        items: [
          {
            type: 'tool_call',
            toolCallId: 'compact-cancelled-turn',
            title: 'Context compacting',
            status: 'in_progress',
            activityKind: 'context_compaction',
          },
        ],
      },
    ];
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      if (
        completion === 'late-steer-write-failure' &&
        (patch.steerTurnStatuses as Record<string, string> | undefined)?.['steer-user-turn']
      ) {
        throw new Error('Synthetic outcome persistence failure');
      }
      meta = { ...meta, ...patch };
    });
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    });
    let activeTurnId: string | undefined;
    const promptStarted = createDeferred();
    const cancelSubmitted = createDeferred();
    const cancelAck = createDeferred();
    const nativeTerminal = createDeferred<PromptResponse>();
    const steerSubmitted = createDeferred();
    const steerApplied = createDeferred<{ release: () => void }>();
    const steerReleased = createDeferred();
    const rawSteer = createDeferred<{ outcome: 'failed' }>();
    const deliveredSteers: ContentBlock[][] = [];
    let steering: ReturnType<SessionExecutionService['steerSession']> | undefined;
    const termination = createDeferred();
    let terminationRequested = false;
    let nativePending = false;
    let promptSignal: AbortSignal | undefined;
    const delivered: ContentBlock[][] = [];
    const agentClient = new AgentClient({
      sessionId: 'session-prompt-cancel' as SessionId,
      logger: createSilentLogger(),
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'codex' },
      onUpdateMessage: () => {},
      onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    });
    // Keep the real AgentClient's local abort and raw ACP tracking behavior.
    // @ts-expect-error - inject an already-created ACP session at the transport boundary
    agentClient.acpSessionId = 'acp-prompt-cancel' as ACPSessionId;
    // @ts-expect-error - only prompt and cancel transport methods are needed here
    agentClient.connection = {
      request: async (_method: string, request: { prompt: ContentBlock[] }) => {
        deliveredSteers.push(request.prompt);
        steerSubmitted.resolve();
        return rawSteer.promise;
      },
      cancel: async () => {
        cancelSubmitted.resolve();
        await cancelAck.promise;
        if (completion === 'cancel-rejected' || completion === 'late-cancel-rejected') {
          throw new Error('Synthetic cancellation rejection');
        }
      },
      prompt: async ({ prompt }: PromptRequest): Promise<PromptResponse> => {
        if (nativePending) throw new RequestError(-32600, 'A Codex prompt is already active');
        delivered.push(prompt);
        if (delivered.length > 1) return { stopReason: 'end_turn' };
        nativePending = true;
        promptStarted.resolve();
        try {
          return await nativeTerminal.promise;
        } finally {
          nativePending = false;
        }
      },
    };
    const sendPrompt = agentClient.prompt.bind(agentClient);
    vi.spyOn(agentClient, 'prompt').mockImplementation((id, blocks, options) => {
      promptSignal = options?.signal;
      return sendPrompt(id, blocks, options);
    });
    if (lateApplied) {
      vi.spyOn(agentClient, 'getAcknowledgedSteerCapability').mockReturnValue({
        provider: 'codex',
        appliedNotificationMethod: 'codex/steerApplied',
        upstreamTurn: 'same',
        configPolicy: 'active',
      });
      vi.spyOn(agentClient, 'steerPrompt').mockImplementation((_id, blocks) => {
        deliveredSteers.push(blocks);
        steerSubmitted.resolve();
        return {
          outcome: steerApplied.promise.then((application) => ({
            outcome: 'applied' as const,
            application,
          })),
          completion: nativeTerminal.promise,
        };
      });
    }
    if (completion === 'stalled-steer-request') {
      agentClient['acknowledgedSteerCapability'] = {
        provider: 'codex',
        requestMethod: '_session/steering',
        appliedNotificationMethod: 'codex/steerApplied',
        upstreamTurn: 'same',
        configPolicy: 'active',
      };
    }
    const session = {
      sessionId: 'session-prompt-cancel' as SessionId,
      acpSessionId: 'acp-prompt-cancel' as ACPSessionId,
      agentClient,
      terminalManager: {} as unknown,
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: vi.fn(async () => ''),
      terminate: vi.fn(async () => {
        terminationRequested = true;
        await termination.promise;
        if (terminationFails) throw new Error('Synthetic termination failure');
        nativeTerminal.reject(new Error('Synthetic ACP connection closed'));
        if (completion === 'stalled-steer-request')
          rawSteer.reject(new Error('Synthetic ACP connection closed'));
      }),
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
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      beginConversationTurn: vi.fn((_id, userTurnId) => {
        activeTurnId =
          userTurnId === 'turn-prompt-cancel'
            ? 'assistant-prompt-cancel'
            : `assistant:${userTurnId}`;
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
      buildAcpPromptBlocks: async ({ inputBlocks }) => inputBlocks as ContentBlock[],
      processMessageQueue: vi.fn(async () => {}),
      recordSessionStopFailure: async (_sessionId, turnId, failure) => {
        stopFailures.push({ turnId, ...failure });
        if (completion === 'notice-write-pending') await pendingNotice.promise;
        if (completion === 'notice-write-rejected')
          throw new Error('Synthetic notice write failure');
      },
    });
    vi.mocked(deps.turnFinalization.finalizeACPState).mockImplementation(
      async (_sessionId, turnId) => {
        history = markAssistantTurnFinished(history as SessionHistoryInput[], {
          turnId,
          endedAt: 42,
        }) as Array<Record<string, unknown>>;
        expect(history[0]).toMatchObject({ id: 'turn-prompt-cancel', status: 'canceled' });
      }
    );
    const service = new SessionExecutionService(deps);
    const message: Parameters<SessionExecutionService['continueSession']>[0] = {
      type: 'session/chat',
      sessionId: 'session-prompt-cancel' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: '/compact', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-prompt-cancel',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    };
    const nextMessage = {
      ...message,
      userTurnId: 'next-user-turn',
      acpSessionConfig: { ...message.acpSessionConfig, prompt: 'continue' },
    };
    const running = service.continueSession(message, {});
    try {
      await promptStarted.promise;
      expect(service.getActiveInvocationContext(message.sessionId)?.sourceTurnId).toBe(
        message.userTurnId
      );
      if (lateApplied || completion === 'stalled-steer-request') {
        history.push({
          id: 'steer-user-turn',
          role: 'user',
          status: 'pending_apply',
          inputConfig: { prompt: 'change direction' },
        });
        steering = service.steerSession({
          sessionId: message.sessionId,
          expectedTurnId: 'assistant-prompt-cancel',
          userTurnId: 'steer-user-turn',
          userId: 'steer-requester',
          timestamp: '2026-09-13T00:00:00.000Z',
          inputConfig: { prompt: 'change direction' },
        });
        await steerSubmitted.promise;
      }
      await expect(
        service.cancelSession(
          {
            type: 'session/cancel',
            sessionId: message.sessionId,
            machineId: message.machineId,
            workspaceId: message.workspaceId,
            turnId: 'assistant-prompt-cancel',
          },
          { pendingInput: 'promote' }
        )
      ).resolves.toEqual({ success: true });
      await cancelSubmitted.promise;
      if (completion !== 'cancel-unacknowledged' && completion !== 'late-cancel-rejected') {
        cancelAck.resolve();
      }
      await vi.advanceTimersByTimeAsync(0);
      if (completion === 'cancel-rejected') {
        expect(stopFailures).toEqual([
          {
            turnId: 'assistant-prompt-cancel',
            phase: 'cancel',
            message: expect.stringContaining('Synthetic cancellation rejection'),
          },
        ]);
      } else {
        expect(stopFailures).toEqual([]);
      }
      if (steering && lateApplied) {
        steerApplied.resolve({ release: () => steerReleased.resolve() });
        await expect(steering).resolves.toMatchObject({
          applied: false,
          disposition: completion === 'late-steer-write-failure' ? 'error' : 'stale-turn',
        });
        await steerReleased.promise;
        // Physical ownership remains, but canceled model work no longer has delegation authority.
        expect(service.getActiveInvocationContext(message.sessionId)).toBeUndefined();
        expect(service.getActiveUserTurnId(message.sessionId)).toBe(message.userTurnId);
        expect(meta.processingUserMsgId).toBe(message.userTurnId);
        expect(meta.latestUserMsgId).not.toBe('steer-user-turn');
        expect(history.find((entry) => entry.id === 'steer-user-turn')).toMatchObject({
          status: completion === 'late-steer-write-failure' ? 'pending_apply' : 'canceled',
        });
      }
      expect(agentClient.pendingPromptCompletion).not.toBeNull();
      expect(service.getExecutionSnapshot(message.sessionId)).toMatchObject({
        hasActiveTurn: true,
        activeTurnId: 'assistant-prompt-cancel',
      });
      expect(promptSignal?.aborted).toBe(false);
      expect(history[0]).toMatchObject({ status: 'processing' });
      expect(history[1]).not.toHaveProperty('finished', true);
      if (completion === 'stalled-steer-request') {
        nativeTerminal.resolve({ stopReason: 'cancelled' });
        await vi.advanceTimersByTimeAsync(0);
        expect(agentClient.pendingPromptCompletion).not.toBeNull();
        const releaseRewrite = service.tryAcquireSessionRewriteBarrier(message.sessionId);
        expect(releaseRewrite).not.toBeNull();
        releaseRewrite?.();
      }
      history.push({
        id: nextMessage.userTurnId,
        role: 'user',
        status: 'pending',
        items: [{ type: 'text', text: 'continue' }],
      });
      meta.latestUserMsgId = nextMessage.userTurnId;
      await service.continueSession(nextMessage);
      expect(delivered).toEqual([[{ type: 'text', text: '/compact' }]]);
      expect(history.find((entry) => entry.id === nextMessage.userTurnId)).toMatchObject({
        status: 'pending',
      });
      expect(deps.recordChatFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(terminationRequested).toBe(false);
      // A repeated Stop must neither abort the owner nor restart its deadline.
      await service.cancelSession(
        {
          type: 'session/cancel',
          sessionId: message.sessionId,
          machineId: message.machineId,
          workspaceId: message.workspaceId,
          turnId: 'assistant-prompt-cancel',
        },
        { pendingInput: 'promote' }
      );
      if (nativeCompletion) {
        nativeTerminal.resolve({ stopReason: 'cancelled' });
      } else {
        await vi.advanceTimersByTimeAsync(1);
        expect(terminationRequested).toBe(true);
        expect(stopFailures).toContainEqual({
          turnId: 'assistant-prompt-cancel',
          phase: 'timeout',
          message: expect.stringContaining('ACP prompt cancellation timed out'),
        });
        expect(promptSignal?.aborted).toBe(false);
        expect(history[1]).not.toHaveProperty('finished', true);
        expect(service.getExecutionSnapshot(message.sessionId)).toMatchObject({
          hasActiveTurn: true,
        });
        await service.continueSession(nextMessage);
        expect(delivered).toEqual([[{ type: 'text', text: '/compact' }]]);
        termination.resolve();
        await vi.advanceTimersByTimeAsync(0);
        if (terminationFails) {
          await vi.advanceTimersByTimeAsync(5_000);
          expect(stopFailures).toEqual([
            {
              turnId: 'assistant-prompt-cancel',
              phase: 'timeout',
              message: expect.stringContaining('ACP prompt cancellation timed out'),
            },
            {
              turnId: 'assistant-prompt-cancel',
              phase: 'terminate',
              message: expect.stringContaining('Synthetic termination failure'),
            },
          ]);
          expect(agentClient.pendingPromptCompletion).not.toBeNull();
          await running;
          expect(promptSignal?.aborted).toBe(true);
          expect(service.getExecutionSnapshot(message.sessionId).hasActiveTurn).toBe(false);
          nativeTerminal.resolve({ stopReason: 'cancelled' });
        }
      }
      await running;
      expect(service.getExecutionSnapshot(message.sessionId).hasActiveTurn).toBe(false);
      cancelAck.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stopFailures).toHaveLength(
        nativeCompletion ? 0 : terminationFails || completion === 'cancel-rejected' ? 2 : 1
      );
      expect(terminationRequested).toBe(!nativeCompletion);
    } finally {
      pendingNotice.resolve();
      steerApplied.resolve({ release: () => steerReleased.resolve() });
      cancelAck.resolve();
      termination.resolve();
      nativeTerminal.resolve({ stopReason: 'cancelled' });
      rawSteer.resolve({ outcome: 'failed' });
      await running;
      await steering;
      vi.useRealTimers();
    }

    expect(agentClient.pendingPromptCompletion).toBeNull();
    expect(service.getExecutionSnapshot(message.sessionId)).toMatchObject({ hasActiveTurn: false });
    expect(deps.processMessageQueue).not.toHaveBeenCalled();
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    // Stopping mid-prompt is the common Stop, and it never reaches finalizeTurn.
    // The agent's work is still unpublished with nothing to commit or push it,
    // so this route has to refresh the flags that raise Commit & Push.
    expect(deps.turnFinalization.syncWorkspaceGitState).toHaveBeenCalledWith(
      'session-prompt-cancel',
      expect.anything(),
      expect.any(AbortSignal)
    );
    expect(history[0]).toMatchObject({ id: 'turn-prompt-cancel', status: 'canceled' });
    expect(history[1]).toMatchObject({
      id: 'assistant-prompt-cancel',
      finished: true,
      items: [
        expect.objectContaining({
          toolCallId: 'compact-cancelled-turn',
          status: 'failed',
        }),
      ],
    });
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-prompt-cancel', {
      lastHandledUserMsgId: 'turn-prompt-cancel',
      processingUserMsgId: undefined,
    });
    await service.continueSession(nextMessage);
    expect(delivered).toEqual([
      [{ type: 'text', text: '/compact' }],
      [{ type: 'text', text: 'continue' }],
    ]);
    expect(history.find((entry) => entry.id === nextMessage.userTurnId)).toMatchObject({
      status: 'handled',
    });
    if (steering) {
      expect(deliveredSteers).toEqual([[{ type: 'text', text: 'change direction' }]]);
      expect(history.find((entry) => entry.id === 'steer-user-turn')).toMatchObject({
        status:
          completion === 'stalled-steer-request'
            ? 'delivery_unknown'
            : completion === 'late-steer-write-failure'
              ? 'pending_apply'
              : 'canceled',
      });
    }
    expect(meta).toMatchObject({
      latestUserMsgId: nextMessage.userTurnId,
      lastHandledUserMsgId: nextMessage.userTurnId,
    });
    expect(deps.recordChatFailure).not.toHaveBeenCalled();
    expect(service.getExecutionSnapshot(message.sessionId)).toMatchObject({ hasActiveTurn: false });
  });

  it.each(['resolved', 'rejected', 'timeout', 'termination-failed'] as const)(
    'keeps ownership through raw ACP drain after external owner interruption (%s)',
    async (completion) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const rawPrompt = createDeferred();
      const termination = createDeferred();
      const promptStarted = createDeferred();
      const drainStarted = createDeferred();
      const terminationStarted = createDeferred();
      const sessionId = 'session-prompt-cancel-drain' as SessionId;
      const userTurnId = 'turn-prompt-cancel-drain';
      let meta: Record<string, unknown> = {};
      let history: Array<Record<string, unknown>> = [
        {
          id: userTurnId,
          role: 'user',
          status: 'pending',
          read: false,
          items: [{ type: 'text', text: 'old request' }],
        },
        {
          id: `assistant:${userTurnId}`,
          role: 'assistant',
          timestamp: '2026-09-10T00:00:00.000Z',
          fileDiff: [],
          items: [
            {
              type: 'tool_call',
              toolCallId: 'compact-cancel-drain',
              title: 'Context compacting',
              status: 'in_progress',
              activityKind: 'context_compaction',
            },
          ],
        },
      ];
      let status: unknown;
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => ({ isArchived: false })),
        setStatus: vi.fn(async (next: unknown) => {
          status = next;
        }),
        setBaseBranch: vi.fn(async () => {}),
        getHistory: vi.fn(() => history),
        updateHistory: vi.fn(async (update: (prev: typeof history) => typeof history) => {
          history = update(history);
        }),
      });
      let activeTurnId: string | undefined;
      let promptSignal: AbortSignal | undefined;
      let rawPending = true;
      let terminated = false;
      const delivered: unknown[][] = [];
      const rawCompletion = rawPrompt.promise.then(
        () => {
          rawPending = false;
        },
        () => {
          rawPending = false;
        }
      );
      const agentClient = {
        isCreated: () => !terminated,
        // A cancel notification need not acknowledge provider cleanup.
        cancel: () => new Promise<never>(() => {}),
        get pendingPromptCompletion(): Promise<void> | null {
          drainStarted.resolve();
          return rawPending ? rawCompletion : null;
        },
        prompt: (
          _acpSessionId: ACPSessionId,
          blocks: unknown[],
          options?: { signal?: AbortSignal }
        ) => {
          delivered.push(blocks);
          if (delivered.length > 1) return Promise.resolve({});
          promptSignal = options?.signal;
          promptStarted.resolve();
          return new Promise<never>((_resolve, reject) => {
            if (promptSignal?.aborted) {
              reject(new Error('Agent prompt aborted'));
              return;
            }
            promptSignal?.addEventListener(
              'abort',
              () => reject(new Error('Agent prompt aborted')),
              { once: true }
            );
          });
        },
        currentModel: undefined,
      };
      const session = {
        sessionId,
        acpSessionId: 'acp-prompt-cancel-drain' as ACPSessionId,
        agentClient,
        terminalManager: {} as unknown,
        getWorkdir: () => '/tmp',
        getHostWorkdir: () => '/tmp',
        getParentSessionId: () => undefined,
        exec: vi.fn(async () => ''),
        terminate: async () => {
          terminationStarted.resolve();
          await termination.promise;
          if (completion === 'termination-failed') throw new Error('Synthetic termination failure');
          terminated = true;
        },
        updateGitIdentity: vi.fn(),
        createAgent: vi.fn(async () => 'acp-prompt-cancel-drain'),
        applyExecutionPlaneLimits: vi.fn(async () => {}),
      };
      const sessionManager = {
        getSession: () => session,
        getPendingSession: () => null,
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager;
      const activePresence = new Map<SessionId, SessionStatus>();
      const presence = new SessionActivePresenceControllerLegacy(
        {
          publishSessionPresence: (id: SessionId, _machine: MachineId, value: SessionStatus) => {
            activePresence.set(id, value);
          },
          clearSessionPresence: (id: SessionId) => activePresence.delete(id),
        } as unknown as LoroDocumentManager,
        'machine-1' as MachineId,
        createSilentLogger()
      );
      const deps = createBaseDeps({
        sessionManager,
        holdSessionActivePresence: (id, phase) => presence.native.hold(id, phase),
        setSessionActivePresencePhase: (id, phase, detail) => presence.setPhase(id, phase, detail),
        clearSessionActivePresence: (id) => presence.clearUnleased(id),
        beginConversationTurn: (_id, turn) => {
          activeTurnId = `assistant:${turn}`;
          return activeTurnId;
        },
        getActiveTurnId: () => activeTurnId,
        clearActiveTurnId: (_id, turn) => {
          if (activeTurnId === turn) activeTurnId = undefined;
        },
        workspaceDocument: {
          repo: {
            upsertDocMeta: async (_id: string, patch: Record<string, unknown>) => {
              meta = { ...meta, ...patch };
            },
            getDocMeta: async () => ({ meta }),
          },
          getOrCreateSessionDoc: async () => sessionDoc,
          updateAcpCapabilities: vi.fn(async () => {}),
        } as unknown as LoroDocumentManager,
        buildAcpPromptBlocks: async ({ inputBlocks }) => inputBlocks as ContentBlock[],
      });
      vi.mocked(deps.turnFinalization.finalizeACPState).mockImplementation(
        async (_sessionId, turnId) => {
          history = markAssistantTurnFinished(history as SessionHistoryInput[], {
            turnId,
            endedAt: 42,
          }) as Array<Record<string, unknown>>;
        }
      );
      const service = new SessionExecutionService(deps);
      const message: Parameters<SessionExecutionService['continueSession']>[0] = {
        type: 'session/chat',
        sessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
        acpSessionConfig: { prompt: 'old request', cliType: 'builtin', agentType: 'codex' },
        userTurnId,
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      };
      const nextMessage = {
        ...message,
        userTurnId: 'turn-new-request',
        acpSessionConfig: { ...message.acpSessionConfig, prompt: 'new request' },
      };
      const running = service.continueSession(message);
      try {
        await promptStarted.promise;
        await expect(
          service.cancelSession({
            type: 'session/cancel',
            sessionId,
            machineId: 'machine-1',
            workspaceId: 'workspace-1' as WorkspaceId,
            turnId: `assistant:${userTurnId}`,
          })
        ).resolves.toEqual({ success: true });
        const owner = (
          service as unknown as {
            turnRuntimeBySession: Map<SessionId, { fiber?: Fiber.Fiber<unknown, unknown> }>;
          }
        ).turnRuntimeBySession.get(sessionId);
        if (!owner?.fiber) throw new Error('Expected the running turn owner');
        const released = service
          .waitForTurnRelease(sessionId, `assistant:${userTurnId}`)
          .then(() => {
            expect(activePresence.has(sessionId)).toBe(false);
            expect(presence.has(sessionId)).toBe(false);
          });
        // External teardown can still interrupt the owner; normal Stop no longer does.
        void Effect.runPromise(Fiber.interrupt(owner.fiber));
        await Promise.race([drainStarted.promise, running]);
        await vi.advanceTimersByTimeAsync(0);
        expect(promptSignal?.aborted).toBe(true);
        expect(status).toEqual(SessionStatusFactory.idle());
        expect(history[0]).toMatchObject({ id: userTurnId, status: 'canceled' });
        expect(meta).toMatchObject({
          lastHandledUserMsgId: userTurnId,
          processingUserMsgId: undefined,
        });
        expect(service.getExecutionSnapshot(sessionId)).toMatchObject({ hasActiveTurn: true });
        expect(activePresence.get(sessionId)?.type).toBe('running');
        expect(presence.has(sessionId)).toBe(true);
        // The entry is already stamped finished here, so its compaction marker
        // is settled with it — a still-spinning row on a finished turn is the
        // state finalization exists to remove. A compaction that does reach a
        // terminal update during the drain still lands: history merges tool
        // calls by id, so the provider's own status wins afterwards.
        expect(history[1]).toMatchObject({
          id: `assistant:${userTurnId}`,
          finished: true,
          items: [
            expect.objectContaining({
              toolCallId: 'compact-cancel-drain',
              status: 'failed',
            }),
          ],
        });
        await service.continueSession(nextMessage);
        expect(delivered).toEqual([[{ type: 'text', text: 'old request' }]]);

        if (completion === 'timeout' || completion === 'termination-failed') {
          await vi.advanceTimersByTimeAsync(5_000);
          await terminationStarted.promise;
          expect(terminated).toBe(false);
          expect(service.getExecutionSnapshot(sessionId)).toMatchObject({ hasActiveTurn: true });
          await service.continueSession(nextMessage);
          expect(delivered).toEqual([[{ type: 'text', text: 'old request' }]]);
          termination.resolve();
          if (completion === 'termination-failed') rawPrompt.resolve();
          await running;
          expect(terminated).toBe(completion === 'timeout');
        } else {
          if (completion === 'resolved') rawPrompt.resolve();
          else rawPrompt.reject(new Error('Synthetic ACP connection closed'));
          await running;
          expect(terminated).toBe(false);
        }
        await released;
        expect(service.getExecutionSnapshot(sessionId)).toMatchObject({ hasActiveTurn: false });
        expect(activePresence.has(sessionId)).toBe(false);
        expect(presence.has(sessionId)).toBe(false);
        expect(history[1]).toMatchObject({
          id: `assistant:${userTurnId}`,
          finished: true,
          items: [
            expect.objectContaining({
              toolCallId: 'compact-cancel-drain',
              status: 'failed',
            }),
          ],
        });
        if (completion !== 'timeout' && completion !== 'termination-failed') {
          await service.continueSession(nextMessage);
          expect(delivered).toEqual([
            [{ type: 'text', text: 'old request' }],
            [{ type: 'text', text: 'new request' }],
          ]);
        }
      } finally {
        rawPrompt.resolve();
        termination.resolve();
        await presence.close();
        vi.useRealTimers();
      }
    }
  );

  it('flushes cancellation when a cancelled prompt resolves before finalization starts', async () => {
    vi.useFakeTimers();
    try {
      let meta: Record<string, unknown> = {};
      const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
        meta = { ...meta, ...patch };
      });
      const sessionDoc = withHistoryPort({
        getMetaState: vi.fn(async () => ({ isArchived: false })),
        setStatus: vi.fn(async () => {}),
        setBaseBranch: vi.fn(async () => {}),
        getHistory: vi.fn(() => []),
        updateHistory: vi.fn(async () => {}),
      });
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
        validateSessionCredentials: vi.fn(async () => {}),
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

      const notificationFacts: TurnOutcomeFact[] = [];
      deps.turnFinalization.onTurnOutcome = async (fact) => {
        notificationFacts.push(fact);
      };
      let releaseRefresh = () => {};
      const refresh = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      const refreshing = createDeferred<void>();
      deps.turnFinalization.refreshCodeCollabSharedState = () => {
        refreshing.resolve();
        return refresh;
      };
      service = new SessionExecutionService(deps);
      const execution = service.continueSession({
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

      await refreshing.promise;
      await vi.advanceTimersByTimeAsync(20_000);
      await execution;
      expect(
        service.getExecutionSnapshot('session-prompt-cancel-resolved' as SessionId).hasActiveTurn
      ).toBe(false);
      releaseRefresh();
      expect(notificationFacts.map((fact) => fact.outcome)).toEqual([{ kind: 'cancelled' }]);
      expect(agentClient.cancel).toHaveBeenCalledWith('acp-prompt-cancel-resolved');
      expect(deps.turnFinalization.finalizeACPState).toHaveBeenCalledTimes(2);
      expect(deps.turnFinalization.finalizeACPState).toHaveBeenLastCalledWith(
        'session-prompt-cancel-resolved',
        'assistant-prompt-cancel-resolved'
      );
      expect(deps.processMessageQueue).not.toHaveBeenCalled();
      expect(upsertDocMeta).toHaveBeenCalledWith('session-session-prompt-cancel-resolved', {
        lastHandledUserMsgId: 'turn-prompt-cancel-resolved',
        processingUserMsgId: undefined,
      });
    } finally {
      vi.useRealTimers();
    }
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
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      roomId: 'session-session-finalizing-cancel',
    });
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
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const upsertDocMeta = vi.fn(async (_roomId: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch };
    });
    let branchOnDisk = 'feature/before-cancel';
    let publishedBranch: string | undefined;
    let service: SessionExecutionService;
    const deps = createBaseDeps({
      syncSessionBranchName: async () => {
        publishedBranch = branchOnDisk;
        return publishedBranch;
      },
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
          branchOnDisk = 'feature/after-cancel';
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
        updateSessionDiffStats: vi.fn(async () => []),
        detectAndAssociatePR: vi.fn(async () => null),
        syncWorkspaceGitState: vi.fn(async () => {}),
        onTurnOutcome: vi.fn(async () => {}),
      },
      processMessageQueue: vi.fn(async () => {}),
    });

    service = new SessionExecutionService(deps);
    await service.startSession({
      type: 'session/create',
      sessionId: 'session-finalizing-cancel' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      // GitHub-capable: the dirty probe is scoped to sessions whose Info Bar can
      // actually offer Commit & Push.
      project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' },
      acpSessionConfig: { prompt: 'hello', cliType: 'builtin', agentType: 'codex' },
      userTurnId: 'turn-finalizing-user',
      userId: 'user-2',
      userName: 'User 2',
      userEmail: 'user2@example.com',
    });

    expect(agentClient.cancel).not.toHaveBeenCalled();
    expect(deps.turnFinalization.onTurnOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { kind: 'cancelled' } })
    );
    expect(deps.processMessageQueue).not.toHaveBeenCalled();
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    // The rest of finalization is skipped, but the interrupted turn may have
    // left unpublished work and nothing commits or pushes it now — the git-state
    // probe is the only thing that raises Commit & Push, so it still runs.
    expect(publishedBranch).toBe('feature/after-cancel');
    expect(deps.turnFinalization.syncWorkspaceGitState).toHaveBeenCalledWith(
      'session-finalizing-cancel',
      expect.anything(),
      expect.any(AbortSignal)
    );
    expect(deps.turnFinalization.updateSessionDiffStats).not.toHaveBeenCalled();
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-finalizing-cancel', {
      lastHandledUserMsgId: 'turn-finalizing-user',
      processingUserMsgId: undefined,
    });
  });

  it('fails startSession when the agent client is missing instead of silently finalizing', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => undefined),
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
      roomId: 'session-session-4',
    });
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
      validateSessionCredentials: vi.fn(async () => {}),
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

    expect(deps.turnFinalization.onTurnOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { kind: 'failed', code: 'session_create_failed' } })
    );
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(
      SessionStatusFactory.initializing(),
      expect.objectContaining({ latestUserMsgId: 'turn-create-4' })
    );
  });

  it('cancels an active session and reports success', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = withHistoryPort({
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
    });
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
      validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {
        throw new Error('status write failed');
      }),
      updateHistory: vi.fn(async () => {}),
    });
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
      validateSessionCredentials: vi.fn(async () => {}),
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
    const sessionDoc = withHistoryPort({
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
    });
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
      validateSessionCredentials: vi.fn(async () => {}),
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

  it('finalizes a stale unfinished compaction turn when no live runtime owns it', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const compactionItem = {
      type: 'tool_call',
      toolCallId: 'context-compaction-stale',
      title: 'Context compacting',
      status: 'in_progress',
      activityKind: 'context_compaction',
    };
    const history = [
      {
        id: 'assistant-stale-compaction',
        role: 'assistant',
        items: [compactionItem],
        finished: false,
      },
    ];
    const sessionDoc = withHistoryPort({
      getHistory: vi.fn(() => history),
      setStatus: vi.fn(async () => {}),
      updateHistory: vi.fn(async (update: (value: typeof history) => typeof history) => {
        update(history);
      }),
    });
    const sessionManager = {
      getSession: vi.fn(() => null),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      getActiveTurnId: vi.fn(() => undefined),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({ meta: {} })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    const result = await service.cancelSession({
      type: 'session/cancel',
      sessionId: 'session-stale-compaction' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      turnId: 'assistant-stale-compaction',
    });

    expect(result).toEqual({ success: true });
    expect((await sessionDoc.sessionData.history.readAll())[0]?.items[0]).toMatchObject({
      status: 'failed',
    });
    expect(sessionDoc.updateHistory).toHaveBeenCalled();
    expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-stale-compaction', {
      lastCanceledTurn: undefined,
    });
  });

  describe('dead assistant turns', () => {
    const setup = (userStatus: 'processing' | 'failed') => {
      const upsertDocMeta = vi.fn(async (_room: string, _patch: Record<string, unknown>) => {});
      const history: Array<Record<string, unknown>> = [
        { id: 'user-dead', role: 'user', status: userStatus, items: [], timestamp: 't0' },
        {
          id: 'assistant:user-dead',
          role: 'assistant',
          userTurnId: 'user-dead',
          items: [{ type: 'text', text: 'partial answer' }],
          timestamp: 't1',
        },
      ];
      const sessionDoc = withHistoryPort({
        getHistory: vi.fn(() => history),
        setStatus: vi.fn(async () => {}),
        updateHistory: vi.fn(async (update: (value: typeof history) => typeof history) => {
          update(history);
        }),
      });
      const deps = createBaseDeps({
        sessionManager: {
          getSession: vi.fn(() => null),
          getPendingSession: vi.fn(() => null),
        } as unknown as SessionManager,
        getActiveTurnId: vi.fn(() => undefined),
        workspaceDocument: {
          repo: {
            upsertDocMeta,
            getDocMeta: vi.fn(async () => ({
              meta: { latestUserMsgId: 'user-dead', processingUserMsgId: 'user-dead' },
            })),
          },
          getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
          updateAcpCapabilities: vi.fn(async () => {}),
        } as unknown as LoroDocumentManager,
      });
      return { service: new SessionExecutionService(deps), history, upsertDocMeta, sessionDoc };
    };

    it('Stop closes an ordinary turn whose agent process is gone', async () => {
      const { service, history, upsertDocMeta, sessionDoc } = setup('processing');

      const result = await service.cancelSession({
        type: 'session/cancel',
        sessionId: 'session-dead' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant:user-dead',
      });

      expect(result).toEqual({ success: true });
      expect(history[1]).toMatchObject({ finished: true, endedAt: expect.any(Number) });
      expect(history[0]).toMatchObject({ status: 'canceled' });
      expect(upsertDocMeta).toHaveBeenCalledWith('session-session-dead', {
        lastHandledUserMsgId: 'user-dead',
        processingUserMsgId: undefined,
      });
      expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
      expect(upsertDocMeta).toHaveBeenCalledWith('session-session-dead', {
        lastCanceledTurn: undefined,
      });
    });

    it('closes automatically only after the user input settled', async () => {
      const owed = setup('processing');
      // A processing input still owes its crash-recovery run on this entry.
      await expect(
        owed.service.closeDeadAssistantTurn('session-dead' as SessionId, {
          requireSettledUserTurn: true,
        })
      ).resolves.toBe(false);
      expect(owed.history[1]?.finished).toBeUndefined();

      const failed = setup('failed');
      await expect(
        failed.service.closeDeadAssistantTurn('session-dead' as SessionId, {
          requireSettledUserTurn: true,
        })
      ).resolves.toBe(true);
      expect(failed.history[1]).toMatchObject({ finished: true });
      // The settled outcome is kept, not rewritten as a cancellation.
      expect(failed.history[0]).toMatchObject({ status: 'failed' });
      expect(failed.upsertDocMeta).not.toHaveBeenCalled();
    });
  });

  it('keeps a newer queued turn pending when cancelling the currently running turn', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = withHistoryPort({
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
    });
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
      validateSessionCredentials: vi.fn(async () => {}),
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

  it('rejects an endpoint rewrite between displaying the secret form and accepting its key', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-auth-binding-'));
    const secrets = new Map<string, string>();
    const store = new codexProfiles.CodexProfileStore(root, {
      get: async (id) => secrets.get(id),
      set: async (id, value) => {
        secrets.set(id, value);
      },
      delete: async (id) => {
        secrets.delete(id);
      },
    });
    let persistedConfig = createLaunchConfig({
      cliType: 'builtin',
      agentType: 'codex',
      env: {},
      codexAuth: {
        mode: 'api-key',
        profileId: '0b772cc2-dc33-4708-aabb-61b7c1cd15c0',
        baseUrl: 'https://confirmed.example.invalid/v1',
      },
    });
    const profileStore = vi.spyOn(codexProfiles, 'getCodexProfileStore').mockReturnValue(store);
    const authenticate = vi
      .spyOn(AcpAuthenticationManager.prototype, 'authenticate')
      .mockImplementation(async (options) => {
        try {
          if (!options.authenticateManagedProfile) throw new Error('Missing managed flow');
          await options.authenticateManagedProfile({
            signal: new AbortController().signal,
            requestInput: async (_form, message) => {
              expect(message).toContain('https://confirmed.example.invalid/v1');
              persistedConfig = {
                ...persistedConfig,
                codexAuth: {
                  profileId: '0b772cc2-dc33-4708-aabb-61b7c1cd15c0',
                  mode: 'api-key',
                  baseUrl: 'https://changed.example.invalid/v1',
                },
              };
              return { apiKey: 'synthetic-key-must-not-be-used' };
            },
          });
          return { success: true, disposition: 'authenticated' };
        } catch (error) {
          return { success: false, disposition: 'error', error: String(error) };
        }
      });
    const service = new SessionExecutionService(
      createBaseDeps({
        workspaceDocument: {
          getAgentConfigForMachineLaunch: async () => persistedConfig,
        } as unknown as LoroDocumentManager,
      })
    );
    try {
      const result = await service.authenticateMachineAcp({
        type: 'machine/acp-authenticate',
        machineId: 'machine-1' as MachineId,
        workspaceId: 'workspace-1' as WorkspaceId,
        requestId: 'frozen-api-binding',
        action: 'start',
        configId: capabilityConfigId,
      });
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('Provider changed during authentication'),
      });
      expect(secrets.size).toBe(0);
      expect(await store.list('workspace-1')).toHaveLength(1);
    } finally {
      authenticate.mockRestore();
      profileStore.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
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
      // Goal actions: this runtime advertises no goal extension.
      undefined,
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

  describe('ACP capability refresh cache', () => {
    const sourceVersion = 'opencode@1.0.0';
    const secretToken = 'sk-test-9f3a-low-entropy-token';

    /** Machine Flock rows in memory, behind the real MachineDocument writer. */
    class InMemoryMachineFlock {
      readonly rows = new Map<string, { key: MachineFlockKey; value: unknown }>();
      commits = 0;
      scan(options?: { prefix?: readonly unknown[] }) {
        return [...this.rows.values()].filter((row) =>
          options?.prefix ? options.prefix.every((part, index) => row.key[index] === part) : true
        );
      }
      set(key: MachineFlockKey, value: unknown): void {
        this.rows.set(JSON.stringify(key), { key: [...key] as MachineFlockKey, value });
      }
      delete(key: MachineFlockKey): void {
        this.rows.delete(JSON.stringify(key));
      }
      commit(): void {
        this.commits += 1;
      }
    }

    const request = {
      type: 'machine/acp-capabilities-refresh' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      configId: capabilityConfigId,
    };

    /**
     * A service whose capability reads and writes go through a real
     * MachineDocument, so persistence decisions (skip, renew, overwrite) are the
     * production ones. Probes always report the same capabilities.
     */
    const createHarness = (
      options: {
        env?: Record<string, string>;
        expectedSourceVersion?: () => string | undefined;
        getAcpCapabilities?: () => Promise<AcpCapabilityCacheEntry | undefined>;
      } = {}
    ) => {
      const flock = new InMemoryMachineFlock();
      const machine = new MachineDocument(
        {
          openFlockDoc: vi.fn(async () => ({ flock, syncOnce: vi.fn(async () => undefined) })),
          flush: vi.fn(async () => undefined),
        } as unknown as LoroRepo,
        'workspace-1' as WorkspaceId,
        'machine-1' as MachineId,
        () => {}
      );
      let launchConfig = createLaunchConfig({
        cliType: 'registry',
        agentType: 'opencode',
        env: options.env ?? { OPENCODE_API_KEY: secretToken },
      });
      let probes = 0;
      let probeCommands: Array<{ name: string }> | undefined = [{ name: 'review' }];
      let onWrite: (() => void) | undefined;
      const deps = createBaseDeps({
        workspaceDocument: {
          repo: {
            upsertDocMeta: vi.fn(async () => {}),
            getDocMeta: vi.fn(async () => undefined),
          },
          getOrCreateSessionDoc: vi.fn(),
          getAcpCapabilities:
            options.getAcpCapabilities ??
            ((_machineId: MachineId, configId: AgentConfigId) =>
              machine.getAcpCapabilities(configId)),
          updateAcpCapabilities: async (
            _machineId: MachineId,
            ...rest: Parameters<MachineDocument['updateAcpCapabilities']>
          ) => {
            const entry = await machine.updateAcpCapabilities(...rest);
            onWrite?.();
            onWrite = undefined;
            return entry;
          },
          getAgentConfigForMachineLaunch: vi.fn(async () => launchConfig),
        } as unknown as LoroDocumentManager,
        fetchAcpCapabilities: async () => {
          probes += 1;
          return {
            modes: [{ id: 'default', name: 'Default' }],
            models: [{ modelId: 'model-a', name: 'Model A' }],
            availableCommands: probeCommands,
            sessionFork: false,
            acknowledgedSteer: true,
            capabilitySourceVersion: sourceVersion,
          };
        },
        resolveAcpCapabilitySourceVersion: async () =>
          options.expectedSourceVersion ? options.expectedSourceVersion() : sourceVersion,
      });
      const service = new SessionExecutionService(deps);
      return {
        service,
        setProbeCommands: (commands: typeof probeCommands) => {
          probeCommands = commands;
        },
        publishSessionCommands: (names: string[]) =>
          new Promise<void>((resolve) => {
            onWrite = resolve;
            service['scheduleCreatedSessionCapabilityUpdate'](
              {
                sessionId: 'project-session' as SessionId,
                getAcpCapabilities: () => ({
                  modes: [],
                  models: [],
                  availableCommands: names.map((name) => ({ name })),
                  sessionFork: false,
                }),
                getAcpCapabilitySourceVersion: () => sourceVersion,
              } as unknown as Parameters<
                SessionExecutionService['scheduleCreatedSessionCapabilityUpdate']
              >[0],
              {
                agentConfigId: capabilityConfigId,
                agentCliType: 'registry',
                agentType: 'opencode',
                env: launchConfig.env,
              } as SessionConfig
            );
          }),
        flock,
        probes: () => probes,
        editEnv: (env: Record<string, string>) => {
          launchConfig = { ...launchConfig, env };
        },
        storedEntry: () =>
          [...flock.rows.values()].find((row) => row.key[0] === 'acpCapability')?.value as
            | AcpCapabilityCacheEntry
            | undefined,
      };
    };

    it('keeps project commands out of the probe preview and refreshes that preview independently', async () => {
      const harness = createHarness();
      await harness.publishSessionCommands(['review-a']);
      expect(harness.storedEntry()?.availableCommands).toBeUndefined();
      await harness.service.refreshMachineAcpCapabilities(request);
      expect(harness.storedEntry()?.availableCommands).toEqual([{ name: 'review' }]);
      await harness.publishSessionCommands(['review-a']);
      await harness.publishSessionCommands(['review-b']);
      expect(harness.storedEntry()?.availableCommands).toEqual([{ name: 'review' }]);
      harness.setProbeCommands([{ name: 'refreshed-help' }]);
      await harness.service.refreshMachineAcpCapabilities({ ...request, force: true });
      expect(harness.storedEntry()?.availableCommands).toEqual([{ name: 'refreshed-help' }]);
      await harness.publishSessionCommands([]);
      expect(harness.storedEntry()?.availableCommands).toEqual([{ name: 'refreshed-help' }]);
    });

    it('persists an empty probe as confirmed and serves it without another probe', async () => {
      const harness = createHarness();
      harness.setProbeCommands(undefined);
      const probed = await harness.service.refreshMachineAcpCapabilities(request);
      expect(probed.availableCommands).toEqual([]);
      expect(harness.storedEntry()?.availableCommands).toEqual([]);
      harness.setProbeCommands([{ name: 'must-not-be-probed' }]);
      const cached = await harness.service.refreshMachineAcpCapabilities(request);
      expect(cached.availableCommands).toEqual([]);
      expect(harness.storedEntry()?.availableCommands).toEqual([]);
    });

    const start = new Date('2026-09-20T00:00:00.000Z').getTime();
    const withClock = async (run: () => Promise<void>) => {
      // Only Date is faked: the refresh path has no timers, and freezing the
      // scheduler would stall the service's own promise chains.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(start);
      try {
        await run();
      } finally {
        vi.useRealTimers();
      }
    };

    it('answers from the persisted entry without starting an agent once it has probed it', () =>
      withClock(async () => {
        const harness = createHarness();

        await harness.service.refreshMachineAcpCapabilities(request);
        const cached = await harness.service.refreshMachineAcpCapabilities(request);

        expect(harness.probes()).toBe(1);
        expect(cached).toEqual({
          type: 'machine/acp-capabilities-refresh_response',
          machineId: 'machine-1',
          configId: capabilityConfigId,
          cliType: 'registry',
          agentType: 'opencode',
          success: true,
          modes: [{ id: 'default', name: 'Default', description: undefined }],
          models: [{ modelId: 'model-a', name: 'Model A', description: undefined }],
          configOptions: undefined,
          capability: harness.storedEntry(),
          availableCommands: [{ name: 'review' }],
        });
      }));

    it('keeps answering from the cache after an expired entry is re-probed with identical content', () =>
      withClock(async () => {
        const harness = createHarness();
        await harness.service.refreshMachineAcpCapabilities(request);

        vi.setSystemTime(start + ACP_CAPABILITY_REFRESH_CACHE_TTL_MS + 1);
        await harness.service.refreshMachineAcpCapabilities(request);
        expect(harness.probes()).toBe(2);

        // The probe found nothing new, yet the entry must be fresh again: otherwise
        // every later request re-probes forever.
        vi.setSystemTime(start + ACP_CAPABILITY_REFRESH_CACHE_TTL_MS + 60_000);
        await harness.service.refreshMachineAcpCapabilities(request);
        expect(harness.probes()).toBe(2);
        expect(harness.storedEntry()?.fetchedAt).toBe(
          start + ACP_CAPABILITY_REFRESH_CACHE_TTL_MS + 1
        );
      }));

    it('does not write the Machine Flock when a young entry is re-probed with identical content', () =>
      withClock(async () => {
        const harness = createHarness();
        await harness.service.refreshMachineAcpCapabilities(request);
        const commitsAfterFirstProbe = harness.flock.commits;

        vi.setSystemTime(start + 60 * 60 * 1000);
        await harness.service.refreshMachineAcpCapabilities({ ...request, force: true });

        expect(harness.probes()).toBe(2);
        expect(harness.flock.commits).toBe(commitsAfterFirstProbe);
        expect(harness.storedEntry()?.fetchedAt).toBe(start);
      }));

    it('starts the agent after the config environment is edited', () =>
      withClock(async () => {
        const harness = createHarness();
        await harness.service.refreshMachineAcpCapabilities(request);
        await harness.service.refreshMachineAcpCapabilities(request);
        expect(harness.probes()).toBe(1);

        // Neither a registry nor a custom source version depends on env, so the
        // stored sourceVersion still matches; only the launch inputs changed.
        harness.editEnv({ OPENCODE_API_KEY: `${secretToken}-rotated` });
        await harness.service.refreshMachineAcpCapabilities(request);
        expect(harness.probes()).toBe(2);

        await harness.service.refreshMachineAcpCapabilities(request);
        expect(harness.probes()).toBe(2);
      }));

    it('probes once after a restart rather than trusting an entry it cannot attribute', () =>
      withClock(async () => {
        const harness = createHarness();
        await harness.service.refreshMachineAcpCapabilities(request);

        const restarted = createHarness();
        restarted.flock.rows.clear();
        for (const [key, row] of harness.flock.rows) restarted.flock.rows.set(key, row);
        // A fresh process has no record of which launch inputs produced the entry.
        await restarted.service.refreshMachineAcpCapabilities(request);
        await restarted.service.refreshMachineAcpCapabilities(request);

        expect(restarted.probes()).toBe(1);
      }));

    it('never persists the config environment or a derivative of it', () =>
      withClock(async () => {
        const harness = createHarness();
        await harness.service.refreshMachineAcpCapabilities(request);
        harness.editEnv({ OPENCODE_API_KEY: `${secretToken}-rotated` });
        await harness.service.refreshMachineAcpCapabilities(request);

        const persisted = JSON.stringify([...harness.flock.rows.values()]);
        const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
        for (const secret of [secretToken, `${secretToken}-rotated`]) {
          expect(persisted).not.toContain(secret);
          for (const derived of [sha256(secret), sha256(`OPENCODE_API_KEY=${secret}`)]) {
            // Twelve hex characters is the shortest digest prefix this codebase
            // stores anywhere (the DeepSeek endpoint suffix).
            expect(persisted).not.toContain(derived.slice(0, 12));
          }
        }
      }));

    it('starts the agent when the launch inputs no longer produce the stored source version', () =>
      withClock(async () => {
        let expected = sourceVersion;
        const harness = createHarness({ expectedSourceVersion: () => expected });
        await harness.service.refreshMachineAcpCapabilities(request);

        expected = `${sourceVersion}+override:other-binary`;
        await harness.service.refreshMachineAcpCapabilities(request);

        expect(harness.probes()).toBe(2);
      }));

    it('starts the agent for a forced refresh even when the stored entry is current', () =>
      withClock(async () => {
        const harness = createHarness();
        await harness.service.refreshMachineAcpCapabilities(request);

        await expect(
          harness.service.refreshMachineAcpCapabilities({ ...request, force: true })
        ).resolves.toEqual(expect.objectContaining({ success: true }));
        expect(harness.probes()).toBe(2);
      }));

    it('reports a failed refresh when the persisted entry cannot be read', () =>
      withClock(async () => {
        const harness = createHarness({
          getAcpCapabilities: async () => {
            throw new Error('machine flock document is unreadable');
          },
        });

        await expect(harness.service.refreshMachineAcpCapabilities(request)).resolves.toEqual(
          expect.objectContaining({
            type: 'machine/acp-capabilities-refresh_response',
            success: false,
            error: expect.stringContaining('machine flock document is unreadable'),
          })
        );
        expect(harness.probes()).toBe(0);
      }));
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

describe('SessionExecutionService goal control', () => {
  const goalSessionId = 'session-goal' as SessionId;

  const createGoalService = ({
    transport = 'request',
  }: {
    transport?: 'request' | 'promptMeta' | 'slashCommand' | null;
  } = {}) => {
    const submitted = createDeferred<void>();
    const completion = createDeferred<void>();
    const failures: string[] = [];
    const failed = createDeferred<void>();
    const delivered: Array<unknown> = [];
    let goalStatus = 'active';
    const controlGoal = async (action: string) => {
      goalStatus = action;
    };
    const agentClient = {
      resolveGoalActionTransport: () => transport,
      controlGoal,
      isCreated: () => true,
      prompt: async (_id: unknown, _blocks: unknown, options: unknown) => {
        delivered.push(options);
        submitted.resolve();
        await completion.promise;
      },
      cancel: async () => {
        completion.resolve();
      },
    };
    const session = {
      agentClient,
      acpSessionId: 'acp-goal',
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: async () => '',
      updateGitIdentity: () => {},
      applyExecutionPlaneLimits: async () => {},
    };
    const sessionDoc = withHistoryPort({
      getMetaState: async () => ({
        id: goalSessionId,
        cliType: 'builtin',
        agentType: 'codex',
        acpSessionId: 'acp-goal',
      }),
      getHistory: () => [],
      setStatus: async () => {},
      setLastMessageAt: async () => {},
      updateHistory: async () => {},
    });
    const deps = createBaseDeps({
      sessionManager: {
        getSession: () => session,
        getPendingSession: () => null,
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument: {
        repo: { upsertDocMeta: async () => {}, getDocMeta: async () => undefined },
        getOrCreateSessionDoc: async () => sessionDoc,
        getOrOpenSessionCode: async () => null,
      } as unknown as LoroDocumentManager,
      recordChatFailure: async (_doc, reason, message) => {
        failures.push(message ?? reason);
        failed.resolve();
      },
    });
    const service = new SessionExecutionService(deps);
    return {
      service,
      deps,
      agentClient,
      sessionDoc,
      submitted,
      completion,
      delivered,
      failures,
      failed,
      goalStatus: () => goalStatus,
    };
  };

  const goalArgs = {
    sessionId: goalSessionId,
    userId: 'owner-user',
    userName: 'Owner',
    userEmail: 'owner@example.com',
  } as const;

  it('pauses out-of-band without opening a turn', async () => {
    const { service, goalStatus } = createGoalService({ transport: 'request' });

    const response = await service.controlSessionGoal({ ...goalArgs, action: 'pause' });

    expect(response).toMatchObject({ accepted: true, disposition: 'applied', action: 'pause' });
    expect(goalStatus()).toBe('pause');
    // The goal's own prompt owns the session's only turn slot; a pause that
    // needed a free slot could never reach the goal it is stopping.
    expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(false);
  });

  it('refuses an action the agent never advertised', async () => {
    const { service } = createGoalService({ transport: null });

    const response = await service.controlSessionGoal({ ...goalArgs, action: 'resume' });

    expect(response).toMatchObject({ accepted: false, disposition: 'unsupported' });
    expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(false);
  });

  it('starts a Lody-owned turn for an action that resumes work', async () => {
    const { service, deps, submitted, completion, delivered, failures } = createGoalService({
      transport: 'promptMeta',
    });

    const notified = createDeferred<TurnOutcomeFact>();
    deps.turnFinalization.onTurnOutcome = async (fact) => {
      notified.resolve(fact);
    };
    const response = await service.controlSessionGoal({ ...goalArgs, action: 'resume' });

    expect(response).toMatchObject({ accepted: true, disposition: 'queued' });
    await submitted.promise;
    expect(delivered).toEqual([expect.objectContaining({ goalControl: { action: 'resume' } })]);
    expect(failures).toEqual([]);
    expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(true);
    const released = service.waitForTurnRelease(goalSessionId, 'turn-1');
    expect(service.getActiveInvocationContext(goalSessionId)?.notificationOriginTurnIds).toEqual([
      expect.stringMatching(/^goal:resume:/),
    ]);
    completion.resolve();
    await released;
    expect(await notified.promise).toMatchObject({
      audience: { kind: 'user' },
      outcome: { kind: 'succeeded' },
      scope: { recipientId: 'owner-user' },
    });
    expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(false);
  });

  it('retains an accepted goal across more than three competing turns', async () => {
    const { service, submitted, completion, delivered } = createGoalService({
      transport: 'promptMeta',
    });
    const internals = service as unknown as {
      currentTurnBySession: Map<SessionId, string>;
      clearCurrentTurn: (sessionId: SessionId, turnId: string) => void;
    };
    let waiting = createDeferred<void>();
    const originalWait = service.waitForTurnRelease.bind(service);
    vi.spyOn(service, 'waitForTurnRelease').mockImplementation((sessionId, turnId) => {
      const result = originalWait(sessionId, turnId);
      waiting.resolve();
      return result;
    });
    internals.currentTurnBySession.set(goalSessionId, 'busy-0');
    expect(await service.controlSessionGoal({ ...goalArgs, action: 'resume' })).toMatchObject({
      accepted: true,
      disposition: 'queued',
    });
    for (let index = 0; index < 4; index += 1) {
      await waiting.promise;
      waiting = createDeferred<void>();
      internals.clearCurrentTurn(goalSessionId, `busy-${index}`);
      internals.currentTurnBySession.set(goalSessionId, `busy-${index + 1}`);
    }
    await waiting.promise;
    expect(delivered).toEqual([]);
    internals.clearCurrentTurn(goalSessionId, 'busy-4');
    await submitted.promise;
    expect(delivered).toEqual([expect.objectContaining({ goalControl: { action: 'resume' } })]);
    const released = originalWait(goalSessionId, 'turn-1');
    completion.resolve();
    await released;
  });

  it.each(['pause', 'clear'] as const)(
    'a newer %s supersedes resume while metadata is loading',
    async (action) => {
      const { service, agentClient, sessionDoc, delivered, goalStatus } = createGoalService({
        transport: 'promptMeta',
      });
      const metadataRead = createDeferred<void>();
      const metadataReady = createDeferred<void>();
      const originalMeta = sessionDoc.getMetaState;
      sessionDoc.getMetaState = async () => {
        metadataRead.resolve();
        await metadataReady.promise;
        return originalMeta();
      };
      const internals = service as unknown as {
        startGoalTurn: (request: unknown) => Promise<boolean>;
      };
      const originalStart = internals.startGoalTurn.bind(service);
      const settled = createDeferred<void>();
      vi.spyOn(internals, 'startGoalTurn').mockImplementation(async (request) => {
        try {
          return await originalStart(request);
        } finally {
          settled.resolve();
        }
      });
      await service.controlSessionGoal({ ...goalArgs, action: 'resume' });
      await metadataRead.promise;
      agentClient.resolveGoalActionTransport = () => 'request';
      await service.controlSessionGoal({ ...goalArgs, action });
      metadataReady.resolve();
      await settled.promise;
      expect(goalStatus()).toBe(action);
      expect(delivered).toEqual([]);
      expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(false);
    }
  );

  it.each([false, true])(
    'only a matching Stop invalidates queued goal work (stale=%s)',
    async (stale) => {
      const { service, delivered, submitted, completion } = createGoalService({
        transport: 'promptMeta',
      });
      const internals = service as unknown as {
        currentTurnBySession: Map<SessionId, string>;
        pendingGoalTurnBySession: Map<SessionId, unknown>;
        clearCurrentTurn: (sessionId: SessionId, turnId: string) => void;
      };
      internals.currentTurnBySession.set(goalSessionId, 'draining');
      await service.controlSessionGoal({ ...goalArgs, action: 'resume' });
      await service.cancelSession({
        type: 'session/cancel',
        sessionId: goalSessionId,
        machineId: 'machine-1' as MachineId,
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: stale ? 'older' : 'draining',
      });
      expect(internals.pendingGoalTurnBySession.has(goalSessionId)).toBe(stale);
      internals.clearCurrentTurn(goalSessionId, 'draining');
      if (stale) {
        await submitted.promise;
        expect(delivered).toEqual([expect.objectContaining({ goalControl: { action: 'resume' } })]);
        const released = service.waitForTurnRelease(goalSessionId, 'turn-1');
        completion.resolve();
        await released;
      } else {
        expect(delivered).toEqual([]);
        expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(false);
      }
    }
  );

  it('fences a superseded resume after turn ownership but before provider submission', async () => {
    const { service, deps, agentClient, delivered, goalStatus, submitted, completion } =
      createGoalService({
        transport: 'promptMeta',
      });
    const preparing = createDeferred<void>();
    const ready = createDeferred<void>();
    deps.applyAcpModeAndModel = async (_session, config) => {
      expect(config.modelId).toBeUndefined();
      expect(config.modeId).toBeUndefined();
      preparing.resolve();
      await ready.promise;
    };
    await service.controlSessionGoal({ ...goalArgs, action: 'resume' });
    await preparing.promise;
    expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(true);
    agentClient.resolveGoalActionTransport = () => 'request';
    await service.controlSessionGoal({ ...goalArgs, action: 'pause' });
    const released = service.waitForTurnRelease(goalSessionId, 'turn-1');
    const outcome = Promise.race([
      submitted.promise.then(() => 'submitted'),
      released.then(() => 'released'),
    ]);
    ready.resolve();
    const first = await outcome;
    completion.resolve();
    await released;
    expect(first).toBe('released');
    expect(goalStatus()).toBe('pause');
    expect(delivered).toEqual([]);
    expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(false);
  });

  it('records a visible failure when an accepted action cannot load its configuration', async () => {
    const { service, sessionDoc, failed, failures, delivered } = createGoalService({
      transport: 'promptMeta',
    });
    sessionDoc.getMetaState = async () => {
      throw new Error('Synthetic metadata failure');
    };
    expect(await service.controlSessionGoal({ ...goalArgs, action: 'resume' })).toMatchObject({
      accepted: true,
      disposition: 'queued',
    });
    await failed.promise;
    expect(failures).toEqual(['Goal resume failed: Synthetic metadata failure']);
    expect(delivered).toEqual([]);
    expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(false);
  });

  it('keeps only the newest queued action so a stale pause cannot undo a resume', async () => {
    const { service, submitted, completion, delivered } = createGoalService({
      transport: 'promptMeta',
    });
    const internals = service as unknown as {
      currentTurnBySession: Map<SessionId, string>;
      clearCurrentTurn: (sessionId: SessionId, turnId?: string) => void;
    };
    internals.currentTurnBySession.set(goalSessionId, 'draining-turn');

    await service.controlSessionGoal({ ...goalArgs, action: 'pause' });
    await service.controlSessionGoal({ ...goalArgs, action: 'resume' });

    internals.clearCurrentTurn(goalSessionId, 'draining-turn');
    await submitted.promise;
    expect(delivered).toEqual([expect.objectContaining({ goalControl: { action: 'resume' } })]);
    const released = service.waitForTurnRelease(goalSessionId, 'turn-1');
    completion.resolve();
    await released;
  });
});

describe('SessionExecutionService initialization deadline', () => {
  type PresenceEvent =
    | { kind: 'publish'; sessionId: string; status: SessionStatus }
    | { kind: 'clear'; sessionId: string };

  /**
   * Wires the REAL native session presence lease into the execution service
   * so presence is an observable output rather than a mock: the fake document
   * manager records every publish/clear exactly as production would drive it.
   *
   * Clock timers are fake and elapsed time is injected; timer/microtask
   * advancement drives the real native heartbeat and visible Turn together.
   */
  const createDeadlineHarness = (options: {
    sessionId: string;
    /** Resolves/rejects the session creation the turn is blocked on. */
    onCreateSession?: (
      config: {
        onPresencePhase?: (phase: SessionActivePresencePhase, detail?: string) => void;
      },
      attempt: number
    ) => Promise<unknown>;
    stallBudgetsMs?: Record<string, number>;
  }) => {
    const presenceEvents: PresenceEvent[] = [];
    let nowMs = 1_000_000;
    // Drain the controlled timer/microtask boundary without wall-clock sleeps.
    const settle = async () => {
      await vi.advanceTimersByTimeAsync(0);
    };
    const advance = async (ms: number) => {
      nowMs += ms;
      vi.advanceTimersByTime(ms);
      await settle();
    };

    let history: Array<Record<string, unknown>> = [
      { id: 'turn-user-1', role: 'user', status: 'pending', read: false },
    ];
    const sessionDoc = withHistoryPort({
      getMetaState: vi.fn(async () => ({ isArchived: false })),
      setStatus: vi.fn(async () => {}),
      setProject: vi.fn(async () => {}),
      setBaseBranch: vi.fn(async () => {}),
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
      roomId: `session-${options.sessionId}`,
    });

    const workspaceDocument = {
      repo: {
        upsertDocMeta: vi.fn(async () => {}),
        getDocMeta: vi.fn(async () => undefined),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      updateAcpCapabilities: vi.fn(async () => {}),
      // The presence sink the controller writes through.
      publishSessionPresence: (sessionId: string, _machineId: MachineId, status: SessionStatus) => {
        presenceEvents.push({ kind: 'publish', sessionId, status });
      },
      clearSessionPresence: (sessionId: string) => {
        presenceEvents.push({ kind: 'clear', sessionId });
      },
    } as unknown as LoroDocumentManager;

    let service!: SessionExecutionService;
    const presence = new SessionActivePresenceControllerLegacy(
      workspaceDocument,
      'machine-1' as MachineId,
      { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger,
      {
        intervalMs: 10_000,
        now: () => nowMs,
        ...(options.stallBudgetsMs ? { stallBudgetsMs: options.stallBudgetsMs } : {}),
      }
    );

    // Mirrors `SessionManager`'s real deduplication: `createSession` returns the
    // cached in-flight promise for a session id, and only the promise's own
    // `finally` clears it — so a create that never settles is handed to every
    // retry unless something detaches it.
    const pendingCreates = new Map<string, Promise<unknown>>();
    let createAttempts = 0;
    const createSession = async (config: {
      sessionId?: string;
      onPresencePhase?: (phase: SessionActivePresencePhase, detail?: string) => void;
    }) => {
      const id = config.sessionId ?? options.sessionId;
      const existing = pendingCreates.get(id);
      if (existing) return await existing;
      createAttempts += 1;
      const promise = (
        options.onCreateSession
          ? options.onCreateSession(config, createAttempts)
          : new Promise<unknown>(() => {})
      ).finally(() => {
        if (pendingCreates.get(id) === promise) pendingCreates.delete(id);
      });
      pendingCreates.set(id, promise);
      return await promise;
    };

    const deps = createBaseDeps({
      sessionManager: {
        getSession: vi.fn(() => null),
        getPendingSession: vi.fn((id: string) => pendingCreates.get(id) ?? null),
        createSession: vi.fn(createSession),
        abandonPendingSessionCreate: vi.fn((id: string) => pendingCreates.delete(id)),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: vi.fn(async () => {}),
      } as unknown as SessionManager,
      workspaceDocument,
      holdSessionActivePresence: (sessionId, phase) => presence.native.hold(sessionId, phase),
      setSessionActivePresencePhase: (
        sessionId: SessionId,
        phase: SessionActivePresencePhase | null,
        detail?: string
      ) => presence.setPhase(sessionId, phase, detail),
      clearSessionActivePresence: (sessionId: SessionId) => presence.clearUnleased(sessionId),
    });
    service = new SessionExecutionService(deps);

    const start = (userTurnId = 'turn-user-1') =>
      service.startSession({
        type: 'session/create',
        sessionId: options.sessionId as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        project: undefined,
        acpSessionConfig: { prompt: 'hi', cliType: 'builtin', agentType: 'codex' },
        userTurnId,
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      });

    return {
      advance,
      settle,
      deps,
      presenceEvents,
      service,
      sessionDoc,
      start,
      pendingCreates,
      appendUserTurn: (id: string) => {
        history = [...history, { id, role: 'user', status: 'pending', read: false }];
      },
      getHistory: () => history,
      heartbeatsFor: (sessionId: string) =>
        presenceEvents.filter((e) => e.kind === 'publish' && e.sessionId === sessionId),
    };
  };

  it('fails a turn whose initialization dependency never returns, and stops its presence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const harness = createDeadlineHarness({
        sessionId: 'session-stalled-init',
        // The observed production failure: a cloud identity lookup that never
        // settled, leaving createSession pending forever.
        onCreateSession: () => new Promise(() => {}),
      });
      const turn = harness.start();
      await harness.settle();

      // Well inside the 180s budget the turn is still initializing and still
      // heartbeating — the watchdog must not fire early.
      await harness.advance(170_000);
      expect(harness.getHistory()[0]?.status).toBe('processing');
      const heartbeatsBeforeStall = harness.heartbeatsFor('session-stalled-init').length;
      expect(heartbeatsBeforeStall).toBeGreaterThan(1);

      await harness.advance(20_000);
      await turn;

      // The user sees an explicit failure naming the stalled stage, not silence.
      expect(harness.deps.recordChatFailure).toHaveBeenCalledWith(
        harness.sessionDoc,
        'session_init_failed',
        expect.stringContaining('stopped making progress')
      );
      expect(harness.getHistory()[0]?.status).toBe('failed');
      expect(harness.sessionDoc.setStatus.mock.calls.at(-1)?.[0]).toEqual(
        SessionStatusFactory.idle()
      );

      // Presence is gone, and the 10s heartbeat that woke every subscriber for
      // 1h51m in production has stopped for good.
      expect(harness.presenceEvents.at(-1)).toEqual({
        kind: 'clear',
        sessionId: 'session-stalled-init',
      });
      const heartbeatsAtFailure = harness.heartbeatsFor('session-stalled-init').length;
      await harness.advance(600_000);
      expect(harness.heartbeatsFor('session-stalled-init').length).toBe(heartbeatsAtFailure);

      // The turn runtime is released, so the session stops counting as active
      // and becomes collectable again.
      expect(
        harness.service.getExecutionSnapshot('session-stalled-init' as SessionId).hasActiveTurn
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the retry after a stall start a fresh create instead of the wedged one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const promptStarted = createDeferred<void>();
      const promptDone = createDeferred<object>();
      let staleProgress: ((phase: SessionActivePresencePhase, detail?: string) => void) | undefined;
      const agentClient = {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
        prompt: vi.fn(async () => {
          promptStarted.resolve();
          return await promptDone.promise;
        }),
        currentModel: undefined,
      };
      const harness = createDeadlineHarness({
        sessionId: 'session-stall-then-retry',
        onCreateSession: (config, attempt) => {
          if (attempt === 1) staleProgress = config.onPresencePhase;
          // First attempt wedges forever; the second is a healthy create.
          return attempt === 1
            ? new Promise(() => {})
            : Promise.resolve({
                sessionId: 'session-stall-then-retry' as SessionId,
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
              });
        },
      });

      const stalledTurn = harness.start();
      await harness.settle();
      await harness.advance(190_000);
      await stalledTurn;

      expect(harness.getHistory()[0]?.status).toBe('failed');
      // The wedged create must not be left in the deduplication map, or the
      // retry below is handed the same promise and stalls again.
      expect(harness.pendingCreates.size).toBe(0);

      // Retrying is sending the message again. It has to actually run.
      harness.appendUserTurn('turn-user-2');
      const retryTurn = harness.start('turn-user-2');
      await harness.settle();
      await promptStarted.promise;
      staleProgress?.('managed-runtime', 'Synthetic stale progress');
      expect(harness.heartbeatsFor('session-stall-then-retry').at(-1)?.status).toEqual({
        type: 'running',
      });
      promptDone.resolve({});
      await retryTurn;

      expect(agentClient.prompt).toHaveBeenCalled();
      expect(harness.getHistory()[1]?.status).toBe('handled');
      // Only the first turn failed; the retry did not stall a second time.
      expect(harness.deps.recordChatFailure).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a stage that reports progress alive past its budget, and fails it once it goes silent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      let reportProgress!: (detail: string) => void;
      const harness = createDeadlineHarness({
        sessionId: 'session-runtime-download',
        // A managed-runtime download: the real SessionManager reports percent
        // through `onPresencePhase`, which is this stage's only progress signal.
        onCreateSession: (config) =>
          new Promise(() => {
            config.onPresencePhase?.('managed-runtime', 'Downloading Kimi runtime 1%');
            reportProgress = (detail) => config.onPresencePhase?.('managed-runtime', detail);
          }),
        stallBudgetsMs: { 'managed-runtime': 60_000 },
      });
      const turn = harness.start();
      await harness.settle();

      // A slow but healthy download: far past the 60s budget in wall-clock, yet
      // never silent for a whole budget, so it must survive.
      for (let percent = 2; percent <= 10; percent += 1) {
        await harness.advance(50_000);
        reportProgress(`Downloading Kimi runtime ${percent}%`);
      }
      expect(harness.getHistory()[0]?.status).toBe('processing');

      // Now the transfer wedges: no further progress for a full budget.
      await harness.advance(70_000);
      await turn;

      expect(harness.deps.recordChatFailure).toHaveBeenCalledWith(
        harness.sessionDoc,
        'session_init_failed',
        expect.stringContaining('Downloading Kimi runtime 10%')
      );
      expect(harness.getHistory()[0]?.status).toBe('failed');
      expect(harness.presenceEvents.at(-1)).toEqual({
        kind: 'clear',
        sessionId: 'session-runtime-download',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Operation Inbox execution boundary', () => {
  function inboxExecutionFixture(
    prompt: (blocks: ContentBlock[]) => Promise<unknown>,
    build?: (blocks: SessionInputBlock[]) => Promise<ContentBlock[]>,
    automaticFinished?: () => void,
    sessionId = 'inbox-session' as SessionId
  ) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-inbox-execution-'));
    const now = () => Date.parse('2026-10-12T00:00:00Z');
    const store = new LodyOperationStore(path.join(root, 'operations.sqlite3'), now);
    let meta: Partial<SessionMeta> = {
      id: sessionId,
      machineId: 'machine-1',
      userId: 'user-1',
      cliType: 'builtin',
      agentType: 'codex',
      agentConfigId: capabilityConfigId,
      isArchived: false,
    };
    const repo = {
      flush: async () => {},
      getDocMeta: async () => ({ meta }),
      upsertDocMeta: async (_id: string, patch: Partial<SessionMeta>) => {
        meta = { ...meta, ...patch };
      },
    };
    const doc = new SessionDocument(repo as never, sessionId, async () => {}, createSilentLogger());
    const config = {
      prompt: 'CURRENT_REQUEST',
      cliType: 'builtin' as const,
      agentType: 'codex',
      chainDepth: 0,
    };
    composeTestSessionDoc(doc, {
      history: [
        {
          id: 'human-input',
          role: 'user',
          userId: 'user-1',
          timestamp: '2026-10-12T00:00:00Z',
          status: 'pending',
          read: false,
          items: [{ type: 'text', text: 'CURRENT_REQUEST' }],
          inputConfig: config,
          finished: true,
          fileDiff: [],
        },
      ],
    });
    doc.waitUntilSynced = async () => {};
    let created = true;
    const client = {
      isCreated: () => created,
      cancel: async () => {},
      prompt: async (_id: unknown, blocks: ContentBlock[]) => prompt(blocks),
      currentModel: undefined,
    };
    const session = {
      sessionId,
      acpSessionId: 'acp-inbox' as ACPSessionId,
      agentClient: client,
      terminalManager: {},
      getWorkdir: () => '/tmp',
      getHostWorkdir: () => '/tmp',
      getParentSessionId: () => undefined,
      exec: async () => '',
      terminate: async () => {
        created = false;
      },
      updateGitIdentity: () => false,
      createAgent: async () => 'acp-inbox',
      applyExecutionPlaneLimits: async () => {},
      getAcpCapabilities: () => ({ modes: [], models: [] }),
    };
    let liveSession: typeof session | undefined = session;
    const deps = createBaseDeps({
      sessionManager: {
        getSession: () => liveSession,
        detachSession: (old: typeof session) => {
          if (liveSession === old) liveSession = undefined;
        },
        getPendingSession: () => null,
        createSession: vi.fn(),
        setSessionError: vi.fn(),
        terminateSession: vi.fn(),
        validateSessionCredentials: async () => {},
      } as never,
      workspaceDocument: {
        repo,
        getOrCreateSessionDoc: async () => doc,
        getOrOpenSessionCode: async () => null,
        updateAcpCapabilities: async () => {},
      } as never,
      beginConversationTurn: (_sid, id) => `assistant:${id}`,
      buildAcpPromptBlocks: async (args) =>
        build ? build(args.inputBlocks) : (args.inputBlocks as ContentBlock[]),
      createAssistantEntryForTurn: async (_sid, _doc, turnId, _model, parentId) => {
        await _doc.sessionData.commands.applyHistoryAction({
          kind: 'upsert-turn',
          turn: {
            id: turnId,
            role: 'assistant',
            userTurnId: parentId,
            timestamp: '2026-10-12T00:00:00Z',
            items: [{ type: 'text', text: 'response' }],
            fileDiff: [],
            finished: false,
          },
        });
      },
      recordChatFailure: async (_doc, reason, message, code) => {
        await doc.sessionData.commands.applyHistoryAction({
          kind: 'upsert-turn',
          turn: {
            id: `failure:${(await (await createSessionBackend(doc)).readHistory()).length}`,
            role: 'system',
            timestamp: '2026-10-12T00:00:00Z',
            items: [
              {
                type: 'system_notice',
                name: 'chat_failed',
                meta: { reason, message, ...(code ? { code } : {}) },
              },
            ],
            fileDiff: [],
          },
        });
      },
    });
    const service = new SessionExecutionService(deps);
    store.inbox.activate('workspace-1', 'owner');
    const bridge = operationInboxLegacy({
      workspaceId: 'workspace-1',
      owner: 'owner',
      sql: store.inbox,
      ready: () => !!automaticFinished && !service.getExecutionSnapshot(sessionId).hasActiveTurn,
      admit: () => true,
      launch: async (batch) => {
        await service.continueSession(
          {
            ...message,
            userTurnId: batch.inputId,
            acpSessionConfig: {
              ...config,
              prompt: 'Review attached completed results',
              chainDepth: batch.chainDepth,
            },
          },
          { dispatchSource: 'inbox', inboxBatch: batch }
        );
        automaticFinished?.();
      },
      report: () => {},
    });
    service.setOperationInbox(bridge, undefined, {
      originsForBatch: (batch) => store.notificationOriginsForBatch(batch),
      pendingOrigins: (scope, origins) => store.pendingNotificationOrigins(scope, origins),
    });
    const message = {
      type: 'session/chat' as const,
      sessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      acpSessionConfig: config,
      userTurnId: 'human-input',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    };
    const add = (
      id: string,
      depth = 0,
      origins: string[] = [],
      finish = true,
      userId = 'user-1'
    ) => {
      store.accept({
        workspaceId: 'workspace-1' as WorkspaceId,
        ownerMachineId: 'machine-1' as MachineId,
        requesterSessionId: sessionId,
        requesterUserId: userId,
        operationId: id,
        kind: 'session_chat',
        canonicalCommand: { id },
        frozenContinuationConfig: {
          inputConfig: { prompt: 'OBSOLETE_REQUEST' },
          sourceTurnId: 'older-source',
          notificationOriginTurnIds: origins,
        },
        initiatorChainDepth: depth,
        createdAt: '2026-10-11T00:00:00Z',
        deadlineAt: '2026-10-13T00:00:00Z',
        items: [],
      });
      if (finish) store.finish(sessionId, id, { type: 'result', value: { items: [] } });
    };
    const accept = () =>
      service.acceptInboxHumanInput({
        sessionId,
        inputId: 'human-input',
        userId: 'user-1',
        config,
      });
    const close = async () => {
      await service.drainInboxExecutions();
      await bridge.close();
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    };
    return {
      service,
      store,
      doc,
      session,
      client,
      deps,
      message,
      add,
      accept,
      close,
      wake: () => bridge.wake(),
      now,
      storePath: path.join(root, 'operations.sqlite3'),
    };
  }

  it('starts dispatch and executes ordinary human input when the Inbox database cannot open', async () => {
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(blocks);
      return { stopReason: 'end_turn' };
    });
    let watching = false;
    const dispatchWatcher = {
      start: async () => {
        watching = true;
      },
    };
    const coordinator = new LodyOperationCoordinator({
      workspaceId: f.message.workspaceId,
      machineId: f.message.machineId as MachineId,
      userId: f.message.userId,
      workspaceDocument: f.deps.workspaceDocument,
      executionService: f.service,
      dispatchWatcher: dispatchWatcher as never,
      logger: createSilentLogger(),
      storeFactory: () => {
        throw new Error('SQLITE_FULL');
      },
      materializeTarget: async () => {
        throw new Error('must not materialize while degraded');
      },
    });
    try {
      await MessageHandler.prototype.startSessionDispatchWatcher.call({
        sessionDispatchWatcher: dispatchWatcher,
        operationCoordinator: coordinator,
      } as never);
      expect(watching).toBe(true);
      await f.accept();
      await f.service.continueSession(f.message);
      expect(
        received
          .flat()
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
      ).toEqual(['CURRENT_REQUEST']);
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      const history = await (await createSessionBackend(f.doc)).readHistory();
      expect(history.find((turn) => turn.id === 'human-input')?.status).toBe('handled');
      expect(
        history.some((turn) => turn.role === 'assistant' && turn.userTurnId === 'human-input')
      ).toBe(true);
    } finally {
      await coordinator.stop();
      await f.close();
    }
  });

  it('preserves a live execution while a later input waits', async () => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(blocks);
      started.resolve();
      await finish.promise;
      return { stopReason: 'end_turn' };
    });
    let running: Promise<unknown> | undefined;
    try {
      await f.accept();
      running = f.service.continueSession(f.message);
      await started.promise;
      const before = f.store.inbox.activeExecution('workspace-1', f.message.sessionId);
      await f.service.continueSession({ ...f.message, userTurnId: 'waiting-input' });
      expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toEqual(before);
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(true);
      const notices = (await (await createSessionBackend(f.doc)).readHistory())
        .flatMap((turn) => turn.items ?? [])
        .filter((item) => item.type === 'system_notice' && item.name === 'chat_failed');
      expect(notices).toEqual([]);
      expect(received).toEqual([[{ type: 'text', text: 'CURRENT_REQUEST' }]]);
    } finally {
      finish.resolve();
      await running;
      await f.close();
    }
  });

  it('does not retire a live Inbox execution when admission registers a replacement runtime', async () => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(structuredClone(blocks));
      if (received.length === 1) {
        started.resolve();
        await finish.promise;
      }
      return { stopReason: 'end_turn' };
    });
    let running: Promise<unknown> | undefined;
    try {
      await f.accept();
      running = f.service.continueSession(f.message);
      await started.promise;
      const prior = f.store.inbox.activeExecution('workspace-1', f.message.sessionId);
      expect(prior).toMatchObject({ executionId: 'assistant:human-input', inputId: 'human-input' });
      // Retire only the facade registration; transport and the SQLite owner remain live.
      const internals = f.service as unknown as {
        releaseTurnRuntime(sessionId: SessionId, turnId: string): void;
      };
      internals.releaseTurnRuntime(f.message.sessionId, 'assistant:human-input');
      const config = { ...f.message.acpSessionConfig, prompt: 'WAITING_REQUEST' };
      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: {
          id: 'waiting-input',
          role: 'user',
          userId: 'user-1',
          status: 'pending',
          inputConfig: config,
          timestamp: '2026-10-29T00:00:00Z',
          items: [{ type: 'text', text: config.prompt }],
          fileDiff: [],
          finished: true,
        },
      });
      await f.service.acceptInboxHumanInput({
        sessionId: f.message.sessionId,
        inputId: 'waiting-input',
        userId: 'user-1',
        config,
      });
      const attempt = await f.service
        .continueSession({ ...f.message, userTurnId: 'waiting-input', acpSessionConfig: config })
        .catch((cause: unknown) => cause);
      expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toEqual(prior);
      expect(received).toEqual([[{ type: 'text', text: 'CURRENT_REQUEST' }]]);
      expect(attempt).toBeInstanceOf(InboxExecutionRejected);
      finish.resolve();
      await running;
      await f.service.continueSession({
        ...f.message,
        userTurnId: 'waiting-input',
        acpSessionConfig: config,
      });
      expect(received).toEqual([
        [{ type: 'text', text: 'CURRENT_REQUEST' }],
        [{ type: 'text', text: 'WAITING_REQUEST' }],
      ]);
    } finally {
      finish.resolve();
      await running;
      await f.close();
    }
  });

  it('retires a crashed input without replay and closes its leftover assistant entry', async () => {
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(blocks);
      return { stopReason: 'end_turn' };
    });
    try {
      const old = {
        workspaceId: 'workspace-1',
        sessionId: f.message.sessionId,
        userId: 'user-1',
        inputId: f.message.userTurnId,
        kind: 'task' as const,
        config: f.message.acpSessionConfig,
      };
      expect(f.store.inbox.accept(old)).toBe(true);
      expect(f.store.inbox.begin(old, 'assistant:human-input')).toBe(true);
      // The crashed run left its assistant entry open.
      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: {
          id: 'assistant:human-input',
          role: 'assistant',
          userTurnId: 'human-input',
          timestamp: '2026-10-12T00:00:01Z',
          items: [{ type: 'text', text: 'partial answer' }],
          fileDiff: [],
        },
      });
      // Restart retires the interrupted input and records its unknown outcome.
      f.store.inbox.activate('workspace-1', 'owner');
      await f.service.continueSession(f.message);
      // The rejected run settles its input, so nothing owns the leftover entry any more.
      const backend = await createSessionBackend(f.doc);
      expect((await backend.readTurn('human-input')).turn).toMatchObject({ status: 'failed' });
      expect((await backend.readTurn('assistant:human-input')).turn).toMatchObject({
        finished: true,
        endedAt: expect.any(Number),
      });
      expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, old.inputId)).toBe(true);
      const db = new Database(f.storePath);
      try {
        expect(
          db
            .prepare(
              'SELECT active_execution,active_input,blocked FROM inbox_sessions WHERE session_id=?'
            )
            .get(f.message.sessionId)
        ).toEqual({
          active_execution: null,
          active_input: null,
          blocked: 0,
        });
        expect(
          db
            .prepare('SELECT outcome FROM inbox_releases WHERE session_id=?')
            .all(f.message.sessionId)
        ).toEqual([{ outcome: 'failed' }]);
      } finally {
        db.close();
      }
      expect(received).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('notifies once after five children, partial summaries and a follow-up delegation finish', async () => {
    const summaries = [createDeferred<void>(), createDeferred<void>(), createDeferred<void>()];
    let summaryCount = 0;
    let promptCount = 0;
    const facts: TurnOutcomeFact[] = [];
    const f = inboxExecutionFixture(
      async () => {
        promptCount++;
        const invocation = f.service.getActiveInvocationContext(f.message.sessionId)!;
        expect(invocation.notificationOriginTurnIds).toEqual(['human-input']);
        if (promptCount === 1) {
          for (let i = 0; i < 5; i++)
            f.add(`child-${i}`, 0, invocation.notificationOriginTurnIds, false);
        } else if (promptCount === 3) {
          f.add('follow-up', 1, invocation.notificationOriginTurnIds, false);
        }
        return { stopReason: 'end_turn' };
      },
      undefined,
      () => summaries[summaryCount++]!.resolve()
    );
    f.deps.turnFinalization.onTurnOutcome = async (fact) => {
      // Success is published only after the consumed batch is durably settled.
      expect(f.store.inbox.historyReceipts('workspace-1').every((b) => b.state === 'settled')).toBe(
        true
      );
      facts.push(fact);
    };
    const finish = (id: string) =>
      f.store.finish(f.message.sessionId, id, { type: 'result', value: { items: [] } });
    try {
      await f.accept();
      await f.service.continueSession(f.message, { notificationAudience: { kind: 'user' } });
      expect(facts).toEqual([]);
      finish('child-0');
      await f.wake();
      await summaries[0]!.promise;
      expect(facts).toEqual([]);
      for (let i = 1; i < 5; i++) finish(`child-${i}`);
      await f.wake();
      await summaries[1]!.promise;
      expect(facts).toEqual([]);
      finish('follow-up');
      await f.wake();
      await summaries[2]!.promise;
      expect(promptCount).toBe(4);
      await f.service.drainInboxExecutions();
      expect(facts).toEqual([
        expect.objectContaining({ audience: { kind: 'user' }, outcome: { kind: 'succeeded' } }),
      ]);
      expect(facts[0]!.turnId).not.toBe('human-input');
      expect(facts[0]!.originTurnIds).toEqual(['human-input']);
    } finally {
      await f.close();
    }
  });

  it.each([false, true])(
    'keeps delegated summaries silent and surfaces user summary errors (user=%s)',
    async (human) => {
      const complete = createDeferred<void>();
      let prompts = 0;
      const facts: TurnOutcomeFact[] = [];
      const f = inboxExecutionFixture(
        async () => {
          if (++prompts === 1) {
            const origins = f.service.getActiveInvocationContext(
              f.message.sessionId
            )!.notificationOriginTurnIds;
            f.add('child', 0, origins, false);
            f.add('still-pending', 0, origins, false);
          } else throw new Error('summary failed');
          return { stopReason: 'end_turn' };
        },
        undefined,
        () => complete.resolve()
      );
      f.deps.turnFinalization.onTurnOutcome = async (fact) => {
        facts.push(fact);
      };
      try {
        await f.accept();
        await f.service.continueSession(f.message, {
          notificationAudience: human
            ? { kind: 'user' }
            : { kind: 'agent', sessionId: 'caller' as SessionId, turnId: 'caller-turn' },
        });
        expect(facts.flatMap((fact) => projectTurnAttention(fact) ?? [])).toEqual([]);
        f.store.finish(f.message.sessionId, 'child', { type: 'result', value: { items: [] } });
        await f.wake();
        await complete.promise;
        const attention = facts.flatMap((fact) => projectTurnAttention(fact) ?? []);
        expect(attention).toEqual(human ? [expect.objectContaining({ outcome: 'failed' })] : []);
      } finally {
        await f.close();
      }
    }
  );

  it('binds inherited origins to their recipient and checks the new requester after steer', async () => {
    const started = createDeferred<void>();
    const originalDone = createDeferred<unknown>();
    const steerDone = createDeferred<unknown>();
    const f = inboxExecutionFixture(async () => {
      started.resolve();
      return await originalDone.promise;
    });
    Object.assign(f.client, {
      getAcknowledgedSteerCapability: () => ({
        provider: 'claudeCode',
        appliedNotificationMethod: 'claude/steerApplied',
        upstreamTurn: 'handoff',
        configPolicy: 'apply',
      }),
      steerPrompt: () => ({
        completion: steerDone.promise,
        outcome: Promise.resolve({
          outcome: 'applied',
          application: { steerId: 'steer', release: () => {} },
        }),
      }),
    });
    const facts: TurnOutcomeFact[] = [];
    f.deps.turnFinalization.onTurnOutcome = async (fact) => {
      facts.push(fact);
    };
    try {
      f.add('old-user-result', 0, ['old-user-request']);
      await f.accept();
      const running = f.service.continueSession(f.message, {
        notificationAudience: { kind: 'user' },
      });
      await started.promise;
      const source = (await (await createSessionBackend(f.doc)).readHistory())[0]!;
      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: { ...source, id: 'steer-input', userId: 'user-2', status: 'pending' },
      });
      expect(
        await f.service.steerSession({
          sessionId: f.message.sessionId,
          expectedTurnId: 'assistant:human-input',
          userTurnId: 'steer-input',
          userId: 'user-2',
          timestamp: '2026-10-12T00:00:00Z',
          inputConfig: f.message.acpSessionConfig,
        })
      ).toMatchObject({ applied: true });
      f.service.setTurnNotificationAudience(f.message.sessionId, 'steer-input', { kind: 'user' });
      expect(f.service.getActiveInvocationContext(f.message.sessionId)).toMatchObject({
        requesterUserId: 'user-2',
        notificationOriginTurnIds: ['steer-input'],
      });
      f.add('new-user-child', 0, ['steer-input'], false, 'user-2');
      originalDone.resolve({ stopReason: 'end_turn' });
      steerDone.resolve({ stopReason: 'end_turn' });
      await running;
      expect(facts).toEqual([]);
    } finally {
      originalDone.resolve({});
      steerDone.resolve({});
      await f.close();
    }
  });

  it('releases before a stalled batch history projection and keeps the committed outcome', async () => {
    const settling = createDeferred<void>();
    const settle = createDeferred<void>();
    const f = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
    const apply = f.doc.sessionData.commands.applyHistoryAction.bind(f.doc.sessionData.commands);
    vi.spyOn(f.doc.sessionData.commands, 'applyHistoryAction').mockImplementation(
      async (action) => {
        if (action.kind === 'operation-batch-status' && action.status === 'settled') {
          settling.resolve();
          await settle.promise;
        }
        return await apply(action);
      }
    );
    const facts: TurnOutcomeFact[] = [];
    f.deps.turnFinalization.onTurnOutcome = async (fact) => {
      facts.push(fact);
    };
    try {
      f.add('result', 0, ['human-input']);
      await f.accept();
      const running = f.service.continueSession(f.message, {
        notificationAudience: { kind: 'user' },
      });
      await settling.promise;
      expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
        true
      );
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      await f.service.cancelSession({
        sessionId: f.message.sessionId,
        turnId: 'assistant:human-input',
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
      });
      settle.resolve();
      await running;
      expect(facts.map((fact) => fact.outcome)).toEqual([{ kind: 'succeeded' }]);
      expect(facts.flatMap((fact) => projectTurnAttention(fact) ?? [])).toHaveLength(1);
    } finally {
      settle.resolve();
      await f.close();
    }
  });

  it('publishes unread and success only after finalization, release and history sync', async () => {
    const finalizing = createDeferred<void>();
    const finalized = createDeferred<void>();
    const confirming = createDeferred<void>();
    const synced = createDeferred<boolean>();
    const f = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
    let presence = false;
    const facts: TurnOutcomeFact[] = [];
    f.deps.startSessionActivePresence = () => {
      presence = true;
    };
    f.deps.clearSessionActivePresence = () => {
      presence = false;
    };
    f.deps.workspaceDocument.getRemoteStreamsGeneration = () => 1;
    f.doc.waitUntilSynced = async () => {
      confirming.resolve();
      return synced.promise;
    };
    f.deps.turnFinalization.finalizeACPState = async (_id, turnId) => {
      finalizing.resolve();
      await finalized.promise;
      await (
        await createSessionBackend(f.doc)
      ).applyHistoryAction({ kind: 'finish-assistant', turnId, endedAt: 100 });
    };
    f.deps.turnFinalization.onTurnOutcome = async (fact) => {
      expect(presence).toBe(false);
      facts.push(fact);
    };
    try {
      await f.accept();
      const running = f.service.continueSession(f.message, {
        notificationAudience: { kind: 'user' },
      });
      await finalizing.promise;
      expect(presence).toBe(true);
      expect((await f.doc.getMetaState())?.lastMessageAt).toBeUndefined();
      finalized.resolve();
      await confirming.promise;
      await running;
      expect(presence).toBe(false);
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      expect((await f.doc.getMetaState())?.lastMessageAt).toBeUndefined();
      expect(facts).toEqual([]);
      synced.resolve(true);
      await f.service.drainInboxExecutions();
      expect((await f.doc.getMetaState())?.lastMessageAt).toEqual(expect.any(Number));
      expect(facts.map((fact) => fact.outcome)).toEqual([{ kind: 'succeeded' }]);
    } finally {
      finalized.resolve();
      synced.resolve(true);
      await f.close();
    }
  });

  it('history finalization failure releases the slot and emits failure attention without unread success', async () => {
    const f = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
    const facts: TurnOutcomeFact[] = [];
    f.deps.turnFinalization.finalizeACPState = async () => {
      throw new Error('history storage unavailable');
    };
    f.deps.turnFinalization.onTurnOutcome = async (fact) => {
      facts.push(fact);
    };
    try {
      await f.accept();
      await f.service.continueSession(f.message, { notificationAudience: { kind: 'user' } });
      await f.service.drainInboxExecutions();
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      expect(facts.map((fact) => fact.outcome.kind)).toEqual(['failed']);
      expect((await f.doc.getMetaState())?.lastMessageAt).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it('shutdown ends a pending sync waiter and late sync cannot publish completion', async () => {
    const confirming = createDeferred<void>();
    const synced = createDeferred<boolean>();
    const f = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
    const facts: TurnOutcomeFact[] = [];
    f.deps.workspaceDocument.getRemoteStreamsGeneration = () => 1;
    f.doc.waitUntilSynced = async () => {
      confirming.resolve();
      return synced.promise;
    };
    f.deps.turnFinalization.onTurnOutcome = async (fact) => {
      facts.push(fact);
    };
    try {
      await f.accept();
      await f.service.continueSession(f.message, { notificationAudience: { kind: 'user' } });
      await confirming.promise;
      f.service.stopCompletionPublication();
      await f.service.drainInboxExecutions();
      synced.resolve(true);
      expect(facts).toEqual([]);
      expect((await f.doc.getMetaState())?.lastMessageAt).toBeUndefined();
    } finally {
      synced.resolve(true);
      await f.close();
    }
  });

  it('releases the execution slot while a notification transport is still pending', async () => {
    const sending = createDeferred<void>();
    const delivered = createDeferred<void>();
    const f = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
    f.deps.turnFinalization.onTurnOutcome = async () => {
      sending.resolve();
      await delivered.promise;
    };
    try {
      await f.accept();
      const running = f.service.continueSession(f.message, {
        notificationAudience: { kind: 'user' },
      });
      await sending.promise;
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      expect(f.store.hasPendingWorkForRequester(f.message.workspaceId, f.message.sessionId)).toBe(
        false
      );
      await running;
      delivered.resolve();
    } finally {
      delivered.resolve();
      await f.close();
    }
  });

  it('runs the next automatic batch while the previous batch notification is still sending', async () => {
    const sending = createDeferred<void>();
    const delivered = createDeferred<void>();
    const secondSent = createDeferred<void>();
    const secondPrompt = createDeferred<void>();
    const secondBatchDone = createDeferred<void>();
    let prompts = 0;
    let batches = 0;
    const f = inboxExecutionFixture(
      async () => {
        if (++prompts === 2) secondPrompt.resolve();
        return { stopReason: 'end_turn' };
      },
      undefined,
      () => {
        if (++batches === 2) secondBatchDone.resolve();
      }
    );
    let sends = 0;
    f.deps.turnFinalization.onTurnOutcome = async () => {
      if (++sends === 1) {
        sending.resolve();
        await delivered.promise;
      } else {
        secondSent.resolve();
      }
    };
    try {
      f.add('first', 0, ['request-a']);
      await f.wake();
      await sending.promise;
      f.add('second', 0, ['request-b']);
      await f.wake();
      await secondPrompt.promise;
      await secondBatchDone.promise;
      await secondSent.promise;
      expect(sends).toBe(2);
      delivered.resolve();
      await f.service.drainInboxExecutions();
    } finally {
      delivered.resolve();
      await f.close();
    }
  });

  it('continues actual work when notification provenance cannot be read', async () => {
    const prompt = vi.fn(async () => ({ stopReason: 'end_turn' }));
    const f = inboxExecutionFixture(prompt);
    vi.spyOn(f.store, 'notificationOriginsForBatch').mockImplementation(() => {
      throw new Error('notification lookup unavailable');
    });
    const facts: TurnOutcomeFact[] = [];
    f.deps.turnFinalization.onTurnOutcome = async (fact) => {
      facts.push(fact);
    };
    try {
      f.add('result', 0, ['old-request']);
      await f.accept();
      await f.service.continueSession(f.message);
      expect(prompt).toHaveBeenCalledOnce();
      expect(facts.flatMap((fact) => projectTurnAttention(fact) ?? [])).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('keeps an access-unverified input pending so the access retry executes it once', async () => {
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(structuredClone(blocks));
      return { stopReason: 'end_turn' };
    });
    try {
      await f.accept();
      const dispatch = (access: MachineAccessVerification) => {
        const onAccessIndeterminate = vi.fn(async () => {});
        return {
          onAccessIndeterminate,
          run: f.service.dispatchPreparedSessionTurn({
            sessionId: f.message.sessionId,
            sessionDoc: f.doc,
            userTurnId: 'human-input',
            invocation: {
              sourceTurnId: 'human-input',
              requesterUserId: 'user-1',
              inputConfig: f.message.acpSessionConfig,
            },
            dispatchSource: 'crdt',
            accessPromise: Promise.resolve(access),
            requestPromise: Promise.resolve({ mode: 'continue' as const, request: f.message }),
            onAccessAllowed: async () => {},
            onAccessDenied: async () => {},
            onAccessIndeterminate,
          }),
        };
      };
      const backend = await createSessionBackend(f.doc);
      const status = async () =>
        (await backend.readHistory()).find((turn) => turn.id === 'human-input')?.status;

      // A network blip during verification leaves both the turn and its input pending.
      const offline = dispatch({
        outcome: 'indeterminate',
        cause: 'network',
        error: 'fetch failed',
      });
      await offline.run;
      expect(offline.onAccessIndeterminate).toHaveBeenCalledTimes(1);
      expect(received).toEqual([]);
      expect(
        findNextDispatchableUserTurn(await backend.readHistory(), {
          id: f.message.sessionId,
        } as SessionMeta)?.id
      ).toBe('human-input');
      expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
        false
      );
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);

      // The retry reuses the same execution id and is admitted, not rejected.
      await dispatch({ outcome: 'allowed' }).run;
      expect(received).toEqual([[{ type: 'text', text: 'CURRENT_REQUEST' }]]);
      expect(await status()).toBe('handled');
      expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
        true
      );
    } finally {
      await f.close();
    }
  });

  it('retires a pending turn whose Inbox input already ended so later messages run', async () => {
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(structuredClone(blocks));
      return { stopReason: 'end_turn' };
    });
    try {
      await f.accept();
      const input = {
        workspaceId: 'workspace-1',
        sessionId: f.message.sessionId,
        userId: 'user-1',
        inputId: 'human-input',
        kind: 'human' as const,
        config: f.message.acpSessionConfig,
      };
      // State left by daemons before the withdraw fix: the input ended while its
      // user turn stayed pending in history.
      expect(f.store.inbox.begin(input, 'assistant:human-input')).toBe(true);
      f.store.inbox.release({ ...input, executionId: 'assistant:human-input', outcome: 'failed' });

      await expect(f.service.continueSession(f.message)).resolves.toBeUndefined();
      const backend = await createSessionBackend(f.doc);
      const old = (await backend.readHistory()).find((turn) => turn.id === 'human-input');
      expect(old).toMatchObject({ status: 'failed' });
      if (!old) throw new Error('Missing original human input');
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      expect(received).toEqual([]);

      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: {
          ...old,
          id: 'next-human',
          status: 'pending',
          items: [{ type: 'text', text: 'NEXT_REQUEST' }],
        },
      });
      const history = await backend.readHistory();
      expect(
        findNextDispatchableUserTurn(history, { id: f.message.sessionId } as SessionMeta)?.id
      ).toBe('next-human');
      await f.service.acceptInboxHumanInput({
        sessionId: f.message.sessionId,
        inputId: 'next-human',
        userId: 'user-1',
        config: { ...f.message.acpSessionConfig, prompt: 'NEXT_REQUEST' },
      });
      await f.service.continueSession({
        ...f.message,
        userTurnId: 'next-human',
        acpSessionConfig: { ...f.message.acpSessionConfig, prompt: 'NEXT_REQUEST' },
      });
      expect(received).toEqual([[{ type: 'text', text: 'NEXT_REQUEST' }]]);
    } finally {
      await f.close();
    }
  });

  it.each(['cleanup-ok', 'cleanup-failed', 'admission-retry', 'persistent'] as const)(
    'retires a rolled-back release without replaying old input (%s)',
    async (mode) => {
      const received: ContentBlock[][] = [];
      const prompt = async (blocks: ContentBlock[]) => {
        received.push(structuredClone(blocks));
        return { stopReason: 'end_turn' };
      };
      const f = inboxExecutionFixture(prompt);
      const db = new Database(f.storePath);
      const backgroundCanRelease = mode.startsWith('cleanup');
      if (mode === 'cleanup-failed')
        f.session.terminate = async () => {
          throw new Error('terminate failed');
        };
      const replacement = {
        ...f.session,
        acpSessionId: 'replacement-acp',
        agentClient: {
          ...f.client,
          isCreated: () => true,
          prompt: async (_id: unknown, blocks: ContentBlock[]) => prompt(blocks),
        },
        createAgent: async () => 'replacement-acp',
        terminate: async () => {},
      };
      Object.assign(f.deps.sessionManager, { createSession: async () => replacement });
      const send = async (inputId: string) => {
        const config = { ...f.message.acpSessionConfig, prompt: 'FRESH_REQUEST' };
        await f.doc.sessionData.commands.applyHistoryAction({
          kind: 'upsert-turn',
          turn: {
            id: inputId,
            role: 'user',
            userId: 'user-1',
            status: 'pending',
            inputConfig: config,
            timestamp: '2026-10-29T00:00:00Z',
            items: [{ type: 'text', text: config.prompt }],
            fileDiff: [],
            finished: true,
          },
        });
        await f.service.acceptInboxHumanInput({
          sessionId: f.message.sessionId,
          inputId,
          userId: 'user-1',
          config,
        });
        return f.service.continueSession({
          ...f.message,
          userTurnId: inputId,
          acpSessionConfig: config,
        });
      };
      try {
        f.add('captured-before-outage');
        await f.accept();
        // ROLLBACK models SQLITE_FULL aborting the whole transaction, not just one statement.
        db.exec(`CREATE TRIGGER release_outage BEFORE UPDATE ON inbox_sessions
          WHEN OLD.active_execution='assistant:human-input' AND NEW.active_execution IS NULL
          ${backgroundCanRelease ? "AND EXISTS(SELECT 1 FROM inbox_releases WHERE execution_id=OLD.active_execution AND outcome='normal')" : ''}
          BEGIN SELECT RAISE(ROLLBACK,'SQLITE_FULL'); END;`);
        await f.service.continueSession(f.message);
        await f.service.drainInboxExecutions();
        expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
        const active = () =>
          db
            .prepare('SELECT active_execution FROM inbox_sessions WHERE session_id=?')
            .get(f.message.sessionId);
        expect(active()).toEqual({
          active_execution: backgroundCanRelease ? null : 'assistant:human-input',
        });
        if (mode === 'persistent') {
          await expect(send('rejected-input')).rejects.toBeInstanceOf(InboxExecutionRejected);
          const notices = (await (await createSessionBackend(f.doc)).readHistory())
            .flatMap((turn) => turn.items ?? [])
            .filter((item) => item.type === 'system_notice' && item.name === 'chat_failed');
          expect(notices).toMatchObject([
            { meta: { message: expect.stringContaining('the disk may be full') } },
          ]);
          expect(received).toHaveLength(1);
        }
        db.exec('DROP TRIGGER release_outage');
        await send('fresh-input');
        expect(received).toHaveLength(2);
        expect(received[1]).toEqual([{ type: 'text', text: 'FRESH_REQUEST' }]);
        expect(active()).toEqual({ active_execution: null });
        expect(
          f.store.inbox.inputEnded('workspace-1', f.message.sessionId, f.message.userTurnId)
        ).toBe(true);
        expect(
          (await (await createSessionBackend(f.doc)).readTurn('fresh-input')).turn
        ).toMatchObject({ status: 'handled' });
        expect(f.store.inbox.historyReceipts('workspace-1')).toMatchObject([
          { state: 'settled', memberCount: 1 },
        ]);
      } finally {
        db.exec('DROP TRIGGER IF EXISTS release_outage');
        db.close();
        await f.close();
      }
    }
  );

  it('retires a failed Inbox preparation even when its release transaction rolls back', async () => {
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(structuredClone(blocks));
      return { stopReason: 'end_turn' };
    });
    const db = new Database(f.storePath);
    try {
      f.add('result-before-prepare-failure');
      await f.accept();
      // Fail only after begin committed, then roll back the compensating release too.
      db.exec(`CREATE TRIGGER prepare_outage BEFORE INSERT ON inbox_batches
        WHEN NEW.input_id='human-input' AND EXISTS(
          SELECT 1 FROM inbox_sessions WHERE active_execution='assistant:human-input')
        BEGIN SELECT RAISE(ROLLBACK,'prepare failed'); END;
        CREATE TRIGGER release_outage BEFORE UPDATE ON inbox_sessions
        WHEN OLD.active_execution='assistant:human-input' AND NEW.active_execution IS NULL
        BEGIN SELECT RAISE(ROLLBACK,'SQLITE_FULL'); END;`);
      await expect(f.service.continueSession(f.message)).rejects.toThrow('prepare failed');
      expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toMatchObject({
        executionId: 'assistant:human-input',
        inputId: 'human-input',
      });
      expect(received).toEqual([]);
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);

      db.exec('DROP TRIGGER prepare_outage; DROP TRIGGER release_outage;');
      const config = { ...f.message.acpSessionConfig, prompt: 'FRESH_REQUEST' };
      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: {
          id: 'fresh-input',
          role: 'user',
          userId: 'user-1',
          status: 'pending',
          inputConfig: config,
          timestamp: '2026-10-30T00:00:00Z',
          items: [{ type: 'text', text: config.prompt }],
          fileDiff: [],
          finished: true,
        },
      });
      await f.service.acceptInboxHumanInput({
        sessionId: f.message.sessionId,
        inputId: 'fresh-input',
        userId: 'user-1',
        config,
      });
      await f.service.continueSession({
        ...f.message,
        userTurnId: 'fresh-input',
        acpSessionConfig: config,
      });
      expect(received).toHaveLength(1);
      expect(received[0]?.[0]).toEqual({ type: 'text', text: 'FRESH_REQUEST' });
      expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
        true
      );
      const backend = await createSessionBackend(f.doc);
      expect((await backend.readTurn('fresh-input')).turn).toMatchObject({ status: 'handled' });
      expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toBeUndefined();
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      await f.service.continueSession(f.message);
      expect((await backend.readTurn('human-input')).turn).toMatchObject({ status: 'failed' });
      expect(received).toHaveLength(1);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS prepare_outage; DROP TRIGGER IF EXISTS release_outage;');
      db.close();
      await f.close();
    }
  });

  it('detaches a failed Agent, continues with a new ACP and reports cleanup without blocking drain', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const started = createDeferred<void>();
    const raw = createDeferred<void>();
    const received: string[] = [];
    const f = inboxExecutionFixture(async () => {
      received.push('old');
      started.resolve();
      await raw.promise;
      return { stopReason: 'end_turn' };
    });
    const cleanupStarted = createDeferred<void>();
    f.session.terminate = async () => {
      cleanupStarted.resolve();
      throw new Error('Synthetic termination failure');
    };
    Object.defineProperty(f.client, 'pendingPromptCompletion', { get: () => raw.promise });
    const notices: string[] = [];
    f.deps.recordSessionStopFailure = async (_sid, _turnId, failure) => {
      notices.push(failure.message);
    };
    const replacement = {
      ...f.session,
      acpSessionId: 'new-acp',
      agentClient: {
        ...f.client,
        prompt: async () => {
          received.push('new');
          return { stopReason: 'end_turn' };
        },
      },
      createAgent: async () => 'new-acp',
      terminate: async () => {},
    };
    Object.assign(f.deps.sessionManager, { createSession: async () => replacement });
    try {
      await f.accept();
      const running = f.service.continueSession(f.message);
      await started.promise;
      await f.service.cancelSession({
        type: 'session/cancel',
        sessionId: f.message.sessionId,
        machineId: f.message.machineId,
        workspaceId: f.message.workspaceId,
        turnId: 'assistant:human-input',
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await cleanupStarted.promise;
      await running;
      expect(f.deps.sessionManager.getSession(f.message.sessionId)).toBeUndefined();
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      expect(notices).toContainEqual(expect.stringContaining('termination failure'));
      await expect(f.service.drainInboxExecutions()).resolves.toBeUndefined();
      const next = { ...f.message, userTurnId: 'fresh-human' };
      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: {
          id: next.userTurnId,
          role: 'user',
          status: 'pending',
          userId: 'user-1',
          timestamp: '2026-10-12T00:00:01Z',
          inputConfig: f.message.acpSessionConfig,
          items: [{ type: 'text', text: 'FRESH' }],
          fileDiff: [],
          finished: true,
        },
      });
      await f.service.acceptInboxHumanInput({
        sessionId: next.sessionId,
        inputId: next.userTurnId,
        userId: 'user-1',
        config: next.acpSessionConfig,
      });
      await f.service.continueSession(next);
      expect(received).toEqual(['old', 'new']);
      expect(
        (await (await createSessionBackend(f.doc)).readTurn(next.userTurnId)).turn
      ).toMatchObject({ status: 'handled' });
    } finally {
      raw.resolve();
      await f.close();
      vi.useRealTimers();
    }
  });

  it('releases an Inbox turn whose failure handling also fails, so the next input runs', async () => {
    // Regression: a document that stops accepting status writes mid-turn made the
    // failure handler throw too. That skipped the Inbox release, leaked the turn
    // registration, and refused every later input as `active-session` forever.
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(structuredClone(blocks));
      return { stopReason: 'end_turn' };
    });
    const setStatus = f.doc.setStatus.bind(f.doc);
    let statusWritesFail = true;
    f.doc.setStatus = async (status) => {
      if (statusWritesFail) throw new Error('Mirror not initialized');
      await setStatus(status);
    };
    try {
      await f.accept();
      await f.service.continueSession(f.message).catch(() => undefined);
      expect(received).toHaveLength(0);
      expect(f.service.getExecutionSnapshot(f.message.sessionId)).toMatchObject({
        hasActiveTurn: false,
      });
      expect(f.service.getExecutionSnapshot(f.message.sessionId).releaseBlocked).toBeUndefined();

      // The agent process is kept for reuse; only the turn's ownership was released.
      expect(f.client.isCreated()).toBe(true);

      statusWritesFail = false;
      const next = { ...f.message, userTurnId: 'later-human' };
      await f.service.acceptInboxHumanInput({
        sessionId: next.sessionId,
        inputId: next.userTurnId,
        userId: 'user-1',
        config: next.acpSessionConfig,
      });
      await f.service.continueSession(next);
      expect(received).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  async function finishFirstThenRunNext(
    f: ReturnType<typeof inboxExecutionFixture>,
    first: Promise<unknown>,
    gate: ReturnType<typeof createDeferred<void>>,
    next: typeof f.message,
    published?: Promise<void>
  ) {
    await f.service.acceptInboxHumanInput({
      sessionId: next.sessionId,
      inputId: next.userTurnId,
      userId: 'user-1',
      config: next.acpSessionConfig,
    });
    // Exercise a successor immediately if admission has already been returned.
    const released = !f.service.getExecutionSnapshot(next.sessionId).hasActiveTurn;
    if (released) {
      await f.service.continueSession(next);
      await published;
    }
    gate.resolve();
    await first;
    if (!released) await f.service.continueSession(next);
  }

  it.each(['edit evidence', 'Git fallback'])(
    'keeps turn-one results before release (%s)',
    async (kind) => {
      const root = createGitLocalProject(),
        file = path.join(root, 'one.txt');
      const entered = createDeferred<void>(),
        finish = createDeferred<void>();
      let n = 0,
        captured: unknown;
      const f = inboxExecutionFixture(async () => {
        fs.writeFileSync(file, ++n === 1 ? 'TURN_ONE\n' : 'TURN_TWO\n');
        if (n === 2) fs.writeFileSync(path.join(root, 'two.txt'), 'second turn\n');
        return { stopReason: 'end_turn' };
      });
      f.session.getWorkdir = () => root;
      f.session.exec = async (_cmd, args) =>
        execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' });
      const post = new TurnPostProcessingService({
        logger: f.deps.logger,
        workspaceDocument: f.deps.workspaceDocument,
        workspaceId: f.deps.workspaceId,
        preferredBaseBranch: 'main',
        prAssociation: null,
      });
      f.deps.turnFinalization.updateSessionDiffStats = post.updateSessionDiffStats.bind(post);
      f.deps.turnFinalization.persistCodeCollabTurnDiffs = async (_id, turn) => {
        if (turn === 'assistant:human-input') {
          entered.resolve();
          await finish.promise;
          if (kind === 'edit evidence')
            captured = await pendingEventFromAgentEditEvidence({
              workspaceRoot: root,
              edit: { path: file, changeType: 'update', contentOldText: 'BASE\n' },
              latestText: { status: 'untracked' },
            });
        }
        return kind === 'edit evidence';
      };
      const message = {
        ...f.message,
        project: { kind: 'github' as const, repoFullName: 'owner/repo', branch: 'main' },
      };
      try {
        await f.deps.workspaceDocument.repo.upsertDocMeta(getSessionRoomId(message.sessionId), {
          project: message.project,
        });
        await f.accept();
        const first = f.service.continueSession(message);
        await entered.promise;
        await finishFirstThenRunNext(f, first, finish, { ...message, userTurnId: 'next' });
        await f.service.drainInboxExecutions();
        expect(n).toBe(2);
        if (kind === 'edit evidence') {
          expect(captured).toMatchObject({ newText: 'TURN_ONE\n' });
          expect(JSON.stringify(captured)).not.toContain('TURN_TWO');
        } else {
          const history = await (await createSessionBackend(f.doc)).readHistory();
          expect(
            history
              .find((turn) => turn.id === 'assistant:human-input')
              ?.fileDiff?.map((diff) => diff.filePath)
          ).toEqual(['one.txt']);
        }
      } finally {
        finish.resolve();
        await f.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each([false, true])(
    'keeps newer dirty/unpushed flags after old stats (deadline=%s)',
    async (expires) => {
      if (expires) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const started = createDeferred<void>(),
        finishOld = createDeferred<void>(),
        newerWritten = createDeferred<void>();
      let dirty = false,
        firstMerge = true,
        n = 0;
      const f = inboxExecutionFixture(async () => {
        if (++n === 2) dirty = true;
        return { stopReason: 'end_turn' };
      });
      const repo = f.deps.workspaceDocument.repo;
      const upsert = repo.upsertDocMeta.bind(repo);
      repo.upsertDocMeta = async (id, patch) => {
        await upsert(id, patch);
        if (patch.workspaceDirty === true) newerWritten.resolve();
      };
      const post = new TurnPostProcessingService({
        logger: f.deps.logger,
        workspaceDocument: f.deps.workspaceDocument,
        workspaceId: f.deps.workspaceId,
        preferredBaseBranch: 'main',
        prAssociation: null,
      });
      f.session.exec = async (_cmd, args) => {
        const key = args.join(' ');
        if (key === 'rev-parse --is-inside-work-tree') return 'true\n';
        if (key === 'rev-parse HEAD' || key.startsWith('rev-parse --verify'))
          return 'a'.repeat(40) + '\n';
        if (args[0] === 'merge-base') {
          if (firstMerge) {
            firstMerge = false;
            started.resolve();
            await finishOld.promise;
          }
          return 'a'.repeat(40) + '\n';
        }
        if (key === 'status --porcelain') return dirty ? ' M a.txt\n' : '';
        if (args[0] === 'rev-list') return dirty ? '1\n' : '0\n';
        return '';
      };
      f.deps.turnFinalization.updateSessionDiffStats = post.updateSessionDiffStats.bind(post);
      const message = {
        ...f.message,
        project: { kind: 'github' as const, repoFullName: 'owner/repo', branch: 'main' },
      };
      try {
        await upsert(getSessionRoomId(message.sessionId), {
          project: message.project,
          workspaceDirty: false,
          workspaceUnpushed: false,
        });
        await f.accept();
        const first = f.service.continueSession(message);
        await started.promise;
        if (expires) {
          await vi.advanceTimersByTimeAsync(19_999);
          expect(f.store.inbox.activeExecution('workspace-1', message.sessionId)).toBeDefined();
          await vi.advanceTimersByTimeAsync(1);
          expect(f.store.inbox.activeExecution('workspace-1', message.sessionId)).toBeUndefined();
        }
        const next = { ...message, userTurnId: 'newer' };
        await finishFirstThenRunNext(f, first, finishOld, next, newerWritten.promise);
        await newerWritten.promise;
        expect(n).toBe(2);
        expect(await f.doc.getMetaState()).toMatchObject({
          workspaceDirty: true,
          workspaceUnpushed: true,
        });
        finishOld.resolve();
        await f.service.drainInboxExecutions();
        expect(await f.doc.getMetaState()).toMatchObject({
          workspaceDirty: true,
          workspaceUnpushed: true,
        });
      } finally {
        finishOld.resolve();
        await f.close();
        if (expires) vi.useRealTimers();
      }
    }
  );

  it.each([
    { stage: 'diff', action: 'shutdown' },
    { stage: 'usage', action: 'shutdown' },
    { stage: 'diff', action: 'Stop' },
    { stage: 'usage', action: 'Stop' },
  ] as const)(
    'releases interrupted $stage persistence after $action within the original deadline',
    async ({ stage, action }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const shutdown = action === 'shutdown';
      const entered = createDeferred<void>(),
        raw = createDeferred<void>();
      const signals: Array<AbortSignal | undefined> = [];
      const f = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
      if (stage === 'diff')
        f.deps.turnFinalization.persistCodeCollabTurnDiffs = async (_id, _turn, signal) => {
          signals.push(signal);
          entered.resolve();
          await raw.promise;
          return true;
        };
      else
        f.deps.turnFinalization.flushSessionUsage = async () => {
          entered.resolve();
          await raw.promise;
        };
      let run: Promise<unknown> | undefined;
      try {
        await f.accept();
        run = f.service.continueSession(f.message);
        await entered.promise;
        if (shutdown) f.service.quiesceInboxExecutions();
        else {
          await vi.advanceTimersByTimeAsync(19_000);
          await f.service.cancelSession({
            ...f.message,
            type: 'session/cancel',
            turnId: 'assistant:human-input',
          });
        }
        const released = f.service.waitForInboxReleases();
        await vi.advanceTimersByTimeAsync(shutdown ? 7_000 : 1_000);
        expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toBeUndefined();
        expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
          true
        );
        const db = new Database(f.storePath, { readonly: true });
        try {
          expect(
            db
              .prepare('SELECT outcome FROM inbox_releases WHERE session_id=?')
              .all(f.message.sessionId)
          ).toEqual([{ outcome: 'user_stop' }]);
        } finally {
          db.close();
        }
        if (stage === 'diff') expect(signals.every((signal) => signal?.aborted)).toBe(true);
        await released;
      } finally {
        raw.resolve();
        await run;
        await f.close();
        vi.useRealTimers();
      }
    }
  );

  it.each(['normal', 'shutdown', 'observation'])(
    'bounds pending generated-image uploads (%s)',
    async (mode) => {
      const shutdown = mode === 'shutdown';
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const entered = createDeferred<void>(),
        raw = createDeferred<void>(),
        nextStarted = createDeferred<void>();
      const uploads = new Map<string, Promise<void>>();
      let prompts = 0;
      const f = inboxExecutionFixture(async () => {
        if (++prompts === 1) uploads.set('image', raw.promise);
        else nextStarted.resolve();
        return { stopReason: 'end_turn' };
      });
      const handler = Object.create(MessageHandler.prototype) as any;
      handler.store = {
        has: () => true,
        get: () => ({
          permissionWaitMs: 0,
          acpUpdateBuffer: [],
          imageGenerationUploads: uploads,
          turn: {
            phase: 'active',
            turnId: 'assistant:human-input',
            turnEpoch: 1,
            hasVisibleOutput: false,
          },
        }),
        getTurnId: () => undefined,
        getCurrentACPUpdateTarget: () => undefined,
      };
      Object.assign(handler, {
        executionService: f.service,
        workspaceDocument: f.deps.workspaceDocument,
        logger: f.deps.logger,
        getSessionBackend: async (doc: typeof f.doc) => createSessionBackend(doc),
        flushSessionContextWindowUsage: async () => {},
        flushACPUpdatesNow: async () => {},
        flushThreadGoalHistoryPersists: async () => {},
      });
      const drain = handler.flushCodexGeneratedImageUploads.bind(handler);
      handler.flushCodexGeneratedImageUploads = async (...args: unknown[]) => {
        entered.resolve();
        await drain(...args);
      };
      f.deps.turnFinalization.finalizeACPState = (id, turn) => handler.finalizeACPState(id, turn);
      if (mode === 'observation')
        f.deps.observePromptContentForTurn = (id, turn) =>
          handler.observePromptContentForTurn(id, turn);
      let run: Promise<unknown> | undefined,
        next: Promise<unknown> | undefined,
        drainWork: Promise<void> | undefined;
      try {
        await f.accept();
        run = f.service.continueSession(f.message);
        await entered.promise;
        if (shutdown) {
          f.service.quiesceInboxExecutions();
          const released = f.service.waitForInboxReleases();
          await vi.advanceTimersByTimeAsync(7_000);
          await released;
        } else {
          await vi.advanceTimersByTimeAsync(19_999);
          expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toBeDefined();
          await vi.advanceTimersByTimeAsync(1);
        }
        expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toBeUndefined();
        expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
          true
        );
        const db = new Database(f.storePath, { readonly: true });
        try {
          expect(db.prepare('SELECT outcome FROM inbox_releases').all()).toHaveLength(1);
        } finally {
          db.close();
        }
        let drained = false;
        drainWork = f.service.drainInboxExecutions().then(() => {
          drained = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(drained).toBe(false);
        if (!shutdown) {
          await run;
          await f.service.acceptInboxHumanInput({
            sessionId: f.message.sessionId,
            inputId: 'next',
            userId: 'user-1',
            config: f.message.acpSessionConfig,
          });
          next = f.service.continueSession({ ...f.message, userTurnId: 'next' });
          await nextStarted.promise;
        }
      } finally {
        uploads.clear();
        raw.resolve();
        await run;
        await next;
        await drainWork;
        await f.close();
        vi.useRealTimers();
      }
    }
  );
  it('forces a failed receipt only during shutdown when the finalization chain never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const entered = createDeferred<void>(),
      raw = createDeferred<void>();
    const f = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
    f.deps.turnFinalization.finalizeACPState = async () => {
      entered.resolve();
      await raw.promise;
    };
    let run: Promise<unknown> | undefined;
    try {
      f.add('shutdown-result');
      await f.accept();
      run = f.service.continueSession(f.message);
      await entered.promise;
      const ordinary = f.service.waitForInboxReleases();
      await vi.advanceTimersByTimeAsync(7_000);
      await ordinary;
      expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toBeDefined();
      f.service.quiesceInboxExecutions();
      const released = f.service.waitForInboxReleases();
      await vi.advanceTimersByTimeAsync(7_000);
      await released;
      expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toBeUndefined();
      expect((f.service as any).liveInboxExecutionIds.size).toBe(0);
      const db = new Database(f.storePath, { readonly: true });
      try {
        expect(db.prepare('SELECT outcome FROM inbox_releases').all()).toEqual([
          { outcome: 'failed' },
        ]);
        expect(db.prepare('SELECT state FROM inbox_batches').all()).toEqual([{ state: 'unknown' }]);
      } finally {
        db.close();
      }
    } finally {
      raw.resolve();
      await run;
      await f.close();
      vi.useRealTimers();
    }
  });
  it('writes both active release receipts inside the shutdown budget despite one stuck finalization', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const started = [createDeferred<void>(), createDeferred<void>()];
    const raw = [createDeferred<void>(), createDeferred<void>()];
    const slow = createDeferred<void>();
    const fixtures = raw.map((work, i) =>
      inboxExecutionFixture(
        async () => {
          started[i]?.resolve();
          await work.promise;
          return { stopReason: 'end_turn' };
        },
        undefined,
        undefined,
        `shutdown-${i}` as SessionId
      )
    );
    const [f, other] = fixtures as [(typeof fixtures)[number], (typeof fixtures)[number]];
    f.deps.workspaceDocument.getOrCreateSessionDoc = async (id) =>
      id === f.message.sessionId ? f.doc : other.doc;
    f.deps.sessionManager.getSession = (id) =>
      (id === f.message.sessionId ? f.session : other.session) as never;
    let statisticsStarted = false;
    f.deps.turnFinalization.syncWorkspaceGitState = async () => {
      statisticsStarted = true;
      await slow.promise;
    };
    fixtures.forEach((fixture, i) => {
      fixture.session.terminate = async () => {
        raw[i]?.resolve();
      };
    });
    try {
      for (const fixture of fixtures)
        await f.service.acceptInboxHumanInput({
          sessionId: fixture.message.sessionId,
          inputId: 'human-input',
          userId: 'user-1',
          config: fixture.message.acpSessionConfig,
        });
      const turns = fixtures.map((fixture) => f.service.continueSession(fixture.message));
      await Promise.all(started.map((signal) => signal.promise));
      f.service.quiesceInboxExecutions();
      await vi.advanceTimersByTimeAsync(0);
      await f.service.waitForInboxReleases();
      await Promise.all(turns);
      expect(statisticsStarted).toBe(false);
      for (const fixture of fixtures) {
        expect(
          f.store.inbox.inputEnded('workspace-1', fixture.message.sessionId, 'human-input')
        ).toBe(true);
        expect(
          f.store.inbox.activeExecution('workspace-1', fixture.message.sessionId)
        ).toBeUndefined();
      }
    } finally {
      raw.forEach((work) => work.resolve());
      slow.resolve();
      await Promise.all(fixtures.map((fixture) => fixture.close()));
      vi.useRealTimers();
    }
  });

  it('bounds a slow yielded finalization, retains its raw work and releases the next input', async () => {
    const finalization = createDeferred<void>();
    const registered = createDeferred<void>();
    let service: SessionExecutionService | undefined;
    const f = inboxExecutionFixture(async () => {
      // A yielded turn's ancillary finalization outlives the old 5 s bound while
      // the prompt fails, so the turn body exits early and the release waits.
      const runtime = (
        service as unknown as {
          turnRuntimeBySession: Map<SessionId, { yieldedFinalization: Promise<void> }>;
        }
      ).turnRuntimeBySession.get('inbox-session' as SessionId);
      if (runtime) runtime.yieldedFinalization = finalization.promise;
      registered.resolve();
      throw new Error('agent crashed');
    });
    service = f.service;
    vi.useFakeTimers();
    try {
      await f.accept();
      const turn = f.service.continueSession(f.message);
      await registered.promise;
      await vi.advanceTimersByTimeAsync(30_000);
      await turn.catch(() => undefined);
      expect(f.service.getExecutionSnapshot(f.message.sessionId)).toMatchObject({
        hasActiveTurn: false,
      });
      expect(f.service.getExecutionSnapshot(f.message.sessionId).releaseBlocked).toBeUndefined();

      expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
        true
      );
      let drained = false;
      const drain = f.service.drainInboxExecutions().then(() => {
        drained = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).toBe(false);
      finalization.resolve();
      await drain;
      expect(drained).toBe(true);
      expect(f.service.getExecutionSnapshot(f.message.sessionId)).toMatchObject({
        hasActiveTurn: false,
      });
      expect(f.service.getExecutionSnapshot(f.message.sessionId).releaseBlocked).toBeUndefined();
    } finally {
      finalization.resolve();
      await f.close();
      vi.useRealTimers();
    }
  });

  it.each(['valid', 'absent', 'foreign', 'canceled'] as const)(
    'restores human identity only from a matching, uncanceled durable receipt (%s) after RPC loss',
    async (mode) => {
      const received: ContentBlock[][] = [];
      const f = inboxExecutionFixture(async (blocks) => {
        received.push(structuredClone(blocks));
        return { stopReason: 'end_turn' };
      });
      try {
        const prior = {
          workspaceId: 'workspace-1',
          sessionId: f.message.sessionId,
          userId: 'user-1',
          inputId: 'prior-human',
          kind: 'human' as const,
          config: f.message.acpSessionConfig,
        };
        f.store.inbox.accept(prior);
        f.store.inbox.begin(prior, 'prior-execution');
        f.store.inbox.pause(
          prior,
          'prior-execution',
          mode === 'canceled' ? ['human-input'] : [],
          'stop-1'
        );
        f.store.inbox.release({ ...prior, executionId: 'prior-execution', outcome: 'user_stop' });
        f.add('queued-result');
        const { LoroDoc, LoroMap } = await import('loro-crdt');
        const raw = f.doc.handle!.doc;
        if (mode !== 'absent') {
          const receipt = raw
            .getMap('humanInputReceipts')
            .setContainer('human-input', new LoroMap());
          receipt.set('userId', mode === 'foreign' ? 'other-user' : 'user-1');
          raw.commit();
        }
        const reopened = new LoroDoc();
        reopened.import(raw.export({ mode: 'snapshot' }));
        composeTestSessionDoc(f.doc, { doc: reopened });
        await f.service.continueSession(f.message, { dispatchSource: 'crdt' });
        if (mode === 'valid') {
          expect(received).toHaveLength(1);
          expect(JSON.stringify(received[0])).toContain('CURRENT_REQUEST');
          expect(JSON.stringify(received[0])).toContain('queued-result');
          expect(f.store.inbox.inputKind(prior, 'human-input')).toBe('human');
          // Re-delivered receipts retain their original accepted identity; after
          // another Stop they cannot grant fresh authorization or another prompt.
          const later = { ...prior, inputId: 'later-human' };
          f.store.inbox.accept(later);
          f.store.inbox.begin(later, 'later-execution');
          f.store.inbox.pause(later, 'later-execution', [], 'stop-2');
          f.store.inbox.release({ ...later, executionId: 'later-execution', outcome: 'user_stop' });
          await f.service.acceptInboxHumanInput({
            sessionId: f.message.sessionId,
            inputId: 'human-input',
            userId: 'user-1',
            config: f.message.acpSessionConfig,
          });
          expect(
            (f.store as unknown as { db: Database.Database }).db
              .prepare('SELECT MAX(paused) AS paused FROM inbox_sessions WHERE session_id=?')
              .get(f.message.sessionId)
          ).toEqual({ paused: 1 });
          expect(received).toHaveLength(1);
        } else if (mode === 'canceled') {
          expect(received).toEqual([]);
          expect(f.store.inbox.pending('workspace-1')).toEqual([]);
        } else {
          // Post-Stop input without a matching receipt still runs, as an Agent-rank task.
          expect(received).toHaveLength(1);
          expect(f.store.inbox.inputKind(prior, 'human-input')).toBe('task');
        }
      } finally {
        await f.close();
      }
    }
  );

  it.each<TurnResultAudience>([
    { kind: 'user' },
    { kind: 'agent', sessionId: 'sender-session' as SessionId, turnId: 'sender-turn' },
    { kind: 'unknown' },
  ])('preserves the $kind audience when an input carries eight Inbox results', async (audience) => {
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(structuredClone(blocks));
      return { stopReason: 'end_turn' };
    });
    const notificationFacts: TurnOutcomeFact[] = [];
    f.deps.turnFinalization.onTurnOutcome = async (fact) => {
      notificationFacts.push(fact);
    };
    try {
      for (let i = 0; i < 8; i++) f.add(`saved-${i}`, i === 0 ? 15 : 0);
      await f.accept();
      await f.service.continueSession(f.message, { notificationAudience: audience });
      await f.service.drainInboxExecutions();
      expect(notificationFacts).toEqual([
        {
          scope: { workspaceId: 'workspace-1', recipientId: 'user-1' },
          sessionId: f.message.sessionId,
          turnId: 'human-input',
          originTurnIds: audience.kind === 'user' ? ['human-input'] : [],
          assistantTurnId: 'assistant:human-input',
          audience,
          outcome: { kind: 'succeeded' },
        },
      ]);
      expect(received).toHaveLength(1);
      expect(received[0][0]).toEqual({ type: 'text', text: 'CURRENT_REQUEST' });
      const results = received[0]
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      for (let i = 0; i < 8; i++) expect(results).toContain(`saved-${i}`);
      expect(results).not.toContain('OBSOLETE_REQUEST');
      const history = await (await createSessionBackend(f.doc)).readHistory();
      const input = history.find((e) => e.id === 'human-input')!;
      expect(input.inputConfig?.chainDepth).toBe(0);
      expect(input.items).toEqual([{ type: 'text', text: 'CURRENT_REQUEST' }]);
      const item = history
        .flatMap((e) => e.items ?? [])
        .find((i) => i.type === 'operation_completion_batch')!;
      expect(item).toMatchObject({ memberCount: 8 });
      const batch = f.store.inbox.getBatch(
        (item as Extract<typeof item, { type: 'operation_completion_batch' }>).batchId,
        { workspaceId: 'workspace-1', sessionId: f.message.sessionId, userId: 'user-1' }
      )!;
      expect(batch.state).toBe('settled');
      expect(batch.chainDepth).toBe(0);
      expect(f.store.inbox.pending('workspace-1')).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('naturally releases into one actual automatic input containing busy receipts then wakes again for a late receipt', async () => {
    const started = createDeferred<void>();
    const complete = createDeferred<void>();
    const automatic = createDeferred<void>();
    const lateAutomatic = createDeferred<void>();
    let automaticCount = 0;
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(
      async (blocks) => {
        received.push(structuredClone(blocks));
        if (received.length === 1) {
          started.resolve();
          await complete.promise;
        }
        return { stopReason: 'end_turn' };
      },
      undefined,
      () => {
        automaticCount++;
        if (automaticCount === 1) automatic.resolve();
        else lateAutomatic.resolve();
      }
    );
    try {
      await f.accept();
      const running = f.service.continueSession(f.message);
      await started.promise;
      for (let n = 0; n < 8; n++) f.add(`busy-${n}`);
      expect(received).toHaveLength(1);
      complete.resolve();
      await running;
      await automatic.promise;
      expect(received).toHaveLength(2);
      const result = received[1]!
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      for (let n = 0; n < 8; n++) expect(result).toContain(`busy-${n}`);
      const history = await (await createSessionBackend(f.doc)).readHistory();
      const batches = history
        .flatMap((e) => e.items ?? [])
        .filter((i) => i.type === 'operation_completion_batch');
      expect(batches).toMatchObject([{ memberCount: 8, deliveryStatus: 'settled' }]);
      expect(f.store.inbox.pending('workspace-1')).toEqual([]);
      f.add('late-nine');
      expect(f.store.inbox.pending('workspace-1')).toHaveLength(1);
      await f.wake();
      await lateAutomatic.promise;
      expect(received).toHaveLength(3);
      const lateBlocks = received[2];
      if (!lateBlocks) throw new Error('Missing late receipt input');
      const late = lateBlocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      expect(late).toContain('late-nine');
      expect(late).not.toContain('busy-0');
      expect(f.store.inbox.pending('workspace-1')).toEqual([]);
    } finally {
      complete.resolve();
      await f.close();
    }
  });

  it('legacy Stop cancels the turn without locking out the next legacy user input', async () => {
    const building = createDeferred();
    const release = createDeferred();
    const received: ContentBlock[][] = [];
    let hold = true;
    const f = inboxExecutionFixture(
      async (blocks) => {
        received.push(blocks);
        return {};
      },
      async (blocks) => {
        if (hold) {
          building.resolve();
          await release.promise;
        }
        return blocks as ContentBlock[];
      }
    );
    try {
      const running = f.service.continueSession(f.message); // No human receipt, like a released client.
      await building.promise;
      const turnId = f.service.getExecutionSnapshot(f.message.sessionId).activeTurnId!;
      await f.service.cancelSession({
        type: 'session/cancel',
        sessionId: f.message.sessionId,
        turnId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
      });
      release.resolve();
      await running;
      expect(received).toEqual([]);
      hold = false;
      f.client.isCreated = () => true; // A fresh Agent is available after the cancelled acquisition.
      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: {
          id: 'legacy-next',
          role: 'user',
          timestamp: '2026-10-12T00:00:00Z',
          status: 'pending',
          read: false,
          items: [{ type: 'text', text: 'next' }],
          inputConfig: f.message.acpSessionConfig,
          finished: true,
          fileDiff: [],
        },
      });
      await f.service.continueSession({ ...f.message, userTurnId: 'legacy-next' });
      expect(received).toHaveLength(1);
      expect(
        (await (await createSessionBackend(f.doc)).readHistory()).find(
          (entry) => entry.id === 'legacy-next'
        )?.status
      ).toBe('handled');
      expect(
        (f.store as unknown as { db: Database.Database }).db
          .prepare('SELECT paused FROM inbox_sessions')
          .get()
      ).toEqual({ paused: 0 });
    } finally {
      release.resolve();
      await f.close();
    }
  });

  // #2050: interrupt-and-send ends the running turn so the queued guidance runs
  // next. It must not use the Stop identity, which pauses the Inbox and cancels
  // the eligibility of every input queued before it.
  it.each([
    ['interrupt', 'running', { pauseInbox: false }, ['CURRENT_REQUEST', 'GUIDANCE'], 'handled'],
    [
      'interrupt',
      'already finished',
      { pauseInbox: false },
      ['CURRENT_REQUEST', 'GUIDANCE'],
      'handled',
    ],
    // RPC lost: the daemon reads the durable turn-id marker, which carries no Stop identity.
    ['interrupt marker', 'running', {}, ['CURRENT_REQUEST', 'GUIDANCE'], 'handled'],
    ['Stop', 'running', { cancelId: 'user-stop' }, ['CURRENT_REQUEST'], 'seen'],
  ] as const)(
    '%s of a %s turn decides whether queued guidance runs',
    async (kind, turnState, request, expectedPrompts, guidanceStatus) => {
      const release = createDeferred();
      const prompting = createDeferred();
      const received: string[] = [];
      const f = inboxExecutionFixture(async (blocks) => {
        const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
        received.push(text);
        if (text === 'CURRENT_REQUEST') {
          prompting.resolve();
          await release.promise;
        }
        return {};
      });
      try {
        await f.accept();
        const running = f.service.continueSession(f.message);
        await prompting.promise;
        const turnId = f.service.getExecutionSnapshot(f.message.sessionId).activeTurnId!;
        const guidanceConfig = {
          ...f.message.acpSessionConfig,
          prompt: 'GUIDANCE',
          inputBlocks: [{ type: 'text' as const, text: 'GUIDANCE' }],
        };
        // The composer queues the guidance, then cancels the running turn.
        await f.doc.pushMessageQueue({
          task: 'GUIDANCE',
          userId: 'user-1',
          userTurnId: 'guidance',
          timestamp: '2026-10-12T00:00:01Z',
          project: undefined,
          acpSessionConfig: guidanceConfig,
        });
        if (turnState === 'already finished') {
          release.resolve();
          await running;
        }
        await f.service.cancelSession({
          ...request,
          type: 'session/cancel',
          sessionId: f.message.sessionId,
          turnId,
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
        });
        release.resolve();
        await running;
        // The dispatch watcher's queue-promotion gate: a canceled head is retired, not run.
        expect(f.service.isInboxInputCanceled(f.message.sessionId, 'guidance')).toBe(
          kind === 'Stop'
        );

        // Queue promotion after release: history row, human receipt, dispatch.
        await f.doc.sessionData.commands.applyHistoryAction({
          kind: 'upsert-turn',
          turn: {
            id: 'guidance',
            role: 'user',
            userId: 'user-1',
            timestamp: '2026-10-12T00:00:01Z',
            status: 'pending',
            read: false,
            items: [{ type: 'text', text: 'GUIDANCE' }],
            inputConfig: guidanceConfig,
            finished: true,
            fileDiff: [],
          },
        });
        const [queued] = await f.doc.getMessageQueue();
        if (queued) await f.doc.removeMessageQueueItem(queued.$cid);
        await f.service.acceptInboxHumanInput({
          sessionId: f.message.sessionId,
          inputId: 'guidance',
          userId: 'user-1',
          config: guidanceConfig,
        });
        await f.service.continueSession({
          ...f.message,
          userTurnId: 'guidance',
          acpSessionConfig: guidanceConfig,
        });

        expect(received).toEqual(expectedPrompts);
        // Even a Stop keeps the typed guidance in history instead of deleting it.
        expect(
          (await (await createSessionBackend(f.doc)).readHistory()).find(
            (entry) => entry.id === 'guidance'
          )?.status
        ).toBe(guidanceStatus);
      } finally {
        release.resolve();
        await f.close();
      }
    }
  );

  it('runs an Agent chat sent after an Inbox-aware Stop and clears the pause', async () => {
    const building = createDeferred();
    const release = createDeferred();
    const received: ContentBlock[][] = [];
    let hold = true;
    const f = inboxExecutionFixture(
      async (blocks) => {
        received.push(blocks);
        return {};
      },
      async (blocks) => {
        if (hold) {
          building.resolve();
          await release.promise;
        }
        return blocks as ContentBlock[];
      }
    );
    try {
      await f.accept();
      const running = f.service.continueSession(f.message);
      await building.promise;
      const turnId = f.service.getExecutionSnapshot(f.message.sessionId).activeTurnId!;
      await f.service.cancelSession({
        cancelId: 'modern-stop',
        type: 'session/cancel',
        sessionId: f.message.sessionId,
        turnId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
      });
      release.resolve();
      await running;
      expect(received).toEqual([]);
      hold = false;
      f.client.isCreated = () => true;
      // An Agent chat carries no human receipt, so the Inbox records it as a task.
      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: {
          id: 'agent-chat',
          role: 'user',
          timestamp: '2026-10-18T02:02:17Z',
          status: 'pending',
          read: false,
          items: [{ type: 'text', text: 'delegated work' }],
          inputConfig: f.message.acpSessionConfig,
          finished: true,
          fileDiff: [],
        },
      });
      await f.service.continueSession({ ...f.message, userTurnId: 'agent-chat' });
      expect(received).toHaveLength(1);
      expect(
        (await (await createSessionBackend(f.doc)).readHistory()).find(
          (entry) => entry.id === 'agent-chat'
        )?.status
      ).toBe('handled');
      expect(
        (f.store as unknown as { db: Database.Database }).db
          .prepare('SELECT MAX(paused) AS paused FROM inbox_sessions WHERE session_id=?')
          .get(f.message.sessionId)
      ).toEqual({ paused: 0 });
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it('Stop accepted while input is being built submits nothing and retains all eight results', async () => {
    const building = createDeferred();
    const release = createDeferred();
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(
      async (blocks) => {
        received.push(blocks);
        return {};
      },
      async (blocks) => {
        building.resolve();
        await release.promise;
        return blocks as ContentBlock[];
      }
    );
    try {
      for (let i = 0; i < 8; i++) f.add(`saved-${i}`);
      await f.accept();
      const running = f.service.continueSession(f.message);
      await building.promise;
      const turnId = f.service.getExecutionSnapshot(f.message.sessionId).activeTurnId!;
      await f.service.cancelSession({
        cancelId: 'modern-stop',
        type: 'session/cancel',
        sessionId: f.message.sessionId,
        turnId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
      });
      release.resolve();
      await running;
      expect(
        (await (await createSessionBackend(f.doc)).readHistory()).find(
          (turn) => turn.id === 'human-input'
        )
      ).toMatchObject({ status: 'canceled', cancellationReason: 'user_stop' });
      expect(received).toEqual([]);
      expect(
        (f.store as unknown as { db: Database.Database }).db
          .prepare('SELECT COUNT(*) AS count FROM inbox_results WHERE consumed=0')
          .get()
      ).toEqual({ count: 8 });
      expect(f.store.inbox.pending('workspace-1')).toEqual([]);
      expect(
        (f.store as unknown as { db: Database.Database }).db
          .prepare('SELECT MAX(paused) AS paused FROM inbox_sessions WHERE session_id=?')
          .get(f.message.sessionId)
      ).toEqual({ paused: 1 });
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it('received user-plus-batch input is unknown after disconnection and cannot replay on reopen', async () => {
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(structuredClone(blocks));
      throw new RequestError(-32603, 'connection disposed');
    });
    try {
      f.add('saved');
      await f.accept();
      await f.service.continueSession(f.message);
      expect(received).toHaveLength(1);
      const item = (await (await createSessionBackend(f.doc)).readHistory())
        .flatMap((e) => e.items ?? [])
        .find((i) => i.type === 'operation_completion_batch')!;
      const scope = {
        workspaceId: 'workspace-1',
        sessionId: f.message.sessionId,
        userId: 'user-1',
      };
      const id = (item as Extract<typeof item, { type: 'operation_completion_batch' }>).batchId;
      expect(f.store.inbox.getBatch(id, scope)?.state).toBe('unknown');
      const other = new LodyOperationStore(f.storePath, f.now);
      try {
        other.inbox.activate('workspace-1', 'replacement');
        expect(other.inbox.getBatch(id, scope)?.state).toBe('unknown');
        expect(
          other.inbox.prepare(
            { ...scope, inputId: 'human-input', kind: 'human', config: f.message.acpSessionConfig },
            'replacement'
          )
        ).toBeUndefined();
      } finally {
        other.close();
      }
      expect(received).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
});

describe('Provider quota refresh', () => {
  const snapshot = {
    rateLimits: [
      {
        limitId: 'example',
        scope: { providerId: 'example' },
        windows: [{ usedPercent: 42, windowDurationSeconds: 18000, resetsAtEpochSeconds: null }],
      },
    ],
  };

  function quotaHarness(query = true, overrides: Partial<AgentConfigMeta> = {}) {
    let config: AgentConfigMeta | null = createLaunchConfig({
      cliType: 'custom',
      agentType: 'example',
      env: {},
      ...overrides,
    });
    const rows = new Map<string, unknown>();
    const deps = createBaseDeps({});
    deps.workspaceDocument.getAgentConfigForMachineLaunch = async () => config;
    deps.workspaceDocument.getAcpCapabilities = async () => ({
      cliType: 'custom',
      agentType: 'example',
      modes: [],
      models: [],
      fetchedAt: 1,
      rateLimits: { version: 1, ...(query ? { query: true } : {}) },
    });
    deps.workspaceDocument.updateRateLimits = async (_machine, id, _cli, limit, guard) => {
      if (!guard || guard()) rows.set(`${id}/${limit.limitId}`, limit);
    };
    return {
      service: new SessionExecutionService(deps),
      rows,
      remove: () => {
        config = null;
      },
      change: () => {
        if (config) config = { ...config, env: { OP_TOKEN: 'changed' } };
      },
    };
  }

  it('publishes a cold query for its exact Provider and coalesces concurrent consumers', async () => {
    const pending = createDeferred<typeof snapshot>();
    const ready = createDeferred();
    const read = vi.spyOn(quotaRunner, 'queryLocalAcpRateLimits').mockImplementation(async () => {
      ready.resolve();
      return pending.promise;
    });
    try {
      const harness = quotaHarness();
      const first = harness.service.refreshProviderRateLimits(capabilityConfigId);
      await ready.promise;
      const second = harness.service.refreshProviderRateLimits(capabilityConfigId);
      pending.resolve(snapshot);
      expect((await first).success).toBe(true);
      expect((await second).success).toBe(true);
      expect([...harness.rows.entries()]).toEqual([
        [`${capabilityConfigId}/example`, snapshot.rateLimits[0]],
      ]);
    } finally {
      read.mockRestore();
    }
  });

  it.each([
    ['codex', 'OPENAI_API_KEY'],
    ['claude', 'ANTHROPIC_BASE_URL'],
    ['grok', 'XAI_API_KEY'],
  ])(
    'refreshes %s with tool env but preserves cached quota for account overrides',
    async (agentType, accountKey) => {
      const read = vi
        .spyOn(quotaRunner, 'queryLocalAcpRateLimits')
        .mockImplementation(async (options) => {
          expect(options.agentConfigId).toBe(capabilityConfigId);
          expect(options.env?.OP_TOKEN).toBe('synthetic');
          return snapshot;
        });
      const status = vi
        .spyOn(SessionExecutionService.prototype, 'getMachineAcpBinaryStatus')
        .mockResolvedValue({
          type: 'machine/acp-binary-status_response',
          machineId: 'machine-1',
          agentType,
          success: true,
          status: 'installed',
        });
      try {
        const allowed = quotaHarness(true, {
          cliType: 'builtin',
          agentType,
          env: { OP_TOKEN: 'synthetic' },
        });
        expect((await allowed.service.refreshProviderRateLimits(capabilityConfigId)).success).toBe(
          true
        );
        const key = `${capabilityConfigId}/example`;
        expect(allowed.rows.get(key)).toEqual(snapshot.rateLimits[0]);

        const blocked = quotaHarness(true, {
          cliType: 'builtin',
          agentType,
          env: { OP_TOKEN: 'synthetic', [accountKey]: 'synthetic' },
        });
        blocked.rows.set(key, 'previous');
        expect((await blocked.service.refreshProviderRateLimits(capabilityConfigId)).success).toBe(
          false
        );
        expect(blocked.rows.get(key)).toBe('previous');
      } finally {
        read.mockRestore();
        status.mockRestore();
      }
    }
  );

  it.each(['empty', 'failure', 'push', 'deleted', 'changed', 'unsupported'] as const)(
    'preserves old quota on %s',
    async (mode) => {
      const pending = createDeferred<typeof snapshot>();
      const ready = createDeferred();
      const read = vi.spyOn(quotaRunner, 'queryLocalAcpRateLimits').mockImplementation(async () => {
        ready.resolve();
        return pending.promise;
      });
      try {
        const harness = quotaHarness(mode !== 'unsupported');
        const key = `${capabilityConfigId}/example`;
        harness.rows.set(key, 'previous');
        const request = harness.service.refreshProviderRateLimits(capabilityConfigId);
        if (mode !== 'unsupported') await ready.promise;
        if (mode === 'push') {
          harness.service.noteProviderRateLimitsUpdate(capabilityConfigId);
          harness.rows.set(key, 'newer-push');
        }
        if (mode === 'deleted') harness.remove();
        if (mode === 'changed') harness.change();
        if (mode === 'failure') pending.reject(new Error('provider unavailable'));
        else pending.resolve(mode === 'empty' ? { rateLimits: [] } : snapshot);
        expect((await request).success).toBe(false);
        expect(harness.rows.get(key)).toBe(mode === 'push' ? 'newer-push' : 'previous');
      } finally {
        read.mockRestore();
      }
    }
  );

  it('keeps independent Providers, bounds freshness, and waits for the prior launch before replacement', async () => {
    let now = 0;
    const cache = new ProviderQuotaRefreshCache(() => now);
    const pending = createDeferred<boolean>();
    const ready = createDeferred();
    const states: string[] = [];
    const first = cache.run('a', 'old', async () => {
      ready.resolve();
      await pending.promise;
      states.push('old-released');
      return true;
    });
    await ready.promise;
    const same = cache.run('a', 'old', async () => {
      throw new Error('duplicate owner');
    });
    const next = cache.run('a', 'new', async () => {
      states.push('new');
      return true;
    });
    await expect(cache.run('b', 'other', async () => false)).resolves.toBe(false);
    expect(states).toEqual([]);
    pending.resolve(true);
    await Promise.all([first, same, next]);
    expect(states).toEqual(['old-released', 'new']);
    await expect(cache.run('a', 'new', async () => false)).resolves.toBe(true);
    now = 15_000;
    await expect(cache.run('a', 'new', async () => false)).resolves.toBe(false);
    now += 5_000;
    await expect(cache.run('a', 'new', async () => true)).resolves.toBe(true);
  });

  it('quarantines unconfirmed process cleanup across launch changes', async () => {
    const cache = new ProviderQuotaRefreshCache(
      () => 100_000,
      () => false
    );
    await expect(
      cache.run('a', 'old', async () => {
        throw new Error('unreleased child');
      })
    ).resolves.toBe(false);
    await expect(cache.run('a', 'new', async () => true)).resolves.toBe(false);
    await expect(cache.run('b', 'other', async () => true)).resolves.toBe(true);
  });
});

describe('session start retry pacing', () => {
  it('caps retries per window across Sessions and frees them as the window passes', () => {
    const startedAt: number[] = [];
    const budget = { limit: 2, windowMs: 60_000 };
    expect(takeSessionStartRetry(startedAt, 0, budget)).toBe(true);
    expect(takeSessionStartRetry(startedAt, 1_000, budget)).toBe(true);
    // A machine-wide failure must not turn every turn's retries into more load.
    expect(takeSessionStartRetry(startedAt, 2_000, budget)).toBe(false);
    expect(takeSessionStartRetry(startedAt, 60_000, budget)).toBe(true);
    expect(startedAt).toEqual([1_000, 60_000]);
  });

  it('spreads retry delays over the upper half of the base delay', () => {
    expect(jitterSessionStartRetryDelay(1_000, 0)).toBe(500);
    expect(jitterSessionStartRetryDelay(1_000, 0.999)).toBe(1_000);
    expect(jitterSessionStartRetryDelay(3_000, 0.5)).toBe(2_250);
  });
});
