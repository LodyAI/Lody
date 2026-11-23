/**
 * Schedule work after the document has loaded and the current frame has
 * painted. Landing uses this so the hero H1 can become LCP without competing
 * with WebGL, rotating copy, or below-fold preview chunks.
 */

export type ScheduleAfterLoadIdleOptions = {
  /** `requestIdleCallback` timeout after load + paint. Default 4000. */
  timeoutMs?: number;
};

export function scheduleAfterLoadIdle(
  start: () => void,
  options: ScheduleAfterLoadIdleOptions = {}
): () => void {
  const timeoutMs = options.timeoutMs ?? 4_000;
  let cancelled = false;
  let idleId: number | undefined;
  let fallbackId: ReturnType<typeof setTimeout> | undefined;

  const runStart = () => {
    if (!cancelled) start();
  };

  const runIdle = () => {
    if (cancelled) return;
    if (typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(runStart, { timeout: timeoutMs });
      return;
    }
    fallbackId = setTimeout(runStart, 1);
  };

  const afterPaint = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(runIdle);
    });
  };

  if (document.readyState === 'complete') {
    afterPaint();
  } else {
    window.addEventListener('load', afterPaint, { once: true });
  }

  return () => {
    cancelled = true;
    window.removeEventListener('load', afterPaint);
    if (idleId !== undefined && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleId);
    }
    if (fallbackId !== undefined) clearTimeout(fallbackId);
  };
}
