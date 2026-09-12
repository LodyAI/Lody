import type { SessionHistory, SessionId } from '@lody/shared';
import type {
  SessionDataChange,
  SessionDirectoryRow,
  SessionHistoryReader,
  SessionTurnRead,
} from '@lody/shared/session-data';
import { pickIndexInputConfig, pickIndexScalars } from './index-row';
import { summarizeTurn } from './turn-summary';
import {
  conversationTailStart,
  DEFAULT_MAX_HYDRATED,
  DEFAULT_TAIL_KEEP,
  type ConversationView,
  type ConversationViewChange,
  type ConversationViewListener,
  type TurnIndexRow,
} from './types';

// # Reader-backed ConversationView
//
// The same `ConversationView` contract as `createConversationViewFromDoc`, but
// over the CRDT-neutral `SessionHistoryReader` port: this module never imports
// loro-crdt, never names a CID or container id, and never touches a raw doc.
// Every synchronous accessor reads an in-memory snapshot that asynchronous
// port reads populate; `readDirectory` supplies the index rows (scalars, send
// config, counts) and `readTurn` supplies bodies on demand.
//
// - Identity is `turnId` everywhere (index map, pins, hydration); positions are
//   only the directory's address.
// - Every async read/lease carries a generation. A response resolving after a
//   structural change, after its lease was released, or after `dispose` is
//   discarded and never overwrites the snapshot.
// - `observe` is the only subscription: `initial` builds the index, then each
//   `changed` re-reads only its affected raw range (directory + the hydrated
//   turns inside it); `reset` is the only full re-read. A structural range
//   (membership/order change, including same-length replacement) emits
//   `structure` and re-keys the lookups.

export type IdleDeadline = { timeRemaining(): number };
/** Schedules one background chunk; returns a cancel function. */
export type IdleScheduler = (task: (deadline: IdleDeadline) => void) => () => void;

export type CreateConversationViewFromReaderOptions = {
  sessionId: SessionId;
  /** Hydrated turns kept beyond the pinned ranges and the tail. */
  maxHydrated?: number;
  /** Trailing turns that are always hydrated (streaming lands here). */
  tailKeep?: number;
  /** Background pass scheduler; defaults to `requestIdleCallback` (or a timer). */
  scheduleIdle?: IdleScheduler;
  /** Yield between chunks of a large `acquireRange`; defaults to a macrotask. */
  yieldToEventLoop?: () => Promise<void>;
  /** Turns hydrated per `acquireRange` chunk before the call is chunked further. */
  hydrateChunkSize?: number;
  /**
   * Message items hydrated per synchronous chunk. Turn count alone is a poor
   * budget: chunks are cut by items as well, and the eager tail stops at this
   * many items with the rest of the tail following in the first idle chunk.
   */
  hydrateItemBudget?: number;
};

/** Turns summarized per background chunk, and the item budget that caps it. */
const IDLE_CHUNK_TURNS = 80;
const IDLE_CHUNK_ITEMS = 1_200;

/** Sentinel: the change carried no `to`, so the whole directory is re-read. */
const FULL_RANGE = Number.MAX_SAFE_INTEGER;

const defaultScheduleIdle: IdleScheduler = (task) => {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback((deadline) => task(deadline), { timeout: 500 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(() => task({ timeRemaining: () => 4 }), 16);
  return () => clearTimeout(id);
};

const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A slot the directory cannot resolve to a turn (never written by a healthy client). */
const phantomRow = (position: number): TurnIndexRow => ({
  id: `invalid-turn:${position}`,
  role: 'system',
  timestamp: '',
  itemCount: 0,
  planCount: 0,
});

export function createConversationViewFromReader(
  reader: SessionHistoryReader,
  options: CreateConversationViewFromReaderOptions
): ConversationView {
  const maxHydrated = options.maxHydrated ?? DEFAULT_MAX_HYDRATED;
  const tailKeep = options.tailKeep ?? DEFAULT_TAIL_KEEP;
  const scheduleIdle = options.scheduleIdle ?? defaultScheduleIdle;
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYield;
  const hydrateChunkSize = options.hydrateChunkSize ?? 64;
  const hydrateItemBudget = options.hydrateItemBudget ?? 320;

  /** Position-aligned with the raw directory; every row owns an id. */
  let rows: TurnIndexRow[] = [];
  let ids: string[] = [];
  const indexById = new Map<string, number>();
  /** Insertion order is LRU order: `touch` moves a turn to the end. */
  const hydrated = new Map<string, SessionHistory>();
  const pins = new Map<string, number>();
  const listeners = new Set<ConversationViewListener>();
  let version = 0;
  let disposed = false;
  /**
   * Bumped on structural change, full re-read and dispose. An async response
   * captured under an older generation is discarded instead of overwriting the
   * snapshot (its change already re-queued a fresh read).
   */
  let generation = 0;
  let idleCancel: (() => void) | null = null;
  let idleCursor = -1;
  let resolveReady: () => void = () => {};
  let readyResolved = false;
  const ready = new Promise<void>((resolve) => {
    resolveReady = () => {
      if (readyResolved) return;
      readyResolved = true;
      resolve();
    };
  });
  // Changes observed before the initial directory applies are replayed after
  // it, so the gap-free initial + the queued events stay ordered.
  let initialApplied = false;
  const pendingChanges: SessionDataChange[] = [];
  let dirtyFrom = Infinity;
  let dirtyTo = -1;
  let flushRunning = false;
  /** A `reset` change rebuilds the whole snapshot instead of patching a range. */
  let resetPending = false;

  const tailStart = () => conversationTailStart(ids.length, tailKeep);

  const bump = () => {
    version += 1;
  };

  const emit = (change: ConversationViewChange) => {
    for (const listener of listeners) listener(change);
  };

  const touch = (id: string, turn: SessionHistory) => {
    hydrated.delete(id);
    hydrated.set(id, turn);
  };

  const evict = () => {
    if (hydrated.size <= maxHydrated) return;
    const tailFrom = tailStart();
    for (const id of hydrated.keys()) {
      if (hydrated.size <= maxHydrated) break;
      if ((pins.get(id) ?? 0) > 0) continue;
      const index = indexById.get(id);
      if (index !== undefined && index >= tailFrom) continue;
      hydrated.delete(id);
    }
  };

  const rowFromDirectory = (entry: SessionDirectoryRow): TurnIndexRow => {
    if (entry.state !== 'ready' || !entry.scalars) return phantomRow(entry.position);
    const row = pickIndexScalars(entry.scalars as unknown as Record<string, unknown>);
    // Send-critical metadata comes from the directory row itself, before any
    // body hydration; the shared projection already kept explicit empty
    // selections intact.
    if (row.role === 'user' && entry.inputConfig !== undefined) {
      row.inputConfig = pickIndexInputConfig(entry.inputConfig);
    }
    if (entry.itemCount !== undefined) row.itemCount = entry.itemCount;
    if (entry.planCount !== undefined) row.planCount = entry.planCount;
    return row;
  };

  /** A full body read subsumes the turn's scalar/count/summary facts. */
  const withBodyFacts = (row: TurnIndexRow, turn: SessionHistory): TurnIndexRow => {
    const next: TurnIndexRow = {
      ...pickIndexScalars(turn as unknown as Record<string, unknown>),
      itemCount: Array.isArray(turn.items) ? turn.items.length : 0,
      planCount: Array.isArray(turn.plan) ? turn.plan.length : 0,
      summary: summarizeTurn(turn),
    };
    if (row.inputConfig !== undefined) next.inputConfig = row.inputConfig;
    if (next.role === 'user') next.inputConfig = pickIndexInputConfig(turn.inputConfig);
    return next;
  };

  /** Ids map to their FIRST position, matching the renderer's de-duplication. */
  const rebuildLookups = (from: number) => {
    for (const [id, index] of indexById) {
      if (index >= from) indexById.delete(id);
    }
    for (let i = from; i < ids.length; i += 1) {
      const id = ids[i]!;
      if (!indexById.has(id)) indexById.set(id, i);
    }
  };

  /** Hydrate a group of ids (already pinned by the caller if leased). */
  const hydrateIds = async (
    targets: readonly string[],
    emitEvents: boolean,
    cancelled?: () => boolean
  ): Promise<void> => {
    const gen = generation;
    for (let start = 0; start < targets.length; start += hydrateChunkSize) {
      if (start > 0) await yieldToEventLoop();
      if (disposed || generation !== gen || cancelled?.()) return;
      const chunk = targets.slice(start, start + hydrateChunkSize);
      const reads: readonly SessionTurnRead[] = await Promise.all(
        chunk.map((id) => reader.readTurn(id))
      );
      if (disposed || generation !== gen || cancelled?.()) return;
      let lo = Infinity;
      let hi = -1;
      const positions: number[] = [];
      for (const read of reads) {
        if (read.state !== 'ready') continue;
        const turn = read.turn as unknown as SessionHistory;
        const pos = indexById.get(turn.id);
        hydrated.set(turn.id, turn);
        if (pos === undefined) continue;
        rows[pos] = withBodyFacts(rows[pos]!, turn);
        lo = Math.min(lo, pos);
        hi = Math.max(hi, pos);
        positions.push(pos);
      }
      evict();
      if (!emitEvents || hi < 0) continue;
      bump();
      emit({ kind: 'index', from: lo, to: hi + 1 });
      for (const pos of positions) {
        emit({ kind: pos >= tailStart() ? 'tail' : 'range', from: pos, to: pos + 1 });
      }
    }
  };

  /**
   * Hydrate the tail from the end backwards within `budget` items. Anything
   * left over is picked up by the idle pass, which runs tail-first.
   */
  const ensureTailHydrated = async (budget: number, emitEvents: boolean): Promise<boolean> => {
    let spent = 0;
    let deferred = false;
    const targets: string[] = [];
    for (let i = ids.length - 1; i >= tailStart(); i -= 1) {
      const id = ids[i]!;
      if (hydrated.has(id)) continue;
      const weight = Math.max(1, rows[i]?.itemCount ?? 0);
      // The newest turn is always admitted; a turn that alone exceeds what is
      // left waits for the next pass.
      if (spent > 0 && spent + weight > budget) {
        deferred = true;
        continue;
      }
      spent += weight;
      targets.push(id);
    }
    if (targets.length > 0) await hydrateIds(targets.reverse(), emitEvents);
    return deferred;
  };

  // ---- background index pass -------------------------------------------------

  const runIdleChunk = async (deadline: IdleDeadline) => {
    if (disposed) return;
    let processed = 0;
    let items = 0;
    let changed = false;
    let complete = true;
    if (await ensureTailHydrated(IDLE_CHUNK_ITEMS, false)) complete = false;
    if (disposed) return;
    for (let i = idleCursor; i >= 0 && complete; i -= 1) {
      idleCursor = i - 1;
      const row = rows[i];
      const id = row ? ids[i] : undefined;
      if (!row || !id) continue;
      const needsSummary = row.summary === undefined;
      const needsCounts = row.itemCount === undefined;
      if (!needsSummary && !needsCounts) continue;
      if (
        processed >= IDLE_CHUNK_TURNS ||
        items >= IDLE_CHUNK_ITEMS ||
        deadline.timeRemaining() <= 1
      ) {
        idleCursor = i;
        complete = false;
        break;
      }
      const body = hydrated.get(id);
      if (body) {
        rows[i] = withBodyFacts(row, body);
        processed += 1;
        items += Math.max(1, rows[i]!.itemCount ?? 0);
        changed = true;
        continue;
      }
      let read: SessionTurnRead;
      try {
        read = await reader.readTurn(id);
      } catch {
        continue;
      }
      if (disposed) return;
      if (read.state !== 'ready') continue;
      const turn = read.turn as unknown as SessionHistory;
      const next: TurnIndexRow = {
        ...(needsCounts
          ? {
              ...row,
              itemCount: Array.isArray(turn.items) ? turn.items.length : 0,
              planCount: Array.isArray(turn.plan) ? turn.plan.length : 0,
            }
          : row),
      };
      if (needsSummary) next.summary = summarizeTurn(turn);
      rows[i] = next;
      processed += 1;
      items += Math.max(1, next.itemCount ?? 0);
      changed = true;
    }
    if (disposed) return;
    if (changed) {
      bump();
      emit({ kind: 'index' });
      emit({ kind: 'tail', from: tailStart(), to: ids.length });
    }
    if (complete) resolveReady();
    else scheduleIdlePass(false);
  };

  const scheduleIdlePass = (restart = true) => {
    if (disposed) return;
    if (restart) idleCursor = ids.length - 1;
    if (idleCancel) return;
    idleCancel = scheduleIdle((deadline) => {
      idleCancel = null;
      void runIdleChunk(deadline);
    });
  };

  // ---- change application ------------------------------------------------------

  const applyHydratedReplacement = async (
    idsToReRead: readonly string[],
    gen: number
  ): Promise<void> => {
    const loPositions: number[] = [];
    for (const id of idsToReRead) {
      let read: SessionTurnRead;
      try {
        read = await reader.readTurn(id);
      } catch {
        continue;
      }
      if (disposed || generation !== gen) return;
      if (read.state !== 'ready') {
        // The turn vanished under us: drop the stale body; the directory row
        // already reflects the current state.
        hydrated.delete(id);
        continue;
      }
      const turn = read.turn as unknown as SessionHistory;
      const pos = indexById.get(id);
      hydrated.set(id, turn);
      if (pos !== undefined) {
        rows[pos] = withBodyFacts(rows[pos]!, turn);
        loPositions.push(pos);
      }
    }
    if (disposed || generation !== gen) return;
    if (loPositions.length === 0) return;
    evict();
    bump();
    for (const pos of loPositions) {
      emit({ kind: pos >= tailStart() ? 'tail' : 'range', from: pos, to: pos + 1 });
    }
  };

  /**
   * Apply one `changed` range. The directory rows decide whether the range is
   * structural: any position whose id changed (or the length changed) means
   * membership/order moved, so everything at and after the first mismatch is
   * re-keyed and a `structure` event fires — including same-length
   * replacements.
   */
  const applyChange = async (
    from: number,
    to: number,
    entries: readonly SessionDirectoryRow[],
    gen: number
  ): Promise<void> => {
    let structuralFrom = Infinity;
    for (const entry of entries) {
      const id = rowFromDirectory(entry).id;
      if (entry.position >= ids.length || ids[entry.position] !== id) {
        structuralFrom = Math.min(structuralFrom, entry.position);
      }
    }
    if (to !== ids.length) structuralFrom = Math.min(structuralFrom, Math.min(to, ids.length));
    const structural = Number.isFinite(structuralFrom);

    if (!structural) {
      const toReRead: string[] = [];
      let lo = Infinity;
      let hi = -1;
      let invalidatedSummary = false;
      for (const entry of entries) {
        const pos = entry.position;
        const row = rowFromDirectory(entry);
        const old = rows[pos];
        if (old && !hydrated.has(old.id)) {
          // The change may have moved content under a summarized turn: let the
          // idle pass recompute instead of trusting a possibly stale summary.
          if (old.summary !== undefined) {
            row.summary = undefined;
            invalidatedSummary = true;
          }
        }
        rows[pos] = row;
        if (row.id !== old?.id) rebuildLookups(pos);
        if (hydrated.has(row.id)) toReRead.push(row.id);
        lo = Math.min(lo, pos);
        hi = Math.max(hi, pos);
      }
      bump();
      if (hi >= 0) emit({ kind: 'index', from: lo, to: hi + 1 });
      if (toReRead.length > 0) await applyHydratedReplacement(toReRead, gen);
      // A summary that was invalidated needs the background pass again.
      if (invalidatedSummary) scheduleIdlePass(false);
      return;
    }

    // Structural: everything at/after the first mismatch is replaced wholesale,
    // but ids that survive (they only moved) keep their bodies and pins — a
    // lease on another viewport's turns is never released by someone else's
    // insert/delete.
    const fromIndex = structuralFrom;
    generation += 1;
    const surviving = new Set<string>();
    for (const entry of entries) surviving.add(rowFromDirectory(entry).id);
    for (let i = fromIndex; i < ids.length; i += 1) {
      const id = ids[i]!;
      if (surviving.has(id)) continue;
      hydrated.delete(id);
      pins.delete(id);
    }
    rows.length = fromIndex;
    ids.length = fromIndex;
    for (const entry of entries) {
      const row = rowFromDirectory(entry);
      rows[entry.position] = row;
      ids[entry.position] = row.id;
    }
    rebuildLookups(fromIndex);
    evict();
    // Re-read the hydrated/pinned turns whose membership is still present but
    // whose position may have changed, plus the fresh tail.
    await ensureTailHydrated(hydrateItemBudget, false);
    if (disposed) return;
    bump();
    emit({ kind: 'structure', from: fromIndex, to: ids.length });
    emit({ kind: 'index', from: fromIndex, to: ids.length });
    scheduleIdlePass();
  };

  const applyFull = async (gen: number, structural: boolean): Promise<void> => {
    const entries = await reader.readDirectory(0, FULL_RANGE);
    if (disposed || generation !== gen) return;
    let structuralFrom = 0;
    if (!structural) {
      structuralFrom = Infinity;
      const n = Math.min(rows.length, entries.length);
      for (let i = 0; i < n; i += 1) {
        if (ids[i] !== rowFromDirectory(entries[i]!).id) {
          structuralFrom = i;
          break;
        }
      }
      if (!Number.isFinite(structuralFrom) && rows.length !== entries.length) {
        structuralFrom = n;
      }
    }
    if (!Number.isFinite(structuralFrom)) {
      // Content-only full refresh: keep identities and bodies, refresh rows.
      const toReRead: string[] = [];
      for (const entry of entries) {
        const row = rowFromDirectory(entry);
        const old = rows[entry.position];
        rows[entry.position] = row;
        if (row.id !== old?.id) rebuildLookups(entry.position);
        if (hydrated.has(row.id)) toReRead.push(row.id);
      }
      bump();
      emit({ kind: 'index', from: 0, to: ids.length });
      await applyHydratedReplacement(toReRead, gen);
      // Summaries of non-hydrated rows were dropped by the directory refresh:
      // re-fill them in the background rather than trusting possibly stale ones.
      scheduleIdlePass();
      return;
    }
    // Continuity was lost: rebuild the whole index and re-hydrate the tail.
    // A `reset` re-reads everything, so it drops every held body and pin. A
    // positionless structural `changed` keeps ids that survived, so a lease on
    // another viewport's turns is not released by this reload.
    generation += 1;
    if (structural) {
      hydrated.clear();
      pins.clear();
    } else {
      const surviving = new Set<string>();
      for (const entry of entries) surviving.add(rowFromDirectory(entry).id);
      for (const [id] of hydrated) if (!surviving.has(id)) hydrated.delete(id);
      for (const [id] of pins) if (!surviving.has(id)) pins.delete(id);
    }
    rows.length = 0;
    ids.length = 0;
    indexById.clear();
    for (const entry of entries) {
      const row = rowFromDirectory(entry);
      rows[entry.position] = row;
      ids[entry.position] = row.id;
    }
    rebuildLookups(0);
    await ensureTailHydrated(hydrateItemBudget, false);
    if (disposed) return;
    bump();
    emit({ kind: 'structure', from: structuralFrom, to: ids.length });
    emit({ kind: 'index', from: 0, to: ids.length });
    scheduleIdlePass();
  };

  const mergeDirty = (from: number, to: number) => {
    dirtyFrom = Math.min(dirtyFrom, from);
    dirtyTo = Math.max(dirtyTo, to);
  };

  const flushDirty = async () => {
    if (flushRunning) return;
    flushRunning = true;
    try {
      while (dirtyFrom <= dirtyTo) {
        if (disposed) break;
        const from = dirtyFrom;
        const to = dirtyTo;
        const reset = resetPending;
        dirtyFrom = Infinity;
        dirtyTo = -1;
        resetPending = false;
        const gen = generation;
        if (to === FULL_RANGE) {
          await applyFull(gen, reset);
          continue;
        }
        let entries: readonly SessionDirectoryRow[];
        try {
          entries = await reader.readDirectory(from, to);
        } catch {
          continue;
        }
        if (disposed || generation !== gen) continue;
        await applyChange(from, to, entries, gen);
      }
    } finally {
      flushRunning = false;
    }
  };

  const onDataChange = (change: SessionDataChange) => {
    if (disposed) return;
    if (!initialApplied) {
      pendingChanges.push(change);
      return;
    }
    if (change.kind === 'reset') {
      resetPending = true;
      mergeDirty(0, FULL_RANGE);
      void flushDirty();
      return;
    }
    mergeDirty(change.from ?? 0, change.to ?? FULL_RANGE);
    void flushDirty();
  };

  const buildInitial = (entries: readonly SessionDirectoryRow[]) => {
    for (const entry of entries) {
      const row = rowFromDirectory(entry);
      rows[entry.position] = row;
      ids[entry.position] = row.id;
    }
    rebuildLookups(0);
    bump();
    // Everything appeared in one go: positional consumers must (re)acquire,
    // and index consumers see the whole window.
    emit({ kind: 'structure', from: 0, to: ids.length });
    emit({ kind: 'index', from: 0, to: ids.length });
  };

  // ---- observation (the only subscription) -------------------------------------

  const observation = reader.observe((change) => onDataChange(change));
  void (async () => {
    try {
      const entries = await observation.initial;
      if (disposed) return;
      buildInitial(entries);
      initialApplied = true;
      // Queue the background pass before the eager tail hydration, so a
      // scheduled-idle consumer can drain everything from one queue.
      scheduleIdlePass();
      await ensureTailHydrated(hydrateItemBudget, false);
      if (disposed) return;
      const queued = pendingChanges.splice(0);
      for (const change of queued) onDataChange(change);
    } catch {
      // The port's initial directory is synchronous snapshots today; keep the
      // contract resolvable rather than hanging consumers on a failed read.
      resolveReady();
    }
  })();

  // ---- leases -------------------------------------------------------------------

  const pinIds = (targets: readonly string[], delta: 1 | -1) => {
    for (const id of targets) {
      const next = (pins.get(id) ?? 0) + delta;
      if (next <= 0) pins.delete(id);
      else pins.set(id, next);
    }
  };

  const view: ConversationView = {
    sessionId: options.sessionId,
    get turnCount() {
      return ids.length;
    },
    get version() {
      return version;
    },
    ready,
    index: (i) => rows[i],
    indexOf: (turnId) => indexById.get(turnId) ?? -1,
    // One consistent port read for export/replay/hash, instead of stitching the
    // windowed cache across a changing source.
    readAll: async () => (await reader.readAll()) as unknown as SessionHistory[],
    turn: (i) => {
      const id = ids[i];
      if (!id) return undefined;
      const turn = hydrated.get(id);
      if (turn) touch(id, turn);
      return turn;
    },
    isHydrated: (i) => {
      const id = ids[i];
      return id !== undefined && hydrated.has(id);
    },
    acquireRange: (from, to) => {
      if (disposed) return { ready: Promise.resolve(), release: () => {} };
      const a = Math.max(0, Math.min(from, ids.length));
      const b = Math.max(a, Math.min(to, ids.length));
      const capturedIds = ids.slice(a, b);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        pinIds(capturedIds, -1);
        evict();
      };
      // Chunks are cut by turn count AND item count; the first chunk starts
      // without a yield so small ranges resolve quickly.
      const chunks: string[][] = [];
      let chunk: string[] = [];
      let weight = 0;
      for (let i = a; i < b; i += 1) {
        const id = ids[i]!;
        if (hydrated.has(id)) continue;
        const turnWeight = Math.max(1, rows[i]?.itemCount ?? 0);
        if (chunk.length > 0 && (chunk.length >= hydrateChunkSize || weight + turnWeight > hydrateItemBudget)) {
          chunks.push(chunk);
          chunk = [];
          weight = 0;
        }
        chunk.push(id);
        weight += turnWeight;
      }
      if (chunk.length > 0) chunks.push(chunk);
      pinIds(capturedIds, 1);
      const hydrationReady = (async () => {
        const gen = generation;
        try {
          for (let index = 0; index < chunks.length; index += 1) {
            if (index > 0) await yieldToEventLoop();
            if (disposed || released) return;
            if (generation !== gen) return;
            await hydrateIds(chunks[index]!, true, () => released);
          }
        } catch (error) {
          release();
          throw error;
        }
      })();
      return { ready: hydrationReady, release };
    },
    subscribe: (listener: ConversationViewListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      observation.unsubscribe();
      idleCancel?.();
      idleCancel = null;
      rows.length = 0;
      ids.length = 0;
      indexById.clear();
      hydrated.clear();
      pins.clear();
      listeners.clear();
      resolveReady();
    },
  };
  return view;
}
