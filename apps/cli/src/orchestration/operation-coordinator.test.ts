import { SessionExecutionService } from '../session/session-execution-service';
import { Cause, Effect, Exit } from 'effect';
import { CoordinatorWorkflow } from './coordinator-workflow';
import type { CoordinatorActivity } from './coordinator-activity';
import type { CoordinatorPorts } from './coordinator-ports';
import { OperationRepository } from './operation-repository';
import { operationRepositoryLayer } from './platform/operations';
import Database from 'better-sqlite3';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withHistoryPort } from '../../tests/history-port-fixture';

import { LoroDoc } from 'loro-crdt';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getAgentConfigRoomId,
  getSessionRoomId,
  machineFlockKeys,
  type AgentConfigMeta,
  type MachineId,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';

import { projectTurnAttention, type TurnResultAudience } from '@lody/shared/notifications';
import { LodyOperationCoordinator } from './operation-coordinator';
import { LodyOperationStore } from './operation-store';

const queuedResults = (store: LodyOperationStore, workspaceId: WorkspaceId) =>
  (store as unknown as { db: Database.Database }).db
    .prepare(
      'SELECT session_id AS requesterSessionId,operation_id AS operationId,consumed FROM inbox_results WHERE workspace_id=? AND consumed=0 ORDER BY sequence'
    )
    .all(workspaceId);

const roots = new Set<string>();
const TEST_NOW_MS = Date.parse('2026-07-20T00:00:00Z');

const makeHarness = async (options?: {
  beforeStoreOpen?: () => void;
  beforeActivate?: () => void;
  onAvailabilityChange?: (message: string | undefined) => void;
  deadlineAt?: string;
  author?: import('@lody/shared').AgentMessageAuthor;
  requesterArchived?: boolean;
  pendingUser?: boolean;
  busy?: boolean;
  activeTurnId?: string;
  agentConfigId?: string;
  configurationSyncSucceeds?: boolean;
  configurationSync?: () => Promise<boolean>;
  beforeTurnClaim?: () => Promise<void>;
  afterTurnComplete?: () => void;
  beforeTargetMetaRead?: () => Promise<void>;
  now?: () => number;
  machineAgentConfig?: AgentConfigMeta;
  legacyAgentConfig?: AgentConfigMeta;
  resolveUserFails?: boolean;
  targetInputDurable?: boolean;
  acceptedInputDurable?: boolean;
  materializationFailuresBeforeSuccess?: number;
  materializationWritesBeforeFailure?: boolean;
  materializationWritesDocBeforeFailure?: boolean;
  historyFailuresBeforeSuccess?: number;
  beforeRequesterHistoryWrite?: () => Promise<void>;
  materializeTargetOverride?: () => Promise<void>;
  confirmTargetReadable?: (docId: string, reason: string) => Promise<void>;
  operationKind?: 'session_create' | 'session_create_many' | 'session_chat';
  failProgressHistoryWrites?: boolean;
  progressHistoryFailures?: number;
  failProgressFlush?: boolean;
  targetDocSync?: () => Promise<{
    history?: SessionHistoryInput[];
    meta?: SessionMeta;
  } | void>;
  workerBootId?: string;
}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lody-operation-coordinator-'));
  roots.add(root);
  const storePath = path.join(root, 'operations.sqlite3');
  const workspaceId = 'workspace-1' as WorkspaceId;
  const machineId = 'machine-1' as MachineId;
  const requesterSessionId = 'requester-1' as SessionId;
  const targetSessionId = 'target-1' as SessionId;
  const targetInputDurable = options?.targetInputDurable ?? true;
  const histories = new Map<SessionId, SessionHistoryInput[]>([
    [requesterSessionId, []],
    [
      targetSessionId,
      targetInputDurable
        ? [
            {
              id: 'turn-1',
              role: 'user',
              timestamp: '2026-07-20T00:00:00.000Z',
              items: [{ type: 'text', text: 'work' }],
              fileDiff: [],
              status: 'pending',
            },
          ]
        : [],
    ],
  ]);
  const targetMeta = {
    id: targetSessionId,
    workspaceId,
    machineId,
    userId: 'user-1',
    cliType: 'builtin',
    agentType: 'codex',
    ...(targetInputDurable ? { latestUserMsgId: 'turn-1' } : {}),
  } as SessionMeta;
  const metas = new Map<SessionId, SessionMeta>([
    [
      requesterSessionId,
      {
        id: requesterSessionId,
        workspaceId,
        machineId,
        userId: 'user-1',
        cliType: 'builtin',
        agentType: 'codex',
        isArchived: options?.requesterArchived ?? false,
      } as SessionMeta,
    ],
    ...(targetInputDurable ? ([[targetSessionId, targetMeta]] as const) : []),
  ]);
  const subscribers = new Map<SessionId, Set<() => void>>();
  let historyUpdateAttempt = 0;
  let remainingProgressHistoryFailures = options?.progressHistoryFailures ?? 0;
  const flushRepo = async () => {
    if (options?.failProgressFlush) throw new Error('flush unavailable');
  };
  const sessionDoc = (sessionId: SessionId) =>
    withHistoryPort({
      mirror: {
        subscribe: (callback: () => void) => {
          const set = subscribers.get(sessionId) ?? new Set();
          set.add(callback);
          subscribers.set(sessionId, set);
          return () => set.delete(callback);
        },
      },
      // `subscribeSessionChanges` needs the session-data surface; the fake drives
      // change notification through its own `mirror.subscribe` set above.
      sessionData: {
        history: {
          count: async () => 0,
          readAt: async () => ({ state: 'missing' as const }),
          readTurn: async (turnId: string) => {
            const turn = (histories.get(sessionId) ?? []).find((entry) => entry.id === turnId);
            return turn ? { state: 'ready' as const, turn } : { state: 'missing' as const };
          },
          readRange: async () => [],
          readDirectory: async () => [],
          observe: (listener: () => void) => {
            const set = subscribers.get(sessionId) ?? new Set();
            set.add(listener);
            subscribers.set(sessionId, set);
            return { initial: Promise.resolve([]), unsubscribe: () => set.delete(listener) };
          },
        },
        commands: {},
        durability: { waitDurable: async () => {} },
      },
      getHistory: () => histories.get(sessionId) ?? [],
      updateHistory: async (update: (history: SessionHistoryInput[]) => SessionHistoryInput[]) => {
        const current = histories.get(sessionId) ?? [];
        const next = update(current);
        if (sessionId === requesterSessionId) {
          await options?.beforeRequesterHistoryWrite?.();
          historyUpdateAttempt += 1;
          if (historyUpdateAttempt <= (options?.historyFailuresBeforeSuccess ?? 0)) {
            throw new Error('transient history write failure');
          }
        }
        const progressItems = (history: SessionHistoryInput[]) =>
          history.flatMap(
            (entry) => entry.items?.filter((item) => item.type === 'operation_progress') ?? []
          );
        if (
          sessionId === requesterSessionId &&
          JSON.stringify(progressItems(next)) !== JSON.stringify(progressItems(current)) &&
          (options?.failProgressHistoryWrites === true || remainingProgressHistoryFailures > 0)
        ) {
          remainingProgressHistoryFailures = Math.max(0, remainingProgressHistoryFailures - 1);
          throw new Error('progress history unavailable');
        }
        histories.set(sessionId, next);
      },
      ...(targetInputDurable || options?.failProgressFlush === true
        ? { flushLocalWrites: flushRepo }
        : {}),
    });
  const flockRows = options?.machineAgentConfig
    ? [
        {
          key: machineFlockKeys.agentConfig(options.machineAgentConfig.id),
          value: options.machineAgentConfig,
        },
      ]
    : [];
  const flockScan = vi.fn((scanOptions?: { prefix?: readonly unknown[] }) => {
    const prefix = scanOptions?.prefix;
    return prefix
      ? flockRows.filter((row) => prefix.every((part, index) => row.key[index] === part))
      : flockRows;
  });
  const openFlockDoc = vi.fn(async () => ({ flock: { scan: flockScan } }));
  const getRepoMeta = vi.fn(() => {
    throw new Error('Inbox configuration lookup must not enumerate repo meta');
  });
  const getDocMeta = vi.fn(async (roomId: string) => {
    if (
      options?.legacyAgentConfig &&
      getAgentConfigRoomId(options.legacyAgentConfig.id) === roomId
    ) {
      return { meta: options.legacyAgentConfig };
    }
    if (roomId === getSessionRoomId(targetSessionId)) await options?.beforeTargetMetaRead?.();
    const sessionId = [...metas.keys()].find((candidate) => getSessionRoomId(candidate) === roomId);
    if (!sessionId) return undefined;
    const meta = metas.get(sessionId);
    return meta ? { meta } : undefined;
  });
  const repo = {
    flush: flushRepo,
    watch: () => ({ unsubscribe: vi.fn() }),
    getDocMeta,
    getMeta: getRepoMeta,
    openFlockDoc,
  };
  let pendingUser = options?.pendingUser ?? false;
  let busy = options?.busy ?? false;
  const continueSession = vi.fn(
    async (
      message: unknown,
      dispatch?: {
        inboxBatch?: import('./inbox/model').InboxBatch;
        notificationAudience?: TurnResultAudience;
      }
    ) => {
      const typedMessage = message as { sessionId: SessionId; userTurnId: string };
      await options?.beforeTurnClaim?.();
      const assistantTurnId = `assistant:${typedMessage.userTurnId}`;
      const batch = dispatch?.inboxBatch;
      const executionStore = batch
        ? new LodyOperationStore(storePath, () => TEST_NOW_MS)
        : undefined;
      if (batch && executionStore) {
        expect(executionStore.inbox.begin(batch, assistantTurnId)).toBe(true);
        expect(executionStore.inbox.fence(batch, assistantTurnId)).toBe(true);
      }
      histories.set(typedMessage.sessionId, [
        ...(histories.get(typedMessage.sessionId) ?? []),
        {
          id: assistantTurnId,
          role: 'assistant',
          userTurnId: typedMessage.userTurnId,
          timestamp: '2026-07-20T00:00:01.000Z',
          items: [{ type: 'text', text: 'continued' }],
          fileDiff: [],
          finished: true,
        },
      ]);
      if (batch && executionStore) {
        executionStore.inbox.settle(batch, 'settled');
        executionStore.inbox.release({ ...batch, executionId: assistantTurnId, outcome: 'normal' });
        executionStore.close();
      }
      options?.afterTurnComplete?.();
    }
  );
  const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const syncMachineFlockDoc = vi.fn(
    async () =>
      await (options?.configurationSync?.() ??
        Promise.resolve(options?.configurationSyncSucceeds ?? true))
  );
  const syncRemoteDocOrThrow = vi.fn(async (docId: string) => {
    if (docId !== getSessionRoomId(targetSessionId)) return;
    const synced = await options?.targetDocSync?.();
    if (synced?.history) histories.set(targetSessionId, synced.history);
    if (synced?.meta) metas.set(targetSessionId, synced.meta);
  });
  const storeLifecycle = { opened: 0, closed: 0 };
  const openedStores: LodyOperationStore[] = [];
  let attachedInbox: unknown;
  const storeFactory = () => {
    options?.beforeStoreOpen?.();
    storeLifecycle.opened += 1;
    const factoryStore = new LodyOperationStore(storePath, options?.now ?? (() => TEST_NOW_MS));
    openedStores.push(factoryStore);
    const activate = factoryStore.inbox.activate.bind(factoryStore.inbox);
    factoryStore.inbox.activate = (activatedWorkspaceId, owner) => {
      options?.beforeActivate?.();
      activate(activatedWorkspaceId, owner);
    };
    const close = factoryStore.close.bind(factoryStore);
    factoryStore.close = () => {
      storeLifecycle.closed += 1;
      close();
    };
    return factoryStore;
  };
  const resolveUser = vi.fn(async (userId: string) => {
    if (options?.resolveUserFails) {
      throw new Error('convex unreachable');
    }
    return { id: userId, name: 'Ada Lovelace', email: 'ada@example.com' };
  });
  let operationStoreWake: ((filename: string | Buffer | null) => void) | undefined;
  let materializationAttempt = 0;
  const materializeTarget = vi.fn(async () => {
    if (options?.materializeTargetOverride) {
      await options.materializeTargetOverride();
      return;
    }
    if (targetInputDurable) {
      throw new Error('target should already be durable');
    }
    materializationAttempt += 1;
    const shouldFail =
      materializationAttempt <= (options?.materializationFailuresBeforeSuccess ?? 0);
    if (
      !shouldFail ||
      options?.materializationWritesBeforeFailure === true ||
      options?.materializationWritesDocBeforeFailure === true
    ) {
      metas.set(targetSessionId, {
        ...targetMeta,
        ...(!shouldFail || options?.materializationWritesBeforeFailure === true
          ? { latestUserMsgId: 'turn-1' }
          : {}),
      });
      histories.set(targetSessionId, [
        {
          id: 'turn-1',
          role: 'user',
          timestamp: '2026-07-20T00:00:00.000Z',
          items: [{ type: 'text', text: 'work' }],
          fileDiff: [],
          status: 'pending',
        },
      ]);
    }
    if (shouldFail) throw new Error('transient Streams failure');
  });
  const coordinatorOptions = {
    workspaceId,
    machineId,
    userId: 'user-1',
    userResolver: { resolve: resolveUser },
    workspaceDocument: {
      repo,
      getOrCreateSessionDoc: async (sessionId: SessionId) => sessionDoc(sessionId),
      syncRemoteDocOrThrow,
      syncMachineFlockDoc,
    } as never,
    executionService: {
      quiesceInboxExecutions: () => {
        busy = false;
      },
      setOperationInbox: (inbox: unknown) => {
        attachedInbox = inbox;
      },
      getExecutionSnapshot: () => ({
        hasActiveTurn: busy,
        ...(busy && options?.activeTurnId ? { activeTurnId: options.activeTurnId } : {}),
      }),
      continueSession,
    } as never,
    dispatchWatcher: { hasPendingDispatch: () => pendingUser } as never,
    logger: logger as never,
    storeFactory,
    onAvailabilityChange: options?.onAvailabilityChange,
    storePath,
    now: options?.now ?? (() => TEST_NOW_MS),
    ...(options?.workerBootId ? { workerBootId: options.workerBootId } : {}),
    operationStoreWatchFactory: (_directory, onChange) => {
      operationStoreWake = onChange;
      return { close: vi.fn() };
    },
    materializeTarget,
    confirmTargetReadable: options?.confirmTargetReadable,
  } satisfies ConstructorParameters<typeof LodyOperationCoordinator>[0];
  const coordinator = new LodyOperationCoordinator(coordinatorOptions);
  const store = new LodyOperationStore(storePath, () => TEST_NOW_MS);
  store.accept({
    workspaceId,
    ownerMachineId: machineId,
    requesterSessionId,
    requesterUserId: 'user-1',
    operationId: 'review-round-1',
    ...(options?.author ? { author: options.author } : {}),
    kind: options?.operationKind ?? 'session_chat',
    canonicalCommand: { sessionId: targetSessionId, prompt: 'work' },
    frozenContinuationConfig: {
      ...(options?.author ? { sourceTurnId: options.author.turnId } : {}),
      ...(options?.agentConfigId ? { agentConfigId: options.agentConfigId } : {}),
      inputConfig: { cliType: 'builtin', agentType: 'codex', chainDepth: 0 },
    },
    initiatorChainDepth: 0,
    createdAt: '2026-07-19T00:00:00.000Z',
    deadlineAt: options?.deadlineAt ?? '2026-07-21T00:00:00.000Z',
    items: [
      {
        status: 'active',
        target: { sessionId: targetSessionId, userTurnId: 'turn-1' },
        inputDurable: options?.acceptedInputDurable ?? targetInputDurable,
      },
    ],
  });
  store.close();
  return {
    coordinator,
    coordinatorOptions,
    continueSession,
    resolveUser,
    histories,
    metas,
    requesterSessionId,
    targetSessionId,
    storePath,
    storeLifecycle,
    openedStores,
    getAttachedInbox: () => attachedInbox,
    isBusy: () => busy,
    syncMachineFlockDoc,
    syncRemoteDocOrThrow,
    flockScan,
    getDocMeta,
    getRepoMeta,
    openFlockDoc,
    logger,
    materializeTarget,
    notifyTargetHistory: () => {
      for (const callback of subscribers.get(targetSessionId) ?? []) callback();
    },
    setProgressWriteFailures: (count: number) => {
      remainingProgressHistoryFailures = count;
    },
    triggerOperationStoreWake: () => operationStoreWake?.(path.basename(storePath)),
    setPendingUser: (value: boolean) => {
      pendingUser = value;
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
};

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe('LodyOperationCoordinator', () => {
  it.each(['open', 'activate', 'watch'])(
    'degrades after %s failure and recovers without restarting',
    async (boundary) => {
      vi.useFakeTimers({
        toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      });
      let failed = true;
      const warnings: (string | undefined)[] = [];
      const fault = () => {
        if (failed) throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
      };
      const h = await makeHarness({
        targetInputDurable: false,
        ...(boundary === 'open'
          ? { beforeStoreOpen: fault }
          : boundary === 'activate'
            ? { beforeActivate: fault }
            : {}),
        onAvailabilityChange: (message) => warnings.push(message),
      });
      if (boundary === 'watch') {
        h.setBusy(true);
        const watch = h.coordinatorOptions.operationStoreWatchFactory;
        h.coordinatorOptions.operationStoreWatchFactory = (directory, onChange) => {
          fault();
          return watch(directory, onChange);
        };
      }
      try {
        expect(() => h.coordinator.start()).not.toThrow();
        expect(warnings.at(-1)).toContain('SQLITE_FULL');
        expect(() => h.coordinator.assertInboxAvailable()).toThrow('INBOX_UNAVAILABLE');
        await expect(h.coordinator.wake('dependent-call')).rejects.toThrow('INBOX_UNAVAILABLE');
        await h.coordinator.idle();
        expect(h.coordinator.hasPendingWorkForRequester(h.requesterSessionId)).toBe(false);
        // Degraded Inbox runs no turn work, so scheduled messages are not held as busy.
        expect(h.coordinator.hasTurnWorkForRequester(h.requesterSessionId)).toBe(false);
        expect(h.histories.get(h.targetSessionId)).toEqual([]);
        expect(h.storeLifecycle.closed).toBe(h.storeLifecycle.opened);
        expect(h.getAttachedInbox()).toBeUndefined();
        if (boundary === 'watch') expect(h.isBusy()).toBe(true);
        for (const store of h.openedStores)
          expect(() => store.get(h.requesterSessionId, 'review-round-1')).toThrow();
        await vi.advanceTimersByTimeAsync(30_000);
        failed = false;
        await vi.advanceTimersByTimeAsync(59_999);
        expect(() => h.coordinator.assertInboxAvailable()).toThrow('INBOX_UNAVAILABLE');
        await vi.advanceTimersByTimeAsync(1);
        await h.coordinator.idle();
        expect(() => h.coordinator.assertInboxAvailable()).not.toThrow();
        expect(warnings.at(-1)).toBeUndefined();
        expect(h.getAttachedInbox()).toBeDefined();
        expect(h.histories.get(h.targetSessionId)?.[0]?.id).toBe('turn-1');
      } finally {
        await h.coordinator.stop();
      }
      expect(h.storeLifecycle.closed).toBe(h.storeLifecycle.opened);
    }
  );

  it('bounds startup backoff and cancels it on stop', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    let failing = true;
    let attempts = 0;
    const h = await makeHarness({
      beforeStoreOpen: () => {
        attempts++;
        if (failing) throw new Error('storage unavailable');
      },
    });
    h.coordinator.start();
    for (const [index, delay] of [
      30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000,
    ].entries()) {
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(delay);
      expect(attempts).toBe(index + 2);
      expect(() => h.coordinator.assertInboxAvailable()).toThrow('INBOX_UNAVAILABLE');
    }
    await h.coordinator.recoverStop();
    expect(vi.getTimerCount()).toBe(0);
    failing = false;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.storeLifecycle).toEqual({ opened: 0, closed: 0 });
    expect(attempts).toBe(8);
    try {
      h.coordinator.start();
      await h.coordinator.idle();
      expect(() => h.coordinator.assertInboxAvailable()).not.toThrow();
    } finally {
      await h.coordinator.stop();
    }
    expect(h.storeLifecycle).toEqual({ opened: 1, closed: 1 });
  });

  it('keeps a newer database byte-for-byte unchanged while degraded', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const h = await makeHarness();
    const db = new Database(h.storePath);
    db.prepare("UPDATE orchestration_meta SET value='99' WHERE key='schema_version'").run();
    db.close();
    const before = await readFile(h.storePath);
    try {
      h.coordinator.start();
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(() => h.coordinator.assertInboxAvailable()).toThrow('INBOX_UNAVAILABLE');
      expect(vi.getTimerCount()).toBe(0);
      expect(await readFile(h.storePath)).toEqual(before);
    } finally {
      await h.coordinator.recoverStop();
    }
  });

  it.each(['INBOX_SCHEMA_UNSUPPORTED', 'INBOX_PROTOCOL_REQUIRED'])(
    'does not retry or write after %s',
    async (reason) => {
      vi.useFakeTimers({
        toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      });
      const h = await makeHarness({
        beforeActivate: () => {
          throw new Error(reason);
        },
      });
      const readModes = () => {
        const db = new Database(h.storePath, { readonly: true });
        try {
          return db.prepare('SELECT * FROM inbox_modes').all();
        } finally {
          db.close();
        }
      };
      const before = readModes();
      try {
        expect(() => h.coordinator.start()).not.toThrow();
        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(vi.getTimerCount()).toBe(0);
        expect(h.storeLifecycle).toEqual({ opened: 1, closed: 1 });
        expect(() => h.coordinator.assertInboxAvailable()).toThrow('INBOX_UNAVAILABLE');
        expect(readModes()).toEqual(before);
      } finally {
        await h.coordinator.stop();
      }
    }
  );

  it.each([
    undefined,
    {
      v: 1 as const,
      kind: 'agent' as const,
      sessionId: 'requester-1',
      turnId: 'origin-turn',
      name: 'Delegating agent',
    },
  ])('keeps synthetic Inbox continuations silent with frozen author %j', async (author) => {
    const completed = Promise.withResolvers<void>();
    const harness = await makeHarness({ author, afterTurnComplete: completed.resolve });
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      store.finish(harness.requesterSessionId, 'review-round-1', {
        type: 'result',
        value: { items: [] },
      });
      harness.coordinator.start();
      await completed.promise;
      await harness.coordinator.stop();

      const [message, dispatch] = harness.continueSession.mock.calls[0] ?? [];
      expect(dispatch?.notificationAudience).toEqual({ kind: 'unknown' });
      const input = message as { userTurnId: string };
      expect(
        projectTurnAttention({
          scope: { workspaceId: harness.coordinatorOptions.workspaceId, recipientId: 'user-1' },
          sessionId: harness.requesterSessionId,
          turnId: input.userTurnId,
          audience: dispatch?.notificationAudience ?? { kind: 'user' },
          outcome: { kind: 'succeeded' },
        })
      ).toBeNull();
      expect(queuedResults(store, harness.coordinatorOptions.workspaceId)).toEqual([]);
      expect(harness.histories.get(harness.requesterSessionId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            userTurnId: input.userTurnId,
            finished: true,
          }),
        ])
      );
      expect(store.get(harness.requesterSessionId, 'review-round-1').author).toEqual(author);
    } finally {
      store.close();
      await harness.coordinator.stop();
    }
  });

  it('recovers local creation using daemon authority even when remote Streams is unavailable', async () => {
    const harness = await makeHarness({
      targetInputDurable: false,
      operationKind: 'session_create',
      targetDocSync: async () => {
        throw new Error('No remote Streams in OSS');
      },
      confirmTargetReadable: async () => {},
    });
    harness.coordinator.start();
    try {
      await harness.coordinator.idle();
      expect(
        harness.histories.get(harness.targetSessionId)?.filter((turn) => turn.id === 'turn-1')
      ).toHaveLength(1);
      await harness.coordinator.wake('retry');
      expect(
        harness.histories.get(harness.targetSessionId)?.filter((turn) => turn.id === 'turn-1')
      ).toHaveLength(1);
      expect(harness.syncRemoteDocOrThrow).not.toHaveBeenCalled();
      const history = harness.histories.get(harness.targetSessionId);
      if (!history?.[0]) throw new Error('Missing materialized target');
      history[0] = { ...history[0], status: 'handled' };
      history.push({
        id: 'assistant:turn-1',
        role: 'assistant',
        userTurnId: 'turn-1',
        timestamp: '2026-07-20T00:00:00.500Z',
        items: [{ type: 'text', text: 'local result' }],
        fileDiff: [],
        finished: true,
      });
      await harness.coordinator.wake('local-target-finished');
      await harness.coordinator.wake('duplicate-finish');
      const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        expect(store.get(harness.requesterSessionId, 'review-round-1')).toMatchObject({
          state: 'finished',
          completion: {
            type: 'result',
            value: { items: [{ status: 'succeeded', output: { text: 'local result' } }] },
          },
        });
        expect(queuedResults(store, 'workspace-1' as WorkspaceId)).toHaveLength(1);
        expect(
          harness.histories
            .get(harness.requesterSessionId)
            ?.filter((turn) => turn.role === 'assistant')
        ).toHaveLength(0);
      } finally {
        store.close();
      }
    } finally {
      await harness.coordinator.stop();
    }
  });

  it('retries transient target materialization on its own bounded timer', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const harness = await makeHarness({
      targetInputDurable: false,
      materializationFailuresBeforeSuccess: 2,
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    harness.triggerOperationStoreWake();
    await vi.advanceTimersByTimeAsync(10);
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(489);
    await harness.coordinator.wake('session-meta');
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_999);
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(3);

    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1').items[0]).toMatchObject({
        status: 'active',
        inputDurable: true,
        target: { sessionId: harness.targetSessionId, userTurnId: 'turn-1' },
      });
    } finally {
      store.close();
      await harness.coordinator.stop();
    }
  });

  it('recognizes an ambiguous successful write before retrying materialization', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const harness = await makeHarness({
      targetInputDurable: false,
      materializationFailuresBeforeSuccess: 1,
      materializationWritesBeforeFailure: true,
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(1);

    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1').items[0]).toMatchObject({
        status: 'active',
        inputDurable: true,
        target: { sessionId: harness.targetSessionId, userTurnId: 'turn-1' },
      });
    } finally {
      store.close();
      await harness.coordinator.stop();
    }
  });

  it('waits for cross-replica target catch-up before replaying a fixed turn', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const fixedTurn: SessionHistoryInput = {
      id: 'turn-1',
      role: 'user',
      timestamp: '2026-07-20T00:00:00.000Z',
      items: [{ type: 'text', text: 'work' }],
      fileDiff: [],
      status: 'pending',
    };
    const acceptorReplica = new LoroDoc();
    acceptorReplica.getList('history').insert(0, fixedTurn);
    acceptorReplica.commit();
    const daemonReplica = new LoroDoc();
    let syncAttempt = 0;
    const readDaemonHistory = (): SessionHistoryInput[] => {
      const fixedCount = daemonReplica
        .getList('history')
        .toJSON()
        .filter(
          (entry: unknown) =>
            typeof entry === 'object' &&
            entry !== null &&
            'id' in entry &&
            entry.id === fixedTurn.id
        ).length;
      return fixedCount > 0 ? [fixedTurn] : [];
    };
    const harness = await makeHarness({
      targetInputDurable: false,
      targetDocSync: async () => {
        syncAttempt += 1;
        if (syncAttempt === 1) {
          throw new Error('target bootstrap unavailable');
        }
        daemonReplica.import(acceptorReplica.export({ mode: 'update' }));
        return {
          history: readDaemonHistory(),
          meta: {
            id: 'target-1' as SessionId,
            workspaceId: 'workspace-1' as WorkspaceId,
            machineId: 'machine-1' as MachineId,
            userId: 'user-1',
            cliType: 'builtin',
            agentType: 'codex',
            latestUserMsgId: fixedTurn.id,
          },
        };
      },
      materializeTargetOverride: async () => {
        daemonReplica.getList('history').insert(0, fixedTurn);
        daemonReplica.commit();
      },
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    expect(harness.syncRemoteDocOrThrow).toHaveBeenCalledTimes(1);
    expect(harness.materializeTarget).not.toHaveBeenCalled();
    let store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    expect(store.get(harness.requesterSessionId, 'review-round-1').items[0]).toMatchObject({
      status: 'active',
      inputDurable: false,
    });
    store.close();

    await vi.advanceTimersByTimeAsync(1_000);
    await harness.coordinator.idle();

    expect(harness.syncRemoteDocOrThrow).toHaveBeenCalledTimes(2);
    expect(harness.materializeTarget).not.toHaveBeenCalled();
    expect(
      daemonReplica
        .getList('history')
        .toJSON()
        .filter(
          (entry: unknown) =>
            typeof entry === 'object' &&
            entry !== null &&
            'id' in entry &&
            entry.id === fixedTurn.id
        )
    ).toHaveLength(1);
    store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1').items[0]).toMatchObject({
        status: 'active',
        inputDurable: true,
      });
    } finally {
      store.close();
      await harness.coordinator.stop();
    }
  });

  it('replays when the fixed turn exists but its dispatch pointer was not written', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const harness = await makeHarness({
      targetInputDurable: false,
      materializationFailuresBeforeSuccess: 1,
      materializationWritesDocBeforeFailure: true,
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await harness.coordinator.idle();
    expect(harness.materializeTarget).toHaveBeenCalledTimes(2);

    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1').items[0]).toMatchObject({
        status: 'active',
        inputDurable: true,
        target: { sessionId: harness.targetSessionId, userTurnId: 'turn-1' },
      });
    } finally {
      store.close();
      await harness.coordinator.stop();
    }
  });

  it('does not replay a handled fixed turn after the latest pointer advances', async () => {
    const harness = await makeHarness({
      targetInputDurable: true,
      acceptedInputDurable: false,
    });
    harness.metas.set(harness.targetSessionId, {
      ...harness.metas.get(harness.targetSessionId)!,
      latestUserMsgId: 'turn-2',
      lastHandledUserMsgId: 'turn-1',
    });

    harness.coordinator.start();
    await harness.coordinator.idle();

    expect(harness.materializeTarget).not.toHaveBeenCalled();
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1').items[0]).toMatchObject({
        status: 'active',
        inputDurable: true,
      });
    } finally {
      store.close();
      await harness.coordinator.stop();
    }
  });

  it('does not start materialization after the deadline passes during an evidence read', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const deadlineMs = TEST_NOW_MS + 1;
    let nowMs = TEST_NOW_MS;
    let releaseMetaReadSignal!: () => void;
    let markMetaReadStarted!: () => void;
    const metaReadStarted = new Promise<void>((resolve) => {
      markMetaReadStarted = resolve;
    });
    const releaseMetaRead = new Promise<void>((resolve) => {
      releaseMetaReadSignal = resolve;
    });
    let firstTargetMetaRead = true;
    const harness = await makeHarness({
      targetInputDurable: false,
      deadlineAt: new Date(deadlineMs).toISOString(),
      now: () => nowMs,
      beforeTargetMetaRead: async () => {
        if (!firstTargetMetaRead) return;
        firstTargetMetaRead = false;
        markMetaReadStarted();
        await releaseMetaRead;
      },
    });

    harness.coordinator.start();
    await metaReadStarted;
    nowMs = deadlineMs;
    releaseMetaReadSignal();
    await harness.coordinator.idle();

    expect(harness.materializeTarget).not.toHaveBeenCalled();
    const store = new LodyOperationStore(harness.storePath, () => nowMs);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1').items[0]).toMatchObject({
        status: 'failed',
        error: { code: 'TARGET_TIMEOUT' },
      });
    } finally {
      store.close();
      await harness.coordinator.stop();
    }
  });

  it('does not start materialization after the deadline passes during target catch-up', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const deadlineMs = TEST_NOW_MS + 1;
    let nowMs = TEST_NOW_MS;
    let releaseTargetSync!: () => void;
    let markTargetSyncStarted!: () => void;
    const targetSyncStarted = new Promise<void>((resolve) => {
      markTargetSyncStarted = resolve;
    });
    const targetSyncRelease = new Promise<void>((resolve) => {
      releaseTargetSync = resolve;
    });
    const harness = await makeHarness({
      targetInputDurable: false,
      deadlineAt: new Date(deadlineMs).toISOString(),
      now: () => nowMs,
      targetDocSync: async () => {
        markTargetSyncStarted();
        await targetSyncRelease;
      },
    });

    harness.coordinator.start();
    await targetSyncStarted;
    nowMs = deadlineMs;
    releaseTargetSync();
    await harness.coordinator.idle();

    expect(harness.materializeTarget).not.toHaveBeenCalled();
    const store = new LodyOperationStore(harness.storePath, () => nowMs);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1').items[0]).toMatchObject({
        status: 'failed',
        error: { code: 'TARGET_TIMEOUT' },
      });
    } finally {
      store.close();
      await harness.coordinator.stop();
    }
  });

  it('turns an unterminal target into TARGET_TIMEOUT without cancelling it', async () => {
    const harness = await makeHarness({ deadlineAt: '2026-07-19T23:59:59.000Z' });
    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.stop();

    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'finished',
        completion: {
          type: 'result',
          value: { items: [{ status: 'failed', error: { code: 'TARGET_TIMEOUT' } }] },
        },
      });
    } finally {
      store.close();
    }
  });

  it.each([
    {
      status: 'failed' as const,
      expected: { status: 'failed', error: { code: 'TARGET_FAILED' } },
    },
    {
      status: 'canceled' as const,
      expected: { status: 'cancelled' },
    },
    {
      status: 'canceled' as const,
      cancellationReason: 'user_stop' as const,
      expected: { status: 'cancelled', cancellationReason: 'user_stop' },
    },
  ])(
    'keeps $status ahead of terminal assistant partial output',
    async ({ status, expected, ...source }) => {
      const harness = await makeHarness();
      const targetHistory = harness.histories.get(harness.targetSessionId)!;
      targetHistory[0] = { ...targetHistory[0]!, status, ...source };
      targetHistory.push({
        id: 'assistant:turn-1',
        role: 'assistant',
        userTurnId: 'turn-1',
        timestamp: '2026-07-20T00:00:00.500Z',
        items: [{ type: 'text', text: 'partial output' }],
        fileDiff: [],
        finished: true,
      });

      harness.coordinator.start();
      await harness.coordinator.idle();
      await harness.coordinator.stop();

      const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        expect(store.get(harness.requesterSessionId, 'review-round-1')).toMatchObject({
          state: 'finished',
          completion: { type: 'result', value: { items: [expected] } },
        });
        if ('cancellationReason' in source) {
          expect(queuedResults(store, harness.coordinatorOptions.workspaceId)).toEqual([]);
          expect(
            harness.histories
              .get(harness.requesterSessionId)
              ?.some((turn) => turn.role === 'assistant')
          ).toBe(false);
        }
      } finally {
        store.close();
      }
    }
  );

  it('uses durable local Stop before stale partial output or an expired deadline can return a receipt', async () => {
    const harness = await makeHarness({ deadlineAt: '2026-07-19T00:00:00Z' });
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      const input = {
        workspaceId: harness.coordinatorOptions.workspaceId,
        sessionId: harness.targetSessionId,
        userId: 'user-1',
        inputId: 'turn-1',
        kind: 'task' as const,
        config: {},
      };
      store.inbox.activate(input.workspaceId, 'target-owner');
      store.inbox.accept(input);
      store.inbox.begin(input, 'target-execution');
      expect(store.inbox.pause(input, 'target-execution', [], 'manual-stop')).toBe(true);
      // The cancellation projection has not arrived. The requester sees only partial terminal output.
      harness.histories.get(harness.targetSessionId)?.push({
        id: 'partial',
        role: 'assistant',
        userTurnId: 'turn-1',
        timestamp: '2026-07-20T00:00:00Z',
        items: [{ type: 'text', text: 'partial' }],
        finished: true,
        fileDiff: [],
      });
      harness.coordinator.start();
      await harness.coordinator.idle();
      await harness.coordinator.stop();
      expect(store.get(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'finished',
        completion: {
          type: 'result',
          value: { items: [{ status: 'cancelled', cancellationReason: 'user_stop' }] },
        },
      });
      expect(queuedResults(store, input.workspaceId)).toEqual([]);
      expect(
        harness.histories.get(harness.requesterSessionId)?.some((turn) => turn.role === 'assistant')
      ).toBe(false);
    } finally {
      await harness.coordinator.stop();
      store.close();
    }
  });

  it('holds one store connection for its lifetime instead of churning WAL sidecars', async () => {
    // Regression: per-reconcile open/close deletes and recreates the SQLite
    // WAL/SHM files, which the store directory watcher observes as fresh
    // events — a self-sustaining wake loop that starves the event loop.
    const harness = await makeHarness();

    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.wake('hint-1');
    await harness.coordinator.idle();
    await harness.coordinator.wake('hint-2');
    await harness.coordinator.idle();
    expect(harness.storeLifecycle).toEqual({ opened: 1, closed: 0 });

    await harness.coordinator.stop();
    expect(harness.storeLifecycle).toEqual({ opened: 1, closed: 1 });
  });

  it('keeps durable create targets queued until exact target execution evidence is present', async () => {
    const harness = await makeHarness({
      operationKind: 'session_create',
      targetInputDurable: true,
      acceptedInputDurable: true,
      busy: true,
      activeTurnId: 'assistant:unrelated-turn',
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.stop();

    const progress = harness.histories
      .get(harness.requesterSessionId)
      ?.find((entry) => entry.id === 'operation-progress:requester-1:review-round-1');
    expect(progress?.items).toEqual([
      {
        type: 'operation_progress',
        operationId: 'review-round-1',
        operationKind: 'session_create',
        items: [{ target: { sessionId: 'target-1', userTurnId: 'turn-1' }, status: 'created' }],
      },
    ]);
  });

  it('marks create progress running only for the exact target turn', async () => {
    const harness = await makeHarness({
      operationKind: 'session_create',
      targetInputDurable: true,
      acceptedInputDurable: true,
      busy: true,
      activeTurnId: 'assistant:turn-1',
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.stop();

    const progress = harness.histories
      .get(harness.requesterSessionId)
      ?.find((entry) => entry.id === 'operation-progress:requester-1:review-round-1');
    expect(progress?.items).toEqual([
      {
        type: 'operation_progress',
        operationId: 'review-round-1',
        operationKind: 'session_create',
        items: [{ target: { sessionId: 'target-1', userTurnId: 'turn-1' }, status: 'running' }],
      },
    ]);
  });

  it.each(
    (['deadline', 'cancelled', 'error'] as const).flatMap((reason) =>
      (['succeeded', 'failed', 'cancelled'] as const).map((terminal) => ({ reason, terminal }))
    )
  )(
    'reconciles target $terminal after root $reason, delivery and daemon restart without another continuation',
    async ({ reason, terminal }) => {
      const completed = Promise.withResolvers<void>();
      const harness = await makeHarness({
        afterTurnComplete: () => completed.resolve(),
        operationKind: 'session_create',
        deadlineAt: reason === 'deadline' ? '2026-07-19T23:59:59.000Z' : '2026-07-21T00:00:00.000Z',
      });
      if (reason !== 'deadline') {
        const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
        try {
          if (reason === 'cancelled') store.cancel(harness.requesterSessionId, 'review-round-1');
          else
            store.finish(harness.requesterSessionId, 'review-round-1', {
              type: 'error',
              error: {
                code: 'COORDINATOR_FAILED',
                message: 'synthetic root error',
                retryable: false,
              },
            });
        } finally {
          store.close();
        }
      }
      const targetHistory = harness.histories.get(harness.targetSessionId);
      const targetTurn = targetHistory?.[0];
      if (!targetHistory || !targetTurn) throw new Error('missing target fixture');
      targetHistory[0] = { ...targetTurn, status: 'processing' };
      const read = () => {
        const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
        try {
          return {
            pending: store.listPendingProgress(
              'workspace-1' as WorkspaceId,
              'machine-1' as MachineId
            ),
            deliveries: queuedResults(store, 'workspace-1' as WorkspaceId),
            completion: store.get(harness.requesterSessionId, 'review-round-1').completion,
          };
        } finally {
          store.close();
        }
      };
      const status = () =>
        harness.histories
          .get(harness.requesterSessionId)
          ?.flatMap((row) => row.items ?? [])
          .find((item) => item.type === 'operation_progress')?.items[0]?.status;
      harness.coordinator.start();
      await harness.coordinator.idle();
      expect(status()).toBe('running');
      expect(read().pending).toHaveLength(1);
      expect(read().deliveries).toHaveLength(1);
      const meta = harness.metas.get(harness.targetSessionId);
      if (!meta) throw new Error('missing target metadata fixture');
      harness.metas.delete(harness.targetSessionId);
      harness.notifyTargetHistory();
      await harness.coordinator.idle();
      expect(status()).toBe('running');
      expect(read().pending).toHaveLength(1);
      harness.metas.set(harness.targetSessionId, meta);
      await completed.promise;
      const rootResult = read().completion;
      const requesterBefore = harness.histories.get(harness.requesterSessionId) ?? [];
      const continuationIds = requesterBefore
        .filter((row) => row.role === 'assistant')
        .map((row) => row.id);
      expect(continuationIds).toHaveLength(1);
      await harness.coordinator.stop();
      // Opening the same SQLite store must restore observation even with no active Operation or runnable intent.
      harness.coordinator.start();
      await harness.coordinator.idle();
      expect(status()).toBe('running');
      targetHistory[0] = {
        ...targetTurn,
        status:
          terminal === 'succeeded' ? 'handled' : terminal === 'failed' ? 'failed' : 'canceled',
      };
      if (terminal === 'succeeded')
        targetHistory.push({
          id: 'late-answer',
          role: 'assistant',
          userTurnId: 'turn-1',
          timestamp: '2026-07-20T00:01:00.000Z',
          items: [{ type: 'text', text: 'late success' }],
          fileDiff: [],
          finished: true,
        });
      harness.notifyTargetHistory();
      await harness.coordinator.idle();
      expect(status()).toBe(terminal);
      expect(read().pending).toEqual([]);
      expect(read().completion).toEqual(rootResult);
      expect(
        harness.histories
          .get(harness.requesterSessionId)
          ?.filter((row) => row.role === 'assistant')
          .map((row) => row.id)
      ).toEqual(continuationIds);
      await harness.coordinator.stop();
    }
  );

  it('does not let an in-flight progress read write after the owning worker stops', async () => {
    let signalRead: () => void = () => {};
    let releaseRead: () => void = () => {};
    const readStarted = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const harness = await makeHarness({
      operationKind: 'session_create',
      beforeTargetMetaRead: async () => {
        signalRead();
        await readGate;
      },
    });
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      store.cancel(harness.requesterSessionId, 'review-round-1');
    } finally {
      store.close();
    }
    harness.coordinator.start();
    const wake = harness.coordinator.wake('observe-owner-stop');
    await readStarted;
    const closing = harness.coordinator.stop();
    expect(() => harness.coordinator.start()).toThrow('shutdown is not complete');
    releaseRead();
    await closing;
    await wake;
    expect(harness.histories.get(harness.requesterSessionId)).toEqual([]);
  });

  it('keeps progress pending until the terminal Loro write is flushed', async () => {
    const options = { operationKind: 'session_create' as const, failProgressFlush: true };
    const harness = await makeHarness(options);
    const targetHistory = harness.histories.get(harness.targetSessionId);
    if (!targetHistory) throw new Error('missing target fixture');
    targetHistory.push({
      id: 'answer',
      role: 'assistant',
      userTurnId: 'turn-1',
      timestamp: '2026-07-20T00:01:00.000Z',
      items: [{ type: 'text', text: 'done' }],
      fileDiff: [],
      finished: true,
    });
    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.stop();
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(queuedResults(store, 'workspace-1' as WorkspaceId)).toHaveLength(1);
      expect(
        store.listPendingProgress('workspace-1' as WorkspaceId, 'machine-1' as MachineId)
      ).toHaveLength(1);
    } finally {
      store.close();
    }
    options.failProgressFlush = false;
    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.stop();
    const recovered = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(
        recovered.listPendingProgress('workspace-1' as WorkspaceId, 'machine-1' as MachineId)
      ).toEqual([]);
    } finally {
      recovered.close();
    }
  });

  it('retries failed terminal progress writes after delivery without needing another history event', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const harness = await makeHarness({
      operationKind: 'session_create',
      deadlineAt: '2026-07-19T23:59:59.000Z',
    });
    const targetHistory = harness.histories.get(harness.targetSessionId);
    const targetTurn = targetHistory?.[0];
    if (!targetHistory || !targetTurn) throw new Error('missing target fixture');
    targetHistory[0] = { ...targetTurn, status: 'processing' };
    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.setProgressWriteFailures(1);
    targetHistory[0] = { ...targetTurn, status: 'failed' };
    harness.notifyTargetHistory();
    await harness.coordinator.idle();
    const status = () =>
      harness.histories
        .get(harness.requesterSessionId)
        ?.flatMap((row) => row.items ?? [])
        .find((item) => item.type === 'operation_progress')?.items[0]?.status;
    expect(status()).toBe('running');
    await vi.advanceTimersByTimeAsync(5_000);
    await harness.coordinator.idle();
    expect(status()).toBe('failed');
    await harness.coordinator.stop();
  });
});

it('reprojects a crashed submitting batch as unknown without starting model work', async () => {
  const h = await makeHarness();
  const store = new LodyOperationStore(h.storePath, () => TEST_NOW_MS);
  const input = {
    workspaceId: h.coordinatorOptions.workspaceId,
    sessionId: h.requesterSessionId,
    userId: 'user-1',
    inputId: 'human',
    kind: 'human' as const,
    config: { prompt: 'request' },
  };
  store.inbox.activate(input.workspaceId, 'old');
  store.finish(h.requesterSessionId, 'review-round-1', { type: 'result', value: { items: [] } });
  store.inbox.accept(input);
  store.inbox.begin(input, 'old-exec', 'old');
  const batch = store.inbox.prepare(input, 'old')!;
  store.inbox.fence(batch, 'old-exec');
  h.histories.set(h.requesterSessionId, [
    {
      id: `operation-batch:${batch.batchId}`,
      role: 'system',
      timestamp: '2026-07-20T00:00:00Z',
      items: [
        {
          type: 'operation_completion_batch',
          batchId: batch.batchId,
          memberCount: 1,
          members: [],
          deliveryStatus: 'prepared',
        },
      ],
      fileDiff: [],
      finished: true,
    },
  ]);
  store.close();
  h.coordinator.start();
  try {
    await h.coordinator.idle();
    expect(h.histories.get(h.requesterSessionId)?.[0]?.items?.[0]).toMatchObject({
      deliveryStatus: 'unknown',
    });
    expect(h.histories.get(h.requesterSessionId)).toHaveLength(1);
    expect(h.continueSession).not.toHaveBeenCalled();
    await h.coordinator.wake('duplicate');
    expect(h.histories.get(h.requesterSessionId)).toHaveLength(1);
  } finally {
    await h.coordinator.stop();
  }
});

it('recovers failed native close through the coordinator without resubmitting transport', async () => {
  const harness = await makeHarness();
  harness.coordinator.start();
  await harness.coordinator.idle();
  const bridge = (
    harness.coordinator as unknown as {
      inbox: import('./inbox/legacy').OperationInboxLegacy;
    }
  ).inbox;
  const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
  const input = {
    workspaceId: 'workspace-1',
    sessionId: harness.requesterSessionId,
    userId: 'user-1',
    inputId: 'fresh-human',
    kind: 'human' as const,
    config: { prompt: 'request' },
  };
  store.finish(harness.requesterSessionId, 'review-round-1', {
    type: 'result',
    value: { items: [] },
  });
  await bridge.accept(input);
  const owner = await bridge.openExecution(input, 'execution');
  const batch = owner.batch!;
  expect(batch.memberCount).toBe(1);
  const received: string[] = [];
  await owner.submit(() => received.push(batch.batchId));
  const db = new Database(harness.storePath);
  db.exec(
    "CREATE TRIGGER review_settle_outage BEFORE UPDATE OF state ON inbox_batches WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'settlement outage'); END;"
  );
  await owner.finish('normal');
  await expect(harness.coordinator.stop()).rejects.toThrow('Inbox Scope release failed');
  db.exec('DROP TRIGGER review_settle_outage');
  await harness.coordinator.recoverStop();
  expect(db.prepare('SELECT state FROM inbox_batches WHERE batch_id=?').get(batch.batchId)).toEqual(
    { state: 'settled' }
  );
  expect(received).toEqual([batch.batchId]);
  expect(await bridge.close()).toBeUndefined();
  harness.coordinator.start();
  await harness.coordinator.idle();
  await harness.coordinator.stop();
  db.close();
  store.close();
});

describe('native coordinator failure boundaries', () => {
  it.each([
    'retry',
    'deadline',
    'deadline-interrupt',
    'deadline-mixed-interrupt',
    'progress',
    'progress-interrupt',
    'progress-mixed-interrupt',
  ] as const)(
    'preserves Cause and durable Operation state at the %s boundary',
    async (scenario) => {
      const store = new LodyOperationStore(':memory:', () => TEST_NOW_MS);
      const interrupted = scenario.endsWith('interrupt');
      const cause = interrupted
        ? scenario.includes('mixed')
          ? Cause.combine(Cause.fail(new Error('cleanup failure')), Cause.interrupt(99))
          : Cause.interrupt(99)
        : Cause.combine(
            Cause.fail(new Error('storage failure')),
            Cause.die(new Error('adapter defect'))
          );
      const warnings: unknown[] = [];
      const operation = store.accept({
        workspaceId: 'workspace-1' as WorkspaceId,
        ownerMachineId: 'machine-1' as MachineId,
        requesterSessionId: 'requester-1' as SessionId,
        requesterUserId: 'user-1',
        operationId: 'cause-boundary',
        kind: scenario.startsWith('progress') ? 'session_create' : 'session_chat',
        canonicalCommand: { scenario },
        frozenContinuationConfig: { inputConfig: {} },
        initiatorChainDepth: 0,
        createdAt: new Date(TEST_NOW_MS).toISOString(),
        deadlineAt: new Date(
          TEST_NOW_MS + (scenario.startsWith('deadline') ? 0 : 60000)
        ).toISOString(),
        items: [
          {
            status: 'active',
            target: { sessionId: 'target-1' as SessionId, userTurnId: 'input-1' },
            inputDurable: true,
          },
        ],
      }).operation;
      const activity: CoordinatorActivity['Service'] = {
        wake: () => Effect.void,
        signal: () => Effect.void,
        arm: () => Effect.void,
        cancel: () => Effect.void,
        cancelWhere: () => Effect.void,
        has: () => false,
        drain: Effect.void,
      };
      const ports: CoordinatorPorts['Service'] = {
        active: () => true,
        now: () => TEST_NOW_MS,
        claimToken: 'claim',
        metadata: () => Effect.failCause(cause),
        session: () => Effect.fail(new Error('unexpected history access')),
        execution: () => ({}),
        operation: () => Effect.succeed({ signal: { aborted: false } }),
        cancelInactive: () => Effect.void,
        receipts: Effect.succeed([]),
        wakeInbox: Effect.void,
        confirmReadable: () => Effect.void,
        materialize: () => Effect.void,
        warn: (_message, detail) =>
          Effect.sync(() => {
            warnings.push(detail);
          }),
      };
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const repository = yield* OperationRepository;
              const scope = yield* Effect.scope;
              const core = new CoordinatorWorkflow(
                { workspaceId: operation.workspaceId, machineId: operation.ownerMachineId },
                ports,
                repository,
                activity,
                scope
              );
              const exit = yield* Effect.exit(
                scenario.startsWith('progress')
                  ? core.writeOperationProgress(operation)
                  : core.reconcileOperation(operation)
              );
              const persisted = yield* repository.get(
                operation.requesterSessionId,
                operation.operationId
              );
              if (scenario === 'deadline') {
                expect(Exit.isSuccess(exit)).toBe(true);
                expect(persisted).toMatchObject({
                  state: 'finished',
                  completion: { type: 'error', error: { code: 'COORDINATOR_FAILED' } },
                });
              } else {
                expect(persisted.state).toBe('active');
                if (scenario === 'progress') {
                  expect(Exit.isSuccess(exit)).toBe(true);
                  expect(warnings).toEqual([cause]);
                } else {
                  expect(Exit.isFailure(exit) && exit.cause).toEqual(cause);
                  expect(warnings).toEqual([]);
                }
              }
            }).pipe(Effect.provide(operationRepositoryLayer(store)))
          )
        );
      } finally {
        store.close();
      }
    }
  );
});

it('closes Inbox and SQLite even when an execution drain has a release failure', async () => {
  const h = await makeHarness();
  h.coordinatorOptions.executionService.drainInboxExecutions = () =>
    SessionExecutionService.prototype.drainInboxExecutions.call({
      ownedWork: new Set(),
      turnRuntimeBySession: new Map([
        ['failed', { releaseFailure: new Error('terminate failed') }],
      ]),
      deps: { logger: h.logger },
    } as never);
  h.coordinator.start();
  await h.coordinator.idle();
  const internal = h.coordinator as unknown as {
    inbox: { wake(): Promise<void> };
    store: LodyOperationStore | null;
  };
  const inbox = internal.inbox;
  await expect(h.coordinator.stop()).resolves.toBeUndefined();
  expect(internal.store).toBeNull();
  await expect(inbox.wake()).rejects.toBeDefined();
});
