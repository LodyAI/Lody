import type { LoroDoc, LoroEventBatch, LoroList, LoroMap } from 'loro-crdt';
import type { SessionHistory, SessionId, TurnSummary } from '@lody/shared';

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
  itemCount?: number;
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
  ensureRange(from: number, to: number): Promise<void>;
  release(from: number, to: number): void;
  /**
   * Every turn, hydrated. O(n) in turns: only for callers that genuinely need
   * the whole transcript (markdown export, end-of-session timing). Cached per
   * `version`, so repeated reads between changes are free.
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
    const items = shallow.items;
    if (isContainerId(items)) {
      const itemsList = doc.getContainerById(items as never);
      if (itemsList && itemsList.kind() === 'List') {
        row.itemCount = (itemsList as LoroList).length;
      }
    } else if (Array.isArray(items)) {
      row.itemCount = items.length;
    }
    return row as TurnIndexRow;
  };

  const rebuildIndex = () => {
    const shallow = list.getShallowValue() as unknown[];
    const nextIds: (string | null)[] = new Array(shallow.length);
    const nextRows: (TurnIndexRow | undefined)[] = new Array(shallow.length);
    positionById.clear();
    for (let i = 0; i < shallow.length; i += 1) {
      const cid = shallow[i];
      if (!isContainerId(cid)) {
        nextIds[i] = null;
        nextRows[i] = undefined;
        continue;
      }
      nextIds[i] = cid;
      // Reuse the previous row when the container did not move so a structural
      // change costs one shallow read for the list, not one per turn.
      const previousPosition = ids.indexOf(cid);
      const row =
        previousPosition >= 0 && previousPosition === i
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
    ids = nextIds;
    indexRows = nextRows;
  };

  const hydrateOne = (i: number): SessionHistory | undefined => {
    const cid = ids[i];
    if (!cid) return undefined;
    const map = readTurnMap(doc, cid);
    if (!map) return undefined;
    const value = toSessionHistory(map.toJSON() as Record<string, unknown>);
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
      const position = ids.indexOf(cid);
      if (position >= 0 && isProtected(position, keep)) continue;
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
      fieldTouched === 'items'
    ) {
      indexRows[i] = readIndexRow(cid);
    }
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
    ensureRange: async (from, to) => {
      const start = Math.max(0, from);
      const end = Math.min(ids.length, to);
      for (let i = start; i < end; i += 1) {
        const cid = ids[i];
        if (cid && !hydrated.has(cid)) hydrateOne(i);
      }
      evict({ from: start, to: end });
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
        const entry = hydrated.get(cid)?.value ?? hydrateOne(i);
        if (entry) value.push(entry);
      }
      // A full read is a deliberate O(n) consumer; do not let it pin every turn.
      evict();
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
      subscribedRanges.clear();
    },
  };
  return view;
}
