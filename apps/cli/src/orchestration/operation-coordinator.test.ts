import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';

import {
  buildMissingEmail,
  getAgentConfigRoomId,
  machineFlockKeys,
  type AgentConfigId,
  type AgentConfigMeta,
  getSessionRoomId,
  type MachineId,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';

import { LodyOperationCoordinator } from './operation-coordinator';
import { LodyOperationStore } from './operation-store';

const roots = new Set<string>();
const TEST_NOW_MS = Date.parse('2026-07-20T00:00:00Z');

type DeliveryDispatchOptions = {
  onTurnClaimed?: () => Promise<boolean>;
  onTurnStarted?: () => Promise<boolean>;
  onTurnSettled?: (
    settlement: 'handled' | 'cancelled' | 'not_started' | 'uncertain'
  ) => Promise<void>;
};

const makeHarness = async (options?: {
  deadlineAt?: string;
  requesterArchived?: boolean;
  pendingUser?: boolean;
  busy?: boolean;
  activeTurnId?: string;
  agentConfigId?: string;
  configurationSyncSucceeds?: boolean;
  configurationSync?: () => Promise<boolean>;
  beforeTurnClaim?: () => Promise<void>;
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
  const sessionDoc = (sessionId: SessionId) => ({
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
        readTurn: async () => ({ state: 'missing' as const }),
        readRange: async () => [],
        readDirectory: async () => [],
        observe: () => ({ initial: Promise.resolve([]), unsubscribe: () => {} }),
      },
      commands: {},
      durability: { waitDurable: async () => {} },
    },
    getHistory: async () => histories.get(sessionId) ?? [],
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
    throw new Error('Delivery configuration lookup must not enumerate repo meta');
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
    flush: async () => {
      if (options?.failProgressFlush) throw new Error('flush unavailable');
    },
    watch: () => ({ unsubscribe: vi.fn() }),
    getDocMeta,
    getMeta: getRepoMeta,
    openFlockDoc,
  };
  let pendingUser = options?.pendingUser ?? false;
  let busy = options?.busy ?? false;
  const continueSession = vi.fn(async (message: unknown, dispatchOptions: unknown) => {
    const typedMessage = message as { sessionId: SessionId; userTurnId: string };
    const typedOptions = dispatchOptions as DeliveryDispatchOptions;
    await options?.beforeTurnClaim?.();
    if ((await typedOptions.onTurnClaimed?.()) === false) return;
    const assistantTurnId = `assistant:${typedMessage.userTurnId}`;
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
    await typedOptions.onTurnSettled?.('handled');
  });
  const logger = { warn: vi.fn(), debug: vi.fn() };
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
  const storeFactory = () => {
    storeLifecycle.opened += 1;
    const factoryStore = new LodyOperationStore(storePath, options?.now ?? (() => TEST_NOW_MS));
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
      getExecutionSnapshot: () => ({
        hasActiveTurn: busy,
        ...(busy && options?.activeTurnId ? { activeTurnId: options.activeTurnId } : {}),
      }),
      continueSession,
    } as never,
    dispatchWatcher: { hasPendingDispatch: () => pendingUser } as never,
    logger: logger as never,
    storeFactory,
    storePath,
    now: options?.now ?? (() => TEST_NOW_MS),
    ...(options?.workerBootId ? { workerBootId: options.workerBootId } : {}),
    operationStoreWatchFactory: (_directory, onChange) => {
      operationStoreWake = onChange;
      return { close: vi.fn() };
    },
    materializeTarget,
  } satisfies ConstructorParameters<typeof LodyOperationCoordinator>[0];
  const coordinator = new LodyOperationCoordinator(coordinatorOptions);
  const store = new LodyOperationStore(storePath, () => TEST_NOW_MS);
  store.accept({
    workspaceId,
    ownerMachineId: machineId,
    requesterSessionId,
    requesterUserId: 'user-1',
    operationId: 'review-round-1',
    kind: options?.operationKind ?? 'session_chat',
    canonicalCommand: { sessionId: targetSessionId, prompt: 'work' },
    frozenContinuationConfig: {
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
  it('retries transient target materialization on its own bounded timer', async () => {
    vi.useFakeTimers();
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
      harness.coordinator.stop();
    }
  });

  it('recognizes an ambiguous successful write before retrying materialization', async () => {
    vi.useFakeTimers();
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
      harness.coordinator.stop();
    }
  });

  it('waits for cross-replica target catch-up before replaying a fixed turn', async () => {
    vi.useFakeTimers();
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
      harness.coordinator.stop();
    }
  });

  it('replays when the fixed turn exists but its dispatch pointer was not written', async () => {
    vi.useFakeTimers();
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
      harness.coordinator.stop();
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
      harness.coordinator.stop();
    }
  });

  it('does not start materialization after the deadline passes during an evidence read', async () => {
    vi.useFakeTimers();
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
      harness.coordinator.stop();
    }
  });

  it('does not start materialization after the deadline passes during target catch-up', async () => {
    vi.useFakeTimers();
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
      harness.coordinator.stop();
    }
  });

  it('folds a terminal target and delivers one visible completion after restart', async () => {
    const harness = await makeHarness();
    const targetHistory = harness.histories.get(harness.targetSessionId)!;
    targetHistory[0] = { ...targetHistory[0]!, status: 'handled' };
    targetHistory.push({
      id: 'assistant:turn-1',
      role: 'assistant',
      userTurnId: 'turn-1',
      timestamp: '2026-07-20T00:00:00.500Z',
      items: [{ type: 'text', text: 'done' }],
      fileDiff: [],
      finished: true,
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.wake('duplicate');
    await harness.coordinator.idle();
    harness.coordinator.stop();

    const requesterHistory = harness.histories.get(harness.requesterSessionId)!;
    expect(requesterHistory.filter((turn) => turn.role === 'system')).toHaveLength(1);
    expect(requesterHistory.filter((turn) => turn.role === 'assistant')).toHaveLength(1);
    expect(harness.continueSession).toHaveBeenCalledTimes(1);
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'finished',
        completion: {
          type: 'result',
          value: { items: [{ status: 'succeeded', output: { text: 'done' } }] },
        },
      });
      expect(store.listPendingDeliveries('workspace-1' as WorkspaceId)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('delivers a durably completed target before its pending user status is repaired', async () => {
    const harness = await makeHarness();
    Object.assign(harness.metas.get(harness.targetSessionId)!, {
      lastHandledUserMsgId: 'turn-1',
      processingUserMsgId: undefined,
    });
    harness.histories.get(harness.targetSessionId)!.push({
      id: 'assistant:turn-1',
      role: 'assistant',
      userTurnId: 'turn-1',
      timestamp: '2026-07-20T00:00:00.500Z',
      endedAt: TEST_NOW_MS,
      items: [{ type: 'text', text: 'done before status repair' }],
      fileDiff: [],
      finished: true,
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'finished',
        completion: {
          type: 'result',
          value: {
            items: [{ status: 'succeeded', output: { text: 'done before status repair' } }],
          },
        },
      });
      expect(harness.continueSession).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it('carries the requester resolved commit identity into the Delivery turn', async () => {
    const harness = await makeHarness();
    const targetHistory = harness.histories.get(harness.targetSessionId)!;
    targetHistory[0] = { ...targetHistory[0]!, status: 'handled' };
    targetHistory.push({
      id: 'assistant:turn-1',
      role: 'assistant',
      userTurnId: 'turn-1',
      timestamp: '2026-07-20T00:00:00.500Z',
      items: [{ type: 'text', text: 'done' }],
      fileDiff: [],
      finished: true,
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.resolveUser).toHaveBeenCalledWith('user-1');
    expect(harness.continueSession).toHaveBeenCalledTimes(1);
    expect(harness.continueSession.mock.calls[0]?.[0]).toMatchObject({
      userId: 'user-1',
      userName: 'Ada Lovelace',
      userEmail: 'ada@example.com',
    });
  });

  it('still delivers with a placeholder identity when requester resolution fails', async () => {
    const harness = await makeHarness({ resolveUserFails: true });
    const targetHistory = harness.histories.get(harness.targetSessionId)!;
    targetHistory[0] = { ...targetHistory[0]!, status: 'handled' };
    targetHistory.push({
      id: 'assistant:turn-1',
      role: 'assistant',
      userTurnId: 'turn-1',
      timestamp: '2026-07-20T00:00:00.500Z',
      items: [{ type: 'text', text: 'done' }],
      fileDiff: [],
      finished: true,
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledTimes(1);
    expect(harness.continueSession.mock.calls[0]?.[0]).toMatchObject({
      userId: 'user-1',
      userName: 'user-1',
      userEmail: buildMissingEmail('lody', 'user-1'),
    });
  });

  it('keeps Delivery pending behind user work, then resumes it at the next idle boundary', async () => {
    const harness = await makeHarness({ pendingUser: true });
    const targetHistory = harness.histories.get(harness.targetSessionId)!;
    targetHistory[0] = { ...targetHistory[0]!, status: 'handled' };
    targetHistory.push({
      id: 'assistant:turn-1',
      role: 'assistant',
      userTurnId: 'turn-1',
      timestamp: '2026-07-20T00:00:00.500Z',
      items: [],
      fileDiff: [],
      finished: true,
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    expect(harness.histories.get(harness.requesterSessionId)).toEqual([]);

    harness.setPendingUser(false);
    await harness.coordinator.wake('user-finished');
    await harness.coordinator.idle();
    harness.coordinator.stop();
    expect(harness.continueSession).toHaveBeenCalledTimes(1);
  });

  it('turns an unterminal target into TARGET_TIMEOUT without cancelling it', async () => {
    const harness = await makeHarness({ deadlineAt: '2026-07-19T23:59:59.000Z' });
    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

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

  it('expires a Delivery 8h past its Operation deadline instead of waking the requester', async () => {
    // deadline + 8h grace lands exactly on TEST_NOW: stranded completions from
    // a long-dead store or downtime must not restart old conversations.
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T16:00:00.000Z',
      workerBootId: 'worker-new',
    });
    const oldStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      oldStore.finish(harness.requesterSessionId, 'review-round-1', { type: 'cancelled' });
      oldStore.claimDeliveryExecution(harness.requesterSessionId, 'review-round-1', {
        claimId: 'stale-attempt',
        workerBootId: 'worker-old',
      });
      oldStore.prepareClaimedDeliveryExecution(
        harness.requesterSessionId,
        'review-round-1',
        'worker-old',
        'stale-attempt'
      );
      oldStore.markClaimedDeliveryExecutionStarted(
        harness.requesterSessionId,
        'review-round-1',
        'worker-old',
        'stale-attempt'
      );
    } finally {
      oldStore.close();
    }
    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).not.toHaveBeenCalled();
    expect(harness.histories.get(harness.requesterSessionId)).toEqual([]);
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'finished',
      });
      expect(store.listPendingDeliveries('workspace-1' as WorkspaceId)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('still delivers a completion within the 8h post-deadline grace window', async () => {
    const harness = await makeHarness({ deadlineAt: '2026-07-19T16:00:01.000Z' });
    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledTimes(1);
    const requesterHistory = harness.histories.get(harness.requesterSessionId)!;
    expect(requesterHistory.filter((turn) => turn.role === 'system')).toHaveLength(1);
  });

  it('keeps a persisted terminal assistant result at the deadline before handled catches up', async () => {
    const harness = await makeHarness({ deadlineAt: '2026-07-19T23:59:59.000Z' });
    const targetHistory = harness.histories.get(harness.targetSessionId)!;
    targetHistory[0] = { ...targetHistory[0]!, status: 'processing' };
    targetHistory.push({
      id: 'assistant:turn-1',
      role: 'assistant',
      userTurnId: 'turn-1',
      timestamp: '2026-07-20T00:00:00.500Z',
      items: [{ type: 'text', text: 'durable reply' }],
      fileDiff: [],
      finished: true,
      endedAt: TEST_NOW_MS - 1,
    });
    let releaseDelivery!: () => void;
    let markDeliveryClaimed!: () => void;
    const deliveryReleased = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const deliveryClaimed = new Promise<void>((resolve) => {
      markDeliveryClaimed = resolve;
    });
    harness.continueSession.mockImplementation(async (message, dispatchOptions) => {
      const typedMessage = message as { sessionId: SessionId };
      const typedOptions = dispatchOptions as DeliveryDispatchOptions;
      await typedOptions.onTurnClaimed?.();
      markDeliveryClaimed();
      await deliveryReleased;
      harness.histories.set(typedMessage.sessionId, [
        ...(harness.histories.get(typedMessage.sessionId) ?? []),
        {
          id: 'assistant:operation-completion:requester-1:review-round-1',
          role: 'assistant',
          timestamp: '2026-07-20T00:00:01.000Z',
          items: [{ type: 'text', text: 'continued' }],
          fileDiff: [],
          finished: true,
        },
      ]);
      await typedOptions.onTurnSettled?.('handled');
    });

    harness.coordinator.start();
    await deliveryClaimed;

    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'finished',
        completion: {
          type: 'result',
          value: {
            items: [{ status: 'succeeded', output: { text: 'durable reply' } }],
          },
        },
      });
      expect(harness.histories.get(harness.requesterSessionId)).toEqual([
        expect.objectContaining({
          role: 'system',
          userId: 'user-1',
          items: [
            expect.objectContaining({
              type: 'operation_completion',
              completion: {
                type: 'result',
                value: { items: [expect.objectContaining({ status: 'succeeded' })] },
              },
            }),
          ],
        }),
      ]);
    } finally {
      store.close();
    }

    targetHistory[0] = { ...targetHistory[0]!, status: 'handled' };
    const lateHandledWake = harness.coordinator.wake('late-handled');
    releaseDelivery();
    await lateHandledWake;
    await harness.coordinator.idle();
    await harness.coordinator.wake('duplicate');
    await harness.coordinator.idle();
    harness.coordinator.stop();

    const requesterHistory = harness.histories.get(harness.requesterSessionId)!;
    expect(requesterHistory.filter((turn) => turn.role === 'system')).toHaveLength(1);
    expect(requesterHistory.filter((turn) => turn.role === 'assistant')).toHaveLength(1);
    expect(harness.continueSession).toHaveBeenCalledOnce();
    const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(finalStore.listPendingDeliveries('workspace-1' as WorkspaceId)).toEqual([]);
    } finally {
      finalStore.close();
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
  ])('keeps $status ahead of terminal assistant partial output', async ({ status, expected }) => {
    const harness = await makeHarness();
    const targetHistory = harness.histories.get(harness.targetSessionId)!;
    targetHistory[0] = { ...targetHistory[0]!, status };
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
    harness.coordinator.stop();

    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'finished',
        completion: { type: 'result', value: { items: [expected] } },
      });
    } finally {
      store.close();
    }
  });

  it('does not write history while archived and becomes eligible after restore', async () => {
    const harness = await makeHarness({
      requesterArchived: true,
      deadlineAt: '2026-07-19T23:59:59.000Z',
    });
    harness.coordinator.start();
    await harness.coordinator.idle();
    expect(harness.histories.get(harness.requesterSessionId)).toEqual([]);

    harness.metas.get(harness.requesterSessionId)!.isArchived = false;
    await harness.coordinator.wake('restore');
    await harness.coordinator.idle();
    harness.coordinator.stop();
    expect(harness.continueSession).toHaveBeenCalledTimes(1);
  });

  it('does not treat temporarily missing Session metadata as permanent deletion', async () => {
    const harness = await makeHarness();
    harness.metas.delete(harness.targetSessionId);

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'active',
        items: [{ status: 'active' }],
      });
    } finally {
      store.close();
    }
  });

  it('consumes a Delivery after a visible pre-prompt failure instead of retrying forever', async () => {
    const harness = await makeHarness();
    const targetHistory = harness.histories.get(harness.targetSessionId)!;
    targetHistory[0] = { ...targetHistory[0]!, status: 'handled' };
    targetHistory.push({
      id: 'assistant:turn-1',
      role: 'assistant',
      userTurnId: 'turn-1',
      timestamp: '2026-07-20T00:00:00.500Z',
      items: [],
      fileDiff: [],
      finished: true,
    });
    harness.continueSession.mockImplementation(async (message, dispatchOptions) => {
      const typedMessage = message as { sessionId: SessionId };
      const typedOptions = dispatchOptions as DeliveryDispatchOptions;
      await typedOptions.onTurnClaimed?.();
      harness.histories.set(typedMessage.sessionId, [
        ...(harness.histories.get(typedMessage.sessionId) ?? []),
        {
          id: 'system-notice:chat-failed',
          role: 'system',
          timestamp: '2026-07-20T00:00:01.000Z',
          items: [
            {
              type: 'system_notice',
              name: 'chat_failed',
              meta: { reason: 'acp_request_cancelled', message: 'cancelled before prompt' },
            },
          ],
          fileDiff: [],
          finished: true,
        },
      ]);
      await typedOptions.onTurnSettled?.('handled');
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.wake('duplicate-history-event');
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledTimes(1);
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.listPendingDeliveries('workspace-1' as WorkspaceId)).toEqual([]);
    } finally {
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

    harness.coordinator.stop();
    expect(harness.storeLifecycle).toEqual({ opened: 1, closed: 1 });
  });

  it('keeps Delivery pending when frozen configuration visibility is transiently unknown', async () => {
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      agentConfigId: 'agent-config-1',
      configurationSyncSucceeds: false,
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.syncMachineFlockDoc).toHaveBeenCalled();
    expect(harness.openFlockDoc).toHaveBeenCalledOnce();
    expect(harness.getRepoMeta).not.toHaveBeenCalled();
    expect(harness.histories.get(harness.requesterSessionId)).toEqual([]);
    expect(harness.continueSession).not.toHaveBeenCalled();
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.listPendingDeliveries('workspace-1' as WorkspaceId)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('continues with an available frozen Machine Flock configuration using a point lookup', async () => {
    const agentConfigId = 'agent-config-1' as AgentConfigId;
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      agentConfigId,
      machineAgentConfig: {
        id: agentConfigId,
        machineId: 'machine-1' as MachineId,
        name: 'Codex',
        cliType: 'builtin',
        agentType: 'codex',
        env: {},
      },
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledOnce();
    expect(harness.syncMachineFlockDoc).not.toHaveBeenCalled();
    expect(harness.flockScan).toHaveBeenCalledWith({
      prefix: machineFlockKeys.agentConfig(agentConfigId),
    });
    expect(harness.getRepoMeta).not.toHaveBeenCalled();
  });

  it('continues with a legacy repo-meta-backed frozen configuration using one doc lookup', async () => {
    const agentConfigId = 'legacy-agent-config' as AgentConfigId;
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      agentConfigId,
      legacyAgentConfig: {
        id: agentConfigId,
        machineId: 'machine-1' as MachineId,
        name: 'Legacy Codex',
        cliType: 'builtin',
        agentType: 'codex',
        env: {},
      },
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledOnce();
    expect(harness.syncMachineFlockDoc).not.toHaveBeenCalled();
    expect(harness.getDocMeta).toHaveBeenCalledWith(getAgentConfigRoomId(agentConfigId));
    expect(harness.getRepoMeta).not.toHaveBeenCalled();
  });

  it('writes a non-started completion when configuration absence is authoritative after sync', async () => {
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      agentConfigId: 'removed-agent-config',
      configurationSyncSucceeds: true,
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.syncMachineFlockDoc).toHaveBeenCalledOnce();
    expect(harness.openFlockDoc).toHaveBeenCalledTimes(2);
    expect(harness.continueSession).not.toHaveBeenCalled();
    expect(harness.histories.get(harness.requesterSessionId)).toEqual([
      expect.objectContaining({
        role: 'system',
        items: [
          expect.objectContaining({
            type: 'operation_completion',
            continuation: {
              status: 'not_started',
              reason: expect.objectContaining({ code: 'CONFIGURATION_UNAVAILABLE' }),
            },
          }),
        ],
      }),
    ]);
  });

  it('does not let progress write failures block operation finalization or delivery', async () => {
    const options: {
      operationKind: 'session_create';
      failProgressHistoryWrites: boolean;
    } = {
      operationKind: 'session_create',
      failProgressHistoryWrites: true,
    };
    const harness = await makeHarness(options);
    harness.histories.set(harness.targetSessionId, [
      {
        id: 'turn-1',
        role: 'user',
        timestamp: '2026-07-20T00:00:00.000Z',
        items: [{ type: 'text', text: 'work' }],
        fileDiff: [],
        status: 'handled',
      },
      {
        id: 'assistant:turn-1',
        role: 'assistant',
        userTurnId: 'turn-1',
        timestamp: '2026-07-20T00:00:01.000Z',
        items: [{ type: 'text', text: 'done' }],
        fileDiff: [],
        finished: true,
      },
    ]);

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    const requesterHistory = harness.histories.get(harness.requesterSessionId) ?? [];
    expect(
      requesterHistory.some((entry) =>
        entry.items?.some((item) => item.type === 'operation_progress')
      )
    ).toBe(false);
    expect(
      requesterHistory.some((entry) =>
        entry.items?.some(
          (item) => item.type === 'operation_completion' && item.progressMessageId === undefined
        )
      )
    ).toBe(true);
    expect(harness.continueSession).toHaveBeenCalledOnce();
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.get(harness.requesterSessionId, 'review-round-1').state).toBe('finished');
    } finally {
      store.close();
    }

    options.failProgressHistoryWrites = false;
    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();
    expect(harness.continueSession).toHaveBeenCalledOnce();
    expect(
      harness.histories
        .get(harness.requesterSessionId)
        ?.some((entry) => entry.items?.some((item) => item.type === 'operation_progress'))
    ).toBe(true);
  });

  it('repairs terminal create progress during pending completion delivery', async () => {
    const harness = await makeHarness({
      operationKind: 'session_create',
      progressHistoryFailures: 2,
    });
    harness.histories.set(harness.targetSessionId, [
      {
        id: 'turn-1',
        role: 'user',
        timestamp: '2026-07-20T00:00:00.000Z',
        items: [{ type: 'text', text: 'work' }],
        fileDiff: [],
        status: 'handled',
      },
      {
        id: 'assistant:turn-1',
        role: 'assistant',
        userTurnId: 'turn-1',
        timestamp: '2026-07-20T00:00:01.000Z',
        items: [{ type: 'text', text: 'done' }],
        fileDiff: [],
        finished: true,
      },
    ]);

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    const requesterHistory = harness.histories.get(harness.requesterSessionId) ?? [];
    expect(
      requesterHistory.some((entry) =>
        entry.items?.some((item) => item.type === 'operation_progress')
      )
    ).toBe(true);
    expect(
      requesterHistory.some((entry) =>
        entry.items?.some(
          (item) =>
            item.type === 'operation_completion' &&
            item.progressMessageId === 'operation-progress:requester-1:review-round-1'
        )
      )
    ).toBe(true);
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
    harness.coordinator.stop();

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
    harness.coordinator.stop();

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

  it.each([
    { completeCoverage: false, progressStatus: 'succeeded' as const, shouldLink: false },
    { completeCoverage: true, progressStatus: 'created' as const, shouldLink: false },
    { completeCoverage: true, progressStatus: 'running' as const, shouldLink: false },
    { completeCoverage: true, progressStatus: 'succeeded' as const, shouldLink: true },
  ])(
    'only suppresses current complete batch cards ($completeCoverage, $progressStatus)',
    async ({ completeCoverage, progressStatus, shouldLink }) => {
      const harness = await makeHarness({
        operationKind: 'session_create_many',
        failProgressHistoryWrites: true,
      });
      const targets = [
        { sessionId: 'batch-child-a' as SessionId, userTurnId: 'batch-turn-a' },
        { sessionId: harness.targetSessionId, userTurnId: 'turn-1' },
      ];
      const results = targets.map((target) => ({
        status: 'succeeded' as const,
        target,
        assistantTurnId: `assistant:${target.userTurnId}`,
      }));
      const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        store.updateItems(harness.requesterSessionId, 'review-round-1', results);
        store.finish(harness.requesterSessionId, 'review-round-1', {
          type: 'result',
          value: { items: results },
        });
      } finally {
        store.close();
      }
      harness.histories.set(harness.requesterSessionId, [
        {
          id: 'operation-progress:requester-1:review-round-1',
          role: 'system',
          timestamp: '2026-07-20T00:00:00.000Z',
          fileDiff: [],
          items: [
            {
              type: 'operation_progress',
              operationId: 'review-round-1',
              operationKind: 'session_create_many',
              items: targets
                .slice(0, completeCoverage ? 2 : 1)
                .map((target) => ({ target, status: progressStatus })),
            },
          ],
        },
      ]);
      harness.coordinator.start();
      await harness.coordinator.idle();
      harness.coordinator.stop();
      const completion = harness.histories
        .get(harness.requesterSessionId)
        ?.flatMap((entry) => entry.items ?? [])
        .find((item) => item.type === 'operation_completion');
      expect(completion?.type).toBe('operation_completion');
      if (completion?.type !== 'operation_completion') throw new Error('Missing completion');
      expect(completion.progressMessageId).toBe(
        shouldLink ? 'operation-progress:requester-1:review-round-1' : undefined
      );
      expect(completion.completion).toMatchObject({ type: 'result', value: { items: results } });
    }
  );

  it.each(
    (['deadline', 'cancelled', 'error'] as const).flatMap((reason) =>
      (['succeeded', 'failed', 'cancelled'] as const).map((terminal) => ({ reason, terminal }))
    )
  )(
    'reconciles target $terminal after root $reason, delivery and daemon restart without another continuation',
    async ({ reason, terminal }) => {
      const harness = await makeHarness({
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
            deliveries: store.listPendingDeliveries('workspace-1' as WorkspaceId),
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
      expect(read().deliveries).toEqual([]);
      const meta = harness.metas.get(harness.targetSessionId);
      if (!meta) throw new Error('missing target metadata fixture');
      harness.metas.delete(harness.targetSessionId);
      harness.notifyTargetHistory();
      await harness.coordinator.idle();
      expect(status()).toBe('running');
      expect(read().pending).toHaveLength(1);
      harness.metas.set(harness.targetSessionId, meta);
      const rootResult = read().completion;
      const requesterBefore = harness.histories.get(harness.requesterSessionId) ?? [];
      const continuationIds = requesterBefore
        .filter((row) => row.role === 'assistant')
        .map((row) => row.id);
      expect(continuationIds).toHaveLength(1);
      harness.coordinator.stop();
      // Opening the same SQLite store must restore observation even with no active Operation/Delivery.
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
      harness.coordinator.stop();
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
    harness.coordinator.stop();
    releaseRead();
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
    harness.coordinator.stop();
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.listPendingDeliveries('workspace-1' as WorkspaceId)).toEqual([]);
      expect(
        store.listPendingProgress('workspace-1' as WorkspaceId, 'machine-1' as MachineId)
      ).toHaveLength(1);
    } finally {
      store.close();
    }
    options.failProgressFlush = false;
    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();
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
    vi.useFakeTimers();
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
    harness.coordinator.stop();
  });

  it('links operation completion to existing create progress history', async () => {
    const harness = await makeHarness({
      operationKind: 'session_create',
      deadlineAt: '2026-07-19T23:59:59.000Z',
      agentConfigId: 'removed-agent-config',
      configurationSyncSucceeds: true,
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    const history = harness.histories.get(harness.requesterSessionId) ?? [];
    expect(history).toEqual([
      expect.objectContaining({
        id: 'operation-progress:requester-1:review-round-1',
        role: 'system',
        items: [expect.objectContaining({ type: 'operation_progress' })],
      }),
      expect.objectContaining({
        id: 'operation-completion:requester-1:review-round-1',
        role: 'system',
        items: [
          expect.objectContaining({
            type: 'operation_completion',
            progressMessageId: 'operation-progress:requester-1:review-round-1',
          }),
        ],
      }),
    ]);
  });

  it('retries terminal settlement after its consume write fails', async () => {
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      agentConfigId: 'removed-agent-config',
      configurationSyncSucceeds: true,
    });
    const consume = vi.spyOn(LodyOperationStore.prototype, 'consumeClaimedDelivery');
    const originalConsume = consume.getMockImplementation();
    consume.mockImplementationOnce(() => {
      throw new Error('terminal settlement write failed');
    });
    if (originalConsume) consume.mockImplementation(originalConsume);

    try {
      harness.coordinator.start();
      await harness.coordinator.idle();

      const afterFailure = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        const delivery = afterFailure.getDelivery(harness.requesterSessionId, 'review-round-1');
        expect(delivery).toMatchObject({ state: 'pending', attemptCount: 0 });
        expect(delivery.activeClaimId).toEqual(expect.any(String));
        expect(delivery.activeClaimWorkerBootId).toEqual(expect.any(String));
      } finally {
        afterFailure.close();
      }
      expect(harness.histories.get(harness.requesterSessionId)).toEqual([
        expect.objectContaining({
          items: [
            expect.objectContaining({
              type: 'operation_completion',
              continuation: {
                status: 'not_started',
                reason: expect.objectContaining({ code: 'CONFIGURATION_UNAVAILABLE' }),
              },
            }),
          ],
        }),
      ]);

      await harness.coordinator.wake('retry-terminal-settlement-1');
      await harness.coordinator.idle();
      await harness.coordinator.wake('retry-terminal-settlement-2');
      await harness.coordinator.idle();
      harness.coordinator.stop();

      expect(harness.continueSession).not.toHaveBeenCalled();
      const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        expect(finalStore.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
          state: 'consumed',
          attemptCount: 0,
        });
      } finally {
        finalStore.close();
      }
      expect(harness.histories.get(harness.requesterSessionId)).toHaveLength(1);
    } finally {
      harness.coordinator.stop();
      consume.mockRestore();
    }
  });

  it.each([0, 2])(
    'recovers terminal settlement during a write outage with %i failed history writes',
    async (historyFailuresBeforeSuccess) => {
      let rejectFurtherHistoryWrites = false;
      const harness = await makeHarness({
        deadlineAt: '2026-07-19T23:59:59.000Z',
        agentConfigId: 'removed-agent-config',
        configurationSyncSucceeds: true,
        historyFailuresBeforeSuccess,
        workerBootId: 'worker-a',
        beforeRequesterHistoryWrite: async () => {
          if (rejectFurtherHistoryWrites) throw new Error('history is unavailable again');
        },
      });
      let writeOutage = true;
      const originalConsume = LodyOperationStore.prototype.consumeClaimedDelivery;
      const originalRelease = LodyOperationStore.prototype.releaseDeliveryClaim;
      const consume = vi.spyOn(LodyOperationStore.prototype, 'consumeClaimedDelivery');
      const release = vi.spyOn(LodyOperationStore.prototype, 'releaseDeliveryClaim');
      consume.mockImplementation(function (this: LodyOperationStore, ...args) {
        if (writeOutage) throw new Error('terminal database write outage');
        return originalConsume.apply(this, args);
      });
      release.mockImplementation(function (this: LodyOperationStore, ...args) {
        if (writeOutage) throw new Error('terminal database write outage');
        return originalRelease.apply(this, args);
      });
      const inspect = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        harness.coordinator.start();
        await harness.coordinator.idle();
        const claimed = inspect.getDelivery(harness.requesterSessionId, 'review-round-1');
        expect(claimed.activeClaimId).toEqual(expect.any(String));
        if (historyFailuresBeforeSuccess > 0) {
          expect(harness.histories.get(harness.requesterSessionId)).toEqual([]);
          await harness.coordinator.wake('history-still-unavailable');
          await harness.coordinator.idle();
          expect(harness.histories.get(harness.requesterSessionId)).toEqual([]);
          expect(inspect.getDelivery(harness.requesterSessionId, 'review-round-1').state).toBe(
            'pending'
          );
        }
        for (let wake = 0; wake < 3; wake += 1) {
          await harness.coordinator.wake('terminal-database-still-unavailable');
          await harness.coordinator.idle();
        }
        expect(inspect.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
          state: 'pending',
          attemptCount: 0,
          activeClaimId: claimed.activeClaimId,
        });
        expect(harness.histories.get(harness.requesterSessionId)).toHaveLength(1);

        rejectFurtherHistoryWrites = true;
        writeOutage = false;
        await harness.coordinator.wake('terminal-database-recovered');
        await harness.coordinator.idle();
        expect(inspect.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
          state: 'consumed',
          attemptCount: 0,
        });
        await harness.coordinator.wake('already-finalized');
        await harness.coordinator.idle();
        expect(harness.continueSession).not.toHaveBeenCalled();
        expect(harness.histories.get(harness.requesterSessionId)).toHaveLength(1);
      } finally {
        consume.mockRestore();
        release.mockRestore();
        harness.coordinator.stop();
        inspect.close();
      }
    }
  );

  it.each(['worker-a', 'worker-b'])(
    'does not consume a replacement terminal claim owned by %s after history yields',
    async (replacementBootId) => {
      let historyStarted!: () => void;
      let finishHistory!: () => void;
      const started = new Promise<void>((resolve) => {
        historyStarted = resolve;
      });
      const finish = new Promise<void>((resolve) => {
        finishHistory = resolve;
      });
      const harness = await makeHarness({
        deadlineAt: '2026-07-19T23:59:59.000Z',
        agentConfigId: 'removed-agent-config',
        configurationSyncSucceeds: true,
        workerBootId: 'worker-a',
        beforeRequesterHistoryWrite: async () => {
          historyStarted();
          await finish;
        },
      });
      const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        harness.coordinator.start();
        await started;
        store.abandonDeliveryClaimsOwnedBy('workspace-1' as WorkspaceId, 'worker-a');
        expect(
          store.claimDeliveryFinalization(harness.requesterSessionId, 'review-round-1', {
            claimId: 'replacement-terminal-claim',
            workerBootId: replacementBootId,
          }).status
        ).toBe('claimed');
        finishHistory();
        await harness.coordinator.idle();
        await harness.coordinator.wake('stale-finalization');
        await harness.coordinator.idle();
        expect(store.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
          state: 'pending',
          activeClaimId: 'replacement-terminal-claim',
          activeClaimWorkerBootId: replacementBootId,
          attemptCount: 0,
        });
        expect(harness.continueSession).not.toHaveBeenCalled();
      } finally {
        finishHistory();
        await harness.coordinator.idle();
        harness.coordinator.stop();
        store.close();
      }
    }
  );

  it('does not write configuration failure when another Worker claims during config sync', async () => {
    let markSyncStarted!: () => void;
    let resolveSync!: (value: boolean) => void;
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    const syncResult = new Promise<boolean>((resolve) => {
      resolveSync = resolve;
    });
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      agentConfigId: 'removed-agent-config',
      workerBootId: 'worker-a',
      configurationSync: async () => {
        markSyncStarted();
        return await syncResult;
      },
    });

    harness.coordinator.start();
    await syncStarted;
    const competitorStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(
        competitorStore.claimDeliveryExecution(harness.requesterSessionId, 'review-round-1', {
          claimId: 'attempt-b',
          workerBootId: 'worker-b',
        })
      ).toMatchObject({ status: 'claimed', delivery: { attemptCount: 0 } });
    } finally {
      competitorStore.close();
    }
    resolveSync(true);
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).not.toHaveBeenCalled();
    expect(harness.histories.get(harness.requesterSessionId)).toEqual([]);
    const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(finalStore.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'pending',
        activeClaimId: 'attempt-b',
        activeClaimWorkerBootId: 'worker-b',
      });
    } finally {
      finalStore.close();
    }
  });

  it('does not finalize a Delivery after stopping during configuration sync', async () => {
    let markSyncStarted!: () => void;
    let resolveSync!: (value: boolean) => void;
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    const syncResult = new Promise<boolean>((resolve) => {
      resolveSync = resolve;
    });
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      agentConfigId: 'removed-agent-config',
      configurationSync: async () => {
        markSyncStarted();
        return await syncResult;
      },
    });

    harness.coordinator.start();
    await syncStarted;
    const oldWork = harness.coordinator.idle();
    harness.coordinator.stop();
    resolveSync(true);
    await oldWork;

    expect(harness.continueSession).not.toHaveBeenCalled();
    expect(harness.histories.get(harness.requesterSessionId)).toEqual([]);
    const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      const delivery = finalStore.getDelivery(harness.requesterSessionId, 'review-round-1');
      expect(delivery).toMatchObject({
        state: 'pending',
        executionPhase: 'ready',
      });
      expect(delivery.activeClaimId).toBeUndefined();
    } finally {
      finalStore.close();
    }
  });

  it('does not claim a Delivery after stopping before the execution claim', async () => {
    let markClaimPending!: () => void;
    let releaseClaim!: () => void;
    const claimPending = new Promise<void>((resolve) => {
      markClaimPending = resolve;
    });
    const claimReleased = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      beforeTurnClaim: async () => {
        markClaimPending();
        await claimReleased;
      },
    });

    harness.coordinator.start();
    await claimPending;
    const oldWork = harness.coordinator.idle();
    harness.coordinator.stop();
    releaseClaim();
    await oldWork;

    expect(harness.continueSession).toHaveBeenCalledOnce();
    expect(harness.histories.get(harness.requesterSessionId)).toEqual([]);
    const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      const delivery = finalStore.getDelivery(harness.requesterSessionId, 'review-round-1');
      expect(delivery).toMatchObject({
        state: 'pending',
        executionPhase: 'ready',
        attemptCount: 0,
      });
      expect(delivery.activeClaimId).toBeUndefined();
    } finally {
      finalStore.close();
    }
  });

  it('clears a stale non-started marker when recovered execution begins', async () => {
    const harness = await makeHarness({ deadlineAt: '2026-07-19T23:59:59.000Z' });
    harness.histories.set(harness.requesterSessionId, [
      {
        id: 'operation-completion:requester-1:review-round-1',
        role: 'system',
        timestamp: '2026-07-20T00:00:00.000Z',
        items: [
          {
            type: 'operation_completion',
            deliveryId: 'operation:requester-1:review-round-1:completion',
            operationId: 'review-round-1',
            operationKind: 'session_chat',
            completion: { type: 'cancelled' },
            continuation: {
              status: 'not_started',
              reason: {
                code: 'CONFIGURATION_UNAVAILABLE',
                message: 'The frozen continuation agent configuration is no longer available.',
              },
            },
          },
        ],
        fileDiff: [],
        finished: true,
      },
    ]);

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledOnce();
    const completion = harness.histories
      .get(harness.requesterSessionId)
      ?.find((entry) => entry.role === 'system')
      ?.items?.find((item) => item.type === 'operation_completion');
    expect(completion).not.toHaveProperty('continuation');
  });

  it('does not replay after graceful teardown terminalizes a started Delivery turn', async () => {
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      workerBootId: 'daemon-after-restart',
    });
    const shutdownStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      shutdownStore.finish(harness.requesterSessionId, 'review-round-1', { type: 'cancelled' });
      expect(
        shutdownStore.claimDeliveryExecution(harness.requesterSessionId, 'review-round-1', {
          claimId: 'attempt-before-graceful-shutdown',
          workerBootId: 'daemon-before-restart',
        })
      ).toMatchObject({ status: 'claimed' });
      expect(
        shutdownStore.prepareClaimedDeliveryExecution(
          harness.requesterSessionId,
          'review-round-1',
          'daemon-before-restart',
          'attempt-before-graceful-shutdown'
        )
      ).toMatchObject({ prepared: true, delivery: { attemptCount: 1 } });
      expect(
        shutdownStore.markClaimedDeliveryExecutionStarted(
          harness.requesterSessionId,
          'review-round-1',
          'daemon-before-restart',
          'attempt-before-graceful-shutdown'
        )
      ).toBe(true);
    } finally {
      shutdownStore.close();
    }
    harness.histories.set(harness.requesterSessionId, [
      {
        id: 'operation-completion:requester-1:review-round-1',
        role: 'system',
        timestamp: '2026-07-20T00:00:00.000Z',
        items: [
          {
            type: 'operation_completion',
            deliveryId: 'operation:requester-1:review-round-1:completion',
            operationId: 'review-round-1',
            operationKind: 'session_chat',
            completion: { type: 'cancelled' },
          },
        ],
        fileDiff: [],
        finished: true,
        endedAt: TEST_NOW_MS - 1,
      },
      {
        id: 'assistant:operation-completion:requester-1:review-round-1',
        role: 'assistant',
        timestamp: '2026-07-20T00:00:01.000Z',
        items: [],
        fileDiff: [],
        finished: true,
      },
    ]);

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).not.toHaveBeenCalled();
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.listPendingDeliveries('workspace-1' as WorkspaceId)).toEqual([]);
      expect(store.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'consumed',
        executionPhase: 'uncertain',
        attemptCount: 1,
      });
    } finally {
      store.close();
    }
    expect(harness.histories.get(harness.requesterSessionId)?.[0]?.items).toEqual([
      expect.objectContaining({
        type: 'operation_completion',
        continuation: {
          status: 'uncertain',
          reason: expect.objectContaining({ code: 'DELIVERY_EXECUTION_UNCERTAIN' }),
        },
      }),
    ]);
  });

  it('recovers a started claim after the workspace coordinator restarts in one Worker', async () => {
    const harness = await makeHarness({ deadlineAt: '2026-07-19T23:59:59.000Z' });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseOldExecution!: () => void;
    const oldExecutionReleased = new Promise<void>((resolve) => {
      releaseOldExecution = resolve;
    });
    let markOldExecutionReturned!: () => void;
    const oldExecutionReturned = new Promise<void>((resolve) => {
      markOldExecutionReturned = resolve;
    });
    harness.continueSession.mockImplementationOnce(async (_message, dispatchOptions) => {
      const typedOptions = dispatchOptions as DeliveryDispatchOptions;
      expect(await typedOptions.onTurnClaimed?.()).toBe(true);
      expect(await typedOptions.onTurnStarted?.()).toBe(true);
      markStarted();
      await oldExecutionReleased;
      markOldExecutionReturned();
    });

    harness.coordinator.start();
    await started;
    const oldStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(oldStore.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'pending',
        executionPhase: 'started',
        activeClaimId: expect.any(String),
        activeClaimWorkerBootId: expect.any(String),
      });
    } finally {
      oldStore.close();
    }
    harness.coordinator.stop();

    const replacement = new LodyOperationCoordinator(harness.coordinatorOptions);
    try {
      replacement.start();
      await replacement.idle();
    } finally {
      replacement.stop();
      releaseOldExecution();
      await oldExecutionReturned;
    }

    expect(harness.continueSession).toHaveBeenCalledOnce();
    const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(finalStore.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'consumed',
        executionPhase: 'uncertain',
        attemptCount: 1,
      });
    } finally {
      finalStore.close();
    }
  });

  it('consumes the Delivery when a user turn lands before its completed assistant turn', async () => {
    const systemTurnId = 'operation-completion:requester-1:review-round-1';
    const harness = await makeHarness({ deadlineAt: '2026-07-19T23:59:59.000Z' });
    harness.continueSession.mockImplementation(async (message, dispatchOptions) => {
      const typedMessage = message as { sessionId: SessionId };
      const typedOptions = dispatchOptions as DeliveryDispatchOptions;
      await typedOptions.onTurnClaimed?.();
      harness.histories.set(typedMessage.sessionId, [
        ...(harness.histories.get(typedMessage.sessionId) ?? []),
        {
          id: 'ordinary-user-turn',
          role: 'user',
          timestamp: '2026-07-20T00:00:00.500Z',
          items: [{ type: 'text', text: 'new work' }],
          fileDiff: [],
          status: 'pending',
        },
        {
          id: `assistant:${systemTurnId}`,
          role: 'assistant',
          userTurnId: systemTurnId,
          timestamp: '2026-07-20T00:00:01.000Z',
          items: [{ type: 'text', text: 'completion handled' }],
          fileDiff: [],
          finished: true,
        },
      ]);
      await typedOptions.onTurnSettled?.('handled');
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.wake('duplicate-history-event');
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledOnce();
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.listPendingDeliveries('workspace-1' as WorkspaceId)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('retries a Delivery when only its eager nonterminal assistant entry survived a crash', async () => {
    const systemTurnId = 'operation-completion:requester-1:review-round-1';
    const harness = await makeHarness({ deadlineAt: '2026-07-19T23:59:59.000Z' });
    harness.histories.set(harness.requesterSessionId, [
      {
        id: systemTurnId,
        role: 'system',
        timestamp: '2026-07-20T00:00:00.000Z',
        items: [],
        fileDiff: [],
        finished: true,
      },
      {
        id: `assistant:${systemTurnId}`,
        role: 'assistant',
        userTurnId: systemTurnId,
        timestamp: '2026-07-20T00:00:00.500Z',
        items: [{ type: 'text', text: 'partial output before crash' }],
        fileDiff: [],
        finished: false,
      },
    ]);

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledOnce();
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.listPendingDeliveries('workspace-1' as WorkspaceId)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('does not consume a Delivery from an unrelated assistant turn', async () => {
    const systemTurnId = 'operation-completion:requester-1:review-round-1';
    const harness = await makeHarness({ deadlineAt: '2026-07-19T23:59:59.000Z' });
    harness.histories.set(harness.requesterSessionId, [
      {
        id: systemTurnId,
        role: 'system',
        timestamp: '2026-07-20T00:00:00.000Z',
        items: [],
        fileDiff: [],
        finished: true,
      },
      {
        id: 'assistant:unrelated-user-turn',
        role: 'assistant',
        userTurnId: 'unrelated-user-turn',
        timestamp: '2026-07-20T00:00:00.500Z',
        items: [],
        fileDiff: [],
        finished: true,
      },
    ]);
    harness.continueSession.mockImplementation(async (message, dispatchOptions) => {
      const typedMessage = message as { sessionId: SessionId };
      const typedOptions = dispatchOptions as DeliveryDispatchOptions;
      await typedOptions.onTurnClaimed?.();
      harness.histories.set(typedMessage.sessionId, [
        ...(harness.histories.get(typedMessage.sessionId) ?? []),
        {
          id: `assistant:${systemTurnId}`,
          role: 'assistant',
          userTurnId: systemTurnId,
          timestamp: '2026-07-20T00:00:01.000Z',
          items: [],
          fileDiff: [],
          finished: true,
        },
      ]);
      await typedOptions.onTurnSettled?.('handled');
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledOnce();
    const store = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(store.listPendingDeliveries('workspace-1' as WorkspaceId)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('keeps an active continuation pending until durable completion evidence exists', async () => {
    const systemTurnId = 'operation-completion:requester-1:review-round-1';
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      busy: true,
      activeTurnId: `assistant:${systemTurnId}`,
    });
    harness.histories.set(harness.requesterSessionId, [
      {
        id: systemTurnId,
        role: 'system',
        timestamp: '2026-07-20T00:00:00.000Z',
        items: [],
        fileDiff: [],
        finished: true,
      },
    ]);

    harness.coordinator.start();
    await harness.coordinator.idle();

    expect(harness.continueSession).not.toHaveBeenCalled();
    const storeWhileActive = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(storeWhileActive.listPendingDeliveries('workspace-1' as WorkspaceId)).toHaveLength(1);
    } finally {
      storeWhileActive.close();
    }

    // Model a hard-crashed turn: the active marker disappears without an
    // assistant or chat_failed history entry. The pending Delivery must retry.
    harness.setBusy(false);
    await harness.coordinator.wake('active-turn-disappeared');
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledOnce();
    const storeAfterRetry = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(storeAfterRetry.listPendingDeliveries('workspace-1' as WorkspaceId)).toEqual([]);
    } finally {
      storeAfterRetry.close();
    }
  });

  it('recovers one prepared pre-provider Delivery after a replacement Worker starts', async () => {
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      workerBootId: 'daemon-new',
    });
    const oldStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      oldStore.finish(harness.requesterSessionId, 'review-round-1', { type: 'cancelled' });
      expect(
        oldStore.claimDeliveryExecution(harness.requesterSessionId, 'review-round-1', {
          claimId: 'attempt-before-crash',
          workerBootId: 'daemon-old',
        })
      ).toMatchObject({ status: 'claimed' });
      expect(
        oldStore.prepareClaimedDeliveryExecution(
          harness.requesterSessionId,
          'review-round-1',
          'daemon-old',
          'attempt-before-crash'
        )
      ).toMatchObject({ prepared: true, delivery: { attemptCount: 1 } });
    } finally {
      oldStore.close();
    }

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledOnce();
    const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(finalStore.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'consumed',
        attemptCount: 2,
      });
    } finally {
      finalStore.close();
    }
  });

  it('does not replay provider execution left uncertain by an exited Worker', async () => {
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      workerBootId: 'daemon-new',
    });
    const oldStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      oldStore.finish(harness.requesterSessionId, 'review-round-1', { type: 'cancelled' });
      oldStore.claimDeliveryExecution(harness.requesterSessionId, 'review-round-1', {
        claimId: 'attempt-before-crash',
        workerBootId: 'daemon-old',
      });
      oldStore.prepareClaimedDeliveryExecution(
        harness.requesterSessionId,
        'review-round-1',
        'daemon-old',
        'attempt-before-crash'
      );
      expect(
        oldStore.markClaimedDeliveryExecutionStarted(
          harness.requesterSessionId,
          'review-round-1',
          'daemon-old',
          'attempt-before-crash'
        )
      ).toBe(true);
    } finally {
      oldStore.close();
    }

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).not.toHaveBeenCalled();
    const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(finalStore.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'consumed',
        executionPhase: 'uncertain',
        attemptCount: 1,
      });
    } finally {
      finalStore.close();
    }
    expect(harness.histories.get(harness.requesterSessionId)).toEqual([
      expect.objectContaining({
        role: 'system',
        items: [
          expect.objectContaining({
            type: 'operation_completion',
            continuation: {
              status: 'uncertain',
              reason: expect.objectContaining({ code: 'DELIVERY_EXECUTION_UNCERTAIN' }),
            },
          }),
        ],
      }),
    ]);
  });

  it('exhausts two orphaned pre-provider attempts without starting ACP a third time', async () => {
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      workerBootId: 'worker-c',
    });
    const crashedStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      crashedStore.finish(harness.requesterSessionId, 'review-round-1', { type: 'cancelled' });
      expect(
        crashedStore.claimDeliveryExecution(harness.requesterSessionId, 'review-round-1', {
          claimId: 'attempt-a',
          workerBootId: 'worker-a',
        })
      ).toMatchObject({ status: 'claimed', delivery: { attemptCount: 0 } });
      expect(
        crashedStore.prepareClaimedDeliveryExecution(
          harness.requesterSessionId,
          'review-round-1',
          'worker-a',
          'attempt-a'
        )
      ).toMatchObject({ prepared: true, delivery: { attemptCount: 1 } });
      expect(
        crashedStore.recoverOrphanedDeliveryClaims('workspace-1' as WorkspaceId, 'worker-b')
      ).toBe(1);
      expect(
        crashedStore.claimDeliveryExecution(harness.requesterSessionId, 'review-round-1', {
          claimId: 'attempt-b',
          workerBootId: 'worker-b',
        })
      ).toMatchObject({ status: 'claimed', delivery: { attemptCount: 1 } });
      expect(
        crashedStore.prepareClaimedDeliveryExecution(
          harness.requesterSessionId,
          'review-round-1',
          'worker-b',
          'attempt-b'
        )
      ).toMatchObject({ prepared: true, delivery: { attemptCount: 2 } });
    } finally {
      crashedStore.close();
    }

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).not.toHaveBeenCalled();
    const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(finalStore.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'consumed',
        attemptCount: 2,
      });
    } finally {
      finalStore.close();
    }
    expect(harness.histories.get(harness.requesterSessionId)).toEqual([
      expect.objectContaining({
        role: 'system',
        items: [
          expect.objectContaining({
            type: 'operation_completion',
            continuation: {
              status: 'not_started',
              reason: expect.objectContaining({ code: 'DELIVERY_ATTEMPTS_EXHAUSTED' }),
            },
          }),
        ],
      }),
    ]);
  });

  it('silently loses a Delivery claim when another Worker wins after the idle check', async () => {
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      workerBootId: 'worker-a',
    });
    harness.continueSession.mockImplementation(async (_message, dispatchOptions) => {
      const competitorStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        expect(
          competitorStore.claimDeliveryExecution(harness.requesterSessionId, 'review-round-1', {
            claimId: 'attempt-b',
            workerBootId: 'worker-b',
          })
        ).toMatchObject({ status: 'claimed', delivery: { attemptCount: 0 } });
      } finally {
        competitorStore.close();
      }
      const typedOptions = dispatchOptions as DeliveryDispatchOptions;
      expect(await typedOptions.onTurnClaimed?.()).toBe(false);
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledOnce();
    expect(harness.histories.get(harness.requesterSessionId)).toEqual([]);
    const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(finalStore.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'pending',
        attemptCount: 0,
        activeClaimId: 'attempt-b',
        activeClaimWorkerBootId: 'worker-b',
      });
    } finally {
      finalStore.close();
    }
  });

  it('does not replay after claimed consume commits even if the coordinator tail fails', async () => {
    const harness = await makeHarness({ deadlineAt: '2026-07-19T23:59:59.000Z' });
    harness.continueSession.mockImplementation(async (_message, dispatchOptions) => {
      const typedOptions = dispatchOptions as DeliveryDispatchOptions;
      await typedOptions.onTurnClaimed?.();
      await typedOptions.onTurnSettled?.('handled');
      throw new Error('coordinator crashed after durable consume');
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.wake('restart-after-ack');
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledOnce();
    const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(finalStore.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'consumed',
        attemptCount: 1,
      });
    } finally {
      finalStore.close();
    }
  });

  it('retries settlement persistence without replaying handled provider execution', async () => {
    const harness = await makeHarness({ deadlineAt: '2026-07-19T23:59:59.000Z' });
    const consume = vi.spyOn(LodyOperationStore.prototype, 'consumeClaimedDelivery');
    const originalConsume = consume.getMockImplementation();
    consume.mockImplementationOnce(() => {
      throw new Error('settlement write failed');
    });
    if (originalConsume) consume.mockImplementation(originalConsume);
    harness.continueSession.mockImplementation(async (_message, dispatchOptions) => {
      const typedOptions = dispatchOptions as DeliveryDispatchOptions;
      expect(await typedOptions.onTurnClaimed?.()).toBe(true);
      expect(await typedOptions.onTurnStarted?.()).toBe(true);
      try {
        await typedOptions.onTurnSettled?.('handled');
      } catch {
        // SessionExecutionService logs settlement persistence failures and returns.
      }
    });

    try {
      harness.coordinator.start();
      await harness.coordinator.idle();
      harness.coordinator.stop();

      expect(harness.continueSession).toHaveBeenCalledOnce();
      const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        expect(finalStore.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
          state: 'consumed',
          attemptCount: 1,
        });
      } finally {
        finalStore.close();
      }
      const completion = harness.histories
        .get(harness.requesterSessionId)
        ?.find((entry) => entry.role === 'system')
        ?.items?.find((item) => item.type === 'operation_completion');
      expect(completion).not.toHaveProperty('continuation');
    } finally {
      consume.mockRestore();
    }
  });

  it('retries an observed settlement on a later wake without replaying provider execution', async () => {
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      workerBootId: 'worker-a',
    });
    const originalConsume = LodyOperationStore.prototype.consumeClaimedDelivery;
    const consume = vi.spyOn(LodyOperationStore.prototype, 'consumeClaimedDelivery');
    consume
      .mockImplementationOnce(() => {
        throw new Error('settlement callback write failed');
      })
      .mockImplementationOnce(() => {
        throw new Error('settlement fallback write failed');
      })
      .mockImplementationOnce(() => {
        throw new Error('first wake settlement write failed');
      })
      .mockImplementation(originalConsume);
    harness.continueSession.mockImplementation(async (_message, dispatchOptions) => {
      const typedOptions = dispatchOptions as DeliveryDispatchOptions;
      expect(await typedOptions.onTurnClaimed?.()).toBe(true);
      expect(await typedOptions.onTurnStarted?.()).toBe(true);
      try {
        await typedOptions.onTurnSettled?.('handled');
      } catch {
        // SessionExecutionService logs settlement persistence failures and returns.
      }
    });

    try {
      harness.coordinator.start();
      await harness.coordinator.idle();

      const strandedStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        expect(
          strandedStore.getDelivery(harness.requesterSessionId, 'review-round-1')
        ).toMatchObject({
          state: 'pending',
          executionPhase: 'started',
          activeClaimWorkerBootId: 'worker-a',
        });
      } finally {
        strandedStore.close();
      }

      await harness.coordinator.wake('retry-observed-settlement-1');
      await harness.coordinator.idle();
      const retryStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        expect(retryStore.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
          state: 'pending',
          executionPhase: 'started',
          activeClaimWorkerBootId: 'worker-a',
        });
      } finally {
        retryStore.close();
      }

      await harness.coordinator.wake('retry-observed-settlement-2');
      await harness.coordinator.idle();
      harness.coordinator.stop();

      expect(harness.continueSession).toHaveBeenCalledOnce();
      const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        expect(finalStore.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
          state: 'consumed',
          attemptCount: 1,
        });
      } finally {
        finalStore.close();
      }
    } finally {
      consume.mockRestore();
    }
  });

  it('does not spend execution attempts when completion history is not durable', async () => {
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      historyFailuresBeforeSuccess: 2,
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.wake('retry-first-history-failure');
    await harness.coordinator.idle();

    const beforeDurableHistory = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(
        beforeDurableHistory.getDelivery(harness.requesterSessionId, 'review-round-1')
      ).toMatchObject({
        state: 'pending',
        attemptCount: 0,
      });
    } finally {
      beforeDurableHistory.close();
    }

    await harness.coordinator.wake('retry-after-history-recovers');
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledTimes(3);
    const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(finalStore.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'consumed',
        attemptCount: 1,
      });
    } finally {
      finalStore.close();
    }
    const completion = harness.histories
      .get(harness.requesterSessionId)
      ?.find((entry) => entry.role === 'system')
      ?.items?.find((item) => item.type === 'operation_completion');
    expect(completion).not.toHaveProperty('continuation');
  });

  it('releases a prepared claim when the pre-provider start fence write fails', async () => {
    const harness = await makeHarness({ deadlineAt: '2026-07-19T23:59:59.000Z' });
    const markStarted = vi
      .spyOn(LodyOperationStore.prototype, 'markClaimedDeliveryExecutionStarted')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      });
    let providerStarts = 0;
    harness.continueSession.mockImplementation(async (_message, dispatchOptions) => {
      const typedOptions = dispatchOptions as DeliveryDispatchOptions;
      if ((await typedOptions.onTurnClaimed?.()) === false) return;
      try {
        if ((await typedOptions.onTurnStarted?.()) === false) return;
      } catch {
        await typedOptions.onTurnSettled?.('not_started');
        return;
      }
      providerStarts += 1;
      await typedOptions.onTurnSettled?.('handled');
    });

    try {
      harness.coordinator.start();
      await harness.coordinator.idle();

      const afterFailure = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        const deliveryAfterFailure = afterFailure.getDelivery(
          harness.requesterSessionId,
          'review-round-1'
        );
        expect(deliveryAfterFailure).toMatchObject({
          state: 'pending',
          executionPhase: 'ready',
          attemptCount: 1,
        });
        expect(deliveryAfterFailure).not.toHaveProperty('activeClaimId');
        expect(deliveryAfterFailure).not.toHaveProperty('activeClaimWorkerBootId');
      } finally {
        afterFailure.close();
      }
      expect(providerStarts).toBe(0);

      await harness.coordinator.wake('retry-after-start-fence-write-failure');
      await harness.coordinator.idle();
      harness.coordinator.stop();

      expect(providerStarts).toBe(1);
      expect(harness.continueSession).toHaveBeenCalledTimes(2);
      const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
      try {
        expect(finalStore.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
          state: 'consumed',
          attemptCount: 2,
        });
      } finally {
        finalStore.close();
      }
    } finally {
      harness.coordinator.stop();
      markStarted.mockRestore();
    }
  });

  it('recovers once when execution exits after claim without reporting a settlement', async () => {
    const harness = await makeHarness({ deadlineAt: '2026-07-19T23:59:59.000Z' });
    let executionCount = 0;
    harness.continueSession.mockImplementation(async (_message, dispatchOptions) => {
      const typedOptions = dispatchOptions as DeliveryDispatchOptions;
      await typedOptions.onTurnClaimed?.();
      executionCount += 1;
      if (executionCount === 1) {
        throw new Error('execution exited without a settlement');
      }
      await typedOptions.onTurnSettled?.('handled');
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.wake('recover-missing-settlement');
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledTimes(2);
    const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(finalStore.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'consumed',
        attemptCount: 2,
      });
    } finally {
      finalStore.close();
    }
  });

  it('records uncertainty when provider execution returns without settlement', async () => {
    const harness = await makeHarness({ deadlineAt: '2026-07-19T23:59:59.000Z' });
    harness.continueSession.mockImplementation(async (_message, dispatchOptions) => {
      const typedOptions = dispatchOptions as DeliveryDispatchOptions;
      expect(await typedOptions.onTurnClaimed?.()).toBe(true);
      expect(await typedOptions.onTurnStarted?.()).toBe(true);
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.wake('duplicate-wake-after-missing-settlement');
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledOnce();
    const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      expect(finalStore.getDelivery(harness.requesterSessionId, 'review-round-1')).toMatchObject({
        state: 'consumed',
        executionPhase: 'uncertain',
        attemptCount: 1,
      });
    } finally {
      finalStore.close();
    }
    expect(harness.histories.get(harness.requesterSessionId)).toEqual([
      expect.objectContaining({
        items: [
          expect.objectContaining({
            continuation: {
              status: 'uncertain',
              reason: expect.objectContaining({ code: 'DELIVERY_EXECUTION_UNCERTAIN' }),
            },
          }),
        ],
      }),
    ]);
  });

  it('records a static failure after two executions exit without a settlement', async () => {
    const harness = await makeHarness({ deadlineAt: '2026-07-19T23:59:59.000Z' });
    harness.continueSession.mockImplementation(async (_message, dispatchOptions) => {
      const typedOptions = dispatchOptions as DeliveryDispatchOptions;
      await typedOptions.onTurnClaimed?.();
      throw new Error('execution exited without a settlement');
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.wake('recover-missing-settlement');
    await harness.coordinator.idle();
    await harness.coordinator.wake('duplicate-wake-after-exhaustion');
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledTimes(2);
    const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      const delivery = finalStore.getDelivery(harness.requesterSessionId, 'review-round-1');
      expect(delivery).toMatchObject({ state: 'consumed', attemptCount: 2 });
    } finally {
      finalStore.close();
    }
  });

  it('consumes a user-cancelled Delivery without starting ACP again', async () => {
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      workerBootId: 'daemon-1',
    });
    harness.continueSession.mockImplementation(async (_message, dispatchOptions) => {
      const typedOptions = dispatchOptions as DeliveryDispatchOptions;
      await typedOptions.onTurnClaimed?.();
      await typedOptions.onTurnStarted?.();
      await typedOptions.onTurnSettled?.('cancelled');
    });

    harness.coordinator.start();
    await harness.coordinator.idle();
    await harness.coordinator.wake('recover-interrupted-delivery');
    await harness.coordinator.idle();
    await harness.coordinator.wake('duplicate-history-event');
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(harness.continueSession).toHaveBeenCalledTimes(1);
    const finalStore = new LodyOperationStore(harness.storePath, () => TEST_NOW_MS);
    try {
      const delivery = finalStore.getDelivery(harness.requesterSessionId, 'review-round-1');
      expect(delivery).toMatchObject({
        state: 'consumed',
        attemptCount: 1,
      });
    } finally {
      finalStore.close();
    }
    expect(harness.histories.get(harness.requesterSessionId)).toEqual([
      expect.objectContaining({
        id: 'operation-completion:requester-1:review-round-1',
        items: [expect.objectContaining({ type: 'operation_completion' })],
      }),
    ]);
  });

  it('coalesces repeated wakes into one serial follow-up Delivery attempt', async () => {
    let resolveSync!: (value: boolean) => void;
    let markSyncStarted!: () => void;
    let inFlightSyncs = 0;
    let maxInFlightSyncs = 0;
    let syncCalls = 0;
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    const syncResult = new Promise<boolean>((resolve) => {
      resolveSync = resolve;
    });
    const configurationSync = vi.fn(async () => {
      syncCalls += 1;
      inFlightSyncs += 1;
      maxInFlightSyncs = Math.max(maxInFlightSyncs, inFlightSyncs);
      try {
        if (syncCalls === 1) {
          markSyncStarted();
          await syncResult;
        }
        return false;
      } finally {
        inFlightSyncs -= 1;
      }
    });
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      agentConfigId: 'agent-config-1',
      configurationSync,
    });

    harness.coordinator.start();
    await syncStarted;
    await Promise.all([
      harness.coordinator.wake('duplicate-1'),
      harness.coordinator.wake('duplicate-2'),
      harness.coordinator.wake('duplicate-3'),
    ]);
    resolveSync(false);
    await harness.coordinator.idle();
    harness.coordinator.stop();

    expect(configurationSync).toHaveBeenCalledTimes(2);
    expect(maxInFlightSyncs).toBe(1);
    expect(harness.openFlockDoc).toHaveBeenCalledTimes(2);
    expect(harness.continueSession).not.toHaveBeenCalled();
  });
});
