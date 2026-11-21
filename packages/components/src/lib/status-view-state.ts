import type { SessionMeta, StatusViewSession, StatusViewSessionPatch } from '@lody/shared';

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
 * Status rows for a metadata set: contained Tabs are dropped (they follow their
 * owner), and a conversation opened from a Tab nests under that Tab's owner.
 */
export function statusViewSessionsFromMetas(metas: readonly SessionMeta[]): StatusViewSession[] {
  const byId = new Map(metas.map((meta) => [meta.id, meta]));
  const rowOf = (id: string | undefined): string | null => {
    const seen = new Set<string>();
    let cursor = id;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = byId.get(cursor as SessionMeta['id'])?.parentSessionId;
      if (!parent) return cursor;
      cursor = parent;
    }
    return id ?? null;
  };
  return metas
    .filter((meta) => !meta.parentSessionId)
    .map((meta) =>
      statusViewSessionFromMeta(
        meta,
        meta.openedByRootSessionId ?? rowOf(meta.openedBySessionId ?? undefined)
      )
    );
}

/** A planned patch as a metadata upsert: `null` clears the field. */
export function statusViewPatchToMeta(patch: StatusViewSessionPatch): Partial<SessionMeta> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch))
    result[key] = value === null ? undefined : value;
  return result as Partial<SessionMeta>;
}
