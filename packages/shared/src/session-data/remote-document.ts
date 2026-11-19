import { produce } from 'immer';
import { prepareReplacement } from '../history-writer';
import {
  HistoryEntryWriteSchema,
  HistoryWriteError,
  parseHistoryWrite,
} from '../history-write-schema';
import { PermissionOutcomeSchema } from '../message-schemas';
import type { SessionHistory } from '../schema';
import { applyHistoryAction, historyActionTarget } from './history-actions';
import { applyRespondPermission } from './planner';
import type { RemoteLoroHistoryPort, RemotePathEvent } from './remote-loro';
import type { SessionEntry } from './domain';
import type { SessionHistoryCommands } from './types';

// # Remote Session document
//
// The renderer holds no replica of a Session document. Reads go to the engine
// (bounded history pages, whole small control roots), one changed-path
// observation serves every view, and writes are JSON patches the engine applies
// with the document's persisted schema, so they create the containers the
// Mirror and the HistoryWriter would. History edits reuse the HistoryWriter's
// planners and validation on the stored JSON of the turns they touch.

type PathSegment = string | number;
export type RemotePatchOp =
  | { readonly op: 'set'; readonly path: readonly PathSegment[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly PathSegment[] }
  | {
      readonly op: 'arr_splice';
      readonly path: readonly PathSegment[];
      readonly at: number;
      readonly del: number;
      readonly items: readonly unknown[];
    }
  | {
      readonly op: 'move';
      readonly from: readonly PathSegment[];
      readonly to: readonly PathSegment[];
    };

/** `rebase`: apply at the version the ops were computed on, then merge. `cas`: only at that head. */
export type RemotePatchPrecondition =
  | { readonly mode: 'rebase'; readonly base_room_tx_id: number }
  | { readonly mode: 'cas'; readonly expected_room_tx_id: number };

/** The write reached the engine but its outcome is unknown: never treat it as not written. */
export class RemoteWriteIndeterminateError extends Error {
  constructor(cause?: unknown) {
    super('remote_write_indeterminate', { cause });
    this.name = 'RemoteWriteIndeterminateError';
  }
}

/** The write was refused before it reached the document: nothing was written. */
export class RemoteWriteRejectedError extends Error {
  constructor(cause: unknown) {
    super('remote_write_rejected', { cause });
    this.name = 'RemoteWriteRejectedError';
  }
}

/** The engine refused a conditional write because the document moved on. */
export class RemoteWriteConflictError extends Error {
  constructor() {
    super('remote_write_conflict');
    this.name = 'RemoteWriteConflictError';
  }
}

export interface RemoteSessionDocPort extends RemoteLoroHistoryPort {
  /** The JSON at `path` and the room head it was read at; `undefined` when absent. */
  readPathAt(path: readonly PathSegment[]): Promise<{ value: unknown; roomTxId: number }>;
  /**
   * Applies `ops` under `precondition`; resolves with the document's frontiers
   * after the write. Rejects with `RemoteWriteConflictError` on a stale `cas`,
   * `RemoteWriteIndeterminateError` when the outcome is unknown.
   */
  applyPatch(
    ops: readonly RemotePatchOp[],
    precondition: RemotePatchPrecondition
  ): Promise<{ frontiers: unknown }>;
}

/** One engine observation for any number of views of the same document. */
export function shareObservation<P extends RemoteLoroHistoryPort>(port: P): P {
  const listeners = new Set<(event: RemotePathEvent) => void>();
  let shared: ReturnType<P['observePaths']> | undefined;
  return {
    ...port,
    observePaths(listener) {
      listeners.add(listener);
      shared ??= port.observePaths((event) => {
        for (const each of [...listeners]) each(event);
      }) as ReturnType<P['observePaths']>;
      const current = shared;
      return {
        ready: current.ready,
        close() {
          if (!listeners.delete(listener) || listeners.size > 0) return;
          shared = undefined;
          current.close();
        },
      };
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const cidOf = (value: unknown): string | undefined =>
  isRecord(value) && typeof value.$cid === 'string' ? value.$cid : undefined;
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => equal(item, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a).filter((k) => k !== '$cid' && a[k] !== undefined);
    const other = Object.keys(b).filter((k) => k !== '$cid' && b[k] !== undefined);
    return keys.length === other.length && keys.every((k) => equal(a[k], b[k]));
  }
  return false;
};
/** A value as written: no `$cid` (the engine assigns container ids). */
const plain = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(plain);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value))
    if (key !== '$cid' && child !== undefined) out[key] = plain(child);
  return out;
};

/**
 * Ops turning `prev` into `next` at `path`, computed against `prev`. Lists of
 * `$cid` maps (movable lists) change by identity: removals, inserts and moves,
 * then field edits. Other arrays change by position, so an edit to one nested
 * field never rewrites sibling containers another writer may be streaming into.
 */
export function diffJson(prev: unknown, next: unknown, path: PathSegment[] = []): RemotePatchOp[] {
  if (equal(prev, next)) return [];
  if (isRecord(prev) && isRecord(next)) {
    const ops: RemotePatchOp[] = [];
    for (const [key, value] of Object.entries(next)) {
      if (key === '$cid' || value === undefined) continue;
      if (!(key in prev) || prev[key] === undefined)
        ops.push({ op: 'set', path: [...path, key], value: plain(value) });
      else ops.push(...diffJson(prev[key], value, [...path, key]));
    }
    for (const key of Object.keys(prev))
      if (key !== '$cid' && prev[key] !== undefined && next[key] === undefined)
        ops.push({ op: 'unset', path: [...path, key] });
    return ops;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (prev.length > 0 && prev.every((item) => cidOf(item) !== undefined))
      return diffIdentityList(prev, next, path);
    const ops: RemotePatchOp[] = [];
    const common = Math.min(prev.length, next.length);
    for (let i = 0; i < common; i++) ops.push(...diffJson(prev[i], next[i], [...path, i]));
    if (next.length > common)
      ops.push({
        op: 'arr_splice',
        path,
        at: common,
        del: 0,
        items: next.slice(common).map(plain),
      });
    else if (prev.length > common)
      ops.push({ op: 'arr_splice', path, at: common, del: prev.length - common, items: [] });
    return ops;
  }
  return [{ op: 'set', path, value: plain(next) }];
}

function diffIdentityList(
  prev: readonly unknown[],
  next: readonly unknown[],
  path: PathSegment[]
): RemotePatchOp[] {
  const ops: RemotePatchOp[] = [];
  const keep = new Set(next.map(cidOf).filter((cid): cid is string => cid !== undefined));
  const current: (string | undefined)[] = prev.map(cidOf);
  for (let i = current.length - 1; i >= 0; i--) {
    if (keep.has(current[i]!)) continue;
    ops.push({ op: 'arr_splice', path, at: i, del: 1, items: [] });
    current.splice(i, 1);
  }
  next.forEach((item, target) => {
    const cid = cidOf(item);
    const at = cid === undefined ? -1 : current.indexOf(cid);
    if (at < 0) {
      ops.push({ op: 'arr_splice', path, at: target, del: 0, items: [plain(item)] });
      current.splice(target, 0, undefined);
    } else if (at !== target) {
      ops.push({ op: 'move', from: [...path, at], to: [...path, target] });
      current.splice(target, 0, ...current.splice(at, 1));
    }
  });
  const byCid = new Map(prev.map((item) => [cidOf(item), item] as const));
  next.forEach((item, index) => {
    const before = byCid.get(cidOf(item));
    if (before !== undefined) ops.push(...diffJson(before, item, [...path, index]));
  });
  return ops;
}

/** Live JSON of the small control roots; writes apply optimistically, then commit. */
export interface RemoteControlState<S> {
  readonly ready: Promise<void>;
  getState(): S;
  subscribe(listener: (state: S) => void): () => void;
  /** Resolves with the frontiers after the commit. */
  update(updater: (draft: S) => void): Promise<{ frontiers: unknown }>;
  /** Resolves when every pending write has settled. */
  settled(): Promise<void>;
  close(): void;
}

export function createRemoteControlState<S extends Record<string, unknown>>(
  port: RemoteSessionDocPort,
  roots: readonly string[],
  initial: S
): RemoteControlState<S> {
  let state = initial;
  const readAt = new Map<string, number>();
  const listeners = new Set<(state: S) => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener(state);
  };
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };
  const reload = async (names: readonly string[]) => {
    const values = await Promise.all(names.map((name) => port.readPathAt([name])));
    const next = { ...state } as Record<string, unknown>;
    names.forEach((name, i) => {
      next[name] = values[i]!.value;
      readAt.set(name, values[i]!.roomTxId);
    });
    state = next as S;
    notify();
  };
  const ready = reload(roots);
  const observation = port.observePaths((event) => {
    const touched =
      event.kind === 'reset'
        ? roots
        : roots.filter((root) => event.changes.some((change) => change.path[0] === root));
    if (touched.length) void serial(() => reload(touched)).catch(() => {});
  });

  return {
    ready,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(updater) {
      // Compute and show the change now; commit in order, each against a fresh base.
      // The ops are computed against `before`, so they apply at the head it was read at.
      const before = state;
      const bases = new Map(readAt);
      const after = produce(before, updater as (draft: S) => void);
      state = after;
      notify();
      return serial(async () => {
        let frontiers: unknown;
        for (const root of roots) {
          const ops = diffJson(before[root], after[root], [root]);
          if (!ops.length) continue;
          try {
            ({ frontiers } = await port.applyPatch(ops, {
              mode: 'rebase',
              base_room_tx_id: bases.get(root) ?? 0,
            }));
          } catch (error) {
            if (error instanceof RemoteWriteIndeterminateError) throw error;
            throw new RemoteWriteRejectedError(error);
          } finally {
            // The engine's state is the truth: refresh the base for the next write.
            await reload([root]).catch(() => {});
          }
        }
        return { frontiers };
      });
    },
    settled: () => queue.then(() => {}),
    close: () => observation.close(),
  };
}

const MAX_ATTEMPTS = 8;
const equalTurns = (a: unknown, b: unknown) => diffJson(a, b).length === 0;

/**
 * History commands for a remote Session document, with the HistoryWriter's
 * planners and validation. New turns are appended at the version their position
 * was read at (`rebase`); edits of stored turns apply only at the head they were
 * read at (`cas`) and are recomputed when another write landed first.
 */
export function createRemoteHistoryCommands(
  port: RemoteSessionDocPort
): Pick<
  SessionHistoryCommands,
  'appendTurn' | 'replaceTurn' | 'respondPermission' | 'applyHistoryAction'
> {
  const positionsOf = async (turnId: string, all: boolean): Promise<number[]> => {
    const found: number[] = [];
    let end: number | undefined;
    for (;;) {
      const page = await port.readListFields(
        end === undefined ? -1024 : Math.max(0, end - 1024),
        end,
        [{ path: ['id'] }]
      );
      for (let i = page.rows.length - 1; i >= 0; i--)
        if (page.rows[i]?.[0] === turnId) {
          found.unshift(page.start + i);
          if (!all) return found;
        }
      if (page.start === 0) return found;
      end = page.start;
    }
  };
  /** Read the turns at `positions`, plan new values, and commit them at that head. */
  const editTurns = async <T>(
    turnId: string,
    all: boolean,
    plan: (turns: SessionEntry[]) => { turns: SessionEntry[]; result: T }
  ): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const positions = await positionsOf(turnId, all);
      if (!positions.length) return plan([]).result;
      const reads = await Promise.all(positions.map((p) => port.readPathAt(['history', p])));
      const head = Math.min(...reads.map((read) => read.roomTxId));
      if (reads.some((read) => read.roomTxId !== head)) continue;
      const turns = reads.map((read) => read.value as SessionEntry);
      // Planners may edit their input in place: plan on copies, diff against the reads.
      const planned = plan(turns.map((turn) => structuredClone(turn)));
      const ops = positions.flatMap((position, i) => {
        const next = planned.turns[i];
        if (next === undefined || equalTurns(turns[i], next)) return [];
        // The writer's changed-field validation, before anything is sent.
        return diffJson(turns[i], prepareReplacement(turns[i], next), ['history', position]);
      });
      if (!ops.length) return planned.result;
      try {
        await port.applyPatch(ops, { mode: 'cas', expected_room_tx_id: head });
        return planned.result;
      } catch (error) {
        if (!(error instanceof RemoteWriteConflictError) || attempt + 1 >= MAX_ATTEMPTS)
          throw error;
      }
    }
  };

  return {
    async appendTurn(turn) {
      const entry = parseHistoryWrite(HistoryEntryWriteSchema, turn);
      for (let attempt = 0; ; attempt++) {
        const { len, roomTxId } = await lengthAt();
        try {
          await port.applyPatch(
            [{ op: 'arr_splice', path: ['history'], at: len, del: 0, items: [plain(entry)] }],
            { mode: 'rebase', base_room_tx_id: roomTxId }
          );
          return;
        } catch (error) {
          if (!(error instanceof RemoteWriteConflictError) || attempt + 1 >= MAX_ATTEMPTS)
            throw error;
        }
      }
    },
    async replaceTurn(turnId, turn) {
      if (turn.id !== turnId) throw new HistoryWriteError([{ path: ['id'], code: 'immutable_id' }]);
      const found = await editTurns(turnId, false, ([stored]) => {
        if (!stored) return { turns: [], result: false };
        return {
          turns: [prepareReplacement(stored, turn) as unknown as SessionEntry],
          result: true,
        };
      });
      if (!found) throw new HistoryWriteError([{ path: ['history'], code: 'not_found' }]);
    },
    async respondPermission(requestId, outcome, options) {
      parseHistoryWrite(PermissionOutcomeSchema, outcome);
      const turnId = options?.turnId ?? (await turnWithRequest(requestId));
      if (!turnId) return false;
      return editTurns(turnId, false, ([stored]) => {
        if (!stored) return { turns: [], result: false };
        let matched = false;
        const next = produce(stored as SessionHistory, (draft) => {
          matched = applyRespondPermission(draft as never, requestId, outcome);
        }) as unknown as SessionEntry;
        return { turns: [next], result: matched };
      });
    },
    async applyHistoryAction(action) {
      const target = historyActionTarget(action);
      if (target === undefined || action.kind === 'operation-progress')
        throw new Error(`remote_history_action_unsupported:${action.kind}`);
      return editTurns(target, action.kind === 'user-status', (turns) => {
        const { turns: next, matched } = applyHistoryAction(turns, action);
        return { turns: next, result: { matched } };
      });
    },
  };

  /** The newest turn holding the request, read back from the tail in bounded pages. */
  async function turnWithRequest(requestId: string): Promise<string | undefined> {
    let end: number | undefined;
    for (;;) {
      const page = await port.readListFields(end === undefined ? -32 : Math.max(0, end - 32), end, [
        { path: ['id'] },
        { path: ['items'] },
      ]);
      for (let i = page.rows.length - 1; i >= 0; i--) {
        const [id, items] = page.rows[i] ?? [];
        if (typeof id !== 'string' || !Array.isArray(items)) continue;
        const holds = items.some(
          (item) =>
            isRecord(item) &&
            item.type === 'tool_call' &&
            isRecord(item.permissionRequest) &&
            item.permissionRequest.requestId === requestId
        );
        if (holds) return id;
      }
      if (page.start === 0) return undefined;
      end = page.start;
    }
  }

  async function lengthAt() {
    const page = await port.readListFields(0, 0, []);
    if (page.roomTxId === undefined) throw new Error('remote_history_head_unknown');
    return { len: page.len, roomTxId: page.roomTxId };
  }
}
