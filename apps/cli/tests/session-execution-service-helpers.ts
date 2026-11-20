import { EventEmitter } from 'node:events';
import { encodeStreamsRoomAdditionalData } from 'loro-repo/transport/streams';
import { bindTestPresenceApplication } from './presence-application-fixture';
import { Lody } from '../src/lib/lody';
import type { MachineRuntimeOptions } from '../src/lib/machine-runtime';
import type { CliE2eeWorkspaceLegacy } from '../src/lib/e2ee/workspace-legacy';
import { makeCliE2eeCustody } from '../src/lib/e2ee/custody';
import {
  cliE2eeIdentityDirectory,
  retainCliE2eeWorkspaceBinding,
} from '../src/lib/e2ee/workspace-legacy';
import { makeNodeE2eeCustody } from '@lody/e2ee-core/adapters/node-custody';
import {
  Bytes,
  decodeRecord,
  extendLedger,
  hashRecordBytes,
  machineSharingContentScope,
  machineSharingDigest,
  prepareDeviceAdmission,
  prepareEpochEnvelope,
  prepareJoinRequest,
  prepareLedgerCommand,
  scopedDocumentKey,
  sealMachineSharingPolicy,
  signExecutionIntent,
  signGenesisRecord,
  signLedgerRecord,
  verifyLedger,
  verifyMachineSharingGeneration,
} from '@lody/e2ee-core/protocol';
import { makeStreamsUpdateBinding } from '@lody/e2ee-core/adapters/loro-streams';
import { createTestCloudPort } from './test-cloud-port';
import { lazyExecutionJournal, makeEncryptedAgentExecution } from '../src/lib/e2ee/agent-execution';
import { createSessionBackend } from '@/session/session-backend';
import { type TurnOutcomeFact, type TurnResultAudience } from '@lody/shared/notifications';
import { type ContentBlock } from '@agentclientprotocol/sdk';
import {
  E2EE_INTENT_KIND,
  encodeE2eeIntentRecord,
  getSessionRoomId,
  SessionStatusFactory,
  turnExecutionDigest,
  type AcpCapabilityCacheEntry,
  type ACPSessionId,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type ProjectRef,
  type SessionHistoryInput,
  type SessionId,
  type SessionInputBlock,
  type SessionMeta,
  type SessionStatus,
  type WorkspaceId,
} from '@lody/shared';
import { Data, Effect, Result } from 'effect';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, vi } from 'vitest';
import { markAssistantTurnFinished } from '../src/lib/assistant-turn-finalize';
import { SessionDocument, type LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionActivePresencePhase } from '../src/lib/loro/session-active-presence';
import { SessionActivePresenceControllerLegacy } from '../src/lib/loro/session-active-presence-legacy';
import { operationInboxLegacy } from '../src/orchestration/inbox/legacy';
import { LodyOperationStore } from '../src/orchestration/operation-store';
import {
  SessionExecutionService,
  type SessionExecutionServiceDeps,
} from '../src/session/session-execution-service';
import type { SessionManager } from '../src/session/session-manager';
import type { SessionConfig } from '../src/session/types';
import type { Logger } from '../src/utils/logger';
import { withHistoryPort } from './history-port-fixture';
import { composeTestSessionDoc } from './session-doc-fixture';

/** Shape of an Effect tagged error without a message, as the lock errors once were. */
class MessagelessStartFailure extends Data.TaggedError('MessagelessStartFailure')<{
  cause: unknown;
}> {}

/** The OS refusing a fork, as `spawnSync` reports it. */
const temporarySpawnFailure = () =>
  Object.assign(new Error('spawnSync /usr/bin/git EAGAIN'), { code: 'EAGAIN' });

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
  /** What the agent reports outside Lody's Turns (Core `sessionActivity`). */
  nativeWork?: { current: 'running' | 'background' | null };
  /** Ordered lifecycle steps observed by the test (e.g. interruption notice before flush). */
  onLifecycleEvent?: (event: string) => void;
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
    getNativeWork: () => options.nativeWork?.current ?? null,
  };
  let liveAgentProcess = true;
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
    hasLiveAgentProcess: () => liveAgentProcess,
    updateGitIdentity: vi.fn(),
    createAgent: vi.fn(async () => 'acp-silent'),
    applyExecutionPlaneLimits: vi.fn(async () => {}),
  };
  let status = SessionStatusFactory.idle();
  let restored = false;
  let docDestroyed = false;
  const roomId = getSessionRoomId(options.sessionId as SessionId);
  const makeDocPort = (isDestroyedFn: () => boolean) =>
    withHistoryPort({
      sessionId: options.sessionId as SessionId,
      roomId,
      get isDestroyed() {
        return isDestroyedFn();
      },
      // Read at call time, so a test can change synced metadata mid-turn.
      getMetaState: vi.fn(async () => ({ isArchived: false, ...options.meta })),
      setStatus: vi.fn(async (next: typeof status) => {
        status = next;
      }),
      setLastMessageAt: vi.fn(async () => {
        if (isDestroyedFn()) throw new Error('SessionDocument not initialized');
        options.onLifecycleEvent?.(isDestroyedFn() ? 'stale:unread' : 'unread');
      }),
      waitUntilSynced: async () => true,
      flushLocalWrites: async () => {
        options.onLifecycleEvent?.(isDestroyedFn() ? 'stale:flush' : 'flush');
      },
      getHistory: vi.fn(() => history),
      updateHistory: vi.fn(async (updater: (prev: typeof history) => typeof history) => {
        history = updater(history);
      }),
    });
  const sessionDoc = makeDocPort(() => docDestroyed);
  const replacementSessionDoc = makeDocPort(() => false);
  const failureMessages: string[] = [];
  const interruptedNotices: string[] = [];
  // Lifecycle events of the live agent, as SessionManager publishes them.
  const sessionEvents = new EventEmitter();
  let sessionEnded = false;
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
    sessionManager: Object.assign(sessionEvents, {
      getSession: vi.fn(() =>
        (options.restore && !restored) || sessionEnded ? null : activeSession
      ),
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
    }) as unknown as SessionManager,
    recordNativeWorkInterrupted: vi.fn(async (_sessionId: SessionId, turnId: string) => {
      options.onLifecycleEvent?.('notice');
      interruptedNotices.push(turnId);
    }),
    workspaceDocument: {
      repo: {
        upsertDocMeta,
        getDocMeta: vi.fn(async () => undefined),
      },
      isSessionDocCleaning: () => false,
      getOrCreateSessionDoc: vi.fn(async () => (docDestroyed ? replacementSessionDoc : sessionDoc)),
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
    replacementSessionDoc,
    notificationFacts,
    failureMessages,
    upsertDocMeta,
    agentClient,
    getHistory: () => history,
    getStatus: () => status,
    finalizationOwners,
    service,
    interruptedNotices,
    /** Publishes a `sessionActivity` change of the live agent. */
    changeNativeWork: (work: 'running' | 'background' | null) => {
      if (options.nativeWork) options.nativeWork.current = work;
      sessionEvents.emit('onNativeWorkChanged', options.sessionId, work);
    },
    /** The ACP child crashes (`onExit` clears `agentProcess` and emits null without `'terminated'`). */
    crashAgentProcess: () => {
      liveAgentProcess = false;
      sessionEvents.emit('onNativeWorkChanged', options.sessionId, null);
    },
    /** The agent process exits, as idle GC or memory pressure ends it. */
    endAgentProcess: (opts?: { destroyDoc?: boolean }) => {
      sessionEnded = true;
      liveAgentProcess = false;
      if (opts?.destroyDoc) docDestroyed = true;
      sessionEvents.emit('terminated', { sessionId: options.sessionId });
    },
  });
};

const encryptedExecutionFixture = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'encrypted-execution-'));
  const filename = path.join(directory, 'execution.sqlite');
  const gate = (
    authorization: 'authorized' | 'denied' = 'authorized',
    file = filename,
    workspaceId = 'workspace-1'
  ) =>
    makeEncryptedAgentExecution({
      machineUserId: 'synthetic-machine-account',
      genesis: 'genesis',
      workspaceId,
      targetMachineId: 'machine-1',
      journal: lazyExecutionJournal(file, () => 100),
      resolveVerifiedOriginal: () =>
        Effect.succeed({
          requesterDevice: 'ab'.repeat(32),
          requesterCryptoUserId: 'user-1',
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
    | 'late'
    | 'unsigned'
    | 'revoked-device'
    | 'guest'
    | 'removed-member'
    | 'same-member'
    | 'other-member'
    | 'other-member-shared'
    | 'other-member-closed'
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
  const removalReleased = Promise.withResolvers<void>();
  const snapshotOnly = mode === 'snapshot' || mode === 'late';
  const deniedSigner =
    mode === 'unsigned' ||
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
  const derivations: Array<'owner' | 'member' | undefined> = [];
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
        // The sending device signs what will run, stored in the row itself.
        const intentSignature = yield* signExecutionIntent({
          kind: E2EE_INTENT_KIND.memberInput,
          genesis: genesis.genesis,
          workspaceId,
          targetMachineId: 'machine-1',
          scope: sessionId,
          messageId: 'turn-user-1',
          contentDigest: Buffer.from(turnExecutionDigest({ inputConfig })!, 'hex'),
          signer: originalSigner,
        });
        const row = source.getList('history').insertContainer(0, new LoroMap());
        row.set('id', 'turn-user-1');
        row.set('role', 'user');
        row.set('userId', user);
        row.set('timestamp', new Date().toISOString());
        row.set('status', 'pending');
        row.set('inputConfig', inputConfig);
        row.set('items', [{ type: 'text', text: 'hi' }]);
        if (mode !== 'unsigned')
          row.set(
            'e2eeIntent',
            encodeE2eeIntentRecord({
              kind: E2EE_INTENT_KIND.memberInput,
              signer: originalSigner.publicKey.toBytes(),
              signature: intentSignature.toBytes(),
            })
          );
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
          sessions: [],
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
      // Execution never needs an original frame: no scan of the stream may happen.
      readExecutionOriginPage: async (input: { docId: string }) => {
        recoveredRooms.push(input.docId);
        return { messages: [], before: '0', atStart: true };
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
          derivations.push(
            service.reserveEncryptedDerivation(sessionId as SessionId, 'turn-user-1', 'observation')
              ?.kind
          );
        },
      });
    // A machine that was offline for days still starts a signed message once.
    if (mode === 'late') vi.setSystemTime(Date.parse('2026-10-31T02:00:00Z'));
    const before = historyReads.length;
    const result = await dispatch();
    expect(submitted).toEqual(deniedSigner ? [] : ['hi']);
    // Derived work follows the verified signer, never the history row's display
    // userId: the owner's own turn derives as owner; a shared member's turn derives
    // as that member, re-authorized when the derived input is written and started.
    if (!deniedSigner) {
      // The row's display account is not the requester: execution uses the verified signer.
      expect(invocations[0]?.requesterUserId).toEqual(
        mode === 'other-member-shared' ? expect.stringMatching(/^e2ee-member:/) : 'user-1'
      );
      expect(derivations[0]).toBe(mode === 'other-member-shared' ? 'member' : 'owner');
    }
    expect(result.getHistory()[0]?.status).toBe(deniedSigner ? 'failed' : 'handled');
    expect(result.failureMessages).toEqual(
      mode === 'other-member' || mode === 'other-member-closed'
        ? [expect.stringContaining('e2ee_machine_not_shared')]
        : mode === 'unsigned'
          ? [expect.stringContaining('e2ee_signature_missing')]
          : deniedSigner
            ? [expect.stringContaining('e2ee_sender_not_authorized')]
            : []
    );
    expect(recoveredRooms).toEqual([]);
    // A signed turn is authorized from a fresh ledger read; an unsigned one never reaches it.
    if (mode === 'unsigned') expect(historyReads.length).toBe(before);
    else expect(historyReads.length).toBeGreaterThan(before);
    expect(
      historyReads.every((credential) => credential.length > 0 && credential !== 'synthetic-token')
    ).toBe(true);
  } finally {
    removalReleased.resolve();
    if (lody)
      await (
        lody as unknown as { encryptedWorkspace: CliE2eeWorkspaceLegacy }
      ).encryptedWorkspace.removalCleanup();
    await lody?.documentManager.cleanUp();
    await presence.closeLegacy();
    source.free();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

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
    getAutomationObservations: () => ({}),
  };
  const session = {
    sessionId,
    acpSessionId: 'acp-inbox' as ACPSessionId,
    agentClient: client,
    terminalManager: {},
    getWorkdir: () => '/tmp',
    getHostWorkdir: () => '/tmp',
    getParentSessionId: () => undefined,
    getProviderBinding: () => ({ bindingId: capabilityConfigId, fingerprint: 'frozen-launch' }),
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
      // Not native: automation reads open the replica above.
      openIdleSessionReader: async () => undefined,
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
            prompt: 'The results returned by delegated work follow.',
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
    machineId: 'machine-1' as MachineId,
    workspaceId: 'workspace-1' as WorkspaceId,
    acpSessionConfig: config,
    userTurnId: 'human-input',
    userId: 'user-1',
    userName: 'User',
    userEmail: 'user@example.com',
  };
  const add = (id: string, depth = 0, origins: string[] = [], finish = true, userId = 'user-1') => {
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
    /** Replaces or ends the live Agent, as idle GC or a crash would. */
    dropLiveSession: () => {
      liveSession = undefined;
    },
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
export {
  cancelCompletions,
  capabilityConfigId,
  createBaseDeps,
  createDeadlineHarness,
  createDeferred,
  createGitLocalProject,
  createGoalService,
  createLaunchConfig,
  createRetryFixture,
  createSilentLogger,
  encryptedExecutionFixture,
  ensureSessionDocDefaults,
  finishFirstThenRunNext,
  fixtureSessionMeta,
  goalArgs,
  goalSessionId,
  inboxExecutionFixture,
  MessagelessStartFailure,
  PresenceEvent,
  PRIOR_CONVERSATION_HISTORY,
  quotaHarness,
  runGit,
  runProductionSignedTurn,
  runSilentPromptTurn,
  SessionMetaTestRepo,
  snapshot,
  temporarySpawnFailure,
};
