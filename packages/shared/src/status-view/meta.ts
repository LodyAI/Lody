import type { SessionMeta } from '../schema';
import type { StatusViewSession } from './layout';
import type { StatusViewSessionPatch } from './command';
/**
 * Adapters between Session metadata and the shared Status view planner
 * (`@lody/shared` `planStatusViewCommand`). Presence and permissions are not
 * metadata: callers that know them override `isWorking`, `canManage` and the rest.
 */

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function statusViewSessionFromMeta(
  meta: SessionMeta,
  openedById: string | null
): StatusViewSession {
  const lastMessageAt = finite(meta.lastMessageAt);
  return {
    id: meta.id,
    title: meta.title ?? '',
    lastMessageAt,
    activityAt: lastMessageAt ?? (Date.parse(meta.createdAt ?? '') || 0),
    lastReadAt: finite(meta.lastReadAt),
    isPinned: meta.isPinned === true,
    pinSectionId: meta.pinSectionId ?? null,
    orderKey: meta.orderKey ?? null,
    snoozedUntil: finite(meta.snoozedUntil),
    settledAt: finite(meta.settledAt),
    focusRestoredAt: finite(meta.focusRestoredAt),
    openedById,
    isWorking: false,
    isWaitingPermission: false,
    canManage: true,
    canPrefer: true,
  };
}

/**
 * Status rows for a metadata set. Contained Tabs are dropped (they follow their
 * owner) and so are archived conversations, other than `keepArchivedId` (the
 * one acted on): status actions never reach an archived sub-conversation. A
 * conversation nests under its precise opener's row, the Tab's owner for a Tab,
 * passing over archived openers; `openedByRootSessionId` is a navigation route
 * and never selects operation targets (specs/session-relations.md).
 */
export function statusViewSessionsFromMetas(
  metas: readonly SessionMeta[],
  options: { keepArchivedId?: string } = {}
): StatusViewSession[] {
  const byId = new Map<string, SessionMeta>(metas.map((meta) => [meta.id, meta]));
  const kept = (meta: SessionMeta) =>
    !meta.parentSessionId && (meta.isArchived !== true || meta.id === options.keepArchivedId);
  const rowOf = (id: string | undefined): string | null => {
    const seen = new Set<string>();
    let cursor = id;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const meta = byId.get(cursor);
      if (!meta) return cursor;
      if (meta.parentSessionId) cursor = meta.parentSessionId;
      else if (kept(meta)) return cursor;
      else cursor = meta.openedBySessionId;
    }
    return null;
  };
  return metas
    .filter(kept)
    .map((meta) => statusViewSessionFromMeta(meta, rowOf(meta.openedBySessionId ?? undefined)));
}

/** A planned patch as a metadata upsert: `null` clears the field. */
export function statusViewPatchToMeta(patch: StatusViewSessionPatch): Partial<SessionMeta> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch))
    result[key] = value === null ? undefined : value;
  return result as Partial<SessionMeta>;
}
