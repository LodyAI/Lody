import type { CacheSnapshot } from '@lody/virtua';
import type { SessionId } from '@lody/shared';
import { LRUCache } from '@/lib/lru-cache';

/**
 * Scroll position state for a session.
 *
 * Simple approach: store either "at end" or a pixel offset.
 * Updated directly on scroll events, bypassing React lifecycle entirely.
 */
export type ScrollPositionState = { type: 'end' } | { type: 'offset'; scrollOffset: number };

const DEFAULT_MAX_CACHE_SIZE = 50;

/**
 * Global LRU cache for scroll positions per session.
 * Module-level singleton that persists across component remounts.
 * Updated directly from scroll handlers - no React lifecycle involvement.
 */
const scrollPositionCache = new LRUCache<SessionId, ScrollPositionState>(DEFAULT_MAX_CACHE_SIZE);

/**
 * Save scroll position state for a session.
 * Call this directly from scroll event handlers.
 */
export function saveScrollPosition(sessionId: SessionId, state: ScrollPositionState): void {
  scrollPositionCache.set(sessionId, state);
}

/**
 * Get cached scroll position state for a session.
 * Returns undefined if no cached state exists (defaults to "end" behavior).
 */
export function getScrollPosition(sessionId: SessionId): ScrollPositionState | undefined {
  return scrollPositionCache.get(sessionId);
}

/**
 * Virtua's measured row sizes for a session, by row key.
 *
 * A cold virtualizer knows no row heights, so it lays a long conversation out
 * at an estimated total height, writes the restore offset into that wrong
 * coordinate space, and only corrects once the first rows have been measured.
 * The conversation stays hidden across those commits, which is the blank flash
 * on open. Handing the previous measurements back makes the first layout the
 * real one. The conversation list is keyed (`Virtualizer keyed`), so sizes are
 * restored by row key: a conversation that grew, or whose placeholder turns
 * became rows, while it was closed keeps every size it still has a row for.
 * A positional (unkeyed) snapshot is only restored against the same row count.
 */
interface VirtualizerCacheEntry {
  snapshot: CacheSnapshot;
  rowCount: number;
}

const virtualizerCache = new LRUCache<SessionId, VirtualizerCacheEntry>(DEFAULT_MAX_CACHE_SIZE);

/** Save Virtua's row measurements for a session. */
export function saveVirtualizerCache(
  sessionId: SessionId,
  snapshot: CacheSnapshot,
  rowCount: number
): void {
  virtualizerCache.set(sessionId, { snapshot, rowCount });
}

/** Row measurements for a session: keyed ones always, positional ones for the same row count. */
export function getVirtualizerCache(
  sessionId: SessionId,
  rowCount: number
): CacheSnapshot | undefined {
  const entry = virtualizerCache.get(sessionId);
  if (!entry) return undefined;
  const keyed = entry.snapshot[2] !== undefined;
  return keyed || entry.rowCount === rowCount ? entry.snapshot : undefined;
}

/**
 * Check if a session has cached scroll position.
 */
export function hasScrollPosition(sessionId: SessionId): boolean {
  return scrollPositionCache.has(sessionId);
}

/**
 * Clear scroll position cache for a specific session.
 */
export function clearScrollPosition(sessionId: SessionId): void {
  scrollPositionCache.delete(sessionId);
  virtualizerCache.delete(sessionId);
}

/**
 * Clear all cached scroll positions.
 */
export function clearAllScrollPositions(): void {
  scrollPositionCache.clear();
  virtualizerCache.clear();
}
