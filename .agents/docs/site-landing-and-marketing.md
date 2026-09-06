# site-docs landing and marketing internals

Background for the public site's landing and marketing surfaces: the numbers,
histories, and current-shape records that would otherwise crowd out the rules.
The rules themselves stay in [`site-docs/AGENTS.md`](../../site-docs/AGENTS.md)
and [`site-docs/components/AGENTS.md`](../../site-docs/components/AGENTS.md);
file-by-file ownership is in [`site-docs/README.md`](../../site-docs/README.md).
Demo sequencing and screenshot notes stay in `site-docs/context/landing-demos.md`.

## Marketing shell palette

`marketing-shell` is a deep-ocean field matching the homepage dark treatment:
ice ink, restrained aqua, seamless nav. Surfaces share one atmosphere hue
(~208 navy-teal) through the `--mkt-panel-*` frosted panels. Light mode is
shallow water (the landing's pale blue) with dark ink; dark mode is abyss with
ice ink.

## Ambient field cost and pacing

`components/marketing-atmosphere.tsx` samples at up to 15Hz into two
full-drawing-buffer textures, uses GPU-query backpressure, and blends cached
endpoints on display frames. Software GPUs start at 8Hz sampling and 30fps
presentation, and GPU timing may slow sampling further.

It is an expensive pass — roughly 445 `sin()` calls per pixel, of which the four
`warped()` calls are about 77%. The two gradient taps feeding `ridge` look
redundant, but they carry the filigree, which is why the rule forbids folding
them into a cheaper finite difference.

## Why pricing carries no clock

The public Plus early-bird end date is one line of static copy. An earlier
`Date.now()` gate caused a visible `$8`→`$5` flash on paint, because the server
render and the hydrated render disagreed. The yearly note already says the price
locks forever, so the date is deliberately not repeated in the note or an FAQ.

## Why the underwater background starts in three stages

Loading three.js through a module-eval `import()` plus `lazy` keeps it out of the
landing's critical chunk, with the CSS gradient on `.underwater-bg` standing in
until mount. The seabed attributes are computed in a worker from pure math shared
via `underwater-terrain-math.ts`, using one regular height grid for normals
instead of four extra noise samples per point, and fade in through the terrain
`uReveal` uniform while gradient, particles, and jellyfish render immediately.
Waiting on `renderer.compileAsync` keeps shader compilation off the main thread
for the first render.

`landing-app-preview.tsx` deliberately does not use the same module-eval
`import()`: it is the heaviest module on the landing (real product UI plus
composer, markdown, and katex), so a plain `lazy()` keeps first-paint bandwidth
for the hero and the WebGL scene.

## Current shape of the replicated session shell

The landing replica tracks `packages/components/src/components/sessions` 1:1.
That directory is the authority; the snapshot below records what it looked like
when this page was written, to save a reading, and defers to the source whenever
the two disagree. Fix it in the same PR that makes it wrong.

- ONE merged top row (`SessionTabBar` `mt-0.5 h-11` plus a right-slot toolbar);
  no repo-title header row and no header PR badge.
- The real `SessionInfoBar` glued above the composer: repo, branch, PR, ±diff,
  actions, and the emerald Browser chip.
- ONE floating right-panel card (`mx-2 mt-2 mb-2 rounded-xl
  border-sidebar-border/80 bg-sidebar`) whose `SessionSidePanelTabBar` carries
  Files / All Changes / conditional PR + Browser plus closeable diff tabs. File
  and diff viewers live in that panel, never in a second pane.
- A composer with no bottom bar: machine → project → branch/worktree pill in the
  top row, `DesktopRunConfigMenu` + `DesktopPermissionModeButton` in the footer.
  Mobile keeps the single `MobileSessionRunConfig`.

The mobile branch of `session-detail.tsx` is a floating frosted `BaseHeader` over
the conversation, glass chrome, no `SessionTabBar`, no header PR badge, and the
bottom `SessionInfoBar` with `branch={null}`. The new-chat sheet's slot stack is
described in `site-docs/context/landing-demos.md`.

## Why the hand-written component declarations matter

There is no tsconfig path from `site-docs` to `packages/components/src`, so
`types/lody-app-components.d.ts` is TypeScript's only view of every `@/*` import.
A stale declaration silently hides a real API break: `DesktopSessionDetailLayout`
once rendered with none of its props, and the whole top bar plus right panel
vanished from the landing while `pnpm typecheck` stayed green.
