# Move spin animations off SVG so they composite on Retina

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/672

[中文](2026-09-13-spinner-off-svg-retina-composite.zh.md)

## Abstract

The packaged desktop renderer idled at 40–50% CPU while two sessions were running,
because every `animate-spin` icon rotated the Lucide `<svg>` itself, and Chromium
refuses to composite a transform animation whose target is an SVG element with an
effective zoom other than 1, which on a Retina display is every SVG. The spin
therefore re-ran style, pre-paint and layerize on the main thread once per vsync
for as long as any session stayed busy. All spinners now render through one
`Spinner` primitive that animates an HTML wrapper around the glyph, and the agent
readiness orbit moves from an SVG `<g>` to a span; a controlled trace in the same
Electron build shows the animation composited and the per-frame main-thread work
gone. The pattern carries one constraint: the wrapper's box must be the glyph's
box, or the rotation turns into an orbit.

## Problem and evidence

Measured on 2026-09-13 in the packaged app, Electron 39.5 / Chromium 142, on a
2× display with two sessions working and nothing visibly changing:

- Main window renderer at 40–50% CPU, GPU helper at 5%. JS was 1% of the CPU
  profile; the rest was Blink's `UpdateLayoutTree`, `PrePaint`, `Layerize` and
  `Commit`, once per vsync (719 main-thread frames in 6 s at 120 Hz).
- Pausing the two sidebar working spinners through `document.getAnimations()`
  dropped main-thread busy time to 3.5%. Two `<div class="animate-spin">` in the
  same slots cost close to nothing.
- A `blink.animations` trace reported `compositeFailed=1088` on those animations;
  bit 10 is `kTransformRelatedPropertyCannotBeAcceleratedOnTarget`.

## Root cause

`CompositorAnimations::CheckCanStartTransformAnimationOnCompositorForSVG` rejects
a transform animation on an SVG element whose `EffectiveZoom()` is not 1
(crbug.com/1186312). Blink folds the device scale factor into layout zoom, so at
DPR 2 every `<svg>` has an effective zoom of 2 and the animation falls back to the
main thread. HTML elements have no such restriction. The check covers inner SVG
elements as well, which is why the `<g class="agent-readiness-orbit">` arc had the
same fate. Tailwind's `animate-spin` is a plain `rotate(360deg)` keyframe, so the
only variable is which element carries it.

### Whose defect is it

Upstream, but only partly. The rejection is a deliberate capability gate, not a
miscomputation: the compositor cannot reproduce Blink's zoom-aware transform
resolution for SVG, so rather than risk drawing the wrong thing it declines and
returns the animation to the main thread. Rendering stays visually correct and
only the cost is wrong, which is why this is a missing optimization with a
correctness-preserving fallback rather than a rendering defect. Tracked as
[crbug.com/1186312](https://issues.chromium.org/issues/40172437); its current
triage status was not verified, because the tracker requires sign-in.

The icon library is not implicated. `lucide-react` calls
`createElement("svg", ...)` and merges the caller's `className` onto that root,
which is ordinary behaviour for an icon component, and the controlled trace below
reproduces the failure on a hand-written `<svg>` with no `lucide-react` in the
page at all. The element type is the whole discriminator.

Our usage was equally ordinary — an `animate-spin` class on an icon is what most
Tailwind applications write — so what made it expensive was the operating
conditions, not the pattern: a device pixel ratio of 2, which is required to
trigger it at all; a 120 Hz panel, doubling the per-second cost; spinners that
stay mounted for the hours a session can run rather than a few hundred
milliseconds; one per running session; and Electron, where renderer CPU is felt
as battery drain. The same markup is free on a 60 Hz non-Retina display, which is
why a code review would never have caught it and a CPU profile did.

Keep the wrapper even if the browser is fixed. The desktop ships on whichever
Chromium version Electron pins, so an upstream fix would take a long time to
reach users, and the wrapper costs nothing.

## Decision

- `packages/components/src/ui/spinner.tsx` is the one place `animate-spin` is
  applied. It renders `<span class="inline-flex shrink-0 … animate-spin
will-change-transform">` around the icon, which fills the span with
  `size-full`. Sizing, margin and colour classes go on the wrapper so its box is
  the glyph's box; `icon` and `spinning` let a refresh glyph reuse one element
  and rotate only while a request is in flight.
- Every direct `<Loader2 className="… animate-spin">` in `packages/components`
  (247 sites) was rewritten by a codemod; about twenty conditional or
  dynamic-icon sites, the `Loading` primitive, the emoji picker loader, the
  syncing indicator and the two local-project status panels were converted by
  hand. No `animate-spin` remains on an `<svg>` in the package.
- `AgentReadinessMark` keeps the static track and the determinate fill in one
  `<svg>`; the indeterminate arc gets its own `<svg>` inside an absolutely
  positioned `<span class="agent-readiness-orbit">`.
- The other infinite animations in `tailwind/index.css`
  (`agent-activity-dot-pulse`, `animate-badge-pulse`, `animate-progress-sweep`)
  already target HTML elements and are unchanged. The `svg.animate-spin` base
  rule stays as a safety net for strays.
- The rule now lives in `packages/components/src/ui/AGENTS.md`.

## Alternatives

- Wrap only the sidebar spinner. Fixes the measured case but leaves every other
  long-lived spinner (syncing indicator, stuck-connection banner, mobile status
  pill, activity states) on the same path, and nothing stops the next
  `<Loader2 className="animate-spin">`. A single primitive makes the rule
  enforceable.
- A pure CSS ring spinner. Composites too, but changes the glyph everywhere and
  cannot host the refresh/rotate icons that spin conditionally.
- Pausing under `prefers-reduced-motion`. Not a fix; only hides the cost for
  users who opt out of motion.

## Follow-up: the primitive's default is a forwarding hazard

Review of the migration found that `Spinner` defaulting `spinning` to `true` is
safe at a call site but not through a wrapper. `undefined` is indistinguishable
from an omitted prop, so a status panel that forwarded its OWN optional
`spinning` / `spin` prop reached the default in every state: the desktop and
mobile "No machines available" panels and the mobile file browser's "Files
unavailable", empty-folder and preview-unavailable panels rotated their icons
forever. The three panel helpers now default the prop to `false`.

The primitive keeps `true`, because a bare `<Spinner />` means "loading" at
almost every one of its call sites and flipping the default would silence them
instead. The constraint that a forwarding wrapper supplies its own default is
recorded in `src/ui/AGENTS.md` and on the prop itself. The other nine forwards
pass comparisons or required booleans and were verified unaffected.

## Verification

- Controlled trace in this workspace's Electron 39.5.1 / Chromium 142.0.7444.265,
  primary display scale factor 2, `webContents.debugger` `Tracing.start` with
  `blink.animations` and `devtools.timeline`, 2 s window, two 12 px spinners:

  | Markup                          | compositeFailed | UpdateLayoutTree | PrePaint | Layerize | Commit |
  | ------------------------------- | --------------- | ---------------- | -------- | -------- | ------ |
  | `svg.animate-spin` (before)     | 1024            | 244              | 248      | 243      | 244    |
  | `span.animate-spin > svg` (now) | none            | 7                | 6        | 5        | 7      |
  | no spinner                      | none            | 3                | 5        | 5        | 6      |

  Playwright's headless Chromium 145.0.7632.6 with an emulated DPR of 2
  composited both variants, so the check may differ by version or under
  emulation; the decision rests on the Electron measurement, which matches the
  shipped runtime.

- `tests/spinner-rotates-in-place.test.tsx` also renders the desktop and mobile
  machine pickers and the provider-less mobile file browser, asserting no
  animation in the resting states and exactly one in the loading state, so a
  fix that simply never spins fails too. It asserts for the sidebar working row,
  the syncing indicator, the mobile status pill and the `Spinner` primitive that
  the single animated element is an HTML span, explicitly square, `shrink-0`,
  icon-only, and that the glyph does not also spin. The PR tab refresh and
  sidebar PR badge tests were adapted to the wrapper.
- `pnpm check` and `pnpm format` were run on macOS; the packaged app was not
  re-profiled with live sessions. The trace above uses the same markup and CSS
  as the component in the same Chromium.
