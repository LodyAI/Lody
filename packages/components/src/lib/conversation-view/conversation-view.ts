import type { LoroDoc, LoroEventBatch, LoroList, LoroMap } from 'loro-crdt';
import type { FileDiff, SessionHistory, SessionId, TurnSummary } from '@lody/shared';

/**
 * Fields of a turn that are always loaded, straight from the turn map's shallow
 * value (one cheap wasm call per turn). Everything the outline rail, the
 * folded-turn header and Virtua's height estimate need lives here.
 */
export const TURN_INDEX_FIELDS = [
  'id',
  'role',
  'timestamp',
  'status',
  'finished',
  'endedAt',
  'sendStatus',
  'userTurnId',
  'acpTurnId',
] as const;

export type TurnIndexRow = Pick<SessionHistory, (typeof TURN_INDEX_FIELDS)[number]> & {
  summary?: TurnSummary;
  /**
   * Read for assistant turns only: the empty-turn rule and the height
   * estimate need it there, and each read is one more wasm call per turn
   * at open. User turns always carry their prompt.
   */
  itemCount?: number;
  planCount?: number;
};

export type ConversationViewChange =
  | { kind: 'index' }
  | { kind: 'range'; from: number; to: number }
  | { kind: 'tail'; from: number; to: number };

/**
 * Windowed read model over a session doc's `history` list.
 *
 * `index(i)` is always available; `turn(i)` is synchronous only for hydrated
 * turns. Turns are keyed by container id, never by position, so a concurrent
 * insert in the middle of the list shifts indices without invalidating
 * hydrated data.
 */
export interface ConversationView {
  readonly sessionId: SessionId;
  readonly turnCount: number;
  /** Bumps on any structural or index-field change. */
  readonly version: number;
  index(i: number): TurnIndexRow | undefined;
  indexOf(turnId: string): number;
  turn(i: number): SessionHistory | undefined;
  isHydrated(i: number): boolean;
  /**
   * The turn's `fileDiff` alone, read from its own small container and cached
   * per turn until that turn changes. Lets the diff summary see every turn's
   * edits without hydrating a single message item.
   */
  fileDiff(i: number): FileDiff[] | undefined;
  ensureRange(from: number, to: number): Promise<void>;
  /**
   * Keep `[from, to)` out of LRU eviction until the returned release runs. A
   * mounted renderer window retains what it shows; an active search retains
   * everything it hydrated.
   */
  retain(from: number, to: number): () => void;
  release(from: number, to: number): void;
  /**
   * Every turn, hydrated. O(n) in turns on the first read; later reads only
   * re-hydrate the turns that changed and hand back the same objects for the
   * rest, so identity-keyed caches downstream keep hitting. Cached per
   * `version`, so repeated reads between changes are free. Still the
   * deliberate full-transcript escape hatch (markdown export, search index):
   * it holds one JS object per turn for the life of the view.
   */
  readAll(): SessionHistory[];
  subscribe(listener: (change: ConversationViewChange) => void): () => void;
  dispose(): void;
}

export type CreateConversationViewOptions = {
  sessionId: SessionId;
  /** Full turns kept in memory beyond subscribed ranges and the tail. */
  maxHydrated?: number;
  /** Trailing turns that are always hydrated and never evicted. */
  tailKeep?: number;
};

const DEFAULT_MAX_HYDRATED = 200;
const DEFAULT_TAIL_KEEP = 20;

type HydratedTurn = { value: SessionHistory; lastUsed: number };

const isContainerId = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('cid:');

const readTurnMap = (doc: LoroDoc, cid: string): LoroMap | null => {
  const container = doc.getContainerById(cid as never);
  return container && container.kind() === 'Map' ? (container as LoroMap) : null;
};

const containerLength = (doc: LoroDoc, value: unknown): number | undefined => {
  if (isContainerId(value)) {
    const container = doc.getContainerById(value as never);
    return container && container.kind() === 'List' ? (container as LoroList).length : undefined;
  }
  return Array.isArray(value) ? value.length : undefined;
};

/**
 * Same normalization `SessionDocument.getHistory()` applies on the CLI: the
 * Mirror state never carries `undefined` for absent optional fields either.
 */
const toSessionHistory = (value: Record<string, unknown>): SessionHistory =>
  value as unknown as SessionHistory;

export function createConversationViewFromDoc(
  doc: LoroDoc,
  options: CreateConversationViewOptions
): ConversationView {
  const maxHydrated = options.maxHydrated ?? DEFAULT_MAX_HYDRATED;
  const tailKeep = options.tailKeep ?? DEFAULT_TAIL_KEEP;
  const list = doc.getList('history') as LoroList;

  let ids: (string | null)[] = [];
  let indexRows: (TurnIndexRow | undefined)[] = [];
  const positionById = new Map<string, number>();
  const hydrated = new Map<string, HydratedTurn>();
  /**
   * Turn objects handed out by `readAll()`, kept beside the LRU so a full read
   * never re-materializes an unchanged turn and never changes its identity.
   * Entries leave only when their turn changes or its container leaves the
   * list. Empty until the first full read.
   */
  const snapshotByCid = new Map<string, SessionHistory>();
  const fileDiffByCid = new Map<string, FileDiff[]>();
  const listeners = new Set<(change: ConversationViewChange) => void>();
  const subscribedRanges = new Set<{ from: number; to: number }>();
  let version = 0;
  let clock = 0;
  let allCache: { version: number; value: SessionHistory[] } | null = null;
  let disposed = false;

  const readIndexRow = (cid: string): TurnIndexRow | undefined => {
    const map = readTurnMap(doc, cid);
    if (!map) return undefined;
    const shallow = map.getShallowValue() as Record<string, unknown>;
    const row: Record<string, unknown> = {};
    for (const field of TURN_INDEX_FIELDS) {
      const value = shallow[field];
      if (value !== undefined && !isContainerId(value)) row[field] = value;
    }
    const summary = shallow.summary;
    if (summary !== undefined) {
      row.summary = isContainerId(summary)
        ? (doc.getContainerById(summary as never)?.toJSON() as TurnSummary | undefined)
        : summary;
    }
    if (shallow.role === 'assistant') {
      const itemCount = containerLength(doc, shallow.items);
      if (itemCount !== undefined) row.itemCount = itemCount;
    }
    if (shallow.plan !== undefined) {
      const planCount = containerLength(doc, shallow.plan);
      if (planCount !== undefined) row.planCount = planCount;
    }
    return row as TurnIndexRow;
  };

  /** Position of every container id in `ids`; rebuilt with the index. */
  let positionByCid = new Map<string, number>();

  const rebuildIndex = () => {
    const shallow = list.getShallowValue() as unknown[];
    const nextIds: (string | null)[] = new Array(shallow.length);
    const nextRows: (TurnIndexRow | undefined)[] = new Array(shallow.length);
    const nextPositionByCid = new Map<string, number>();
    positionById.clear();
    for (let i = 0; i < shallow.length; i += 1) {
      const cid = shallow[i];
      if (!isContainerId(cid)) {
        nextIds[i] = null;
        nextRows[i] = undefined;
        continue;
      }
      nextIds[i] = cid;
      nextPositionByCid.set(cid, i);
      // Reuse the previous row when the container did not move so a structural
      // change costs one shallow read for the list, not one per turn.
      const previousPosition = positionByCid.get(cid);
      const row =
        previousPosition === i
          ? (indexRows[previousPosition] ?? readIndexRow(cid))
          : readIndexRow(cid);
      nextRows[i] = row;
      if (row?.id) positionById.set(row.id, i);
    }
    // Drop hydrated turns whose container left the list.
    const live = new Set(nextIds.filter((cid): cid is string => cid !== null));
    for (const cid of hydrated.keys()) {
      if (!live.has(cid)) hydrated.delete(cid);
    }
    for (const cid of snapshotByCid.keys()) {
      if (!live.has(cid)) snapshotByCid.delete(cid);
    }
    for (const cid of fileDiffByCid.keys()) {
      if (!live.has(cid)) fileDiffByCid.delete(cid);
    }
    ids = nextIds;
    indexRows = nextRows;
    positionByCid = nextPositionByCid;
  };

  const materialize = (i: number): SessionHistory | undefined => {
    const cid = ids[i];
    if (!cid) return undefined;
    const map = readTurnMap(doc, cid);
    if (!map) return undefined;
    return toSessionHistory(map.toJSON() as Record<string, unknown>);
  };

  const hydrateOne = (i: number): SessionHistory | undefined => {
    const cid = ids[i];
    const value = materialize(i);
    if (!cid || !value) return undefined;
    hydrated.set(cid, { value, lastUsed: (clock += 1) });
    return value;
  };

  const isProtected = (i: number, keep?: { from: number; to: number }): boolean => {
    if (i >= ids.length - tailKeep) return true;
    if (keep && i >= keep.from && i < keep.to) return true;
    for (const range of subscribedRanges) {
      if (i >= range.from && i < range.to) return true;
    }
    return false;
  };

  /**
   * Trim to `maxHydrated`, least recently used first. The tail, subscribed
   * ranges and the range a caller just asked for (`keep`) are never evicted:
   * a caller that awaits `ensureRange(a, b)` must find every turn in it.
   */
  const evict = (keep?: { from: number; to: number }) => {
    if (hydrated.size <= maxHydrated) return;
    const candidates: { cid: string; lastUsed: number }[] = [];
    for (const [cid, entry] of hydrated) {
      const position = positionByCid.get(cid);
      if (position !== undefined && isProtected(position, keep)) continue;
      candidates.push({ cid, lastUsed: entry.lastUsed });
    }
    candidates.sort((left, right) => left.lastUsed - right.lastUsed);
    let excess = hydrated.size - maxHydrated;
    for (const candidate of candidates) {
      if (excess <= 0) break;
      hydrated.delete(candidate.cid);
      excess -= 1;
    }
  };

  const bump = (change: ConversationViewChange) => {
    version += 1;
    allCache = null;
    for (const listener of listeners) listener(change);
  };

  const refreshTurn = (i: number, fieldTouched: string | null) => {
    const cid = ids[i];
    if (!cid) return;
    if (
      fieldTouched === null ||
      (TURN_INDEX_FIELDS as readonly string[]).includes(fieldTouched) ||
      fieldTouched === 'summary' ||
      fieldTouched === 'items' ||
      fieldTouched === 'plan'
    ) {
      indexRows[i] = readIndexRow(cid);
    }
    if (fieldTouched === null || fieldTouched === 'fileDiff') fileDiffByCid.delete(cid);
    // Any change to the turn invalidates the object a full read handed out;
    // the next `readAll()` re-materializes exactly this turn.
    snapshotByCid.delete(cid);
    if (hydrated.has(cid)) hydrateOne(i);
  };

  const handleEvent = (batch: LoroEventBatch) => {
    if (disposed) return;
    let structural = false;
    let rangeFrom = Number.POSITIVE_INFINITY;
    let rangeTo = -1;
    for (const event of batch.events) {
      const path = event.path as unknown[];
      if (path[0] !== 'history') continue;
      if (path.length === 1) {
        structural = true;
        continue;
      }
      const position = path[1];
      if (typeof position !== 'number') continue;
      const fieldTouched = path.length >= 3 && typeof path[2] === 'string' ? path[2] : null;
      // A path of exactly ['history', i] is the turn map itself (a scalar
      // field set), which may include index fields.
      refreshTurn(position, path.length === 2 ? null : fieldTouched);
      rangeFrom = Math.min(rangeFrom, position);
      rangeTo = Math.max(rangeTo, position + 1);
    }
    if (structural) {
      rebuildIndex();
      bump({ kind: 'index' });
      return;
    }
    if (rangeTo >= 0) {
      const isTail = rangeTo > ids.length - tailKeep;
      bump({ kind: isTail ? 'tail' : 'range', from: rangeFrom, to: rangeTo });
    }
  };

  rebuildIndex();
  // The tail is what streaming touches; keep it warm from the start.
  for (let i = Math.max(0, ids.length - tailKeep); i < ids.length; i += 1) hydrateOne(i);
  const unsubscribeDoc = doc.subscribe(handleEvent);

  const view: ConversationView = {
    sessionId: options.sessionId,
    get turnCount() {
      return ids.length;
    },
    get version() {
      return version;
    },
    index: (i) => indexRows[i],
    indexOf: (turnId) => positionById.get(turnId) ?? -1,
    turn: (i) => {
      const cid = ids[i];
      if (!cid) return undefined;
      const entry = hydrated.get(cid);
      if (!entry) return undefined;
      entry.lastUsed = clock += 1;
      return entry.value;
    },
    isHydrated: (i) => {
      const cid = ids[i];
      return cid !== null && cid !== undefined && hydrated.has(cid);
    },
    fileDiff: (i) => {
      const cid = ids[i];
      if (!cid) return undefined;
      const cached = fileDiffByCid.get(cid);
      if (cached) return cached;
      const map = readTurnMap(doc, cid);
      if (!map) return undefined;
      const raw = map.get('fileDiff');
      const value =
        raw && typeof raw === 'object' && 'kind' in (raw as object)
          ? (raw as LoroList).toJSON()
          : raw;
      const fileDiff = (Array.isArray(value) ? value : []) as FileDiff[];
      fileDiffByCid.set(cid, fileDiff);
      return fileDiff;
    },
    ensureRange: async (from, to) => {
      const start = Math.max(0, from);
      const end = Math.min(ids.length, to);
      for (let i = start; i < end; i += 1) {
        const cid = ids[i];
        if (cid && !hydrated.has(cid)) hydrateOne(i);
      }
      evict({ from: start, to: end });
    },
    retain: (from, to) => {
      const range = { from: Math.max(0, from), to };
      subscribedRanges.add(range);
      return () => {
        subscribedRanges.delete(range);
      };
    },
    release: (from, to) => {
      for (let i = Math.max(0, from); i < Math.min(ids.length, to); i += 1) {
        const cid = ids[i];
        if (cid && !isProtected(i)) hydrated.delete(cid);
      }
    },
    readAll: () => {
      if (allCache && allCache.version === version) return allCache.value;
      const value: SessionHistory[] = [];
      for (let i = 0; i < ids.length; i += 1) {
        const cid = ids[i];
        if (!cid) continue;
        // The LRU holds the freshest object for a hydrated turn (events
        // re-hydrate in place); the snapshot holds what an earlier full read
        // saw for everything else and is cleared per turn on change.
        let entry = hydrated.get(cid)?.value ?? snapshotByCid.get(cid);
        if (!entry) entry = materialize(i);
        if (!entry) continue;
        snapshotByCid.set(cid, entry);
        value.push(entry);
      }
      allCache = { version, value };
      return value;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      disposed = true;
      unsubscribeDoc();
      listeners.clear();
      hydrated.clear();
      snapshotByCid.clear();
      fileDiffByCid.clear();
      subscribedRanges.clear();
      allCache = null;
    },
  };
  return view;
}
