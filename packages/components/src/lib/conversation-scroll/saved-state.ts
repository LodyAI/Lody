import type { SessionId } from '@lody/shared';
import { LRUCache } from '@/lib/lru-cache';
import type { CycleDiagnostic, SavedScrollState } from './types';

/**
 * The engine's per-session memory: the reading intent and the measured row
 * sizes, by row key and layout version. Like the Virtua path's caches it lives
 * in memory for the page's life only, so a restart opens every conversation at
 * its end. It uses its own keys: switching implementations never reads the
 * other one's state.
 */
const MAX_SESSIONS = 50;
const savedStates = new LRUCache<SessionId, SavedScrollState>(MAX_SESSIONS);

export function getSavedScrollState(sessionId: SessionId): SavedScrollState | undefined {
  const saved = savedStates.get(sessionId);
  return saved?.formatVersion === 1 ? saved : undefined;
}

export function saveScrollState(sessionId: SessionId, state: SavedScrollState): void {
  savedStates.set(sessionId, state);
}

export function clearSavedScrollStates(): void {
  savedStates.clear();
}

/**
 * The turn the restored reading position is in, so the hydration window can
 * load it before the first viewport report.
 */
export function getSavedAnchorTurnId(sessionId: SessionId): string | null {
  const intent = getSavedScrollState(sessionId)?.intent;
  return intent?.kind === 'read' && intent.anchor.kind === 'turn' ? intent.anchor.turnId : null;
}

// ---- Always-on diagnostics --------------------------------------------------

const MAX_DIAGNOSTICS = 200;
const diagnostics: Array<CycleDiagnostic & { at: number; session: string }> = [];

/** Record one engine cycle. Geometry only, never message text. */
export function recordScrollEngineDiagnostic(sessionId: SessionId, diagnostic: CycleDiagnostic) {
  diagnostics.push({
    ...diagnostic,
    at: Math.round(performance.now()),
    session: sessionId.slice(0, 8),
  });
  if (diagnostics.length > MAX_DIAGNOSTICS)
    diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS);
}

export function getScrollEngineDiagnostics(): ReadonlyArray<
  CycleDiagnostic & { at: number; session: string }
> {
  return diagnostics.slice();
}

if (typeof window !== 'undefined') {
  (window as unknown as { __lodyScrollEngineLog?: unknown }).__lodyScrollEngineLog = {
    dump: getScrollEngineDiagnostics,
  };
}
