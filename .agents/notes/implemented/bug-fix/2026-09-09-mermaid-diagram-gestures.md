# Give the page back the wheel over a Mermaid diagram

Status: implemented
Translation: pending

## Abstract

Streamdown wraps every rendered Mermaid diagram in a pan/zoom canvas whose
non-passive `wheel` listener calls `preventDefault()`, so scrolling a conversation
stopped dead and zoomed the diagram whenever the pointer happened to rest over
one; `controls.mermaid.panZoom: false` hides that canvas's buttons but not its
listener. A diagram in a message is now a still preview: `markdown-renderer.tsx`
takes the wheel in the capture phase and re-dispatches an uncancelable copy so the
conversation's own wheel listeners still see the gesture, and `!important`
overrides return `touch-action` and the cursor to the page. Canvas behaviour moved
to the full-screen viewer, where a trackpad pinch (ctrl-modified wheel) zooms
around the pointer and a held mouse button drags. Touch panning stays with the
browser's scrolling, which is why two-finger pinch on a touch screen is
deliberately absent rather than partly implemented.

## Decision

Two surfaces, one rule each. A diagram in a message opens the viewer and does
nothing else; the viewer is the only canvas.

Streamdown's canvas is neutralized from outside rather than removed, because the
package offers no way to turn it off:

- `wheel` is intercepted on the markdown root in the capture phase, above the
  canvas element that carries the listener. The interceptor never calls
  `preventDefault()` — the browser's own scrolling is the behaviour being restored.
- `stopPropagation()` alone would also hide the gesture from the conversation's
  wheel listeners further up: releasing stick-to-bottom (`use-sticky-scroll.ts`)
  and abandoning an outline jump (`view.tsx`) both listen on the scroll viewport.
  An uncancelable `WheelEvent` copy is therefore re-dispatched from the markdown
  root, whose propagation path excludes the canvas.
- `touch-action: none`, the pan transform, and the `grab` cursor are inline styles
  on the canvas, so `MARKDOWN_BASE_CLASSNAME` overrides all three with
  `!important`. Pinning the transform makes the canvas's remaining pointer drag
  visually inert without intercepting `pointerdown`, which would have hidden that
  event from outside-dismiss and selection handlers above the markdown.

In the viewer, a ctrl- or meta-modified wheel is taken (Chromium spends it on
zooming the window otherwise) and zooms around the pointer. The anchored point is
restored by scrolling the surface, measured from the diagram's box rather than
from scroll offsets, because the surface centres a diagram that fits and that
offset is not proportional to the zoom. A held mouse or pen button pans; a release
that moved the diagram does not count as the click off the diagram that closes.

Two-finger touch pinch is not implemented. Custom pinch requires taking
`touch-action` from the browser, which means reimplementing inertial panning for
the phone case this viewer exists to serve. Touch zooms with the control bar
instead. Invariants: `packages/components/src/components/ai-gui/mermaid-diagram-rendering.md`.

## Alternatives

- **Patch `streamdown`.** Honouring `panZoom: false` in the package would be the
  semantically correct fix, and the repository already carries eleven patches. Its
  only build artifact is a single-line minified `dist` chunk, so a unified diff
  would restate the whole bundle and could not be reviewed.
- **Replace the mermaid block with a custom `plugins.renderers` entry.** Full
  control, but it also takes over lazy rendering, the streaming and error paths,
  and the diagram copy/download menu, none of which are exported.
- **`pointer-events: none` on the canvas.** Does not help: pointer events only
  affect hit-testing, while the propagation path of an event targeted at a
  descendant still runs through the canvas.

## Evidence and limits

`tests/markdown-mermaid-fullscreen.test.tsx` renders the real Streamdown block in
jsdom. The new wheel case asserts `defaultPrevented === false` and that a listener
above the message still receives one event of the same `deltaY`; with the
interceptor removed from `markdown-renderer.tsx`, that case fails on
`defaultPrevented`, so it guards the reported defect rather than restating the
implementation. The viewer cases assert that a plain wheel is left alone while a
ctrl-modified one is taken and moves the zoom readout from 100% to 122%, that a
drag moves `scrollLeft`/`scrollTop`, and that the release does not close the
viewer. `computePinchZoomFactor` and `computeAnchoredScrollCorrection` are pure
and unit-tested for reversibility, notch bounding, and the anchored point.

All 16 tests in that file pass, as do the 105 in `tests/markdown*`, and
`packages/components` typechecks. The three CSS overrides compile to `!important`
declarations, checked by running the Tailwind CLI over `src/tailwind/index.css`.

Chromium drove the real `MermaidStyleReview` story through Playwright against a
local Storybook, with the story given a scroll container because the Storybook
preview clips its own overflow. With the fix, a 300px wheel over the diagram moved
that container by 300px — the same as the control wheel over prose beside it — and
the diagram reported `touch-action: auto`, no transform, and a `zoom-in` cursor. A
drag across the preview left its transform at `none` and its release opened the
viewer. In the viewer, a ctrl-modified wheel moved the zoom readout from 121% to
148% without zooming the window, a plain wheel panned the surface from 69 to 177
and left the zoom alone, and a 150 x 120 drag panned to the horizontal limit and by
exactly 120px vertically while leaving the viewer open, which Escape then closed.

Reverting only `markdown-renderer.tsx` in the same session reproduced the report:
the wheel over the diagram left the container at 0 while the control still scrolled
300, `touch-action` was `none`, and the drag left the preview at
`matrix(0.9, 0, 0, 0.9, 100, 60)` — displaced, and still holding a zoom from the
swallowed wheel.

The first CI run failed without a failing test: shifting test timing exposed a
latent teardown race in an unrelated suite, recorded in
[a React commit outside act](../testing/2026-09-09-react-commit-teardown-leak.md)
and fixed in the same pull request.

A later decision partly supersedes this one: a diagram in a message can now be
activated into a canvas by clicking it, and full-screen moved to the block's
action bar. The wheel rule below is unchanged — see
[click to turn a Mermaid diagram into a canvas](../feature/2026-09-10-mermaid-click-to-activate.md).

Limits: touch was not exercised; the `touch-action` fix is a computed-style
observation, not a finger on a phone, and two-finger pinch is absent by design.
The full `pnpm check` was not run — this worktree needs its submodules initialized
to install at all, and the suite reaches far past the changed files. Two full
`packages/components` runs each failed one unrelated test, and a different one each
time (`markdown-streaming-reparse`, then `avatar-cache`); both pass in isolation,
so they are load flakes rather than regressions. `NODE_ENV=production` in the
environment resolves React to its production build, where `act` is missing; the
suite was run with `NODE_ENV=test`.
