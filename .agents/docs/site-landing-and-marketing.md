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

Loading three.js through `lazy(() => import())` keeps it out of the landing's
critical chunk, with the CSS gradient on `.underwater-bg` standing in until
mount. The import starts only when the experience mounts (not at module
evaluation), then waits for `load` plus idle so docs routes do not download the
3D chunk and the hero title can paint. The preview chunk and rotating H1 words
use the same gate — a one-viewport `rootMargin` used to start the preview
download during LCP because the stage sits just below a 100dvh hero.
The seabed attributes are computed in a worker from pure math shared
via `underwater-terrain-math.ts`, using one regular height grid for normals
instead of four extra noise samples per point, and fade in through the terrain
`uReveal` uniform while gradient, particles, and jellyfish render immediately.
Waiting on `renderer.compileAsync` keeps shader compilation off the main thread
for the first render.

`landing-app-preview.tsx` deliberately does not use the same module-eval
`import()`: the stage is below a 100dvh hero, so a plain `lazy()` behind the
`previewArmed` latch keeps first-paint bandwidth for the hero and the WebGL
scene. Since the stage became a site-owned replica it no longer pulls in the app's
CRDT runtime, markdown renderer, or analytics module (measurements in the
[standalone replica note](../notes/implemented/architecture/2026-09-24-landing-standalone-product-replica.md)).

## Recorded shape of the product replica

`components/landing-replica/` copies the app's markup as it looked when the
replica was written (2026-09-24). It does not follow the app: when the app's
look changes enough that the landing misrepresents it, copy the new markup and
classes into the replica and compare screenshots. The record below is the shape
the replica reproduces, so a later change can tell drift from intent.

- ONE merged desktop top row (session tabs `h-11` plus a right-slot toolbar);
  no repo-title header row and no header PR badge.
- The info bar glued above the composer: repo, branch, PR, ±diff, actions, and
  the emerald Browser chip that appears once a dev server reports a preview.
- ONE right panel (Files / All Changes / conditional PR + Browser, plus a
  closeable diff tab) that starts closed; file and diff viewers live in it,
  never in a second pane. The diff itself is `@pierre/diffs` used directly.
- A composer with no bottom bar: machine → project → branch/worktree pill in the
  top row on the chat landing, run config + permission chips in the footer.
  Mobile keeps one run-config chip and a round send button.
- The mobile session is a floating frosted header over the conversation, glass
  chrome, no session tab bar, and the bottom info bar without the branch. The
  new-chat sheet stacks title, Machine, Type, composer, then agent + permission.

## Why the landing stopped rendering app components

The stage used to import the real app components through an `@/*` alias, with
Vite aliases swapping app-only modules for shims and a hand-written declaration
file as TypeScript's only view of them. App changes kept breaking it: a stale
declaration once hid a `DesktopSessionDetailLayout` API change (the top bar and
right panel vanished with typecheck green), and a composer hook that needed an
authenticated Convex provider blanked the whole stage (#937). The replica
removed the alias, shims, declarations, and dependencies; `scripts/app-boundary.mjs`
keeps them out. See the
[standalone replica note](../notes/implemented/architecture/2026-09-24-landing-standalone-product-replica.md).

## Why the static check mounts the app preview

The app preview renders inside an `OptionalEnhancement` boundary, so a crash
blanks the product stage while the hero, copy, and every other check stay green.
`test:static` therefore waits for the stage composer on `/` and `/zh`. It was
added when an app composer hook crashed the stage (see the
[bug-fix note](../notes/implemented/bug-fix/2026-09-24-landing-app-preview-mention-expansion.md));
it still guards replica regressions.
