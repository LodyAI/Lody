/**
 * Frame-rate budget for ambient motion: the infinite, decorative animations that
 * mark ongoing work (the sidebar working grid, spinners, the status shimmer).
 *
 * Any running animation keeps Chromium's compositor producing a frame every vsync
 * (120 Hz on ProMotion), however small it is and even when it is composited. The
 * cost lands in the GPU process and in macOS WindowServer, and a visible window is
 * never throttled. While the window has focus the motion stays smooth. When it
 * loses focus — the user works in another app, often with Lody on a second
 * display — every ambient animation is quantized to {@link AMBIENT_UNFOCUSED_FPS}
 * on one shared tick grid, so the compositor draws at most that many frames a
 * second. Pausing instead would make a visible Lody look frozen.
 *
 * Quantizing only pays off when every animation changes on the SAME ticks:
 * unaligned `steps()` animations interleave and still change almost every vsync.
 * So duration, delay and start time are all snapped to multiples of the tick.
 *
 * Measured on Electron 43 / macOS (renderer + GPU process CPU for four working
 * marks and two spinners): 7.9% continuous, 4.3% at 30 fps, 0 with no animation.
 */

export const AMBIENT_UNFOCUSED_FPS = 30;

export type AmbientTiming = {
  duration: number;
  delay: number;
  easing: string;
};

/**
 * The timing that makes an animation change only on multiples of `1000 / fps` ms
 * of its timeline, given that its start time is also on that grid.
 */
export function quantizeAmbientTiming(
  timing: { duration: number; delay: number },
  fps: number
): AmbientTiming {
  const tick = 1000 / fps;
  const steps = Math.max(1, Math.round(timing.duration / tick));
  return {
    duration: steps * tick,
    delay: Math.round(timing.delay / tick) * tick,
    easing: `steps(${steps})`,
  };
}

const originals = new WeakMap<Animation, AmbientTiming>();
let quantizedFps: number | null = null;

function isAmbient(animation: Animation): boolean {
  const timing = animation.effect?.getTiming();
  return (
    timing !== undefined &&
    timing.iterations === Infinity &&
    typeof timing.duration === 'number' &&
    timing.duration > 0
  );
}

function quantize(animation: Animation, fps: number): void {
  if (originals.has(animation) || !isAmbient(animation)) return;
  const effect = animation.effect!;
  const timing = effect.getTiming();
  const duration = timing.duration as number;
  const delay = timing.delay ?? 0;
  originals.set(animation, { duration, delay, easing: timing.easing ?? 'linear' });
  effect.updateTiming(quantizeAmbientTiming({ duration, delay }, fps));
  // A CSS animation starts whenever its element mounted; move it onto the shared
  // grid. The shift is under half a tick, so it is invisible.
  if (typeof animation.startTime === 'number') {
    const tick = 1000 / fps;
    animation.startTime = Math.round(animation.startTime / tick) * tick;
  }
}

function restore(animation: Animation): void {
  const original = originals.get(animation);
  if (!original) return;
  originals.delete(animation);
  animation.effect?.updateTiming({
    duration: original.duration,
    delay: original.delay,
    easing: original.easing,
  });
}

/**
 * Put freshly created ambient Web Animations under the current budget. Script
 * animations do not fire `animationstart`, so their owner must hand them over.
 */
export function adoptAmbientAnimations(animations: Iterable<Animation>): void {
  if (quantizedFps === null) return;
  for (const animation of animations) quantize(animation, quantizedFps);
}

function applyBudget(document: Document, fps: number | null): void {
  if (fps === quantizedFps) return;
  const previous = quantizedFps;
  quantizedFps = fps;
  for (const animation of document.getAnimations()) {
    if (previous !== null) restore(animation);
    if (fps !== null) quantize(animation, fps);
  }
}

/**
 * Throttle ambient motion in `window` while it is unfocused. Returns an uninstall
 * function that also restores every animation's own timing.
 */
export function installAmbientMotionBudget(
  window: Window,
  fps: number = AMBIENT_UNFOCUSED_FPS
): () => void {
  const { document } = window;
  if (typeof document.getAnimations !== 'function') return () => {};

  const onFocus = () => applyBudget(document, null);
  const onBlur = () => applyBudget(document, fps);
  // CSS animations that start while unfocused, including on pseudo-elements.
  const onAnimationStart = (event: AnimationEvent) => {
    if (quantizedFps === null || !(event.target instanceof Element)) return;
    for (const animation of event.target.getAnimations({ subtree: true })) {
      quantize(animation, quantizedFps);
    }
  };

  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  document.addEventListener('animationstart', onAnimationStart, true);
  applyBudget(document, document.hasFocus() ? null : fps);

  return () => {
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('animationstart', onAnimationStart, true);
    applyBudget(document, null);
  };
}
