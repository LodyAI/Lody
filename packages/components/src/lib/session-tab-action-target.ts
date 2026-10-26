import type { SessionId } from '@lody/shared';

/** Resolve an active tab to an executable session only when its metadata is present. */
export function resolveActiveSessionTabId(
  activeTabId: string,
  rootSessionId: SessionId,
  visibleChildSessionIds: readonly SessionId[]
): SessionId | null {
  if (activeTabId === rootSessionId) return rootSessionId;
  return visibleChildSessionIds.find((id) => id === activeTabId) ?? null;
}
