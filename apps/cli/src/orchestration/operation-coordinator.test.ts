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
  materializeTargetOverride?: () => Promise<void>;
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
  const sessionDoc = (sessionId: SessionId) => ({
    mirror: {
      subscribe: (callback: () => void) => {
        const set = subscribers.get(sessionId) ?? new Set();
        set.add(callback);
        subscribers.set(sessionId, set);
        return () => set.delete(callback);
      },
    },
    getHistory: async () => histories.get(sessionId) ?? [],
    updateHistory: async (update: (history: SessionHistoryInput[]) => SessionHistoryInput[]) => {
      if (sessionId === requesterSessionId) {
        historyUpdateAttempt += 1;
        if (historyUpdateAttempt <= (options?.historyFailuresBeforeSuccess ?? 0)) {
          throw new Error('transient history write failure');
        }
      }
      histories.set(sessionId, update(histories.get(sessionId) ?? []));
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
    kind: 'session_chat',
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
        expect(delivery.activeClaimId).toBeUndefined();
        expect(delivery.activeClaimWorkerBootId).toBeUndefined();
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
