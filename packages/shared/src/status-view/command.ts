import {
  buildPinnedSectionLayout,
  comparePinSections,
  isPinOrderKey,
  normalizePinSection,
  planManualOrderMove,
  planNewPinPlacement,
  planNewPinSectionOrderKey,
  planPinnedSessionMove,
  planPinSectionMove,
  planTopOrderKey,
  type PinSection,
} from '../pinned-sections';
import { FractionalIndex, type JitterOptions } from '../vendor/loro-fractional-index';
import {
  buildStatusViewLayout,
  type StatusViewLayoutInput,
  type StatusViewSession,
} from './layout';
import { expiredSnoozeTimestamp, statusViewActivityAt } from './tiers';

/**
 * Write planning for the Status view and pin sections. Pure: the caller
 * supplies the metadata snapshot, the clock and the random bytes, and performs
 * the returned writes. A command the state cannot satisfy (unknown row,
 * missing permission, a past snooze time) plans no writes.
 */

export type StatusViewCommand =
  | { type: 'snooze'; sessionId: string; until: number; includeOpened: boolean }
  | { type: 'settle'; sessionId: string; includeOpened: boolean }
  | { type: 'moveToFocus'; sessionId: string; includeOpened: boolean }
  | { type: 'setPinned'; sessionId: string; pinned: boolean }
  | {
      /** Drag-and-drop, "Move to section", "Move to top". */
      type: 'move';
      sessionId: string;
      to: { area: 'focus' } | { area: 'pinned'; sectionId: string | null };
      /** The top-level row it lands in front of; `null` is the end. */
      beforeId: string | null;
    }
  | { type: 'createSection'; sectionId: string; name: string }
  | { type: 'renameSection'; sectionId: string; name: string }
  | { type: 'deleteSection'; sectionId: string }
  | { type: 'moveSection'; sectionId: string; beforeId: string | null }
  /** A message was sent: clears `snoozedUntil` / `settledAt`. */
  | { type: 'touchOnSend'; sessionId: string }
  /** A conversation was created: top of Focus; none for an opened-by row. */
  | { type: 'newSessionOrder'; sessionId: string };

export type StatusViewState = StatusViewLayoutInput & {
  /**
   * Conversations the list does not show that opened-tree actions still reach
   * (another scope, a hidden project, archived). They never affect order.
   */
  related?: StatusViewSession[];
};

export type StatusViewEnv = {
  /** Synced server clock. */
  nowMs: number;
  /** One byte in [0, 255] per call; fractional-index jitter. */
  randomByte: () => number;
};

/** `null` deletes the field. */
export type StatusViewSessionPatch = {
  isPinned?: boolean;
  pinSectionId?: string | null;
  orderKey?: string;
  snoozedUntil?: number | null;
  settledAt?: number | null;
  focusRestoredAt?: number;
};

export type StatusViewWrite =
  | {
      type: 'session';
      sessionId: string;
      /** `manage` needs full session management; `prefer` the narrower preference path. */
      access: 'manage' | 'prefer';
      patch: StatusViewSessionPatch;
    }
  | { type: 'putSection'; section: PinSection }
  | { type: 'deleteSection'; sectionId: string };

type Pool = Map<string, StatusViewSession>;

const poolOf = (state: StatusViewState): Pool => {
  const pool: Pool = new Map();
  for (const session of state.related ?? []) pool.set(session.id, session);
  for (const session of state.sessions) pool.set(session.id, session);
  return pool;
};

/** The session plus every conversation opened from it, recursively. */
function openedTree(pool: Pool, sessionId: string): string[] {
  const children = new Map<string, string[]>();
  for (const session of pool.values()) {
    if (!session.openedById) continue;
    const siblings = children.get(session.openedById) ?? [];
    siblings.push(session.id);
    children.set(session.openedById, siblings);
  }
  const visited = new Set<string>([sessionId]);
  for (const parentId of visited) {
    for (const child of children.get(parentId) ?? []) visited.add(child);
  }
  return [...visited];
}

const sessionWrite = (
  sessionId: string,
  access: 'manage' | 'prefer',
  patch: StatusViewSessionPatch
): StatusViewWrite => ({ type: 'session', sessionId, access, patch });

/**
 * A restore into Focus: clears settle state and a snooze that is still ahead.
 * An expired snooze is kept, so the restored row stays unread until it is read;
 * `focusRestoredAt` marks it placed, so it does not float.
 */
const restorePatch = (session: StatusViewSession, nowMs: number): StatusViewSessionPatch =>
  expiredSnoozeTimestamp(session.snoozedUntil, nowMs) === null
    ? { snoozedUntil: null, settledAt: null, focusRestoredAt: nowMs }
    : { settledAt: null, focusRestoredAt: nowMs };

const allowed = (pool: Pool, writes: StatusViewWrite[]): StatusViewWrite[] =>
  writes.every((write) => {
    if (write.type !== 'session') return true;
    const session = pool.get(write.sessionId);
    return session ? (write.access === 'manage' ? session.canManage : session.canPrefer) : false;
  })
    ? writes
    : [];

function statusTargets(
  pool: Pool,
  sessionId: string,
  includeOpened: boolean
): StatusViewSession[] | null {
  if (!pool.has(sessionId)) return null;
  const ids = includeOpened ? openedTree(pool, sessionId) : [sessionId];
  return ids.map((id) => pool.get(id)!);
}

function indexBefore(ids: readonly string[], beforeId: string | null): number {
  if (beforeId === null) return ids.length;
  const index = ids.indexOf(beforeId);
  return index < 0 ? ids.length : index;
}

/**
 * Expired snoozes float at the top of Focus without writes; an explicit drag
 * gives them real keys first, so the drop lands where it was shown. Placing a
 * woken row records `focusRestoredAt` at its wake-up and keeps the expired
 * `snoozedUntil`, so it stops floating but stays unread until it is read. A row
 * dropped in from Later, Settled or the Pinned area (unpinned) is restored
 * together with its opened sub-conversations, which get no keys of their own.
 */
function planFocusMove(
  state: StatusViewState,
  pool: Pool,
  sessionId: string,
  beforeId: string | null,
  env: StatusViewEnv,
  jitter: JitterOptions
): StatusViewWrite[] {
  const moved = pool.get(sessionId);
  if (!moved) return [];
  const { nowMs } = env;
  const focusRoots = buildStatusViewLayout({ ...state, nowMs }).focus;
  const wasInFocus = focusRoots.some((row) => row.id === sessionId);

  const placements: { id: string; orderKey: string | null }[] = [];
  for (const row of focusRoots) {
    if (row.woken) continue;
    placements.push({ id: row.id, orderKey: pool.get(row.id)?.orderKey ?? null });
  }
  const keyed = new Map<string, string>();
  const woken = focusRoots.filter((row) => row.woken && pool.get(row.id)?.canManage);
  for (let i = woken.length - 1; i >= 0; i -= 1) {
    const row = woken[i]!;
    const key = planTopOrderKey(placements, jitter);
    placements.unshift({ id: row.id, orderKey: key });
    keyed.set(row.id, key);
  }
  const toIndex = indexBefore(
    placements.filter((entry) => entry.id !== sessionId).map((entry) => entry.id),
    beforeId
  );
  for (const write of planManualOrderMove(placements, { sessionId, toIndex }, jitter)) {
    keyed.set(write.sessionId, write.orderKey);
  }

  const restored = new Set(wasInFocus ? [] : openedTree(pool, sessionId));
  const writes: StatusViewWrite[] = [];
  for (const [id, orderKey] of keyed) {
    const session = pool.get(id)!;
    const patch: StatusViewSessionPatch = { orderKey };
    const wokeAt = expiredSnoozeTimestamp(session.snoozedUntil, nowMs);
    if (restored.delete(id)) {
      Object.assign(patch, restorePatch(session, nowMs));
    } else if (wokeAt !== null && wokeAt > (session.focusRestoredAt ?? 0)) {
      patch.focusRestoredAt = wokeAt;
    }
    if (id === sessionId && moved.isPinned)
      Object.assign(patch, { isPinned: false, pinSectionId: null });
    writes.push(sessionWrite(id, 'manage', patch));
  }
  for (const id of restored) {
    writes.push(sessionWrite(id, 'manage', restorePatch(pool.get(id)!, nowMs)));
  }
  return allowed(pool, writes);
}

/**
 * Plans against the pinned rows themselves; carried opened rows never move
 * alone. Rows naming a section not read yet are held back, as the layout holds them.
 */
function planPinnedMove(
  state: StatusViewState,
  pool: Pool,
  sessionId: string,
  sectionId: string | null,
  beforeId: string | null,
  env: StatusViewEnv,
  jitter: JitterOptions
): StatusViewWrite[] {
  if (!pool.has(sessionId)) return [];
  const placements = state.sessions
    .filter((session) => session.isPinned)
    .map((session) => ({
      id: session.id,
      pinSectionId: session.pinSectionId,
      orderKey: session.orderKey,
      recency: statusViewActivityAt(
        session.activityAt ?? session.lastMessageAt,
        session.snoozedUntil,
        env.nowMs
      ),
    }));
  const layout = buildPinnedSectionLayout(placements, state.sections, (placement) => placement, {
    sectionsLoaded: state.sectionsLoaded,
  });
  const target = layout.find((entry) => entry.sectionId === sectionId) ?? layout[0];
  const ids = (target?.items ?? []).map((item) => item.id).filter((id) => id !== sessionId);
  const writes = planPinnedSessionMove(
    layout,
    { sessionId, toSectionId: target?.sectionId ?? null, toIndex: indexBefore(ids, beforeId) },
    jitter
  ).map((write) =>
    sessionWrite(write.sessionId, 'prefer', {
      isPinned: true,
      pinSectionId: write.pinSectionId ?? null,
      orderKey: write.orderKey,
    })
  );
  return allowed(pool, writes);
}

const sortedSections = (sections: readonly PinSection[]) => [...sections].sort(comparePinSections);

export function planStatusViewCommand(
  state: StatusViewState,
  command: StatusViewCommand,
  env: StatusViewEnv
): StatusViewWrite[] {
  const pool = poolOf(state);
  const jitter: JitterOptions = { randomByte: env.randomByte };
  const { nowMs } = env;

  switch (command.type) {
    case 'snooze': {
      if (!Number.isFinite(command.until) || command.until <= nowMs) return [];
      const targets = statusTargets(pool, command.sessionId, command.includeOpened);
      if (!targets) return [];
      return allowed(
        pool,
        targets.map((session) =>
          sessionWrite(session.id, 'manage', { snoozedUntil: command.until, settledAt: null })
        )
      );
    }
    case 'settle': {
      const targets = statusTargets(pool, command.sessionId, command.includeOpened);
      if (!targets) return [];
      return allowed(
        pool,
        targets.map((session) =>
          sessionWrite(session.id, 'manage', {
            settledAt: Math.max(nowMs, session.lastMessageAt ?? 0, session.activityAt ?? 0),
            snoozedUntil: null,
          })
        )
      );
    }
    case 'moveToFocus': {
      const targets = statusTargets(pool, command.sessionId, command.includeOpened);
      if (!targets) return [];
      return allowed(
        pool,
        targets.map((session) => sessionWrite(session.id, 'manage', restorePatch(session, nowMs)))
      );
    }
    case 'setPinned': {
      if (!pool.has(command.sessionId)) return [];
      if (!command.pinned) {
        return allowed(pool, [
          sessionWrite(command.sessionId, 'prefer', { isPinned: false, pinSectionId: null }),
        ]);
      }
      const sectionIds = new Set(state.sections.map((section) => section.id));
      const inDefaultSection = (session: StatusViewSession) =>
        !session.pinSectionId || (state.sectionsLoaded && !sectionIds.has(session.pinSectionId));
      const defaultPins = [...pool.values()]
        .filter(
          (session) =>
            session.isPinned && inDefaultSection(session) && session.id !== command.sessionId
        )
        .map((session) => ({
          id: session.id,
          pinSectionId: null,
          orderKey: session.orderKey,
          recency: session.activityAt ?? session.lastMessageAt ?? 0,
        }));
      const { orderKey } = planNewPinPlacement(
        buildPinnedSectionLayout(defaultPins, [], (placement) => placement),
        jitter
      );
      return allowed(pool, [
        sessionWrite(command.sessionId, 'prefer', { isPinned: true, pinSectionId: null, orderKey }),
      ]);
    }
    case 'move':
      return command.to.area === 'focus'
        ? planFocusMove(state, pool, command.sessionId, command.beforeId, env, jitter)
        : planPinnedMove(
            state,
            pool,
            command.sessionId,
            command.to.sectionId,
            command.beforeId,
            env,
            jitter
          );
    case 'createSection': {
      if (!state.canManageSections) return [];
      if (state.sections.some((section) => section.id === command.sectionId)) return [];
      const section = normalizePinSection({
        id: command.sectionId,
        name: command.name,
        orderKey: planNewPinSectionOrderKey(state.sections, jitter),
      });
      return section ? [{ type: 'putSection', section }] : [];
    }
    case 'renameSection': {
      if (!state.canManageSections) return [];
      const existing = state.sections.find((section) => section.id === command.sectionId);
      const section = existing && normalizePinSection({ ...existing, name: command.name });
      return section ? [{ type: 'putSection', section }] : [];
    }
    case 'deleteSection': {
      if (!state.canManageSections) return [];
      return state.sections.some((section) => section.id === command.sectionId)
        ? [{ type: 'deleteSection', sectionId: command.sectionId }]
        : [];
    }
    case 'moveSection': {
      if (!state.canManageSections) return [];
      const existing = state.sections.find((section) => section.id === command.sectionId);
      if (!existing) return [];
      const others = sortedSections(state.sections)
        .map((section) => section.id)
        .filter((id) => id !== command.sectionId);
      const orderKey = planPinSectionMove(
        state.sections,
        command.sectionId,
        indexBefore(others, command.beforeId),
        jitter
      );
      return [{ type: 'putSection', section: { ...existing, orderKey } }];
    }
    case 'touchOnSend': {
      const session = pool.get(command.sessionId);
      if (!session) return [];
      const patch: StatusViewSessionPatch = {};
      if (session.snoozedUntil !== null) patch.snoozedUntil = null;
      if (session.settledAt !== null) patch.settledAt = null;
      return Object.keys(patch).length > 0
        ? allowed(pool, [sessionWrite(session.id, 'manage', patch)])
        : [];
    }
    case 'newSessionOrder': {
      if (pool.get(command.sessionId)?.openedById) return [];
      let topKey: string | null = null;
      for (const session of pool.values()) {
        if (!isPinOrderKey(session.orderKey)) continue;
        if (topKey === null || FractionalIndex.compare(session.orderKey, topKey) < 0) {
          topKey = session.orderKey;
        }
      }
      return [
        sessionWrite(command.sessionId, 'manage', {
          orderKey: planTopOrderKey([{ id: '', orderKey: topKey }], jitter),
        }),
      ];
    }
  }
}
