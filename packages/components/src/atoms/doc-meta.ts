import { atom, type PrimitiveAtom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import { atomEffect } from 'jotai-effect';
import type { LoroRepo } from 'loro-repo';
import {
  isLoroRepoDocDeleted,
  isAgentConfigDocRoomId,
  isMachineDocRoomId,
  isSessionDocRoomId,
  SESSION_DOC_PREFIX,
  type SessionMeta,
  type MachineMeta,
  type AgentConfigMeta,
  type SessionId,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from './runtime';
import { mergeBootstrapMetaCache } from '@/lib/doc-meta-bootstrap';
import { listDocMetaEntries } from '@/lib/doc-meta-batch';
import { getDocMetaRoomKind, withDerivedDocMetaId } from '@/lib/doc-meta-room';

// ---------------------------------------------------------------------------
// Runtime guard for metadata entering the cache.
//
// The CRDT metadata store may not always include the `id` field — it can be
// derived from the roomId (e.g. roomId "session-abc" → id "abc").  Rather
// than rejecting entries without `id`, we ensure `id` is always populated
// before the entry enters the cache.  This guarantees downstream code that
// reads `session.id` never gets undefined.
//
// When the data is not even a valid object, the entry is dropped and an async
// error is reported so it surfaces in monitoring without crashing the render.
// ---------------------------------------------------------------------------

function stringifyForReport(data: unknown): string {
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    return String(data);
  }
}

function reportInvalidMeta(context: string, roomId: string, data: unknown): void {
  // Async report — surfaces in monitoring/error trackers with a full stack trace
  // without blocking the current render.
  queueMicrotask(() => {
    const err = new Error(
      `[doc-meta] Invalid metadata dropped (${context}): roomId=${roomId}, ` +
        `data=${stringifyForReport(data)}`
    );
    err.name = 'InvalidDocMetaError';
    console.error(err);
  });
}

/** Returns false for non-objects / null — the entry should be dropped entirely. */
function isMetaObject(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null;
}

function normalizeDocMetaForCache(
  roomId: string,
  meta: Record<string, unknown>
): Record<string, unknown> {
  return withDerivedDocMetaId(roomId, meta);
}

function normalizeDocMetaPatchForCache(
  context: string,
  roomId: string,
  patch: unknown
): Record<string, unknown> | null {
  if (!isMetaObject(patch)) {
    reportInvalidMeta(context, roomId, patch);
    return null;
  }
  return patch;
}

function mergeNormalizedDocMetaPatch(
  roomId: string,
  current: Record<string, unknown>,
  normalizedPatch: Record<string, unknown>
): Record<string, unknown> {
  return withDerivedDocMetaId(roomId, {
    ...current,
    ...normalizedPatch,
  });
}

/**
 * Fields on SessionMeta that are relevant to the sidebar task list display.
 * When only non-visible fields change (e.g. lastRunningSeen heartbeat), we
 * skip producing a new array reference to avoid cascading re-renders.
 */
const SESSION_LIST_VISIBLE_KEYS: readonly (keyof SessionMeta)[] = [
  'id',
  'title',
  'repoFullName',
  'branchName',
  'status',
  'lastRunningSeen',
  'lastMessageAt',
  'lastReadAt',
  'createdAt',
  'userId',
  'machineId',
  'isArchived',
  'isPinned',
  'diffStats',
  'pullRequests',
  'pullRequestState',
  'project',
  'parentSessionId',
  'childSessionPlacement',
  'openedBySessionId',
  'openedByRootSessionId',
  'latestUserMsgId',
  'awaitingUserSince',
  'taskId',
  'lastCanceledTurn',
] as const;
const DOC_META_EVENT_FLUSH_BATCH_SIZE = 50;

function sessionListEntryEqual(a: SessionMeta, b: SessionMeta): boolean {
  for (const key of SESSION_LIST_VISIBLE_KEYS) {
    const av = a[key];
    const bv = b[key];
    if (av === bv) continue;
    if (!sessionMetaValueEqual(av, bv)) return false;
  }
  return true;
}

function sessionMetaValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if ((typeof a === 'object' && a !== null) || (typeof b === 'object' && b !== null)) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function metaRecordEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown>
): boolean {
  if (!a) return false;
  if (a === b) return true;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!sessionMetaValueEqual(a[key], b[key])) return false;
  }
  return true;
}

function sessionMetaEqual(a: SessionMeta, b: SessionMeta): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a) as Array<keyof SessionMeta>;
  const bKeys = Object.keys(b) as Array<keyof SessionMeta>;
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!sessionMetaValueEqual(a[key], b[key])) return false;
  }

  return true;
}

function sessionMetaArrayEqual(a: readonly SessionMeta[], b: readonly SessionMeta[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const next = b[index];
      return next !== undefined && entry.id === next.id && sessionMetaEqual(entry, next);
    })
  );
}

type SessionListEntry = SessionMeta & { id: SessionId };

type DocExistenceState = 'active' | 'deleted' | 'missing';

function isTrackedMetaDocRoomId(roomId: string): boolean {
  return getDocMetaRoomKind(roomId) !== undefined;
}

function toSessionListEntry(roomId: string, meta: SessionMeta): SessionListEntry {
  return {
    ...meta,
    id: meta.id ?? (roomId.slice(SESSION_DOC_PREFIX.length) as SessionId),
  };
}

function listSessionEntries(
  cache: Record<string, SessionMeta>,
  include: (meta: SessionMeta) => boolean
): SessionListEntry[] {
  return Object.entries(cache)
    .filter(([, meta]) => include(meta))
    .map(([roomId, meta]) => toSessionListEntry(roomId, meta));
}

// 分类缓存
export const sessionMetaCacheAtom = atom<Record<string, SessionMeta>>({});
export const machineMetaCacheAtom = atom<Record<string, MachineMeta>>({});
export const agentConfigMetaCacheAtom = atom<Record<string, AgentConfigMeta>>({});
export const docMetaCacheReadyAtom = atom(false);

export type DocMetaCacheScope = {
  runtime: WorkspaceRuntime;
  workspaceId: WorkspaceRuntime['workspaceId'];
  workspaceSlug: string;
  ready: boolean;
};

/** Identifies which runtime owns the current singleton metadata projection. */
export const docMetaCacheScopeAtom = atom<DocMetaCacheScope | null>(null);

// 兼容层
// Doc-meta atoms expose durable CRDT state only. Live signals (machine online,
// session working state) come from the presence atoms; the old
// `MachineMeta.lastSeen` presence overlay was removed with the durable
// heartbeat.
export const docMetaCacheAtom = atom<Record<string, unknown>>((get) => {
  return {
    ...get(sessionMetaCacheAtom),
    ...get(machineMetaCacheAtom),
    ...get(agentConfigMetaCacheAtom),
  };
});

/**
 * Billable session count for the workspace quota: the size of the session meta
 * cache, or `null` while that cache has not hydrated (an unhydrated cache cannot
 * report a trustworthy count). Readiness is folded in here so every consumer
 * gets the same fail-open rule. Scalar-valued so subscribers do not re-render on
 * unrelated meta ticks.
 */
export const sessionMetaCountAtom = atom((get) =>
  get(docMetaCacheReadyAtom) ? Object.keys(get(sessionMetaCacheAtom)).length : null
);

// 精确订阅 - 使用普通 atom 而非 selectAtom，确保缓存更新时正确触发订阅者
export const sessionMetaAtomFamily = atomFamily((roomId: string) => {
  let previous: SessionMeta | undefined;
  return atom((get) => {
    const next = get(sessionMetaCacheAtom)[roomId];
    if (!next) {
      previous = undefined;
      return undefined;
    }
    if (previous && sessionMetaEqual(previous, next)) {
      return previous;
    }
    previous = next;
    return next;
  });
});
export const machineMetaAtomFamily = atomFamily((roomId: string) =>
  atom((get) => get(machineMetaCacheAtom)[roomId])
);
export const agentConfigMetaAtomFamily = atomFamily((roomId: string) =>
  atom((get) => get(agentConfigMetaCacheAtom)[roomId])
);

// Session 列表 (active sessions only) — stabilized with structural equality
let _prevSessionList: SessionListEntry[] = [];
export const sessionListAtom = atom((get) => {
  const cache = get(sessionMetaCacheAtom);
  const next = listSessionEntries(
    cache,
    (session) => !session.isArchived && !session.parentSessionId
  );

  // Structural equality: return previous reference if nothing visible changed
  if (
    next.length === _prevSessionList.length &&
    next.every((entry, i) => {
      const prev = _prevSessionList[i];
      return prev !== undefined && prev.id === entry.id && sessionListEntryEqual(prev, entry);
    })
  ) {
    return _prevSessionList;
  }
  _prevSessionList = next;
  return next;
});

// Archived session 列表 — stabilized with structural equality
let _prevArchivedSessionList: SessionListEntry[] = [];
export const archivedSessionListAtom = atom((get) => {
  const cache = get(sessionMetaCacheAtom);
  const next = listSessionEntries(
    cache,
    (session) => !!session.isArchived && !session.parentSessionId
  );

  if (
    next.length === _prevArchivedSessionList.length &&
    next.every((entry, i) => {
      const prev = _prevArchivedSessionList[i];
      return prev !== undefined && prev.id === entry.id && sessionListEntryEqual(prev, entry);
    })
  ) {
    return _prevArchivedSessionList;
  }
  _prevArchivedSessionList = next;
  return next;
});

// All active sessions (including children) — used for child status aggregation
let _prevAllActiveSessions: SessionMeta[] = [];
export const allActiveSessionsAtom = atom((get) => {
  const cache = get(sessionMetaCacheAtom);
  const next = Object.values(cache).filter((session) => !session.isArchived);
  if (sessionMetaArrayEqual(_prevAllActiveSessions, next)) {
    return _prevAllActiveSessions;
  }
  _prevAllActiveSessions = next;
  return next;
});

// Every per-parent child projection is the same memoized filter over the meta
// cache; only the predicate (and optional ordering) differs.
function createChildSessionsAtomFamily(
  match: (session: SessionMeta, parentId: SessionId) => boolean,
  compare?: (left: SessionMeta, right: SessionMeta) => number
) {
  return atomFamily((parentId: SessionId) => {
    let previous: SessionMeta[] = [];
    return atom((get) => {
      const cache = get(sessionMetaCacheAtom);
      const next = Object.values(cache).filter((session) => match(session, parentId));
      if (compare) next.sort(compare);
      if (sessionMetaArrayEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return next;
    });
  });
}

const isTopTabChild = (session: SessionMeta, parentId: SessionId): boolean =>
  session.parentSessionId === parentId && session.childSessionPlacement !== 'side-panel';

// `createdAt` is an ISO string, so byte order is chronological order; Intl
// collation would only add cost.
const byCreatedAtAscending = (left: SessionMeta, right: SessionMeta): number =>
  left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;

// Child sessions for a given parent session — used by the multi-tab UI
export const childSessionsAtomFamily = createChildSessionsAtomFamily(
  (session, parentId) => isTopTabChild(session, parentId) && !session.isArchived
);

// Archived child sessions for a given parent — used by the tab archive popover
export const archivedChildSessionsAtomFamily = createChildSessionsAtomFamily(
  (session, parentId) => isTopTabChild(session, parentId) && !!session.isArchived
);

/**
 * Independent Sessions this Session opened (`openedBySessionId`), e.g. through
 * the `lody_session_create` MCP tool. Unlike `childSessionsAtomFamily` these are
 * NOT semantic children: they keep their own workspace, lifecycle, and sidebar
 * row. Rows already nested as a child tab / side chat (`parentSessionId`) are
 * excluded so a Session is never presented in both relationships at once.
 */
export const openedSessionsAtomFamily = createChildSessionsAtomFamily(
  (session, openerId) =>
    session.openedBySessionId === openerId &&
    !session.parentSessionId &&
    session.id !== openerId &&
    !session.isArchived,
  byCreatedAtAscending
);

// Durable side-session conversations share the parent workspace like ordinary
// child tabs, but are projected only into the right panel.
export const sideSessionsAtomFamily = createChildSessionsAtomFamily(
  (session, parentId) =>
    session.parentSessionId === parentId &&
    session.childSessionPlacement === 'side-panel' &&
    !session.isArchived,
  byCreatedAtAscending
);

export const setDocMetaByRoomIdAtom = atom(null, (_get, set, roomId: string, meta: unknown) => {
  if (!isMetaObject(meta)) {
    reportInvalidMeta('set', roomId, meta);
    return;
  }
  const nextMeta = normalizeDocMetaForCache(roomId, meta);
  if (isSessionDocRoomId(roomId)) {
    console.debug('[doc-meta] setDocMeta:', roomId, 'id=' + String(nextMeta.id));
    set(sessionMetaCacheAtom, (p) =>
      metaRecordEqual(p[roomId] as Record<string, unknown> | undefined, nextMeta)
        ? p
        : { ...p, [roomId]: nextMeta as SessionMeta }
    );
  } else if (isMachineDocRoomId(roomId))
    set(machineMetaCacheAtom, (p) =>
      metaRecordEqual(p[roomId] as Record<string, unknown> | undefined, nextMeta)
        ? p
        : { ...p, [roomId]: nextMeta as MachineMeta }
    );
  else if (isAgentConfigDocRoomId(roomId))
    set(agentConfigMetaCacheAtom, (p) =>
      metaRecordEqual(p[roomId] as Record<string, unknown> | undefined, nextMeta)
        ? p
        : { ...p, [roomId]: nextMeta as AgentConfigMeta }
    );
});

export const patchDocMetaByRoomIdAtom = atom(null, (_get, set, roomId: string, patch: unknown) => {
  // Only merge patches into entries that already exist in the cache.
  // Applying a partial patch to an absent entry would create an incomplete record
  // (e.g. SessionMeta without required fields) that passes truthy guards but
  // crashes downstream code. The subscription layer must fetch full metadata
  // before initializing missing entries.
  const normalizedPatch = normalizeDocMetaPatchForCache('patch', roomId, patch);
  if (!normalizedPatch) return;

  if (isSessionDocRoomId(roomId))
    set(sessionMetaCacheAtom, (p) => {
      if (!p[roomId]) return p;
      const merged = mergeNormalizedDocMetaPatch(roomId, p[roomId], normalizedPatch) as SessionMeta;
      if (metaRecordEqual(p[roomId] as Record<string, unknown>, merged)) return p;
      return { ...p, [roomId]: merged };
    });
  else if (isMachineDocRoomId(roomId))
    set(machineMetaCacheAtom, (p) => {
      if (!p[roomId]) return p;
      const merged = mergeNormalizedDocMetaPatch(roomId, p[roomId], normalizedPatch) as MachineMeta;
      if (metaRecordEqual(p[roomId] as Record<string, unknown>, merged)) return p;
      return { ...p, [roomId]: merged };
    });
  else if (isAgentConfigDocRoomId(roomId))
    set(agentConfigMetaCacheAtom, (p) => {
      if (!p[roomId]) return p;
      const merged = mergeNormalizedDocMetaPatch(
        roomId,
        p[roomId],
        normalizedPatch
      ) as AgentConfigMeta;
      if (metaRecordEqual(p[roomId] as Record<string, unknown>, merged)) return p;
      return { ...p, [roomId]: merged };
    });
});

export const clearDocMetaCacheAtom = atom(null, (_get, set) => {
  set(sessionMetaCacheAtom, {});
  set(machineMetaCacheAtom, {});
  set(agentConfigMetaCacheAtom, {});
});

// 初始扫描
async function buildDocMetaCache(repo: LoroRepo) {
  const sessions: Record<string, SessionMeta> = {};
  const machines: Record<string, MachineMeta> = {};
  const agents: Record<string, AgentConfigMeta> = {};

  const entries = await listDocMetaEntries(repo);
  if (typeof window !== 'undefined') {
    const sessionEntries = entries.filter((e) => isSessionDocRoomId(e.docId));
    console.debug(
      '[doc-meta] buildDocMetaCache: listDoc returned',
      entries.length,
      'entries,',
      sessionEntries.length,
      'sessions',
      sessionEntries.map((e) => ({
        docId: e.docId,
        deleted: isLoroRepoDocDeleted(e),
        metaKeys: Object.keys(e.meta),
      }))
    );
  }
  for (const entry of entries) {
    const { docId, meta } = entry;
    if (isLoroRepoDocDeleted(entry) || Object.keys(meta).length === 0) continue;
    if (!isMetaObject(meta)) {
      reportInvalidMeta('buildCache', docId, meta);
      continue;
    }
    const normalizedMeta = normalizeDocMetaForCache(docId, meta as Record<string, unknown>);
    if (isSessionDocRoomId(docId)) sessions[docId] = normalizedMeta as SessionMeta;
    else if (isMachineDocRoomId(docId)) machines[docId] = normalizedMeta as MachineMeta;
    else if (isAgentConfigDocRoomId(docId)) agents[docId] = normalizedMeta as AgentConfigMeta;
  }

  return { sessions, machines, agents };
}

// Helper to fetch metadata for a single doc through loro-repo's public API.
async function fetchDocMeta(
  repo: LoroRepo,
  docId: string
): Promise<Record<string, unknown> | null> {
  const entry = await repo.getDocMeta(docId);
  if (!entry || isLoroRepoDocDeleted(entry)) return null;
  return Object.keys(entry.meta).length > 0 ? entry.meta : null;
}

export const docMetaSubscriptionAtom = atomEffect((get, set) => {
  const runtime = get(activeWorkspaceRuntimeAtom);
  if (!runtime) {
    set(clearDocMetaCacheAtom);
    set(docMetaCacheReadyAtom, false);
    set(docMetaCacheScopeAtom, null);
    return undefined;
  }

  let cancelled = false;
  set(docMetaCacheReadyAtom, false);
  set(docMetaCacheScopeAtom, {
    runtime,
    workspaceId: runtime.workspaceId,
    workspaceSlug: runtime.workspaceSlug,
    ready: false,
  });

  // Track active docs whose initial fetchDocMeta returned null (metadata not
  // yet synced).  When a subsequent doc-metadata patch event arrives for one of
  // these docs, we do a full fetchDocMeta instead of a partial patch merge so
  // the cache entry is properly initialized.
  const pendingMetaDocIds = new Set<string>();

  const existenceEpochByDocId = new Map<string, number>();
  const existenceStateByDocId = new Map<string, DocExistenceState>();
  const fullMetaFetchEpochByDocId = new Map<string, number>();

  const clearCachedDocMeta = (docId: string) => {
    if (isSessionDocRoomId(docId)) {
      console.debug('[doc-meta] clearCachedDocMeta:', docId);
      set(sessionMetaCacheAtom, (p) => {
        if (!(docId in p)) return p;
        console.warn('[doc-meta] CLEARING existing session from cache:', docId);
        const n = { ...p };
        delete n[docId];
        return n;
      });
    } else if (isMachineDocRoomId(docId)) {
      set(machineMetaCacheAtom, (p) => {
        if (!(docId in p)) return p;
        const n = { ...p };
        delete n[docId];
        return n;
      });
    } else if (isAgentConfigDocRoomId(docId)) {
      set(agentConfigMetaCacheAtom, (p) => {
        if (!(docId in p)) return p;
        const n = { ...p };
        delete n[docId];
        return n;
      });
    }
  };

  const setCachedDocMeta = (docId: string, meta: Record<string, unknown>) => {
    if (!isMetaObject(meta)) {
      reportInvalidMeta('setCached', docId, meta);
      return;
    }
    const nextMeta = normalizeDocMetaForCache(docId, meta);
    if (isSessionDocRoomId(docId))
      set(sessionMetaCacheAtom, (p) =>
        metaRecordEqual(p[docId] as Record<string, unknown> | undefined, nextMeta)
          ? p
          : { ...p, [docId]: nextMeta as SessionMeta }
      );
    else if (isMachineDocRoomId(docId))
      set(machineMetaCacheAtom, (p) =>
        metaRecordEqual(p[docId] as Record<string, unknown> | undefined, nextMeta)
          ? p
          : { ...p, [docId]: nextMeta as MachineMeta }
      );
    else if (isAgentConfigDocRoomId(docId))
      set(agentConfigMetaCacheAtom, (p) =>
        metaRecordEqual(p[docId] as Record<string, unknown> | undefined, nextMeta)
          ? p
          : { ...p, [docId]: nextMeta as AgentConfigMeta }
      );
  };

  const hasCachedDocMeta = (docId: string): boolean => {
    if (isSessionDocRoomId(docId)) return !!get(sessionMetaCacheAtom)[docId];
    if (isMachineDocRoomId(docId)) return !!get(machineMetaCacheAtom)[docId];
    if (isAgentConfigDocRoomId(docId)) return !!get(agentConfigMetaCacheAtom)[docId];
    return false;
  };

  const fetchAndSetCachedDocMeta = (
    docId: string,
    expectedExistence?: { state: DocExistenceState | undefined; epoch: number }
  ) => {
    if (!isTrackedMetaDocRoomId(docId)) return;
    if (existenceStateByDocId.get(docId) === 'deleted') return;

    const fetchEpoch = (fullMetaFetchEpochByDocId.get(docId) ?? 0) + 1;
    fullMetaFetchEpochByDocId.set(docId, fetchEpoch);

    void fetchDocMeta(runtime.repo, docId).then((meta) => {
      if (cancelled) return;
      if (fullMetaFetchEpochByDocId.get(docId) !== fetchEpoch) return;
      if (existenceStateByDocId.get(docId) === 'deleted') return;
      if (expectedExistence) {
        if (existenceStateByDocId.get(docId) !== expectedExistence.state) return;
        if ((existenceEpochByDocId.get(docId) ?? 0) !== expectedExistence.epoch) return;
      }
      if (!meta) {
        if (expectedExistence?.state === 'missing') {
          clearCachedDocMeta(docId);
        } else {
          pendingMetaDocIds.add(docId);
        }
        return;
      }
      pendingMetaDocIds.delete(docId);
      setCachedDocMeta(docId, meta);
    });
  };

  const handleDocumentExistence = (docId: string, state: DocExistenceState) => {
    if (isSessionDocRoomId(docId)) {
      console.debug('[doc-meta] handleDocumentExistence:', docId, state);
    }
    const prevEpoch = existenceEpochByDocId.get(docId) ?? 0;
    const epoch = prevEpoch + 1;
    existenceEpochByDocId.set(docId, epoch);
    existenceStateByDocId.set(docId, state);

    if (state === 'deleted') {
      clearCachedDocMeta(docId);
      return;
    }

    // Active and missing states need a metadata refresh to restore the latest fields.
    // However, if fetchDocMeta returns null (transient — e.g. metadata not yet synced
    // for a freshly created doc), preserve any cache entry already present.  Only clear
    // the cache when the state is 'missing' AND fetch confirms no metadata exists.
    fetchAndSetCachedDocMeta(docId, { state, epoch });
  };

  // Apply a whole batch of patches to one cache atom in a single copy-on-write
  // `set` (one re-render per atom per flush), instead of per-doc dispatch via
  // patchDocMetaByRoomIdAtom — which would re-render once per doc and reintroduce
  // the reconnect-burst cascade this batching exists to avoid.
  const applyPatchesToCacheAtom = <T extends SessionMeta | MachineMeta | AgentConfigMeta>(
    cacheAtom: PrimitiveAtom<Record<string, T>>,
    patches: Array<[string, Record<string, unknown>]>
  ) => {
    if (patches.length === 0) return;
    set(cacheAtom, (prev) => {
      let next = prev;
      for (const [docId, patch] of patches) {
        const current = next[docId];
        if (!current) continue;
        const normalizedPatch = normalizeDocMetaPatchForCache('livePatch', docId, patch);
        if (!normalizedPatch) continue;
        const merged = mergeNormalizedDocMetaPatch(docId, current, normalizedPatch) as T;
        if (
          metaRecordEqual(current as Record<string, unknown>, merged as Record<string, unknown>)
        ) {
          continue;
        }
        if (next === prev) next = { ...prev };
        next[docId] = merged;
      }
      return next;
    });
  };

  const applyPatchBatchToCache = (entries: Array<[string, Record<string, unknown>]>) => {
    const sessionPatches: Array<[string, Record<string, unknown>]> = [];
    const machinePatches: Array<[string, Record<string, unknown>]> = [];
    const agentPatches: Array<[string, Record<string, unknown>]> = [];

    for (const entry of entries) {
      const [docId] = entry;
      if (isSessionDocRoomId(docId)) sessionPatches.push(entry);
      else if (isMachineDocRoomId(docId)) machinePatches.push(entry);
      else if (isAgentConfigDocRoomId(docId)) agentPatches.push(entry);
    }

    applyPatchesToCacheAtom(sessionMetaCacheAtom, sessionPatches);
    applyPatchesToCacheAtom(machineMetaCacheAtom, machinePatches);
    applyPatchesToCacheAtom(agentConfigMetaCacheAtom, agentPatches);
  };

  // Bound each projection turn so reconnect catch-up cannot monopolize the
  // mobile main thread. Rejected: microtask-only batching, which still blocks
  // paint until a large CRDT metadata burst is fully projected into Jotai.
  const pendingPatches = new Map<string, Record<string, unknown>>();
  type ExistenceEvent = { docId: string; state: DocExistenceState };
  const pendingExistenceUpdates: ExistenceEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const takePendingPatchBatch = (maxEntries: number): Array<[string, Record<string, unknown>]> => {
    const entries: Array<[string, Record<string, unknown>]> = [];
    if (maxEntries <= 0) return entries;
    for (const entry of pendingPatches) {
      entries.push(entry);
      pendingPatches.delete(entry[0]);
      if (entries.length >= maxEntries) {
        break;
      }
    }
    return entries;
  };

  const flushPending = () => {
    flushTimer = null;
    if (cancelled) {
      pendingPatches.clear();
      pendingExistenceUpdates.length = 0;
      return;
    }
    // Flush existence updates FIRST so that deleted docs are cleared before
    // metadata patches are applied — prevents ghost-doc resurrection during
    // purge batches where flock emits both ['e', docId] and ['m', docId, ...].
    const existenceBatch = pendingExistenceUpdates.splice(0, DOC_META_EVENT_FLUSH_BATCH_SIZE);
    for (const { docId, state } of existenceBatch) {
      handleDocumentExistence(docId, state);
      // Drop accumulated metadata patches for docs that are no longer active
      if (state !== 'active') {
        pendingPatches.delete(docId);
      }
    }

    const remainingBudget = DOC_META_EVENT_FLUSH_BATCH_SIZE - existenceBatch.length;
    const patchesToApply: Array<[string, Record<string, unknown>]> = [];
    // Flush remaining metadata patches (merged per docId), skipping deleted docs.
    // If existence updates remain, defer patches so delete/restore state still wins.
    const patchBatch =
      pendingExistenceUpdates.length === 0 ? takePendingPatchBatch(remainingBudget) : [];
    for (const [docId, patch] of patchBatch) {
      if (!isTrackedMetaDocRoomId(docId)) continue;
      if (existenceStateByDocId.get(docId) === 'deleted') continue;
      if (pendingMetaDocIds.has(docId) || !hasCachedDocMeta(docId)) {
        // This doc is not initialized in the local projection yet. Fetch the
        // source-of-truth metadata instead of creating an incomplete cache entry
        // from a partial patch.
        pendingMetaDocIds.delete(docId);
        const epoch = existenceEpochByDocId.get(docId) ?? 0;
        const state = existenceStateByDocId.get(docId);
        fetchAndSetCachedDocMeta(docId, state ? { state, epoch } : undefined);
        continue;
      }
      patchesToApply.push([docId, patch]);
    }
    applyPatchBatchToCache(patchesToApply);

    if (pendingExistenceUpdates.length > 0 || pendingPatches.size > 0) {
      scheduleFlush();
    }
  };

  function scheduleFlush() {
    if (flushTimer === null) {
      flushTimer = setTimeout(flushPending, 0);
    }
  }

  const handle = runtime.repo.watch(
    (event) => {
      if (event.kind === 'doc-metadata') {
        const patch = event.patch as Record<string, unknown>;
        // Local writes have already been accepted by Meta Flock. Apply them to
        // an existing UI projection immediately instead of placing a user
        // action behind a potentially large reconnect/catch-up batch.
        if (event.by === 'local' && hasCachedDocMeta(event.docId)) {
          const pendingPatch = pendingPatches.get(event.docId);
          pendingPatches.delete(event.docId);
          applyPatchBatchToCache([
            [event.docId, pendingPatch ? { ...pendingPatch, ...patch } : patch],
          ]);
          return;
        }

        // Merge remote/live patches for the same docId within the same batch.
        const existing = pendingPatches.get(event.docId);
        if (existing) {
          Object.assign(existing, patch);
        } else {
          pendingPatches.set(event.docId, { ...patch });
        }
        scheduleFlush();
      } else if ((event as { kind: string }).kind === 'doc-existence-changed') {
        const e = event as unknown as { kind: string; docId: string; from: string; to: string };
        if (e.to === 'deleted') {
          pendingExistenceUpdates.push({ docId: e.docId, state: 'deleted' });
        } else if (e.to === 'active') {
          pendingExistenceUpdates.push({ docId: e.docId, state: 'active' });
        } else if (e.to === 'missing') {
          pendingExistenceUpdates.push({ docId: e.docId, state: 'missing' });
        }
        scheduleFlush();
      }
    },
    { kinds: ['doc-metadata', 'doc-existence-changed'] as string[] as never }
  );

  // Started after the watch above so the live subscription covers the whole scan
  // window. The scan and live events overlap regardless, so merge per field: a
  // later partial live patch must not clobber complete metadata already present in
  // the flock snapshot, and a resolving snapshot must not undo an archive/restore
  // already observed live.
  void buildDocMetaCache(runtime.repo).then((cache) => {
    if (cancelled) return;
    set(sessionMetaCacheAtom, (prev) =>
      mergeBootstrapMetaCache(cache.sessions, prev, existenceStateByDocId)
    );
    set(machineMetaCacheAtom, (prev) =>
      mergeBootstrapMetaCache(cache.machines, prev, existenceStateByDocId)
    );
    set(agentConfigMetaCacheAtom, (prev) =>
      mergeBootstrapMetaCache(cache.agents, prev, existenceStateByDocId)
    );
    set(docMetaCacheReadyAtom, true);
    set(docMetaCacheScopeAtom, {
      runtime,
      workspaceId: runtime.workspaceId,
      workspaceSlug: runtime.workspaceSlug,
      ready: true,
    });
  });

  return () => {
    cancelled = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    handle.unsubscribe();
  };
});
