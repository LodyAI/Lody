import {
  buildStatusViewLayout,
  flattenStatusViewRows,
  type PinSection,
  type SessionMeta,
  type StatusViewCommand,
  type StatusViewLayout,
  type StatusViewLayoutInput,
  type StatusViewRow,
  type StatusViewSession,
} from '@lody/shared';
import type { MobileConversationItem } from './mobile-project-screen';

/** Phone rows ↔ the shared Status view contract: [README](./README.md#status-grouping). */

/** The fields `chat-landing` copies from `SessionMeta` onto each phone row. */
export function mobileStatusFieldsOf(
  meta: Pick<
    SessionMeta,
    'lastMessageAt' | 'lastReadAt' | 'snoozedUntil' | 'settledAt' | 'focusRestoredAt'
  >
): Pick<
  MobileConversationItem,
  'lastMessageAt' | 'lastReadAt' | 'snoozedUntil' | 'settledAt' | 'focusRestoredAt'
> {
  const finite = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    lastMessageAt: finite(meta.lastMessageAt),
    lastReadAt: finite(meta.lastReadAt),
    snoozedUntil: finite(meta.snoozedUntil),
    settledAt: finite(meta.settledAt),
    focusRestoredAt: finite(meta.focusRestoredAt),
  };
}

/** One phone row as the shared layout's session; `readOnly` is the management guard's predicate. */
export function toStatusViewSession(
  chat: MobileConversationItem,
  writable = true,
  preferable = true
): StatusViewSession {
  return {
    id: chat.id,
    title: chat.title,
    lastMessageAt: chat.lastMessageAt ?? null,
    activityAt: chat.latestMessageAt ?? chat.lastMessageAt ?? null,
    lastReadAt: chat.lastReadAt ?? null,
    isPinned: chat.isPinned === true,
    pinSectionId: chat.pinSectionId ?? null,
    orderKey: chat.orderKey ?? null,
    snoozedUntil: chat.snoozedUntil ?? null,
    settledAt: chat.settledAt ?? null,
    focusRestoredAt: chat.focusRestoredAt ?? null,
    openedById: chat.openedByRowSessionId ?? chat.openedBySessionId ?? null,
    isWorking: chat.isWorking === true,
    isWaitingPermission: chat.isWaitingPermission === true,
    canManage: writable && chat.readOnly !== true,
    canPrefer: preferable,
  };
}

export type MobileStatusViewOptions = {
  sections: readonly PinSection[];
  sectionsLoaded: boolean;
  /** The member may write Status view state (`useStatusViewWritable`); false only pins. */
  writable: boolean;
  /**
   * The member may pin and place pins. False where no write can land at all: an
   * encrypted workspace member without the write role cannot seal a pin either.
   */
  preferable?: boolean;
  /** Pinned rows the list's scope hid, by pin section id (`""` = default). */
  scopeHiddenCounts?: Record<string, number>;
  nowMs: number;
};

/** The shared layout input for the phone rows; commands are planned against the same input. */
export function buildMobileStatusViewInput(
  chats: readonly MobileConversationItem[],
  options: MobileStatusViewOptions
): StatusViewLayoutInput {
  return {
    sessions: chats.map((chat) =>
      toStatusViewSession(chat, options.writable, options.preferable ?? true)
    ),
    sections: [...options.sections],
    sectionsLoaded: options.sectionsLoaded,
    canManageSections: options.writable && options.sectionsLoaded,
    ...(options.scopeHiddenCounts ? { scopeHiddenCounts: options.scopeHiddenCounts } : {}),
    nowMs: options.nowMs,
  };
}

export function buildMobileStatusViewLayout(
  chats: readonly MobileConversationItem[],
  options: MobileStatusViewOptions
): StatusViewLayout {
  return buildStatusViewLayout(buildMobileStatusViewInput(chats, options));
}

/** Where a top-level row sits: the list it belongs to and its index in it. */
export type StatusViewArea = { area: 'focus' } | { area: 'pinned'; sectionId: string | null };

export type StatusViewRowPlace = {
  area: StatusViewArea | { area: 'later' } | { area: 'settled' };
  index: number;
  rows: readonly StatusViewRow[];
};

/** Locate a top-level row (children are carried by their opener). */
export function findStatusViewRow(
  layout: StatusViewLayout,
  sessionId: string
): StatusViewRowPlace | null {
  for (const section of layout.pinned) {
    const index = section.rows.findIndex((row) => row.id === sessionId);
    if (index >= 0)
      return { area: { area: 'pinned', sectionId: section.sectionId }, index, rows: section.rows };
  }
  for (const tier of ['focus', 'later', 'settled'] as const) {
    const index = layout[tier].findIndex((row) => row.id === sessionId);
    if (index >= 0)
      return { area: { area: tier } as StatusViewRowPlace['area'], index, rows: layout[tier] };
  }
  return null;
}

/**
 * A rendered row, top-level or nested under its opener, with the top-level
 * place it is carried by. Acting on a nested row acts on that row only.
 */
export function findStatusViewEntry(
  layout: StatusViewLayout,
  sessionId: string
): { place: StatusViewRowPlace; row: StatusViewRow; nested: boolean } | null {
  const lists: Array<[StatusViewRowPlace['area'], readonly StatusViewRow[]]> = [
    ...layout.pinned.map(
      (section) =>
        [{ area: 'pinned', sectionId: section.sectionId }, section.rows] as [
          StatusViewRowPlace['area'],
          readonly StatusViewRow[],
        ]
    ),
    [{ area: 'focus' }, layout.focus],
    [{ area: 'later' }, layout.later],
    [{ area: 'settled' }, layout.settled],
  ];
  for (const [area, rows] of lists) {
    for (let index = 0; index < rows.length; index += 1) {
      const root = rows[index]!;
      if (root.id === sessionId) return { place: { area, index, rows }, row: root, nested: false };
      const child = root.children.find((candidate) => candidate.id === sessionId);
      if (child) return { place: { area, index, rows }, row: child, nested: true };
    }
  }
  return null;
}

/** The top-level row a rendered row belongs to: itself, or the opener it is nested under. */
export function statusViewRootId(layout: StatusViewLayout, sessionId: string): string | null {
  const lists = [
    ...layout.pinned.map((section) => section.rows),
    layout.focus,
    layout.later,
    layout.settled,
  ];
  for (const rows of lists) {
    for (const row of rows) {
      if (row.id === sessionId || row.children.some((child) => child.id === sessionId))
        return row.id;
    }
  }
  return null;
}

type MoveCommand = Extract<StatusViewCommand, { type: 'move' }>;

/** `layout` with `move` applied; a move whose row is gone changes nothing. */
export function applyStatusViewMove(layout: StatusViewLayout, move: MoveCommand): StatusViewLayout {
  const from = findStatusViewRow(layout, move.sessionId);
  if (!from) return layout;
  const moving = from.rows[from.index]!;
  const tier = move.to.area === 'focus' ? 'focus' : 'pinned';
  const landed: StatusViewRow = { ...moving, tier, snoozedUntil: null, woken: false };
  const insert = (rows: readonly StatusViewRow[]): StatusViewRow[] => {
    const without = rows.filter((row) => row.id !== move.sessionId);
    const at =
      move.beforeId === null
        ? without.length
        : without.findIndex((row) => row.id === move.beforeId);
    const index = at < 0 ? without.length : at;
    return [...without.slice(0, index), landed, ...without.slice(index)];
  };
  const remove = (rows: readonly StatusViewRow[]) =>
    rows.filter((row) => row.id !== move.sessionId);
  const target = move.to;
  const next: StatusViewLayout = {
    ...layout,
    pinned: layout.pinned.map((section) =>
      target.area === 'pinned' && target.sectionId === section.sectionId
        ? { ...section, rows: insert(section.rows) }
        : { ...section, rows: remove(section.rows) }
    ),
    focus: target.area === 'focus' ? insert(layout.focus) : remove(layout.focus),
    later: remove(layout.later),
    settled: remove(layout.settled),
  };
  if (
    target.area === 'pinned' &&
    !layout.pinned.some((section) => section.sectionId === target.sectionId)
  ) {
    next.pinned = [
      ...next.pinned,
      { sectionId: target.sectionId, name: null, rows: [landed], hiddenCount: 0 },
    ];
  }
  return next;
}

/** A held order is released once this changes (read back) or the write fails. */
export function statusViewPlacementSignature(chat: MobileConversationItem | undefined): string {
  if (!chat) return '';
  return JSON.stringify([
    chat.isPinned === true,
    chat.pinSectionId ?? null,
    chat.orderKey ?? null,
    chat.snoozedUntil ?? null,
    chat.settledAt ?? null,
    chat.focusRestoredAt ?? null,
  ]);
}

/** Row ids in render order across the Pinned area and the tiers. */
export function statusViewOrderedIds(layout: StatusViewLayout): string[] {
  return [
    ...layout.pinned.flatMap((section) => flattenStatusViewRows(section.rows)),
    ...flattenStatusViewRows(layout.focus),
    ...flattenStatusViewRows(layout.later),
    ...flattenStatusViewRows(layout.settled),
  ].map((row) => row.id);
}

/** `beforeId` for Move up / Move down / Move to top; `undefined` at that edge. */
export function statusViewNeighbourBeforeId(
  place: StatusViewRowPlace,
  direction: 'up' | 'down' | 'top'
): string | null | undefined {
  const { rows, index } = place;
  if (direction === 'top') return index === 0 ? undefined : rows[0]!.id;
  if (direction === 'up') return index === 0 ? undefined : rows[index - 1]!.id;
  if (index >= rows.length - 1) return undefined;
  return rows[index + 2]?.id ?? null;
}
