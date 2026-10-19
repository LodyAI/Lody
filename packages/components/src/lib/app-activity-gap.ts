/**
 * How long the app sat unused before the latest launch or return to the
 * foreground. Stuck-open reports carry it, because the hangs being chased
 * cluster on launches after a long absence (and the version jumps that come
 * with them).
 *
 * Device-local and diagnostic only; deliberately not in the cache-clear DELETE
 * list, so a clear does not erase the gap that explains it.
 */
const LAST_ACTIVE_AT_KEY = 'lody:lastActiveAt';

let latestIdleGapMs: number | null = null;

function readLastActiveAt(): number | null {
  try {
    const value = Number(localStorage.getItem(LAST_ACTIVE_AT_KEY));
    return value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeLastActiveAt(nowMs: number): void {
  try {
    localStorage.setItem(LAST_ACTIVE_AT_KEY, String(nowMs));
  } catch {
    // Diagnostics only.
  }
}

/** The app is in use from `nowMs`: measure the gap since it was last in use. */
export function recordAppActive(nowMs: number): void {
  const lastActiveAt = readLastActiveAt();
  latestIdleGapMs = lastActiveAt === null ? null : Math.max(0, nowMs - lastActiveAt);
  writeLastActiveAt(nowMs);
}

/** The app is leaving the foreground at `nowMs`; the next gap starts here. */
export function recordAppInactive(nowMs: number): void {
  writeLastActiveAt(nowMs);
}

export function readIdleGapMs(): number | null {
  return latestIdleGapMs;
}

/**
 * Mounted once by `AppInitializer`. A page that boots hidden (the desktop's warm
 * spare) is not in use yet; it starts counting when it is first shown.
 */
export function installAppActivityTracking(now: () => number = Date.now): () => void {
  if (typeof document === 'undefined') return () => {};
  if (document.visibilityState !== 'hidden') recordAppActive(now());
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') recordAppActive(now());
    else recordAppInactive(now());
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => document.removeEventListener('visibilitychange', onVisibilityChange);
}

/** Test-only. */
export function resetAppActivityGapForTests(): void {
  latestIdleGapMs = null;
}
