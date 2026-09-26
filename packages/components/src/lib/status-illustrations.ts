// The two drawings a status page opens with, as plain SVG strings so that the
// pre-React boot screen (`boot-failure.ts`) and the React `StatusPage` draw the
// same thing from one source. No React, no StyleX, no icon package here: the
// boot screen shows these when none of those loaded.
//
// Both are a Lody window — a surface, three dots, a sidebar, content — so they
// say "this app" rather than "an error", and each moves once to say what
// happened: a piece of the content slips out of its slot and lands below the
// window (something broke), or a lens sweeps an empty content area (something
// is not here). Then they are still. A page that keeps moving is a page that
// keeps asking for attention, which is the opposite of what it is for.
//
// Colours are custom properties set by whoever draws them:
//   --si-surface   the window          --si-edge     its hairline
//   --si-shadow    shadows on the ground under what rests there
//   --si-region    the sidebar
//   --si-line      content bars        --si-dot      dots, dashed outlines
//   --si-accent    the one moving part --si-on-accent a mark on it
//   --si-ink       the lens handle

export type StatusIllustration = 'broken' | 'missing';

export const STATUS_ILLUSTRATION_CLASS = 'lody-status-art';

const WINDOW =
  '<ellipse cx="100" cy="112" rx="66" ry="4" fill="var(--si-shadow)"/>' +
  '<rect x="30.5" y="12.5" width="139" height="95" rx="13" fill="var(--si-surface)" stroke="var(--si-edge)"/>' +
  '<circle cx="45" cy="25" r="3" fill="var(--si-dot)"/>' +
  '<circle cx="55" cy="25" r="3" fill="var(--si-dot)"/>' +
  '<circle cx="65" cy="25" r="3" fill="var(--si-dot)"/>' +
  '<rect x="40" y="36" width="28" height="62" rx="6" fill="var(--si-region)"/>' +
  '<rect x="45" y="43" width="18" height="4" rx="2" fill="var(--si-line)"/>' +
  '<rect x="45" y="52" width="14" height="4" rx="2" fill="var(--si-line)"/>' +
  '<rect x="45" y="61" width="16" height="4" rx="2" fill="var(--si-line)"/>';

const SVG_OPEN =
  `<svg class="${STATUS_ILLUSTRATION_CLASS}" xmlns="http://www.w3.org/2000/svg" ` +
  'viewBox="0 0 200 140" fill="none" aria-hidden="true" focusable="false">';

const BROKEN =
  SVG_OPEN +
  WINDOW +
  '<rect x="76" y="38" width="82" height="8" rx="4" fill="var(--si-line)"/>' +
  '<rect x="76" y="52" width="60" height="8" rx="4" fill="var(--si-line)"/>' +
  // The slot the piece left: the outline of what should be there.
  '<rect x="76.5" y="66.5" width="73" height="17" rx="5" stroke="var(--si-dot)" stroke-dasharray="3 3"/>' +
  '<rect x="76" y="90" width="46" height="8" rx="4" fill="var(--si-line)"/>' +
  '<ellipse class="si-landing" cx="142" cy="135" rx="36" ry="3.5" fill="var(--si-shadow)"/>' +
  // The bump where its low corner hit the ground; it appears as the piece lands.
  '<g class="si-bump" stroke="var(--si-accent)" stroke-width="2" stroke-linecap="round">' +
  '<path d="M99 129 L92 126.5"/><path d="M101 123.5 L96 118"/><path d="M106 121 L105.5 115"/>' +
  '</g>' +
  // Drawn at rest, tipped onto one corner; the animation starts it in the slot
  // (113, 75) and drops it here.
  '<g transform="translate(142 121)"><g class="si-fall">' +
  '<rect x="-37" y="-9" width="74" height="18" rx="5" fill="var(--si-accent)"/>' +
  '<rect x="-29" y="-2" width="30" height="4" rx="2" fill="var(--si-on-accent)" opacity="0.7"/>' +
  '</g></g>' +
  '</svg>';

const MISSING =
  SVG_OPEN +
  WINDOW +
  '<rect x="76.5" y="38.5" width="81" height="59" rx="6" stroke="var(--si-dot)" stroke-dasharray="3 3"/>' +
  '<ellipse class="si-landing" cx="160" cy="133" rx="22" ry="3" fill="var(--si-shadow)"/>' +
  '<g transform="translate(150 100)"><g class="si-seek">' +
  '<line x1="12" y1="12" x2="24" y2="24" stroke="var(--si-ink)" stroke-width="6" stroke-linecap="round"/>' +
  '<circle r="16" fill="var(--si-surface)" stroke="var(--si-accent)" stroke-width="4"/>' +
  '<path d="M-8 -3 A9 9 0 0 1 -3 -8" stroke="var(--si-accent)" stroke-width="2.5" stroke-linecap="round" opacity="0.55"/>' +
  '</g></g>' +
  '</svg>';

export const STATUS_ILLUSTRATIONS: Record<StatusIllustration, string> = {
  broken: BROKEN,
  missing: MISSING,
};

const EASE = 'cubic-bezier(0.2, 0, 0, 1)';
const A = `.${STATUS_ILLUSTRATION_CLASS}`;

/**
 * The motion, once. The piece holds in its slot for a beat, tips, falls with
 * gravity's ease-in, and settles with one small bounce; its shadow gathers as it
 * lands. The lens crosses the empty content and comes to rest on the corner.
 */
export const STATUS_ILLUSTRATION_CSS = `
${A} { display: block; width: 200px; max-width: 100%; height: auto; overflow: visible; }
${A} .si-fall, ${A} .si-seek, ${A} .si-landing, ${A} .si-bump { transform-box: fill-box; transform-origin: center; }
${A} .si-fall { transform: rotate(-6deg); animation: lody-si-fall 1200ms linear 250ms both; }
${A} .si-bump { animation: lody-si-bump 1200ms ${EASE} 250ms both; }
${A} .si-seek { animation: lody-si-seek 1500ms ${EASE} 250ms both; }
${A} .si-landing { animation: lody-si-land 1200ms linear 250ms both; }
@keyframes lody-si-fall {
  0% { transform: translate(-29px, -46px) rotate(0deg); animation-timing-function: ${EASE}; }
  22% { transform: translate(-29px, -46px) rotate(0deg); animation-timing-function: ${EASE}; }
  34% { transform: translate(-25px, -47px) rotate(8deg); animation-timing-function: cubic-bezier(0.5, 0, 1, 1); }
  74% { transform: translate(0, 0) rotate(-10deg); animation-timing-function: ${EASE}; }
  86% { transform: translate(0, -2px) rotate(-4deg); animation-timing-function: cubic-bezier(0.5, 0, 1, 1); }
  100% { transform: translate(0, 0) rotate(-6deg); }
}
@keyframes lody-si-bump {
  0%, 70% { opacity: 0; transform: scale(0.4); }
  82% { opacity: 1; transform: scale(1.1); }
  100% { opacity: 0.7; transform: scale(1); }
}
@keyframes lody-si-land {
  0%, 60% { opacity: 0; transform: scaleX(0.5); }
  74% { opacity: 1; transform: scaleX(1.04); }
  100% { opacity: 1; transform: scaleX(1); }
}
@keyframes lody-si-seek {
  0% { transform: translate(-58px, -52px) rotate(-10deg); opacity: 0; }
  12% { opacity: 1; }
  55% { transform: translate(-24px, -40px) rotate(6deg); }
  100% { transform: translate(0, 0) rotate(0deg); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  ${A} .si-fall, ${A} .si-seek, ${A} .si-landing, ${A} .si-bump { animation: none; }
  ${A} .si-bump { opacity: 0.7; }
}
`;
