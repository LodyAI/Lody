/**
 * Holds every {@link WorkingGrid} still while the user is reading.
 *
 * Peripheral vision is most sensitive to motion, so a sidebar full of moving
 * marks keeps pulling the eye away from the text beside it. Any wheel, key,
 * pointer or touch press outside a `[data-working-grid-region]` (the sidebar) counts
 * as reading and freezes all marks on their current frame; they resume after
 * {@link READING_IDLE_MS} of quiet, or at once when the pointer enters the region.
 *
 * Only pause and resume touch the animations; frames still run on the compositor.
 * All marks share one clock offset, so after a pause they resume on the same sea.
 */

export const READING_IDLE_MS = 4_000;
const REGION = '[data-working-grid-region]';

const live = new Set<Animation>();
let enabled = true;
let installed = false;
let paused = false;
let pausedAt = 0;
/** Total time spent paused; every loop starts at this offset on the timeline. */
let offset = 0;
let resumeTimer: ReturnType<typeof setTimeout> | undefined;

const now = () => Number(document.timeline?.currentTime ?? performance.now());

function inRegion(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(REGION) !== null;
}

function pause() {
  if (!paused) {
    paused = true;
    pausedAt = now();
    for (const animation of live) animation.pause();
  }
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(resume, READING_IDLE_MS);
}

function resume() {
  clearTimeout(resumeTimer);
  resumeTimer = undefined;
  if (!paused) return;
  paused = false;
  offset += now() - pausedAt;
  for (const animation of live) animation.startTime = offset;
}

function onReadingActivity(event: Event) {
  if (enabled && !inRegion(event.target)) pause();
}

function onPointerOver(event: Event) {
  if (inRegion(event.target)) resume();
}

function install() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const options = { capture: true, passive: true } as const;
  // User input only: `scroll` also fires for programmatic scrolling, such as a
  // streaming conversation following its tail, which is not the user reading.
  for (const type of ['wheel', 'keydown', 'pointerdown', 'touchstart']) {
    document.addEventListener(type, onReadingActivity, options);
  }
  document.addEventListener('pointerover', onPointerOver, options);
}

/**
 * Starts `animation` on the shared clock and keeps it in step with reading pauses.
 * Returns the function that stops tracking it.
 */
export function trackWorkingGridAnimation(animation: Animation): () => void {
  install();
  animation.startTime = offset;
  if (paused) {
    animation.pause();
    animation.currentTime = pausedAt - offset;
  }
  live.add(animation);
  return () => live.delete(animation);
}

/** Turns the reading pause on or off (on by default); turning it off resumes at once. */
export function setWorkingGridReadingPause(on: boolean): void {
  enabled = on;
  if (!on) resume();
}
