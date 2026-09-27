// The tour camera.
//
// WHAT THIS REPLACES, and why. The first version declared six hand-written
// rectangles in a fixed 1180x720 coordinate system (`SESSION_FOCUS`), then
// solved a transform against them. Two things were wrong with that and both
// were structural, not tuning:
//
//  1. The rectangles were constants. The moment the layout moved — a panel
//     opened, the sidebar resized, a row was added — every frame was a guess
//     again, and the code said so in its own comments.
//  2. The framing could only ever be "somewhere inside the one window", because
//     the coordinate system WAS the window.
//
// So the camera now aims at REAL DOM NODES. Anything on the stage can mark
// itself with `data-tour-anchor="..."` and become a shot: a button in the
// composer, a row in the sidebar, the side panel while it is still opening, a
// second machine's window, a phone sitting next to the laptop. The camera reads
// the node's live rect every frame, so a shot stays correct while its subject
// is still moving, and a layout change can never desync it.
//
// The motion is a SPRING INTEGRATED PER FRAME toward the target, not a CSS
// transition between two declared states. That difference is the whole feel:
//
//  - A transition has to know where it starts. The old code did not, so it
//    parked at `full` for 900ms before every move and each cut became two
//    teleports. A spring has no start — it has a position and a velocity — so
//    it can be re-aimed mid-flight and simply curves.
//  - A moving subject is free. Following the side panel as it expands is the
//    same code as holding still on a button.
//  - Being interrupted is free. The user grabbing control mid-move does not
//    fight an animation that is committed to its endpoint.

/** A shot: which node to look at, and how much air to leave around it. */
export type CameraShot = {
  /** `data-tour-anchor` value of the node to frame. */
  anchor: string;
  /**
   * Breathing room around the subject, in stage pixels. Generous by default:
   * a frame that cuts flush to its subject reads as a crop, not a look.
   */
  padding?: number;
  /**
   * Ceiling on magnification. Without it, framing a 24px icon would fill the
   * viewport with one glyph and lose every bit of context that made the shot
   * mean something.
   */
  maxScale?: number;
  /** Authoring magnification relative to the fit scale. */
  zoom?: number;
  /**
   * Floor on magnification. Used by the wide shots so "pull back to the whole
   * desk" cannot creep in just because the window happens to be small.
   */
  minScale?: number;
  /**
   * Where the subject lands inside the full camera viewport, expressed as a
   * 0..1 fraction. The viewport itself remains the whole stage; these values
   * compose around foreground UI without clipping the camera into a panel.
   */
  focusX?: number;
  focusY?: number;
};

export type CameraPose = {
  /** Scale applied to the stage. */
  scale: number;
  /** Translation applied BEFORE the scale (transform-origin: 0 0). */
  x: number;
  y: number;
};

/** A rectangle in the stage's own untransformed coordinate space. */
export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Find the node a shot names.
 *
 * Most anchors are `data-tour-anchor` markers. A few are DERIVED from selectors
 * the product already carries — sidebar rows key off `data-sidebar-session-id`,
 * session tabs off their position in the real tab bar — because those exist for
 * the app's own reasons, and adding a second tour-only attribute beside them
 * would be one more thing to keep in sync for no gain. Anything the product does
 * not already identify gets an explicit marker instead.
 */
export function resolveAnchor(stage: HTMLElement, anchor: string): HTMLElement | null {
  const row = anchor.startsWith('sidebar.row.') ? anchor.slice('sidebar.row.'.length) : null;
  if (row) {
    return stage.querySelector<HTMLElement>(`[data-sidebar-session-id="${row}"]`);
  }
  const tab = anchor.startsWith('tab-bar.tab.')
    ? Number(anchor.slice('tab-bar.tab.'.length))
    : null;
  if (tab !== null && Number.isFinite(tab)) {
    const bar = stage.querySelector<HTMLElement>('[data-tour-anchor="tab-bar"]');
    return bar?.querySelectorAll<HTMLElement>('[role="tab"]')[tab] ?? null;
  }
  // The run-config trigger belongs to the composer footer; the product marks it
  // for its own reasons (the onboarding blueprint and camera both aim at it).
  if (anchor === 'composer.run-config') {
    return stage.querySelector<HTMLElement>(
      '[data-tour-anchor="composer"] [data-run-config-trigger]'
    );
  }
  if (anchor === 'composer.input') {
    return stage.querySelector<HTMLElement>(
      '[data-tour-anchor="composer"] [data-lody-composer-input]'
    );
  }
  if (anchor === 'composer.card' || anchor === 'composer.send') {
    const input = stage.querySelector<HTMLElement>(
      '[data-tour-anchor="composer"] [data-lody-composer-input]'
    );
    // The card is the input's nearest ancestor that paints its own ground.
    let card: HTMLElement | null = input?.parentElement ?? null;
    while (card && getComputedStyle(card).backgroundColor === 'rgba(0, 0, 0, 0)') {
      card = card.parentElement;
    }
    if (anchor === 'composer.card') return card;
    const buttons = card?.querySelectorAll<HTMLElement>('button');
    return buttons && buttons.length > 0 ? buttons[buttons.length - 1]! : null;
  }
  if (anchor === 'sidebar.workspace') {
    return stage.querySelector<HTMLElement>(
      '[data-tour-anchor="sidebar"] [data-workspace-switcher-trigger]'
    );
  }
  if (anchor === 'pr.merge') {
    const buttons = stage.querySelectorAll<HTMLElement>(
      '[data-tour-anchor="side-panel"] [data-pr-merge-control] > button:first-child'
    );
    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      if (rect.width >= 1 && rect.height >= 1) return button;
    }
    return null;
  }
  return stage.querySelector<HTMLElement>(`[data-tour-anchor="${anchor}"]`);
}

export const DEFAULT_PADDING = 56;
export const DEFAULT_MAX_SCALE = 2.6;

/**
 * Read an anchor's rect in the stage's UNTRANSFORMED coordinates.
 *
 * `getBoundingClientRect` reports post-transform pixels, so the currently
 * applied scale has to be divided back out — otherwise the solver would chase
 * its own output and the camera would drift every frame it moved.
 */
export function measureAnchor(
  stage: HTMLElement,
  anchor: string,
  appliedScale: number
): Rect | null {
  const node = resolveAnchor(stage, anchor);
  if (!node) return null;
  const stageRect = stage.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  // A node that has been laid out to zero — a panel that has not opened yet —
  // is not a frameable subject. Reporting null lets the caller hold the
  // previous target instead of diving into a degenerate rect.
  if (nodeRect.width < 1 || nodeRect.height < 1) return null;
  const s = appliedScale <= 0 ? 1 : appliedScale;
  return {
    x: (nodeRect.left - stageRect.left) / s,
    y: (nodeRect.top - stageRect.top) / s,
    w: nodeRect.width / s,
    h: nodeRect.height / s,
  };
}

/**
 * The pose that puts `rect` in the middle of a `viewport`-sized frame.
 *
 * Fit, never crop: whichever axis is tighter sets the scale, so a shot always
 * contains its whole subject. The old code's tight rectangles sliced headers in
 * half; that is a framing decision, and framing decisions belong here rather
 * than in each shot's numbers.
 */
export function solvePose(
  rect: Rect,
  viewport: { width: number; height: number },
  shot: Pick<CameraShot, 'padding' | 'maxScale' | 'minScale' | 'zoom' | 'focusX' | 'focusY'> = {}
): CameraPose {
  const padding = shot.padding ?? DEFAULT_PADDING;
  const available = {
    width: Math.max(1, viewport.width - padding * 2),
    height: Math.max(1, viewport.height - padding * 2),
  };
  const fit = Math.min(available.width / rect.w, available.height / rect.h);
  const zoom = Math.max(0.1, shot.zoom ?? 1);
  const scale = Math.min(
    shot.maxScale ?? DEFAULT_MAX_SCALE,
    Math.max(shot.minScale ?? 0, fit * zoom)
  );
  const centreX = rect.x + rect.w / 2;
  const centreY = rect.y + rect.h / 2;
  const focusX = Math.min(1, Math.max(0, shot.focusX ?? 0.5));
  const focusY = Math.min(1, Math.max(0, shot.focusY ?? 0.5));
  return {
    scale,
    x: viewport.width * focusX - centreX * scale,
    y: viewport.height * focusY - centreY * scale,
  };
}

/**
 * The camera's physical state.
 *
 * Position AND velocity, which is the reason this is a spring rather than a
 * tween: velocity is what survives a change of target. Re-aiming mid-move
 * curves the path instead of restarting it.
 */
export type CameraMotion = {
  scale: number;
  centreX: number;
  centreY: number;
  velocity: { scale: number; centreX: number; centreY: number };
};

export function createCameraMotion(): CameraMotion {
  return {
    scale: 0,
    centreX: 0,
    centreY: 0,
    velocity: { scale: 0, centreX: 0, centreY: 0 },
  };
}

/**
 * Camera stiffness.
 *
 * Slightly OVER-damped (ratio ~1.06), on purpose and by correction: at 0.96 the
 * settle was a visible little bounce at the end of every move, which is fine on
 * a button and wrong on a camera — real camera moves ease out, they do not
 * spring back. Keep the ratio at or just above 1. The softness that makes a
 * move read as a move comes from the low stiffness, not from overshoot.
 */
const STIFFNESS = 40;
const DAMPING = 13.4;
/** Below this, the camera is considered parked and the integrator idles. */
const REST_EPSILON = 0.0004;

function integrateAxis(
  position: number,
  velocity: number,
  target: number,
  dt: number
): [number, number] {
  const acceleration = (target - position) * STIFFNESS - velocity * DAMPING;
  const nextVelocity = velocity + acceleration * dt;
  return [position + nextVelocity * dt, nextVelocity];
}

/**
 * Advance the camera one frame toward `target`.
 *
 * Scale is integrated in LOG space. Linear scale makes the same spring feel
 * violent zooming in and sluggish zooming out, because equal steps of scale are
 * not equal steps of apparent magnification; in log space a 2x push and a 2x
 * pull are the same distance and read as the same move.
 *
 * `dt` is clamped: a backgrounded tab returns with a delta of seconds, and an
 * unclamped integrator answers that by hurling the camera across the stage.
 */
export function stepCamera(
  motion: CameraMotion,
  target: { scale: number; centreX: number; centreY: number },
  dtSeconds: number
): CameraMotion {
  // First frame: adopt the target outright. Springing in from an arbitrary
  // origin would open the tour with a swoop nobody asked for.
  if (motion.scale <= 0) {
    return {
      scale: target.scale,
      centreX: target.centreX,
      centreY: target.centreY,
      velocity: { scale: 0, centreX: 0, centreY: 0 },
    };
  }
  const dt = Math.min(0.05, Math.max(0, dtSeconds));
  if (dt === 0) return motion;

  const [logScale, logScaleVelocity] = integrateAxis(
    Math.log(motion.scale),
    motion.velocity.scale,
    Math.log(Math.max(0.0001, target.scale)),
    dt
  );
  const [centreX, centreXVelocity] = integrateAxis(
    motion.centreX,
    motion.velocity.centreX,
    target.centreX,
    dt
  );
  const [centreY, centreYVelocity] = integrateAxis(
    motion.centreY,
    motion.velocity.centreY,
    target.centreY,
    dt
  );

  return {
    scale: Math.exp(logScale),
    centreX,
    centreY,
    velocity: {
      scale: logScaleVelocity,
      centreX: centreXVelocity,
      centreY: centreYVelocity,
    },
  };
}

/** True once the camera has effectively stopped, so callers can stop their rAF. */
export function cameraAtRest(
  motion: CameraMotion,
  target: Pick<CameraMotion, 'scale' | 'centreX' | 'centreY'>
): boolean {
  return (
    Math.abs(Math.log(motion.scale) - Math.log(target.scale)) < REST_EPSILON &&
    Math.abs(motion.centreX - target.centreX) < 0.05 &&
    Math.abs(motion.centreY - target.centreY) < 0.05 &&
    Math.abs(motion.velocity.scale) < REST_EPSILON &&
    Math.abs(motion.velocity.centreX) < 0.5 &&
    Math.abs(motion.velocity.centreY) < 0.5
  );
}

/** The pose the stage should render, given the camera's current state. */
export function poseFromMotion(
  motion: CameraMotion,
  viewport: { width: number; height: number }
): CameraPose {
  return {
    scale: motion.scale,
    x: viewport.width / 2 - motion.centreX * motion.scale,
    y: viewport.height / 2 - motion.centreY * motion.scale,
  };
}

/** Where a solved pose puts the subject's centre, in stage coordinates. */
export function centreFromPose(
  pose: CameraPose,
  viewport: { width: number; height: number }
): { scale: number; centreX: number; centreY: number } {
  return {
    scale: pose.scale,
    centreX: (viewport.width / 2 - pose.x) / pose.scale,
    centreY: (viewport.height / 2 - pose.y) / pose.scale,
  };
}
