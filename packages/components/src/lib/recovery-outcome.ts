import { deferredPostHog } from './deferred-posthog';
import { capturePostHogEvent } from './posthog-analytics';
import { takeBootLocalClear } from './clear-local-cache';
import { recordSessionRenderTrace } from './session-render-trace';

export type RecoveryOutcome = 'ready' | 'stuck_again';

/**
 * Report whether the clear this page load ran at boot fixed anything: `ready`
 * when the workspace opened, `stuck_again` when a blocking wait still needed
 * the recovery screen. At most once per page load, and only after a clear.
 * This is what says whether a clear is enough or users still need the full reset.
 */
export function reportRecoveryOutcome(outcome: RecoveryOutcome, gate: string | null): void {
  const record = takeBootLocalClear();
  if (!record) return;
  const properties = {
    outcome,
    gate,
    mode: record.mode,
    clear_ok: record.ok,
    failed_count: record.failedCount,
  };
  recordSessionRenderTrace(`recovery outcome ${outcome} after ${record.mode} clear`);
  try {
    capturePostHogEvent(deferredPostHog, 'workspace/recovery_outcome', properties);
  } catch {
    // Diagnostics only.
  }
}
