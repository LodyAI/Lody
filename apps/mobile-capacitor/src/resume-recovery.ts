import { App as CapacitorApp } from '@capacitor/app';
import { capturePostHogSingleton } from '@lody/components/lib/mobile-resume-analytics';

const RESUME_RELOAD_MARKER = 'lody:resume-reload-at';
const RESUME_RELOAD_COOLDOWN_MS = 30_000;
// Give React a chance to re-paint after the app becomes active before we judge
// the WebView "blank" — resume can fire a frame before the next commit.
const RESUME_CHECK_DELAY_MS = 400;

type ShouldRecoverParams = {
  isActive: boolean;
  visible: boolean;
  blank: boolean;
  lastReloadAt: number | null;
  now: number;
  cooldownMs?: number;
};

/**
 * Pure decision for the resume health-check, extracted so the (DOM/storage-free)
 * branching is unit-testable. We only recover when the app is active, the page
 * is visible, the root is blank, and we haven't already reloaded recently — the
 * cooldown stops a genuinely broken boot from looping (the index.html boot guard
 * shows the error UI instead).
 */
export function shouldRecoverOnResume(params: ShouldRecoverParams): boolean {
  const { isActive, visible, blank, lastReloadAt, now } = params;
  const cooldownMs = params.cooldownMs ?? RESUME_RELOAD_COOLDOWN_MS;
  if (!isActive || !visible || !blank) return false;
  if (lastReloadAt != null && Number.isFinite(lastReloadAt) && now - lastReloadAt < cooldownMs) {
    return false;
  }
  return true;
}

function rootLooksBlank(): boolean {
  const root = document.getElementById('root');
  if (!root) return true;
  return root.childElementCount === 0;
}

function readLastReloadAt(): number | null {
  try {
    const raw = sessionStorage.getItem(RESUME_RELOAD_MARKER);
    if (raw == null || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function markReloaded(now: number): void {
  try {
    sessionStorage.setItem(RESUME_RELOAD_MARKER, String(now));
  } catch {
    // sessionStorage can throw in private mode / disabled storage; best-effort.
  }
}

/**
 * Recover from the "blank WebView after returning from background" white screen.
 *
 * iOS/Android can discard the WebView's rendered content under memory pressure
 * while backgrounded. When the JS context survives but the DOM was lost, the
 * page comes back visually blank; a single in-place reload restores it. When the
 * JS context itself was killed this listener never fires — that case needs a
 * native WebView reload and is out of scope here.
 */
export function initResumeRecovery(): void {
  void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) return;
    window.setTimeout(() => {
      const now = Date.now();
      const blank = rootLooksBlank();
      const shouldRecover = shouldRecoverOnResume({
        isActive: true,
        visible: typeof document === 'undefined' || document.visibilityState === 'visible',
        blank,
        lastReloadAt: readLastReloadAt(),
        now,
      });

      if (!shouldRecover) return;

      // mobile/blank_screen_recovery_triggered (spec §8f.2, P0, tier A): the
      // app came back blank and we are forcing a one-shot reload to recover.
      capturePostHogSingleton('mobile/blank_screen_recovery_triggered', {
        last_reload_at_ms: readLastReloadAt(),
      });

      markReloaded(now);
      console.warn('[Lody] WebView looked blank after resume; reloading once to recover.');
      window.location.reload();
    }, RESUME_CHECK_DELAY_MS);
  });
}
