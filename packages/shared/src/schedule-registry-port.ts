import { z } from 'zod';
import type { WorkspaceId } from './ids';
import {
  ScheduleRegistryRowSchema,
  ScheduleRuntimeRowSchema,
  ScheduleTombstoneSchema,
  type ScheduleRegistryRow,
  type ScheduleRuntimeRow,
} from './schedule-types';
import {
  canonicalScheduleJson,
  collectScheduleIds,
  getScheduleRegistryFlockDocId,
  readScheduleRegistryRows,
  scheduleRegistryKeys,
  type ScheduleRegistryScanRow,
} from './schedule-registry';
import type { RepoRoomSubscription } from 'loro-repo';

export const scheduleManualRequestSchema = z.object({
  scheduleId: z.string().min(1),
  actorId: z.string().min(1),
  manualRunId: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),
  activationId: z.string().min(1),
  requestedAt: z.number().finite(),
});
export type ScheduleManualRequest = z.infer<typeof scheduleManualRequestSchema>;
export type ScheduleRegistrySnapshot = {
  schedules: ScheduleRegistryRow[];
  runtimes: ScheduleRuntimeRow[];
  manuals: ScheduleManualRequest[];
  tombstones: Array<{ scheduleId: string; deletedAt: number; actorId: string }>;
  discoveryIds: string[];
  synced: boolean;
};
export type ScheduleRegistryCommand =
  | { kind: 'publish'; row: ScheduleRegistryRow }
  | { kind: 'put-runtime'; runtime: ScheduleRuntimeRow }
  | { kind: 'tombstone'; scheduleId: string; actorId: string; now: number }
  | { kind: 'request-run'; request: ScheduleManualRequest }
  | {
      kind: 'prune' | 'prepare-prune' | 'complete-prune';
      scheduleId: string;
      actorId: string;
      machineId: string;
      activationId: string;
      runtimeUpdatedAt: number;
      now: number;
      retentionMs: number;
    };
export type ScheduleRetentionRequest = Omit<
  Extract<ScheduleRegistryCommand, { kind: 'prune' | 'prepare-prune' | 'complete-prune' }>,
  'kind' | 'scheduleId'
>;
export type ScheduleRegistryMutation =
  | { op: 'put'; key: string[]; value: unknown }
  | { op: 'delete'; key: string[] };
export interface ScheduleRegistryReader {
  readonly workspaceId: WorkspaceId;
  /** Trusted human export only; ordinary IPC excludes this method. */ exportRows(): Promise<
    readonly ScheduleRegistryScanRow[]
  >;
  read(): Promise<ScheduleRegistrySnapshot>;
  observe(
    update: (snapshot: ScheduleRegistrySnapshot) => void,
    error: (error: unknown) => void
  ): Promise<{ close(): void | Promise<void> }>;
}
export interface ScheduleRegistryCommands {
  execute(command: ScheduleRegistryCommand): Promise<{ changed: boolean }>;
  flush(): Promise<void>;
  sync(): Promise<void>;
}
export type ScheduleRegistryPort = ScheduleRegistryReader & ScheduleRegistryCommands;

export function projectScheduleRegistry(
  rows: Iterable<ScheduleRegistryScanRow>,
  synced = false
): ScheduleRegistrySnapshot {
  const entries = [...rows];
  const runtimes: ScheduleRuntimeRow[] = [];
  const manuals: ScheduleManualRequest[] = [];
  const tombstones: ScheduleRegistrySnapshot['tombstones'] = [];
  for (const entry of entries) {
    if (entry.key[0] === 'runtime') {
      const parsed = ScheduleRuntimeRowSchema.safeParse(entry.value);
      if (
        parsed.success &&
        entry.key.length === 3 &&
        entry.key[1] === parsed.data.scheduleId &&
        entry.key[2] === parsed.data.machineId
      )
        runtimes.push(parsed.data);
    }
    if (entry.key[0] === 'manual') {
      const parsed = scheduleManualRequestSchema.safeParse(entry.value);
      if (
        parsed.success &&
        entry.key.length === 3 &&
        entry.key[1] === parsed.data.scheduleId &&
        entry.key[2] === parsed.data.manualRunId
      )
        manuals.push(parsed.data);
    }
    if (
      entry.key[0] === 'tombstone' &&
      entry.key.length === 2 &&
      typeof entry.key[1] === 'string'
    ) {
      const parsed = ScheduleTombstoneSchema.safeParse(entry.value);
      if (parsed.success) tombstones.push({ scheduleId: entry.key[1], ...parsed.data });
    }
  }
  return {
    schedules: readScheduleRegistryRows(
      entries.map((entry) => {
        if (entry.key[0] !== 'schedule') return entry;
        const parsed = ScheduleRegistryRowSchema.strip().safeParse(entry.value);
        return parsed.success ? { ...entry, value: parsed.data } : entry;
      })
    ),
    runtimes,
    manuals,
    tombstones,
    discoveryIds: collectScheduleIds([], entries),
    synced,
  };
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const mergeKnown = (raw: unknown, next: Record<string, unknown>, keys: readonly string[]) => {
  const value = { ...record(raw), ...next };
  for (const key of keys) if (!(key in next) || next[key] === undefined) delete value[key];
  return value;
};
/** One planner for legacy mutations and native CAS retries. Never repairs orphan definitions. */
export function planScheduleRegistry(
  rows: readonly ScheduleRegistryScanRow[],
  command: ScheduleRegistryCommand
): ScheduleRegistryMutation[] {
  const get = (key: readonly string[]) =>
    rows.find((row) => canonicalScheduleJson(row.key) === canonicalScheduleJson(key))?.value;
  const put = (key: string[], value: unknown): ScheduleRegistryMutation[] =>
    canonicalScheduleJson(get(key)) === canonicalScheduleJson(value)
      ? []
      : [{ op: 'put', key, value }];
  const id =
    command.kind === 'publish'
      ? command.row.scheduleId
      : command.kind === 'put-runtime'
        ? command.runtime.scheduleId
        : command.kind === 'request-run'
          ? command.request.scheduleId
          : command.scheduleId;
  const tombstone = ScheduleTombstoneSchema.safeParse(get(scheduleRegistryKeys.tombstone(id)));
  const raw = get(scheduleRegistryKeys.schedule(id));
  const row = ScheduleRegistryRowSchema.strip().safeParse(raw);
  if (command.kind === 'publish') {
    const next = ScheduleRegistryRowSchema.parse(command.row);
    if (tombstone.success) throw new Error('Schedule was deleted');
    if (raw !== undefined && !row.success)
      throw new Error('Unsupported existing Schedule registry row');
    if (row.success && row.data.ownerId !== next.ownerId)
      throw new Error('Only the Schedule owner can change it');
    return put(
      scheduleRegistryKeys.schedule(id),
      mergeKnown(raw, next, Object.keys(ScheduleRegistryRowSchema.shape))
    );
  }
  if (command.kind === 'put-runtime') {
    const next = ScheduleRuntimeRowSchema.parse(command.runtime);
    const key = scheduleRegistryKeys.runtime(id, next.machineId);
    const prior = ScheduleRuntimeRowSchema.safeParse(get(key));
    const retained = {
      ...next,
      lastDispatch:
        next.lastDispatch ??
        (prior.success && prior.data.activationId === next.activationId
          ? prior.data.lastDispatch
          : undefined),
    };
    if (
      prior.success &&
      canonicalScheduleJson({ ...prior.data, updatedAt: 0 }) ===
        canonicalScheduleJson({ ...retained, updatedAt: 0 })
    )
      return [];
    return put(key, mergeKnown(get(key), retained, Object.keys(ScheduleRuntimeRowSchema.shape)));
  }
  if (command.kind === 'tombstone') {
    if (tombstone.success) {
      if (tombstone.data.actorId !== command.actorId)
        throw new Error('Only the Schedule owner can delete it');
      return [];
    }
    if (!row.success || row.data.ownerId !== command.actorId)
      throw new Error('Only the Schedule owner can delete it');
    return put(
      scheduleRegistryKeys.tombstone(id),
      ScheduleTombstoneSchema.parse({ deletedAt: command.now, actorId: command.actorId })
    );
  }
  if (command.kind === 'request-run') {
    const request = scheduleManualRequestSchema.parse(command.request);
    if (tombstone.success) throw new Error('Schedule was deleted');
    if (
      !row.success ||
      row.data.ownerId !== request.actorId ||
      row.data.activationId !== request.activationId
    )
      throw new Error('Schedule request binding changed');
    const key = scheduleRegistryKeys.manual(id, request.manualRunId);
    const existing = get(key);
    if (existing !== undefined) {
      if (
        canonicalScheduleJson({ ...record(existing), requestedAt: 0 }) !==
        canonicalScheduleJson({ ...request, requestedAt: 0 })
      )
        throw new Error('Idempotency key conflict');
      return [];
    }
    return put(key, request);
  }
  if (
    !Number.isFinite(command.now) ||
    !Number.isFinite(command.runtimeUpdatedAt) ||
    !Number.isFinite(command.retentionMs) ||
    command.retentionMs < 0
  )
    throw new Error('Invalid Schedule retention input');
  if (command.kind === 'complete-prune') {
    const expected = {
      activationId: command.activationId,
      runtimeUpdatedAt: command.runtimeUpdatedAt,
      now: command.now,
      retentionMs: command.retentionMs,
      machineId: command.machineId,
    };
    const retained = record(get(scheduleRegistryKeys.tombstone(id)));
    if (
      !tombstone.success ||
      tombstone.data.actorId !== command.actorId ||
      canonicalScheduleJson(retained.nativeRetention) !== canonicalScheduleJson(expected)
    )
      throw new Error('Schedule retention reservation missing');
    if (raw !== undefined && !row.success) throw new Error('Unsupported retained Schedule row');
    if (
      row.success &&
      (row.data.ownerId !== command.actorId ||
        row.data.machineId !== command.machineId ||
        row.data.activationId !== command.activationId ||
        !row.data.scheduledMessage)
    )
      throw new Error('Schedule retention binding changed');
    return rows
      .filter(
        (entry) =>
          (entry.key[0] === 'schedule' ||
            entry.key[0] === 'runtime' ||
            entry.key[0] === 'manual') &&
          entry.key[1] === id
      )
      .map((entry) => ({ op: 'delete' as const, key: entry.key.map(String) }));
  }
  const runtime = ScheduleRuntimeRowSchema.safeParse(
    get(scheduleRegistryKeys.runtime(id, command.machineId))
  );
  if (
    !row.success ||
    !row.data.scheduledMessage ||
    row.data.ownerId !== command.actorId ||
    row.data.machineId !== command.machineId ||
    row.data.activationId !== command.activationId ||
    !runtime.success ||
    runtime.data.activationId !== command.activationId ||
    runtime.data.updatedAt !== command.runtimeUpdatedAt ||
    !['sent', 'cancelled', 'failed'].includes(runtime.data.messageState ?? '') ||
    command.now - runtime.data.updatedAt < command.retentionMs
  )
    return [];
  const retention = {
    activationId: command.activationId,
    runtimeUpdatedAt: command.runtimeUpdatedAt,
    now: command.now,
    retentionMs: command.retentionMs,
    machineId: command.machineId,
  };
  const priorTombstone = get(scheduleRegistryKeys.tombstone(id));
  if (command.kind === 'prepare-prune') {
    if (tombstone.success && tombstone.data.actorId !== command.actorId)
      throw new Error('Schedule retention owner changed');
    const existing = record(priorTombstone).nativeRetention;
    if (existing !== undefined) {
      if (canonicalScheduleJson(existing) !== canonicalScheduleJson(retention))
        throw new Error('Schedule retention intent changed');
      return [];
    }
    return put(scheduleRegistryKeys.tombstone(id), {
      ...record(priorTombstone),
      ...ScheduleTombstoneSchema.parse({ deletedAt: command.now, actorId: command.actorId }),
      nativeRetention: retention,
    });
  }
  return [
    {
      op: 'put',
      key: scheduleRegistryKeys.tombstone(id),
      value: {
        ...record(priorTombstone),
        ...ScheduleTombstoneSchema.parse({ deletedAt: command.now, actorId: command.actorId }),
      },
    },
    ...rows
      .filter(
        (entry) =>
          (entry.key[0] === 'schedule' ||
            entry.key[0] === 'runtime' ||
            entry.key[0] === 'manual') &&
          entry.key[1] === id
      )
      .map((entry) => ({ op: 'delete' as const, key: entry.key.map(String) })),
  ];
}
export type LegacyScheduleRegistryRepo = {
  openFlockDoc(id: string): Promise<{
    flock: {
      scan(): Iterable<ScheduleRegistryScanRow>;
      set(key: string[], value: never): unknown;
      delete?(key: string[]): unknown;
      subscribe?(callback: () => void): () => void;
    };
    syncOnce?(): Promise<unknown>;
    joinRoom?(): Promise<RepoRoomSubscription>;
  }>;
  flush(): Promise<void>;
};
/** Real legacy owner. No asynchronous writable mirror is exposed by the domain port. */
export function createLegacyScheduleRegistry(options: {
  workspaceId: WorkspaceId;
  repo: LegacyScheduleRegistryRepo;
  /** UI recovery replaces the room; daemon observation retains its stable binding. */
  releaseRoomOnSyncError?: boolean;
  selectBinding?: (
    subscription: RepoRoomSubscription
  ) => ReturnType<RepoRoomSubscription['subscription']>;
}): ScheduleRegistryPort {
  const open = () => options.repo.openFlockDoc(getScheduleRegistryFlockDocId(options.workspaceId));
  return {
    workspaceId: options.workspaceId,
    async exportRows() {
      return [...(await open()).flock.scan()];
    },
    async read() {
      return projectScheduleRegistry((await open()).flock.scan());
    },
    async execute(command) {
      const handle = await open();
      const ops = planScheduleRegistry([...handle.flock.scan()], command);
      if (ops.some((op) => op.op === 'delete') && !handle.flock.delete)
        throw new Error('Registry removal unavailable');
      for (const op of ops)
        if (op.op === 'put') handle.flock.set(op.key, op.value as never);
        else handle.flock.delete?.(op.key);
      return { changed: ops.length > 0 };
    },
    flush: () => options.repo.flush(),
    async sync() {
      const handle = await open();
      if (handle.syncOnce) await handle.syncOnce();
    },
    async observe(update, onError) {
      const handle = await open();
      let closed = false;
      let synced = false;
      let generation = 0;
      let room: RepoRoomSubscription | undefined;
      let offStatus = () => {};
      const emit = () => {
        if (!closed)
          try {
            update(projectScheduleRegistry(handle.flock.scan(), synced));
          } catch (error) {
            onError(error);
          }
      };
      const initial = projectScheduleRegistry(handle.flock.scan());
      const off = handle.flock.subscribe?.(emit) ?? (() => {});
      try {
        update(initial);
      } catch (error) {
        off();
        throw error;
      }
      try {
        if (handle.joinRoom) {
          room = await handle.joinRoom();
          const binding = options.selectBinding?.(room) ?? room.subscription('streams');
          const status = () => {
            const current = ++generation;
            synced = false;
            emit();
            if (binding.status !== 'joined') return;
            void (async () => {
              await binding.firstSyncedWithRemote;
              await binding.waitUntilSynced();
              if (!closed && generation === current && binding.status === 'joined') {
                synced = true;
                emit();
              }
            })().catch((error) => {
              if (!closed) {
                if (options.releaseRoomOnSyncError) {
                  offStatus();
                  const failed = room;
                  room = undefined;
                  failed?.unsubscribe();
                }
                onError(error);
              }
            });
          };
          offStatus = binding.onStatusChange(status);
          status();
        }
      } catch (error) {
        off();
        room?.unsubscribe();
        throw error;
      }
      return {
        close() {
          closed = true;
          generation++;
          offStatus();
          off();
          room?.unsubscribe();
        },
      };
    },
  };
}
