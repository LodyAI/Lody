# Mermaid diagram rendering

Streamdown renders the diagram; `markdown-renderer.tsx` decides what a diagram in
a message may do, and `mermaid-diagram-viewer.tsx` owns the full-screen surface.
Binding rules live in [AGENTS.md](AGENTS.md); this file holds the invariants and
why they read the way they do. Coverage:
`tests/markdown-mermaid-fullscreen.test.tsx`.

## A diagram in a message is a still preview until it is clicked

- It NEVER captures an unmodified wheel, activated or not. Streamdown wraps every
  diagram in a pan/zoom canvas that listens for `wheel` non-passively and calls
  `preventDefault()` on each one, so a page scroll passing under a diagram became
  a zoom. `controls.mermaid.panZoom: false` only hides that canvas's buttons — the
  listener stays — so `use-mermaid-diagram-canvas.tsx` takes the gesture in the
  capture phase above the canvas and hands it back to the page.
- The interceptor must not call `preventDefault()` except for a pinch on the
  activated diagram; the browser's own scrolling is the behaviour being restored.
  It re-dispatches an uncancelable copy from the markdown root, because
  `stopPropagation()` alone would also hide the gesture from the conversation's
  wheel listeners further up — releasing stick-to-bottom (`use-sticky-scroll.ts`)
  and abandoning an outline jump (`view.tsx`).
- Clicking a diagram with a mouse, pen, or the keyboard ACTIVATES it: that one
  diagram becomes a canvas, where a trackpad pinch (a ctrl- or meta-modified
  wheel) zooms around the pointer and a held button drags. Escape, a press
  anywhere else, or the full-screen viewer releases it, and releasing resets the
  transform — the copy in the conversation is a preview, not a saved view.
- Touch never activates: inline pinch would mean taking `touch-action` from the
  browser and reimplementing inertial panning for the phone case the viewer
  exists to serve. A tap opens the viewer, where the control bar's buttons zoom.
- The transform goes on the `<svg>`, which Streamdown injected as raw markup and
  never writes to. Its own canvas stays pinned at `transform: none` with
  `touch-action: auto`, so its remaining handlers cannot move anything and a
  finger resting on a diagram still scrolls the conversation.
- The activated ring is written inline with `important` because it cannot come
  from a stylesheet: activating focuses the diagram, and `tailwind/index.css`
  carries a global `*:focus, *:focus-visible { outline: none !important }`.
  Specificity does not beat `important`, so only an inline `important` of our own
  wins. The grab cursor, which is not focus-gated, does live in that stylesheet
  beside the resting `zoom-in`.
- Every key the canvas answers — Escape included — is read only while focus is
  inside the activated diagram. An activated diagram sitting further up the
  scrollback must not swallow the Escape that dismisses a dialog, nor pull the
  caret out of the composer. Leaving by keyboard releases the canvas, so
  "activated" and "focused" never drift apart.
- Streamdown owns the markup, so the click target, its `role`/`tabindex`, and the
  full-screen button's host are all found by a `MutationObserver` — a diagram
  appears only after the lazily imported runtime resolves, long after the
  component commits. The block's own copy/download controls stay reachable
  without hover, and the full-screen button joins them there.
- The observer marks a diagram ONCE. It re-runs on every mutation a streaming
  turn makes, and removing `tabindex` from a focused element blurs it in
  Chromium — which would drop an activated canvas out of the keyboard mid-turn —
  while rewriting `aria-label` re-announces it. Only a diagram that has
  disappeared is restored.

## The viewer is the only full-screen surface

- It replaces Streamdown's own full-screen overlay (`controls.mermaid.fullscreen`
  stays off), whose only exit sat at a raw `top-4 right-4` — inside a phone's
  status-bar inset — while its content layer covered the backdrop and swallowed
  every tap, leaving a touch user no way out. Its entry point is a button
  portalled into Streamdown's action bar, beside copy and download.
- Controls are at least 44px and padded by the `--safe-area-*` variables, never at
  a fixed viewport offset. There is always more than one exit: the close button, a
  click off the diagram, and Escape. Stacking comes from `--z-image-viewer`, so a
  diagram opened inside a dialog lands above that dialog.
- A diagram that does not fit opens at NATURAL size and is panned. Scaling an
  agent's sequence diagram down to a phone screen turns readable labels into a
  grey texture; only a diagram that already fits is scaled up.
- A trackpad pinch arrives as a ctrl-modified `wheel`, which Chromium would spend
  on zooming the whole window, so the viewer takes that default and zooms the
  diagram around the pointer instead. The anchored point is restored by scrolling
  the surface, measured from the diagram's own box: the surface centres a diagram
  that fits, and that offset is not proportional to the zoom.
- Plain wheel and touch panning stay with the surface's own scrolling. A pan
  driven from pointer deltas cannot reproduce touch momentum or rubber-banding, so
  only a held mouse or pen button pans by hand.
- Whether a click closes the viewer is decided by where the press STARTED, never
  by the click's target. Panning takes pointer capture on the surface, and pointer
  capture retargets the following `click` to the capturing element — so a plain
  click on the diagram arrives with the surface as its target and would otherwise
  dismiss the viewer the reader just opened.
- Two-finger pinch on a touch screen is deliberately absent, here and inline:
  implementing it means taking `touch-action` from the browser and reimplementing
  inertial panning. Touch zooms with the control bar's buttons instead.
