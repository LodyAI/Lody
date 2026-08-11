import { describe, expect, it, vi } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import type { RepoRoomSubscription, RepoTransportRoomSubscription } from 'loro-repo';
import {
  getMachineFlockDocId,
  getTaskIndexFlockDocId,
  machineFlockKeys,
  taskIndexKeys,
  writeMachineFlockRowToFlock,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type TaskId,
  type TaskIndexRow,
  type WorkspaceId,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { readTaskIndexRowsForWorkspace } from './task-automation-scheduler';
import { createTaskAutomationWorkspace } from './task-automation-workspace';

/**
 * These tests run against a REAL `Flock`. A hand-written scan mock is a plain
 * function and keeps working when the production code detaches `scan` from its
 * receiver — which is exactly the failure that left delegated automation dead
 * in every workspace.
 */

const WORKSPACE = 'ws-1' as WorkspaceId;
const MACHINE = 'machine-1' as MachineId;
const OPERATOR = 'user-1';
const AGENT = 'agent-1' as AgentConfigId;

const createDeferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const taskRow = (overrides: Partial<TaskIndexRow> = {}): TaskIndexRow => ({
  taskId: 't1',
  title: 'Ship it',
  status: 'backlog',
  ownerId: OPERATOR,
  order: '2',
  hasAgent: true,
  agentConfigId: AGENT,
  ready: true,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

const putTaskRow = (flock: Flock, row: TaskIndexRow): void => {
  flock.set(taskIndexKeys.task(row.taskId as TaskId), { ...row });
  flock.commit();
};

const agentConfig = (): AgentConfigMeta =>
  ({
    id: AGENT,
    machineId: MACHINE,
    name: 'Agent 1',
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
  }) as AgentConfigMeta;

describe('readTaskIndexRowsForWorkspace', () => {
  it('scans a real Flock handle', async () => {
    const flock = new Flock('index-peer');
    putTaskRow(flock, taskRow());

    const rows = await readTaskIndexRowsForWorkspace(
      { openFlockDoc: async () => ({ flock }) },
      WORKSPACE
    );

    expect(rows.map((row) => row.taskId)).toEqual(['t1']);
  });

  it('hides deleted rows', async () => {
    const flock = new Flock('index-peer');
    putTaskRow(flock, taskRow());
    putTaskRow(flock, taskRow({ taskId: 't2', deletedAt: 5 }));

    const rows = await readTaskIndexRowsForWorkspace(
      { openFlockDoc: async () => ({ flock }) },
      WORKSPACE
    );

    expect(rows.map((row) => row.taskId)).toEqual(['t1']);
  });
});

describe('createTaskAutomationWorkspace', () => {
  const createHarness = (options: { seedRows?: TaskIndexRow[] } = {}) => {
    const indexFlock = new Flock('index-peer');
    for (const row of options.seedRows ?? []) {
      putTaskRow(indexFlock, row);
    }
    const machineFlock = new Flock('machine-peer');
    writeMachineFlockRowToFlock(machineFlock, {
      key: machineFlockKeys.agentConfig(AGENT),
      value: agentConfig(),
    });
    const flocks = new Map<string, Flock>([
      [getTaskIndexFlockDocId(WORKSPACE), indexFlock],
      [getMachineFlockDocId(WORKSPACE, MACHINE), machineFlock],
    ]);

    const joinedRoom = createDeferred();
    const roomUnsubscribe = vi.fn();
    const firstSynced = createDeferred();
    const streamsBinding = {
      transportId: 'streams',
      status: 'joined',
      onStatusChange: vi.fn(() => vi.fn()),
      firstSyncedWithRemote: firstSynced.promise,
      waitUntilSynced: vi.fn(() => firstSynced.promise),
      rejoin: vi.fn(async () => undefined),
    } satisfies RepoTransportRoomSubscription;
    const joinRoom = vi.fn(async (): Promise<RepoRoomSubscription> => {
      joinedRoom.resolve();
      return {
        unsubscribe: roomUnsubscribe,
        firstSyncedWithRemote: firstSynced.promise,
        waitUntilSynced: vi.fn(() => firstSynced.promise),
        rejoin: vi.fn(async () => undefined),
        status: 'joined',
        onStatusChange: vi.fn(() => vi.fn()),
        transportIds: () => ['streams'],
        subscription: (transportId) => {
          if (transportId !== 'streams') {
            throw new Error(`unexpected transport ${transportId}`);
          }
          return streamsBinding;
        },
        subscriptions: () => [streamsBinding],
      };
    });

    const documentManager = {
      repo: {
        // Workspace meta: no agent-config documents, no task documents.
        getMeta: () => new Flock('meta-peer'),
        getDocMeta: async () => undefined,
        openFlockDoc: async (flockDocId: string) => {
          const flock = flocks.get(flockDocId);
          if (!flock) {
            throw new Error(`unexpected flock doc ${flockDocId}`);
          }
          return { flock, joinRoom, syncOnce: async () => undefined };
        },
      },
      isTransportConnected: () => true,
      onMetaRoomSynced: () => () => undefined,
      onStreamsOnline: () => () => undefined,
    } as unknown as LoroDocumentManager;

    const started: string[] = [];
    const startCalled = createDeferred();
    const warned = createDeferred<string>();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn((message: string) => warned.resolve(message)),
      error: vi.fn(),
    } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
    const handle = createTaskAutomationWorkspace({
      documentManager,
      workspaceId: WORKSPACE,
      machineId: MACHINE,
      userId: OPERATOR,
      logger,
      startTask: async (taskId, agentConfigId) => {
        started.push(`${taskId}:${agentConfigId}`);
        startCalled.resolve();
      },
    });

    return {
      handle,
      indexFlock,
      firstSynced,
      roomUnsubscribe,
      started,
      startCalled,
      warned,
      logger,
      /**
       * Resolves once the baseline pass ran and the room was joined. An attach
       * failure reports itself here instead of hanging until the test timeout.
       */
      attached: () =>
        Promise.race([
          joinedRoom.promise,
          warned.promise.then((message) => {
            throw new Error(message);
          }),
        ]),
    };
  };

  it('attaches to the task index and starts work assigned after boot', async () => {
    const harness = createHarness();
    // `joinRoom` is reached only after the baseline pass read the (empty) index,
    // so the row written below is a fresh assignment, not pre-existing backlog.
    await harness.attached();
    harness.firstSynced.resolve();

    putTaskRow(harness.indexFlock, taskRow());
    await harness.startCalled.promise;

    expect(harness.started).toEqual(['t1:agent-1']);
    expect(harness.logger.warn).not.toHaveBeenCalled();
    await harness.handle.dispose();
  });

  it('never starts a task that was already waiting at boot', async () => {
    const harness = createHarness({ seedRows: [taskRow()] });
    await harness.attached();
    harness.firstSynced.resolve();

    await harness.handle.evaluate();

    expect(harness.started).toEqual([]);
    await harness.handle.dispose();
  });

  it('reports an attach failure instead of dying silently', async () => {
    const warned = createDeferred<string>();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn((message: string) => warned.resolve(message)),
      error: vi.fn(),
    } as unknown as Logger;
    const documentManager = {
      repo: {
        getMeta: () => new Flock('meta-peer'),
        getDocMeta: async () => undefined,
        openFlockDoc: async () => {
          throw new Error('flock doc unavailable');
        },
      },
      isTransportConnected: () => true,
      onMetaRoomSynced: () => () => undefined,
      onStreamsOnline: () => () => undefined,
    } as unknown as LoroDocumentManager;

    const handle = createTaskAutomationWorkspace({
      documentManager,
      workspaceId: WORKSPACE,
      machineId: MACHINE,
      userId: OPERATOR,
      logger,
      startTask: async () => undefined,
    });

    await expect(warned.promise).resolves.toContain('failed to attach task index');
    await handle.dispose();
  });
});
