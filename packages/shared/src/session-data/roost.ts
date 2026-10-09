import { pickDirectoryInputConfig, pickDirectoryScalars } from './directory';
import { selectTurnOutput } from './read';
import type { SessionDirectoryRow, SessionEntry, SessionTurnRead } from './domain';
import type { SessionId } from '../ids';
import type { SessionSnapshotService } from './snapshot';
import type {
  SessionData,
  SessionHistoryCommands,
  SessionHistoryReader,
  SessionObservation,
} from './types';

/**
 * The storage-neutral shape emitted by a Roost adapter.
 *
 * A row is a physical execution segment. `businessId` is the logical Lody
 * turn identity; callers must never use `segmentId` as a message identity.
 * `content` is already converted to ordinary JSON by the adapter boundary.
 */
export type RoostHistorySegment = {
  readonly businessId: string;
  readonly segmentId: string;
  readonly content: unknown;
  readonly nextSeq?: bigint;
  readonly sealed: boolean;
};

/**
 * Roost changes are expressed in logical positions and identities. A segment
 * successor for an existing business id is a content change; it is never a
 * structural row insertion.
 */
export type RoostHistoryChange =
  | { readonly kind: 'structure'; readonly from: number; readonly to: number }
  | { readonly kind: 'changed'; readonly businessIds: readonly string[] };

export type RoostHistoryObservation = {
  /** The segment snapshot captured at the same point the listener went live. */
  readonly initial: Promise<readonly RoostHistorySegment[]>;
  /** Logical entries for a backend that has already projected its active branch. */
  readonly initialEntries?: Promise<readonly SessionEntry[]>;
  readonly unsubscribe: () => void;
};

/**
 * Storage-neutral port used by the logical reader.
 *
 * The port deliberately does not mention Stream, IndexedDbStorage, or
 * NodeLodyHistory. Branch operations and lifecycle methods stay on the selected
 * backend, so Roost storage details do not leak into the renderer or orchestration
 * code.
 */
export type RoostHistoryPort =
  | {
      /** Physical projection supplied by an adapter that owns the Roost view. */
      readonly readProjectedMessages: () => Promise<readonly RoostHistorySegment[]>;
      /** Direct logical projection supplied by an adapter that already collapsed segments. */
      readonly readLogicalEntries?: never;
      readonly observe: (listener: (change: RoostHistoryChange) => void) => RoostHistoryObservation;
    }
  | {
      /** Physical segments are intentionally absent when the adapter returns logical rows. */
      readonly readProjectedMessages?: never;
      readonly readLogicalEntries: () => Promise<readonly SessionEntry[]>;
      readonly observe: (listener: (change: RoostHistoryChange) => void) => RoostHistoryObservation;
    };

export type RoostSessionDataOptions = {
  readonly sessionId: SessionId;
  readonly port?: RoostHistoryPort;
  readonly history?: SessionHistoryReader;
  /** Commands and snapshots remain owned by the selected history backend. */
  readonly commands: SessionHistoryCommands;
  readonly snapshots: SessionSnapshotService;
  readonly dispose?: () => void;
};

export type RoostSessionData = SessionData & { readonly dispose?: () => void };

/** Compose renderer-facing SessionData without making the renderer know Roost. */
export function createRoostSessionData(options: RoostSessionDataOptions): RoostSessionData {
  if (Boolean(options.port) === Boolean(options.history)) {
    throw new Error('Roost SessionData requires exactly one history port or reader');
  }
  const history = options.history ?? createRoostHistoryReader(options.port!);
  return {
    sessionId: options.sessionId,
    history,
    commands: options.commands,
    snapshots: options.snapshots,
    ...(options.dispose ? { dispose: options.dispose } : {}),
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const appendFields = new Set(['items', 'plan', 'fileDiff']);
export const ROOST_CLEAR_FIELDS_KEY = '__lody_roost_clear_fields_v1';

const projectionError = (message: string): Error => {
  const error = new Error(`Invalid Roost history projection: ${message}`);
  error.name = 'RoostHistoryProjectionError';
  return error;
};

const cloneArray = (value: unknown): unknown[] | undefined =>
  Array.isArray(value) ? [...value] : undefined;

const mergeSegment = (
  current: Record<string, unknown> | undefined,
  segment: RoostHistorySegment
): Record<string, unknown> => {
  if (!segment.businessId || segment.businessId.trim() !== segment.businessId) {
    throw projectionError('businessId must be a non-empty trimmed string');
  }
  if (!segment.segmentId || segment.segmentId.trim() !== segment.segmentId) {
    throw projectionError('segmentId must be a non-empty trimmed string');
  }
  if (!record(segment.content)) throw projectionError('segment content must be an object');

  const next: Record<string, unknown> = current ? { ...current } : {};
  const clearFields = segment.content[ROOST_CLEAR_FIELDS_KEY];
  if (clearFields !== undefined) {
    if (!segment.segmentId.startsWith('late:') || !Array.isArray(clearFields)) {
      throw projectionError('clear-field metadata is only valid on late segments');
    }
    for (const field of clearFields) {
      if (
        typeof field !== 'string' ||
        !field ||
        field === 'id' ||
        field === ROOST_CLEAR_FIELDS_KEY
      ) {
        throw projectionError('clear-field metadata contains an invalid field');
      }
      delete next[field];
    }
  }
  for (const [key, value] of Object.entries(segment.content)) {
    if (key === ROOST_CLEAR_FIELDS_KEY) continue;
    if (value === undefined) continue;
    if (appendFields.has(key) && Array.isArray(value)) {
      const prior = cloneArray(next[key]);
      next[key] = prior ? [...prior, ...value] : [...value];
      continue;
    }
    next[key] = value;
  }
  // The logical id is owned by the segment envelope, never by mutable content.
  next.id = segment.businessId;
  return next;
};

const toEntry = (businessId: string, value: Record<string, unknown>): SessionEntry => {
  if (value.role !== 'user' && value.role !== 'assistant' && value.role !== 'system') {
    throw projectionError(`${businessId} has no valid role`);
  }
  if (typeof value.timestamp !== 'string') {
    throw projectionError(`${businessId} has no timestamp`);
  }
  const items = cloneArray(value.items);
  const fileDiff = cloneArray(value.fileDiff);
  return {
    ...value,
    id: businessId,
    role: value.role,
    timestamp: value.timestamp,
    ...(items ? { items } : {}),
    fileDiff: fileDiff ?? [],
  } as SessionEntry;
};

/**
 * Collapse physical Roost segments into the logical history consumed by Lody.
 * The first segment establishes display order. Later segments for that
 * business id append list fields and replace scalar fields, which models a
 * sealed primary plus append-only successor output without editing the sealed
 * record in place.
 */
export function projectRoostSegments(
  segments: readonly RoostHistorySegment[]
): readonly SessionEntry[] {
  const grouped = new Map<string, Record<string, unknown>>();
  for (const segment of segments) {
    grouped.set(segment.businessId, mergeSegment(grouped.get(segment.businessId), segment));
  }
  return [...grouped].map(([businessId, value]) => toEntry(businessId, value));
}

const asReady = (turn: SessionEntry): SessionTurnRead => ({
  state: 'ready',
  turn: structuredClone(turn),
});

const detached = <T>(value: T): T => structuredClone(value);

export const createRoostDirectoryRow = (
  position: number,
  turn: SessionEntry
): SessionDirectoryRow => {
  const scalars = pickDirectoryScalars(turn);
  if (!scalars) return { position, state: 'invalid' };
  return {
    position,
    state: 'ready',
    turnId: turn.id,
    scalars,
    ...(turn.role === 'user' ? { inputConfig: pickDirectoryInputConfig(turn.inputConfig) } : {}),
    ...(turn.items ? { itemCount: turn.items.length } : {}),
    ...(turn.plan ? { planCount: turn.plan.length } : {}),
  };
};

type Projection = {
  readonly entries: readonly SessionEntry[];
  readonly rows: readonly SessionDirectoryRow[];
  readonly byId: ReadonlyMap<string, number>;
};

const buildProjection = (segments: readonly RoostHistorySegment[]): Projection => {
  const entries = projectRoostSegments(segments);
  const rows = entries.map((entry, position) => createRoostDirectoryRow(position, entry));
  const byId = new Map<string, number>();
  entries.forEach((entry, index) => byId.set(entry.id, index));
  return { entries, rows, byId };
};

const buildProjectionFromEntries = (entries: readonly SessionEntry[]): Projection => {
  const copied = entries.map((entry) => detached(entry));
  const rows = copied.map((entry, position) => createRoostDirectoryRow(position, entry));
  const byId = new Map<string, number>();
  copied.forEach((entry, index) => byId.set(entry.id, index));
  return { entries: copied, rows, byId };
};

const clipRange = (from: number, to: number, length: number): [number, number] => {
  const lo = Math.max(0, Math.min(from, length));
  const hi = Math.max(lo, Math.min(to, length));
  return [lo, hi];
};

/** Build the shared Lody history reader over a Roost logical projection. */
export function createRoostHistoryReader(port: RoostHistoryPort): SessionHistoryReader {
  let cached: Projection | undefined;
  let cachedGeneration = -1;
  let refresh: { readonly generation: number; readonly promise: Promise<Projection> } | undefined;
  let generation = 0;
  let liveObservations = 0;

  const readProjection = async (): Promise<Projection> => {
    while (true) {
      const requestedGeneration = generation;
      if (cached && liveObservations > 0 && cachedGeneration === requestedGeneration) return cached;

      let pending = refresh;
      if (!pending || pending.generation !== requestedGeneration) {
        const promise = (
          port.readLogicalEntries
            ? port.readLogicalEntries().then((entries) => buildProjectionFromEntries([...entries]))
            : port.readProjectedMessages().then((segments) => buildProjection(segments))
        ).then((next) => {
          if (generation === requestedGeneration) {
            cached = next;
            cachedGeneration = requestedGeneration;
          }
          return next;
        });
        pending = { generation: requestedGeneration, promise };
        refresh = pending;
        void promise.then(
          () => {
            if (refresh === pending) refresh = undefined;
          },
          () => {
            if (refresh === pending) refresh = undefined;
          }
        );
      }

      let projection: Projection;
      try {
        projection = await pending.promise;
      } catch (error) {
        if (generation !== requestedGeneration) continue;
        throw error;
      }
      if (generation !== requestedGeneration) continue;
      if (cachedGeneration !== requestedGeneration) {
        cached = projection;
        cachedGeneration = requestedGeneration;
      }
      return projection;
    }
  };

  const invalidate = () => {
    generation += 1;
    cached = undefined;
    cachedGeneration = -1;
  };

  const history: SessionHistoryReader = {
    async count() {
      return (await readProjection()).entries.length;
    },
    async readAt(position) {
      const entry = (await readProjection()).entries[position];
      return entry ? asReady(entry) : { state: 'missing' };
    },
    async readTurn(turnId) {
      const projection = await readProjection();
      const position = projection.byId.get(turnId);
      return position === undefined ? { state: 'missing' } : asReady(projection.entries[position]!);
    },
    async readRange(from, to) {
      const entries = (await readProjection()).entries;
      const [lo, hi] = clipRange(from, to, entries.length);
      return entries.slice(lo, hi).map(asReady);
    },
    async readDirectory(from, to) {
      const rows = (await readProjection()).rows;
      const [lo, hi] = clipRange(from, to, rows.length);
      return rows.slice(lo, hi).map((row, offset) => ({ ...row, position: lo + offset }));
    },
    async readAll() {
      return detached([...(await readProjection()).entries]);
    },
    async readTurnOutput(userTurnId) {
      const projection = await readProjection();
      return selectTurnOutput(
        projection.entries.length,
        userTurnId,
        (index) => projection.rows[index]?.scalars,
        (index) => {
          const entry = projection.entries[index];
          return entry ? detached(entry) : undefined;
        }
      );
    },
    observe(listener): SessionObservation {
      let active = true;
      const generationBeforeSubscribe = generation;
      const observed = port.observe((change) => {
        if (!active) return;
        invalidate();
        if (change.kind === 'structure') {
          listener({ kind: 'structure', from: change.from, to: change.to });
        } else {
          listener({ kind: 'changed', ids: [...change.businessIds] });
        }
      });
      const generationAtSubscribe = generation;
      liveObservations += 1;
      const initial = (async () => {
        const projection = await (observed.initialEntries
          ? observed.initialEntries.then((entries) => buildProjectionFromEntries(entries))
          : observed.initial.then((segments) => buildProjection(segments)));
        if (
          generationBeforeSubscribe === generationAtSubscribe &&
          generation === generationAtSubscribe
        ) {
          cached = projection;
          cachedGeneration = generationAtSubscribe;
          return projection.rows;
        }
        return (await readProjection()).rows;
      })();
      return {
        initial,
        unsubscribe: () => {
          if (!active) return;
          active = false;
          observed.unsubscribe();
          liveObservations = Math.max(0, liveObservations - 1);
          if (liveObservations === 0) invalidate();
        },
      };
    },
  };

  return history;
}
