const DEFAULT_IDLE_TIMEOUT_MS = 2_000;

/**
 * Runs `task` once the main thread is idle and returns a cancel function.
 *
 * Use it to keep work that no interaction waits on — telemetry above all — out
 * of the task that handled the input. A discrete event such as a keydown
 * renders synchronously in React, so anything its effects call is charged to
 * the user's key press and delays the next paint.
 */
export function scheduleIdleTask(
  task: () => void,
  timeoutMs = DEFAULT_IDLE_TIMEOUT_MS
): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(task, { timeout: timeoutMs });
    return () => window.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(task, 0);
  return () => window.clearTimeout(handle);
}
