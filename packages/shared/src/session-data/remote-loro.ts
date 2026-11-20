import { resolveLatestSessionGoalFromHistory, type SessionGoalMessage } from '../goal';
import {
  historyQueryRow,
  selectTranscriptTail,
  type HistoryQueryAccess,
  type HistoryQueryRow,
} from './history-selection';
import { SESSION_DIRECTORY_INPUT_CONFIG_KEYS } from './domain';
import type { SessionDirectoryRow, SessionEntry, SessionTurnRead } from './domain';
import {
  pickDirectoryInputConfig,
  pickDirectoryScalars,
  SESSION_DIRECTORY_SCALAR_KEYS,
} from './directory';
import type {
  SessionDataChangeListener,
  SessionHistoryDirectoryPage,
  SessionHistoryReader,
  SessionObservation,
} from './types';

// # Remote Loro history reader
//
// Reads a Loro Session document that lives in another process (the native
// engine) without a local replica: bounded directory pages and single turns are
// read on request, and observation receives only which containers changed. The
// projection rules match the in-process Loro reader's plain-JSON rows.

type PathSegment = string | number;

/** One projected field of each history item; `shape` returns a container's kind and length. */
export interface RemoteListField {
  readonly path: readonly PathSegment[];
  readonly shape?: boolean;
}

/** One container a commit changed; no values. */
export interface RemotePathChange {
  readonly path: readonly PathSegment[];
  readonly kind: string;
  readonly ops?: readonly ({ retain: number } | { insert: number } | { delete: number })[];
  readonly keys?: readonly string[];
}

export type RemotePathEvent =
  /** The observation (re)started at the head; anything held may be stale. */
  | { readonly kind: 'reset' }
  | { readonly kind: 'changes'; readonly changes: readonly RemotePathChange[] };

export interface RemoteLoroHistoryPort {
  /** Items `[start, end)` of `history` (negative counts from the end); cells align with `fields`. */
  readListFields(
    start: number,
    end: number | undefined,
    fields: readonly RemoteListField[]
  ): Promise<{
    len: number;
    start: number;
    rows: readonly (readonly unknown[])[];
    /** The room head the page was read at. */
    roomTxId?: number;
  }>;
  /** The JSON value at `path` from the document root, or undefined when absent. */
  readPath(path: readonly PathSegment[]): Promise<unknown>;
  /** Changed-path observation; `ready` settles once it is established at the head. */
  observePaths(listener: (event: RemotePathEvent) => void): {
    readonly ready: Promise<void>;
    close(): void;
  };
}

const HISTORY = 'history';
const ID_FIELD: RemoteListField = { path: ['id'] };
const DIRECTORY_FIELDS: readonly RemoteListField[] = [
  ...SESSION_DIRECTORY_SCALAR_KEYS.map((key) => ({ path: [key] })),
  { path: ['userId'] },
  { path: ['scheduleRun'] },
  ...SESSION_DIRECTORY_INPUT_CONFIG_KEYS.map((key) => ({ path: ['inputConfig', key] })),
];
const SCALAR_COUNT = SESSION_DIRECTORY_SCALAR_KEYS.length;
const CONFIG_FROM = SCALAR_COUNT + 2;
/** Identity scans read ids only, in pages of this many items. */
const ID_SCAN_PAGE = 1024;

/**
 * A directory row from one aligned field row, as the in-process Loro reader
 * projects a turn map: counts are omitted and arrive with a hydration read.
 */
function directoryRow(position: number, cells: readonly unknown[]): SessionDirectoryRow {
  const record: Record<string, unknown> = {};
  SESSION_DIRECTORY_SCALAR_KEYS.forEach((key, index) => {
    if (cells[index] !== undefined) record[key] = cells[index];
  });
  const scalars = pickDirectoryScalars(record);
  if (!scalars) return { position, state: 'invalid' };
  const userId = cells[SCALAR_COUNT];
  const scheduleRun = cells[SCALAR_COUNT + 1];
  const row: SessionDirectoryRow = {
    metadataVersion: 1,
    position,
    state: 'ready',
    turnId: scalars.id,
    scalars,
    ...(typeof userId === 'string' ? { userId } : {}),
    ...(scheduleRun !== undefined ? { scheduleRun } : {}),
  };
  if (scalars.role !== 'user') return row;
  // Send configuration projects on first read, as in the in-process reader.
  const config: Record<string, unknown> = {};
  SESSION_DIRECTORY_INPUT_CONFIG_KEYS.forEach((key, index) => {
    const value = cells[CONFIG_FROM + index];
    if (value !== undefined) config[key] = value;
  });
  let projected: unknown;
  let done = false;
  Object.defineProperty(row, 'inputConfig', {
    enumerable: true,
    configurable: true,
    get: () => {
      if (!done) {
        done = true;
        projected = pickDirectoryInputConfig(config);
      }
      return projected;
    },
  });
  return row;
}

const asTurnRead = (value: unknown): SessionTurnRead =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? { state: 'ready', turn: value as SessionEntry }
    : { state: 'invalid' };

/**
 * A `SessionHistoryReader` over a remote Loro Session document. Directory reads
 * are bounded pages; a turn id resolves through positions this reader has seen,
 * else an id-only scan back from the tail. Observation turns changed paths into
 * structural ranges (list edits, identity edits) or changed turn ids.
 */
export function createRemoteLoroHistoryReader(port: RemoteLoroHistoryPort): SessionHistoryReader {
  /** Positions of ids seen in reads since the last structural change. */
  let positions = new Map<string, number>();
  let ids = new Map<number, string>();
  let knownLength: number | undefined;

  const remember = (position: number, id: unknown) => {
    if (typeof id !== 'string') return;
    positions.set(id, position);
    ids.set(position, id);
  };
  const forgetFrom = (from: number) => {
    for (const [position, id] of ids) {
      if (position < from) continue;
      ids.delete(position);
      if (positions.get(id) === position) positions.delete(id);
    }
  };

  /** Rows `[from, to)`, in as many bounded pages as the engine's byte limit needs. */
  const readDirectory = async (from: number, to: number) => {
    const rows: SessionDirectoryRow[] = [];
    let at = Math.max(0, from);
    while (at < to) {
      const page = await port.readListFields(at, to, DIRECTORY_FIELDS);
      knownLength = page.len;
      for (const [offset, cells] of page.rows.entries()) {
        const row = directoryRow(page.start + offset, cells);
        remember(row.position, row.turnId);
        rows.push(row);
      }
      if (page.rows.length === 0) break;
      at = page.start + page.rows.length;
      if (at >= page.len) break;
    }
    return rows;
  };

  /** The page of `limit` items ending at `end`, or at the tail when `end` is omitted. */
  const readPage = async (
    end: number | undefined,
    limit: number
  ): Promise<SessionHistoryDirectoryPage> => {
    const size = Math.max(1, Math.floor(limit));
    const page = await port.readListFields(
      end === undefined ? -size : Math.max(0, end - size),
      end,
      DIRECTORY_FIELDS
    );
    knownLength = page.len;
    const rows = page.rows.map((cells, offset) => {
      const row = directoryRow(page.start + offset, cells);
      remember(row.position, row.turnId);
      return row;
    });
    return {
      startPosition: page.start,
      totalCount: page.len,
      rows,
      hasMoreOlder: page.start > 0,
      cursor: page.start > 0 ? String(page.start) : null,
    };
  };

  /** Newest position holding `turnId`, by an id-only scan back from the tail. */
  const scanFor = async (turnId: string): Promise<number | undefined> => {
    let end: number | undefined;
    for (;;) {
      const start = end === undefined ? -ID_SCAN_PAGE : Math.max(0, end - ID_SCAN_PAGE);
      const page = await port.readListFields(start, end, [ID_FIELD]);
      knownLength = page.len;
      for (let offset = page.rows.length - 1; offset >= 0; offset -= 1) {
        if (page.rows[offset]?.[0] === turnId) {
          remember(page.start + offset, turnId);
          return page.start + offset;
        }
      }
      if (page.start === 0) return undefined;
      end = page.start;
    }
  };

  /** A position seen in a read, else a scan; callers verify the id they read there. */
  const locate = async (turnId: string) => positions.get(turnId) ?? scanFor(turnId);

  const readAt = async (position: number): Promise<SessionTurnRead> => {
    if (position < 0) return { state: 'missing' };
    const value = await port.readPath([HISTORY, position]);
    return value === undefined ? { state: 'missing' } : asTurnRead(value);
  };

  const readTurn = async (turnId: string): Promise<SessionTurnRead> => {
    const known = positions.get(turnId);
    if (known !== undefined) {
      const read = await readAt(known);
      if (read.state === 'ready' && read.turn.id === turnId) return read;
      // The turn moved since it was seen there.
      positions.delete(turnId);
    }
    const position = await scanFor(turnId);
    if (position === undefined) return { state: 'missing' };
    const read = await readAt(position);
    if (read.state === 'ready' && read.turn.id !== turnId) {
      positions.delete(turnId);
      const again = await scanFor(turnId);
      return again === undefined ? { state: 'missing' } : readAt(again);
    }
    return read;
  };

  const count = async () => (await port.readListFields(0, 0, [])).len;

  const reader: SessionHistoryReader = {
    count,
    readAt,
    readTurn,
    async readRange(from, to) {
      const out: SessionTurnRead[] = [];
      for (let position = Math.max(0, from); position < to; position += 1)
        out.push(await readAt(position));
      return out;
    },
    readDirectory: (from, to) => readDirectory(from, to),
    readLatestDirectoryPage: (limit) => readPage(undefined, limit),
    async readOlderDirectoryPage(cursor, limit) {
      const end = Number(cursor);
      if (!Number.isSafeInteger(end) || end <= 0) throw new Error('invalid_directory_cursor');
      return readPage(end, limit);
    },
    async readAll() {
      const all = await port.readPath([HISTORY]);
      return (Array.isArray(all) ? all : []) as SessionEntry[];
    },
    async readTurnOutput(userTurnId) {
      let position = await locate(userTurnId);
      if (position === undefined) return [];
      let [user] = await readDirectory(position, position + 1);
      if (user?.turnId !== userTurnId) {
        positions.delete(userTurnId);
        position = await scanFor(userTurnId);
        if (position === undefined) return [];
        [user] = await readDirectory(position, position + 1);
      }
      const scalars = user?.scalars;
      if (!scalars || scalars.role !== 'user' || scalars.id !== userTurnId) return [];
      const selected: SessionEntry[] = [{ ...scalars, role: 'user', items: [], fileDiff: [] }];
      const failed = scalars.status === 'failed';
      // The linked assistant and failure notices follow their user turn closely.
      for (let from = position + 1; ; from += 64) {
        const rows = await readDirectory(from, from + 64);
        for (const row of rows) {
          const role = row.scalars?.role;
          const assistant = role === 'assistant' && row.scalars?.userTurnId === userTurnId;
          if (assistant || (failed && role === 'system')) {
            const read = await readAt(row.position);
            if (read.state === 'ready') selected.push(read.turn as SessionEntry);
            if (assistant && !failed) return selected;
          }
        }
        if (rows.length < 64) return selected;
      }
    },
    observe(listener: SessionDataChangeListener): SessionObservation {
      // Deliver in order: id lookups for changed positions are asynchronous.
      let queue = Promise.resolve();
      const enqueue = (task: () => Promise<void>) => {
        queue = queue.then(task).catch(() => {
          // A failed lookup cannot name the changed turns: re-key everything.
          listener({ kind: 'structure', from: 0, to: Number.MAX_SAFE_INTEGER });
        });
      };
      // The first reset only establishes the observation; nothing is held yet.
      let established = false;
      const observation = port.observePaths((event) => {
        if (event.kind === 'reset') {
          if (!established) {
            established = true;
            return;
          }
          positions = new Map();
          ids = new Map();
          enqueue(async () =>
            listener({ kind: 'structure', from: 0, to: Number.MAX_SAFE_INTEGER })
          );
          return;
        }
        let structuralFrom = Number.POSITIVE_INFINITY;
        let lengthDelta = 0;
        const changed = new Set<number>();
        for (const change of event.changes) {
          if (change.path[0] !== HISTORY) continue;
          if (change.path.length === 1) {
            let cursor = 0;
            for (const op of change.ops ?? []) {
              if ('retain' in op) cursor += op.retain;
              else if ('insert' in op) {
                structuralFrom = Math.min(structuralFrom, cursor);
                cursor += op.insert;
                lengthDelta += op.insert;
              } else {
                structuralFrom = Math.min(structuralFrom, cursor);
                lengthDelta -= op.delete;
              }
            }
            continue;
          }
          const position = change.path[1];
          if (typeof position !== 'number') {
            structuralFrom = 0;
            continue;
          }
          // An identity edit re-keys the turn: structural from its position.
          if (change.path.length === 2 && change.keys?.includes('id'))
            structuralFrom = Math.min(structuralFrom, position);
          changed.add(position);
        }
        if (Number.isFinite(structuralFrom)) {
          // Earlier content edits in the same commit are re-read with the range.
          for (const position of changed) structuralFrom = Math.min(structuralFrom, position);
          const from = structuralFrom;
          forgetFrom(from);
          const to =
            knownLength === undefined ? Number.MAX_SAFE_INTEGER : knownLength + lengthDelta;
          if (knownLength !== undefined) knownLength += lengthDelta;
          enqueue(async () => listener({ kind: 'structure', from, to: Math.max(from, to) }));
          return;
        }
        if (changed.size === 0) return;
        const targets = [...changed].sort((a, b) => a - b);
        enqueue(async () => {
          const named: string[] = [];
          const unknown: number[] = [];
          for (const position of targets) {
            const id = ids.get(position);
            if (id === undefined) unknown.push(position);
            else named.push(id);
          }
          for (const position of unknown) {
            const page = await port.readListFields(position, position + 1, [ID_FIELD]);
            const id = page.rows[0]?.[0];
            if (typeof id === 'string') {
              remember(position, id);
              named.push(id);
            }
          }
          if (named.length > 0) listener({ kind: 'changed', ids: named });
        });
      });
      let initial: Promise<readonly SessionDirectoryRow[]> | undefined;
      let active = true;
      return {
        // A whole directory only for a consumer that reads it, after the
        // observation is established, so no change falls between the two.
        get initial() {
          return (initial ??= observation.ready.then(async () => readDirectory(0, await count())));
        },
        unsubscribe() {
          if (!active) return;
          active = false;
          observation.close();
        },
      };
    },
  };
  return reader;
}

/**
 * The newest goal in a remote history, as the in-process reader's
 * `readLatestGoal`: turns are read back from the tail in bounded pages and the
 * scan stops at the first turn that holds one.
 */
export async function readRemoteLatestGoal(
  port: Pick<RemoteLoroHistoryPort, 'readListFields'>
): Promise<SessionGoalMessage | null> {
  let end: number | undefined;
  for (;;) {
    const page = await port.readListFields(
      end === undefined ? -GOAL_SCAN_PAGE : Math.max(0, end - GOAL_SCAN_PAGE),
      end,
      [{ path: ['items'] }]
    );
    for (let i = page.rows.length - 1; i >= 0; i--) {
      const [items] = page.rows[i] ?? [];
      if (!Array.isArray(items)) continue;
      for (let j = items.length - 1; j >= 0; j--) {
        const item: unknown = items[j];
        if (
          typeof item !== 'object' ||
          item === null ||
          (item as { type?: unknown }).type !== 'goal'
        )
          continue;
        const goal = resolveLatestSessionGoalFromHistory([{ items: [item] }] as never);
        if (goal) return structuredClone(goal);
      }
    }
    if (page.start === 0 || page.rows.length === 0) return null;
    end = page.start;
  }
}

const GOAL_SCAN_PAGE = 32;

const jsonQueryAccess: HistoryQueryAccess = {
  field: (value, key) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)[key]
      : undefined,
  // As the stored reader: containers project to an empty shape, never their content.
  scalar: (value) =>
    value !== null && typeof value === 'object' ? (Array.isArray(value) ? [] : {}) : value,
  keys: (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [],
  length: (value) => (Array.isArray(value) ? value.length : 0),
  at: (value, index) => (Array.isArray(value) ? value[index] : undefined),
};

/**
 * The visible transcript tail of a remote history, as the in-process
 * `readHistoryTranscript`: turns are projected back from the tail in bounded
 * pages (bodies are not kept) until the limit and one more visible turn are
 * found, then only the selected turns are read whole. A selected turn whose id
 * moved is a concurrent structural edit and the read starts again.
 */
export async function readRemoteHistoryTranscript(
  port: Pick<RemoteLoroHistoryPort, 'readListFields'>,
  options: { limit?: number; reverse?: boolean }
): Promise<{ hasMore: boolean; positions: number[]; entries: SessionEntry[] }> {
  for (let attempt = 0; ; attempt++) {
    const ids = new Map<number, unknown>();
    const { len } = await port.readListFields(0, 0, []);
    const selected = await selectTranscriptTail(
      len,
      async (from, to) => {
        const rows: HistoryQueryRow[] = [];
        for (let at = from; at < to;) {
          const page = await port.readListFields(at, to, TRANSCRIPT_FIELDS);
          for (const [offset, [id, role, items]] of page.rows.entries()) {
            ids.set(page.start + offset, id);
            rows.push(historyQueryRow({ role, items }, jsonQueryAccess, true));
          }
          if (page.rows.length === 0) break;
          at = page.start + page.rows.length;
        }
        return rows;
      },
      options
    );
    const entries: SessionEntry[] = [];
    let moved = false;
    for (const position of selected.positions) {
      const page = await port.readListFields(position, position + 1, WHOLE_TURN);
      const turn = page.rows[0]?.[0] as SessionEntry | undefined;
      if (!turn || turn.id !== ids.get(position)) {
        moved = true;
        break;
      }
      entries.push(turn);
    }
    if (!moved) return { ...selected, entries };
    if (attempt >= 2) throw new Error('remote_history_changed_during_read');
  }
}

const TRANSCRIPT_FIELDS: readonly RemoteListField[] = [
  { path: ['id'] },
  { path: ['role'] },
  { path: ['items'] },
];
const WHOLE_TURN: readonly RemoteListField[] = [{ path: [] }];
