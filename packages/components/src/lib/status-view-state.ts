import { flattenStatusViewRows, type StatusViewLayout, type StatusViewSession } from '@lody/shared';

export {
  statusViewSessionFromMeta,
  statusViewSessionsFromMetas,
  statusViewPatchToMeta,
} from '@lody/shared/status-view';

/**
 * Sidebar drag-and-drop reports a slot index; the planner takes the row the
 * drop lands in front of. These resolve one into the other against the layout
 * the list rendered, so a stale index still names the intended neighbor.
 */
export function focusDropBeforeId(
  layout: StatusViewLayout,
  sessionId: string,
  toIndex: number
): string | null {
  const others = layout.focus.map((row) => row.id).filter((id) => id !== sessionId);
  return others[Math.max(0, toIndex)] ?? null;
}

/** Index among the pinned rows of a section; rows carried by a pinned opener never count. */
export function pinnedDropBeforeId(
  layout: StatusViewLayout,
  sessions: readonly StatusViewSession[],
  sectionId: string | null,
  sessionId: string,
  toIndex: number
): string | null {
  const entry =
    layout.pinned.find((candidate) => candidate.sectionId === sectionId) ?? layout.pinned[0];
  const pinnedIds = new Set(sessions.filter((session) => session.isPinned).map((s) => s.id));
  const ids = flattenStatusViewRows(entry?.rows ?? [])
    .map((row) => row.id)
    .filter((id) => pinnedIds.has(id) && id !== sessionId);
  return ids[Math.max(0, toIndex)] ?? null;
}

/** Index among the user sections, without the moved one. */
export function sectionDropBeforeId(
  layout: StatusViewLayout,
  sectionId: string,
  toIndex: number
): string | null {
  const others = layout.pinned
    .flatMap((entry) => (entry.sectionId === null ? [] : [entry.sectionId]))
    .filter((id) => id !== sectionId);
  return others[Math.max(0, toIndex)] ?? null;
}
