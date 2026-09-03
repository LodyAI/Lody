import type { SessionHistory, SessionId } from '@lody/shared';
import {
  isContainer,
  type Container,
  type ContainerID,
  type LoroDoc,
  type LoroEvent,
  type LoroEventBatch,
  type LoroList,
  type LoroMap,
} from 'loro-crdt';
import { applyEventToTurn } from './apply-turn-event';
import {
  INDEX_SCALAR_KEYS,
  pickIndexInputConfig,
  pickIndexScalars,
  type IndexScalarKey,
} from './index-row';
import { summarizeTurn, summarizeTurnShallow } from './turn-summary';
import {
  conversationTailStart,
  DEFAULT_MAX_HYDRATED,
  DEFAULT_TAIL_KEEP,
  type ConversationView,
  type ConversationViewChange,
  type ConversationViewListener,
  type TurnIndexRow,
} from './types';

export const HISTORY_ROOT_KEY = 'history';

export type IdleDeadline = { timeRemaining(): number };
/** Schedules one background chunk; returns a cancel function. */
export type IdleScheduler = (task: (deadline: IdleDeadline) => void) => () => void;

export type CreateConversationViewFromDocOptions = {
  sessionId: SessionId;
  /** Hydrated turns kept beyond the pinned ranges and the tail. */
  maxHydrated?: number;
  /** Trailing turns that are always hydrated (streaming lands here). */
  tailKeep?: number;
  /** Background pass scheduler; defaults to `requestIdleCallback` (or a timer). */
  scheduleIdle?: IdleScheduler;
  /** Yield between chunks of a large `ensureRange`; defaults to a macrotask. */
  yieldToEventLoop?: () => Promise<void>;
  /** Turns hydrated synchronously per `ensureRange` before the call goes chunked. */
  hydrateChunkSize?: number;
  /**
   * Message items hydrated per synchronous chunk. Turn count alone is a poor
   * budget: a real session can hold 100 items (and ~1,000 containers) per turn,
   * so chunks are cut by items as well, and the eager tail stops at this many
   * items with the rest of the tail following in the first idle chunk.
   */
  hydrateItemBudget?: number;
  /** Turns summarized per background chunk. */
  idleChunkSize?: number;
  /** Message items summarized per background chunk. */
  idleItemBudget?: number;
};

const defaultScheduleIdle: IdleScheduler = (task) => {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback((deadline) => task(deadline), { timeout: 500 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(() => task({ timeRemaining: () => 4 }), 16);
  return () => clearTimeout(id);
};

const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A turn map's `toJSON()` is exactly the object loro-mirror materializes for
 * it (texts as strings, nested containers as plain values, no decode
 * transforms in the session schema), so hydration is one call. Guarded so a
 * corrupt slot cannot be handed out as a turn.
 */
export function normalizeHydratedTurn(value: unknown): SessionHistory | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.role !== 'string') {
    return undefined;
  }
  return value as unknown as SessionHistory;
}

const listLengthOf = (doc: LoroDoc, cid: unknown): number => {
  if (typeof cid !== 'string') return 0;
  const container = doc.getContainerById(cid as ContainerID);
  return container && container.kind() === 'List' ? (container as LoroList).length : 0;
};

const countAfterListDelta = (
  count: number,
  deltas: readonly { insert?: unknown[]; delete?: number; retain?: number }[]
): number => {
  let next = count;
  for (const delta of deltas) {
    if (delta.insert !== undefined) next += delta.insert.length;
    else if (delta.delete !== undefined) next -= delta.delete;
  }
  return Math.max(0, next);
};

/** A slot whose list value is not a map (never written by a healthy client). */
const phantomRow = (position: number): TurnIndexRow => ({
  id: `invalid-turn:${position}`,
  role: 'system',
  timestamp: '',
  itemCount: 0,
  planCount: 0,
});

/**
 * `ConversationView` over today's loro-crdt APIs.
 *
 * Open cost is one shallow read per turn (ids, scalars, item counts) plus the
 * tail's `toJSON()`; everything heavier (summaries, shallow config) runs in
 * idle chunks from the tail backwards and resolves `ready`. Doc events are
 * applied incrementally: list-level inserts/deletes maintain the index, map
 * events on a turn refresh its scalars, and events inside a hydrated turn
 * patch that object copy-on-write (falling back to re-reading the turn when a
 * path does not resolve).
 */
export function createConversationViewFromDoc(
  doc: LoroDoc,
  options: CreateConversationViewFromDocOptions
): ConversationView {
  const maxHydrated = options.maxHydrated ?? DEFAULT_MAX_HYDRATED;
  const tailKeep = options.tailKeep ?? DEFAULT_TAIL_KEEP;
  const scheduleIdle = options.scheduleIdle ?? defaultScheduleIdle;
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYield;
  const hydrateChunkSize = options.hydrateChunkSize ?? 64;
  // ~40 ms of `toJSON()` on the heaviest real turns seen (≈1,000 containers
  // per 100-item turn); on a typical session (5–10 items per turn) this covers
  // far more than the tail, so the budget only bites where it matters.
  const hydrateItemBudget = options.hydrateItemBudget ?? 320;
  const idleChunkSize = options.idleChunkSize ?? 80;
  const idleItemBudget = options.idleItemBudget ?? 1_200;

  const historyList = doc.getList(HISTORY_ROOT_KEY);
  const listId = historyList.id;

  /** Position-aligned with the doc list; `null` marks a non-map slot. */
  let cids: (ContainerID | null)[] = [];
  let rows: TurnIndexRow[] = [];
  const indexByCid = new Map<ContainerID, number>();
  const indexById = new Map<string, number>();
  /** Insertion order is LRU order: `touch` moves a turn to the end. */
  const hydrated = new Map<ContainerID, SessionHistory>();
  const pins = new Map<ContainerID, number>();
  const turnCidByDescendant = new Map<ContainerID, ContainerID>();
  const listeners = new Set<ConversationViewListener>();
  let version = 0;
  let disposed = false;
  let idleCancel: (() => void) | null = null;
  let resolveReady: () => void = () => {};
  let readyResolved = false;
  const ready = new Promise<void>((resolve) => {
    resolveReady = () => {
      if (readyResolved) return;
      readyResolved = true;
      resolve();
    };
  });

  const tailStart = () => conversationTailStart(cids.length, tailKeep);

  const turnMapOf = (cid: ContainerID): LoroMap | undefined => {
    const container = doc.getContainerById(cid);
    return container && container.kind() === 'Map' ? (container as LoroMap) : undefined;
  };

  const readIndexRow = (map: LoroMap): TurnIndexRow => {
    const shallow = map.getShallowValue();
    const row = pickIndexScalars(shallow);
    row.itemCount = listLengthOf(doc, shallow.items);
    row.planCount = listLengthOf(doc, shallow.plan);
    return row;
  };

  const readIndexInputConfig = (map: LoroMap) => {
    const config = map.get('inputConfig');
    if (!isContainer(config) || config.kind() !== 'Map') return undefined;
    return pickIndexInputConfig((config as LoroMap).getShallowValue());
  };

  const withHydratedFacts = (row: TurnIndexRow, turn: SessionHistory): TurnIndexRow => {
    const next: TurnIndexRow = { ...row, summary: summarizeTurn(turn) };
    if (next.role === 'user') next.inputConfig = pickIndexInputConfig(turn.inputConfig);
    return next;
  };

  /** Ids map to their FIRST position, matching the renderer's de-duplication. */
  const rebuildLookups = (from: number) => {
    for (let i = from; i < cids.length; i += 1) {
      const cid = cids[i];
      if (cid) indexByCid.set(cid, i);
    }
    indexById.clear();
    for (let i = 0; i < rows.length; i += 1) {
      const id = rows[i]?.id;
      if (id !== undefined && !indexById.has(id)) indexById.set(id, i);
    }
  };

  const bump = () => {
    version += 1;
  };

  const emit = (change: ConversationViewChange) => {
    for (const listener of listeners) listener(change);
  };

  const touch = (cid: ContainerID, turn: SessionHistory) => {
    hydrated.delete(cid);
    hydrated.set(cid, turn);
  };

  const evict = () => {
    if (hydrated.size <= maxHydrated) return;
    const tailFrom = tailStart();
    for (const cid of hydrated.keys()) {
      if (hydrated.size <= maxHydrated) break;
      if ((pins.get(cid) ?? 0) > 0) continue;
      const index = indexByCid.get(cid);
      if (index !== undefined && index >= tailFrom) continue;
      hydrated.delete(cid);
    }
  };

  const materializeTurn = (cid: ContainerID): SessionHistory | undefined => {
    const map = turnMapOf(cid);
    return map ? normalizeHydratedTurn(map.toJSON()) : undefined;
  };

  /** Returns true when the turn was newly hydrated. */
  const hydrateByCid = (cid: ContainerID): boolean => {
    const existing = hydrated.get(cid);
    if (existing) {
      touch(cid, existing);
      return false;
    }
    const turn = materializeTurn(cid);
    if (!turn) return false;
    hydrated.set(cid, turn);
    const index = indexByCid.get(cid);
    const row = index === undefined ? undefined : rows[index];
    if (index !== undefined && row) rows[index] = withHydratedFacts(row, turn);
    return true;
  };

  const clampRange = (from: number, to: number): [number, number] => [
    Math.max(0, Math.min(from, cids.length)),
    Math.max(0, Math.min(to, cids.length)),
  ];

  const hydrateMany = (targets: readonly ContainerID[]) => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = -1;
    for (const cid of targets) {
      if (!hydrateByCid(cid)) continue;
      const index = indexByCid.get(cid);
      if (index === undefined) continue;
      lo = Math.min(lo, index);
      hi = Math.max(hi, index);
    }
    evict();
    if (hi < 0) return;
    bump();
    // Hydration also fills the row's summary, which the outline reads.
    emit({ kind: 'index', from: lo, to: hi + 1 });
    emit({ kind: hi >= tailStart() ? 'tail' : 'range', from: lo, to: hi + 1 });
  };

  /** Cost proxy for hydrating a turn: its item count (at least one). */
  const itemWeight = (index: number): number => Math.max(1, rows[index]?.itemCount ?? 0);

  /**
   * Hydrate the tail from the end backwards within `budget` items. Anything
   * left over is picked up by the idle pass, which runs tail-first, so the
   * whole tail is hydrated within a tick or two without blocking first paint.
   */
  const ensureTailHydrated = (
    ignoredTurns?: Set<ContainerID>,
    budget: number = hydrateItemBudget
  ): boolean => {
    let spent = 0;
    let deferred = false;
    for (let i = cids.length - 1; i >= tailStart(); i -= 1) {
      const cid = cids[i];
      if (!cid || hydrated.has(cid)) continue;
      const weight = itemWeight(i);
      // The newest turn is always admitted (the viewport opens on it); a turn
      // that alone exceeds what is left waits for the next pass.
      if (spent > 0 && spent + weight > budget) {
        deferred = true;
        continue;
      }
      spent += weight;
      if (hydrateByCid(cid)) ignoredTurns?.add(cid);
    }
    return deferred;
  };

  // ---- background index pass -------------------------------------------------

  const runIdleChunk = (deadline: IdleDeadline) => {
    if (disposed) return;
    let processed = 0;
    let items = 0;
    let changed = false;
    let complete = true;
    // The tail comes first: a turn the eager pass deferred is still part of
    // the always-hydrated window.
    if (ensureTailHydrated(undefined, idleItemBudget)) complete = false;
    for (let i = tailStart(); i < cids.length; i += 1) {
      const cid = cids[i];
      const row = rows[i];
      if (cid && row && hydrated.has(cid) && row.summary === undefined) {
        rows[i] = withHydratedFacts(row, hydrated.get(cid)!);
        changed = true;
      }
    }
    for (let i = cids.length - 1; i >= 0 && complete; i -= 1) {
      const row = rows[i];
      const cid = cids[i];
      if (!row || !cid) continue;
      const needsSummary = row.summary === undefined;
      const needsConfig = row.role === 'user' && !('inputConfig' in row);
      if (!needsSummary && !needsConfig) continue;
      if (processed >= idleChunkSize || items >= idleItemBudget || deadline.timeRemaining() <= 1) {
        complete = false;
        break;
      }
      const turn = hydrated.get(cid);
      const map = turn ? undefined : turnMapOf(cid);
      if (!turn && !map) continue;
      const next: TurnIndexRow = { ...row };
      if (needsSummary) {
        next.summary = turn ? summarizeTurn(turn) : summarizeTurnShallow(doc, map as LoroMap);
      }
      if (needsConfig) {
        next.inputConfig = turn
          ? pickIndexInputConfig(turn.inputConfig)
          : readIndexInputConfig(map as LoroMap);
      }
      rows[i] = next;
      processed += 1;
      items += itemWeight(i);
      changed = true;
    }
    if (changed) {
      bump();
      emit({ kind: 'index' });
      emit({ kind: 'tail', from: tailStart(), to: cids.length });
    }
    if (complete) resolveReady();
    else scheduleIdlePass();
  };

  const scheduleIdlePass = () => {
    if (disposed || idleCancel) return;
    idleCancel = scheduleIdle((deadline) => {
      idleCancel = null;
      runIdleChunk(deadline);
    });
  };

  // ---- doc events ----------------------------------------------------------------

  const findOwningTurnCid = (target: ContainerID): ContainerID | undefined => {
    const cached = turnCidByDescendant.get(target);
    if (cached) return cached;
    let current: Container | undefined = doc.getContainerById(target);
    while (current) {
      const parent = current.parent();
      if (!parent) return undefined;
      if (parent.id === listId) {
        if (turnCidByDescendant.size > 100_000) turnCidByDescendant.clear();
        turnCidByDescendant.set(target, current.id);
        return current.id;
      }
      current = parent;
    }
    return undefined;
  };

  const resolveTurnIndex = (event: LoroEvent): number => {
    const position = event.path[1];
    const guess = typeof position === 'number' ? position : -1;
    const guessedCid = guess >= 0 ? cids[guess] : undefined;
    if (guessedCid && event.target === guessedCid) return guess;
    const owner = indexByCid.has(event.target) ? event.target : findOwningTurnCid(event.target);
    if (!owner) return guess;
    return indexByCid.get(owner) ?? -1;
  };

  const isUnderIgnored = (
    target: ContainerID,
    ignored: ReadonlySet<ContainerID>,
    turnCid: ContainerID
  ): boolean => {
    let current: Container | undefined = doc.getContainerById(target);
    while (current) {
      if (ignored.has(current.id)) return true;
      if (current.id === turnCid) return false;
      current = current.parent();
    }
    return false;
  };

  const applyScalarUpdates = (
    row: TurnIndexRow,
    updated: Record<string, unknown>
  ): TurnIndexRow | null => {
    let next: TurnIndexRow | null = null;
    for (const key of INDEX_SCALAR_KEYS) {
      if (!(key in updated)) continue;
      const value = updated[key];
      if (isContainer(value)) continue;
      next ??= { ...row };
      if (value === undefined) delete (next as Record<IndexScalarKey, unknown>)[key];
      else (next as Record<IndexScalarKey, unknown>)[key] = value;
    }
    return next;
  };

  const removeSlots = (position: number, count: number) => {
    const removed = cids.slice(position, position + count);
    const removedRows = rows.slice(position, position + count);
    for (const cid of removed) {
      if (!cid) continue;
      hydrated.delete(cid);
      pins.delete(cid);
      indexByCid.delete(cid);
    }
    for (const row of removedRows) if (row) indexById.delete(row.id);
    cids.splice(position, count);
    rows.splice(position, count);
    rebuildLookups(position);
  };

  const insertSlots = (position: number, inserted: readonly unknown[]) => {
    const newCids: (ContainerID | null)[] = [];
    const newRows: TurnIndexRow[] = [];
    inserted.forEach((item, offset) => {
      if (isContainer(item) && item.kind() === 'Map') {
        newCids.push(item.id);
        newRows.push(readIndexRow(item as LoroMap));
      } else {
        newCids.push(null);
        newRows.push(phantomRow(position + offset));
      }
    });
    cids.splice(position, 0, ...newCids);
    rows.splice(position, 0, ...newRows);
    rebuildLookups(position);
  };

  const handleBatch = (batch: LoroEventBatch) => {
    const events = batch.events.filter(
      (event) => event.target === listId || event.path[0] === HISTORY_ROOT_KEY
    );
    if (events.length === 0) return;

    let indexChanged = false;
    let tailLo = Number.POSITIVE_INFINITY;
    let tailHi = -1;
    let rangeLo = Number.POSITIVE_INFINITY;
    let rangeHi = -1;
    const ignoredTurns = new Set<ContainerID>();
    const ignoredContainers = new Set<ContainerID>();
    const changedHydrated = new Set<number>();
    const noteChanged = (index: number) => {
      if (index >= tailStart()) {
        tailLo = Math.min(tailLo, index);
        tailHi = Math.max(tailHi, index);
      } else {
        rangeLo = Math.min(rangeLo, index);
        rangeHi = Math.max(rangeHi, index);
      }
    };

    let structural = false;
    for (const event of events) {
      if (event.target !== listId || event.diff.type !== 'list') continue;
      structural = true;
      let cursor = 0;
      for (const delta of event.diff.diff) {
        if (delta.retain !== undefined) {
          cursor += delta.retain;
        } else if (delta.delete !== undefined) {
          if (delta.delete > 0) removeSlots(cursor, delta.delete);
        } else if (delta.insert !== undefined) {
          insertSlots(cursor, delta.insert);
          cursor += delta.insert.length;
        }
      }
    }
    if (structural) {
      indexChanged = true;
      // A turn read through `toJSON()` already reflects the end of this
      // transaction, so its own child events in this batch must not re-apply.
      ensureTailHydrated(ignoredTurns);
      for (const cid of ignoredTurns) {
        const index = indexByCid.get(cid);
        if (index !== undefined) noteChanged(index);
      }
      evict();
      scheduleIdlePass();
    }

    for (const event of events) {
      if (event.target === listId) continue;
      const index = resolveTurnIndex(event);
      const cid = index >= 0 ? cids[index] : undefined;
      const row = index >= 0 ? rows[index] : undefined;
      if (!cid || !row) continue;
      if (ignoredTurns.has(cid)) continue;
      if (ignoredContainers.size > 0 && isUnderIgnored(event.target, ignoredContainers, cid)) {
        continue;
      }
      const relPath = event.path.slice(2) as (string | number)[];

      if (relPath.length === 0 && event.diff.type === 'map') {
        const updated = applyScalarUpdates(row, event.diff.updated);
        if (updated) {
          rows[index] = updated;
          if (updated.id !== row.id) rebuildLookups(index);
          indexChanged = true;
        }
      } else if (relPath.length === 1 && event.diff.type === 'list') {
        if (relPath[0] === 'items') {
          rows[index] = {
            ...rows[index]!,
            itemCount: countAfterListDelta(row.itemCount ?? 0, event.diff.diff),
          };
          indexChanged = true;
        } else if (relPath[0] === 'plan') {
          rows[index] = {
            ...rows[index]!,
            planCount: countAfterListDelta(row.planCount ?? 0, event.diff.diff),
          };
          indexChanged = true;
        }
      }

      const turn = hydrated.get(cid);
      if (turn) {
        const patched = applyEventToTurn(turn, relPath, event.diff, (container) => {
          ignoredContainers.add(container.id);
          return container.toJSON();
        });
        const next = patched ?? materializeTurn(cid);
        if (!next) continue;
        if (!patched) ignoredTurns.add(cid);
        hydrated.set(cid, next);
        changedHydrated.add(index);
        noteChanged(index);
      } else if (rows[index]!.summary !== undefined && relPath[0] === 'items') {
        // Content moved under a summarized, non-hydrated turn: let the idle
        // pass recompute it rather than guessing from the delta.
        rows[index] = { ...rows[index]!, summary: undefined };
        indexChanged = true;
        scheduleIdlePass();
      }
    }

    for (const index of changedHydrated) {
      const cid = cids[index];
      const turn = cid ? hydrated.get(cid) : undefined;
      const row = rows[index];
      if (!turn || !row) continue;
      rows[index] = withHydratedFacts(row, turn);
      indexChanged = true;
    }

    bump();
    if (indexChanged) emit({ kind: 'index' });
    if (tailHi >= 0) emit({ kind: 'tail', from: tailLo, to: tailHi + 1 });
    if (rangeHi >= 0) emit({ kind: 'range', from: rangeLo, to: rangeHi + 1 });
  };

  // ---- initial index ---------------------------------------------------------------

  historyList.getShallowValue().forEach((value, position) => {
    if (typeof value === 'string' && value.startsWith('cid:')) {
      const cid = value as ContainerID;
      const map = turnMapOf(cid);
      if (map) {
        cids.push(cid);
        rows.push(readIndexRow(map));
        return;
      }
    }
    cids.push(null);
    rows.push(phantomRow(position));
  });
  rebuildLookups(0);
  ensureTailHydrated();
  scheduleIdlePass();

  const unsubscribeDoc = doc.subscribe((batch) => {
    if (disposed) return;
    handleBatch(batch);
  });

  const pinRange = (from: number, to: number, delta: 1 | -1) => {
    for (let i = from; i < to; i += 1) {
      const cid = cids[i];
      if (!cid) continue;
      const next = (pins.get(cid) ?? 0) + delta;
      if (next <= 0) pins.delete(cid);
      else pins.set(cid, next);
    }
  };

  const view: ConversationView = {
    sessionId: options.sessionId,
    get turnCount() {
      return cids.length;
    },
    get version() {
      return version;
    },
    ready,
    index: (i) => rows[i],
    indexOf: (turnId) => indexById.get(turnId) ?? -1,
    turn: (i) => {
      const cid = cids[i];
      if (!cid) return undefined;
      const turn = hydrated.get(cid);
      if (turn) touch(cid, turn);
      return turn;
    },
    isHydrated: (i) => {
      const cid = cids[i];
      return cid !== null && cid !== undefined && hydrated.has(cid);
    },
    ensureRange: async (from, to) => {
      if (disposed) return;
      const [a, b] = clampRange(from, to);
      pinRange(a, b, 1);
      // Chunks are cut by turn count AND item count; the first chunk runs
      // synchronously so small ranges resolve without a tick.
      const chunks: ContainerID[][] = [];
      let chunk: ContainerID[] = [];
      let weight = 0;
      for (let i = a; i < b; i += 1) {
        const cid = cids[i];
        if (!cid || hydrated.has(cid)) continue;
        const turnWeight = itemWeight(i);
        if (
          chunk.length > 0 &&
          (chunk.length >= hydrateChunkSize || weight + turnWeight > hydrateItemBudget)
        ) {
          chunks.push(chunk);
          chunk = [];
          weight = 0;
        }
        chunk.push(cid);
        weight += turnWeight;
      }
      if (chunk.length > 0) chunks.push(chunk);
      if (chunks.length === 0) return;
      hydrateMany(chunks[0]!);
      for (let index = 1; index < chunks.length; index += 1) {
        await yieldToEventLoop();
        if (disposed) return;
        hydrateMany(chunks[index]!);
      }
    },
    release: (from, to) => {
      if (disposed) return;
      const [a, b] = clampRange(from, to);
      pinRange(a, b, -1);
      evict();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribeDoc();
      idleCancel?.();
      idleCancel = null;
      hydrated.clear();
      pins.clear();
      listeners.clear();
      resolveReady();
    },
  };
  return view;
}
