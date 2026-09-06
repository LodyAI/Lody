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

const makeHarness = async (options?: {
  deadlineAt?: string;
  requesterArchived?: boolean;
  pendingUser?: boolean;
  busy?: boolean;
  activeTurnId?: string;
  agentConfigId?: string;
  configurationSyncSucceeds?: boolean;
  configurationSync?: () => Promise<boolean>;
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
  materializeTargetOverride?: () => Promise<void>;
  targetDocSync?: () => Promise<{
    history?: SessionHistoryInput[];
    meta?: SessionMeta;
  } | void>;
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
    const typedMessage = message as { sessionId: SessionId };
    const typedOptions = dispatchOptions as { onTurnClaimed?: () => Promise<void> };
    await typedOptions.onTurnClaimed?.();
    histories.set(typedMessage.sessionId, [
      ...(histories.get(typedMessage.sessionId) ?? []),
      {
        id: `assistant:${histories.get(typedMessage.sessionId)?.length ?? 0}`,
        role: 'assistant',
        timestamp: '2026-07-20T00:00:01.000Z',
        items: [{ type: 'text', text: 'continued' }],
        fileDiff: [],
        finished: true,
      },
    ]);
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
  const coordinator = new LodyOperationCoordinator({
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
    operationStoreWatchFactory: (_directory, onChange) => {
      operationStoreWake = onChange;
      return { close: vi.fn() };
    },
    materializeTarget,
  });
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
    const harness = await makeHarness({ deadlineAt: '2026-07-19T16:00:00.000Z' });
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
      const typedOptions = dispatchOptions as { onTurnClaimed?: () => Promise<void> };
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
      const typedOptions = dispatchOptions as { onTurnClaimed?: () => Promise<void> };
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

  it('consumes existing continuation evidence before configuration lookup or sync', async () => {
    const harness = await makeHarness({
      deadlineAt: '2026-07-19T23:59:59.000Z',
      agentConfigId: 'removed-agent-config',
    });
    harness.histories.set(harness.requesterSessionId, [
      {
        id: 'operation-completion:requester-1:review-round-1',
        role: 'system',
        timestamp: '2026-07-20T00:00:00.000Z',
        items: [],
        fileDiff: [],
        finished: true,
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

    expect(harness.openFlockDoc).not.toHaveBeenCalled();
    expect(harness.syncMachineFlockDoc).not.toHaveBeenCalled();
    expect(harness.continueSession).not.toHaveBeenCalled();
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
