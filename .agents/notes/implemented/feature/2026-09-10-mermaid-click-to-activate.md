# Click to turn a Mermaid diagram into a canvas

Status: implemented
Translation: current

[中文](2026-09-10-mermaid-click-to-activate.zh.md)

## Abstract

Taking the wheel away from diagrams in a message
([earlier note](../bug-fix/2026-09-09-mermaid-diagram-gestures.md)) left zooming
reachable only through the full-screen viewer, which is heavy for a glance at one
node. A pointer click now activates the diagram in place: that one diagram
becomes a canvas where a trackpad pinch zooms around the pointer and a drag pans,
released by Escape, a press elsewhere, or the viewer. An unmodified wheel is still
never taken, activated or not, so a reader who forgets they activated a diagram
can always scroll past it — the trap the earlier note removed cannot return.
Full-screen moves to a button in the block's own action bar, and touch keeps
opening the viewer rather than gaining an inline pinch, because a custom touch
canvas would have to reimplement inertial panning for the phone case that viewer
exists to serve.

## Decision

Activation is a pointer affordance with an explicit release, the pattern embedded
maps use: the reader opts into the canvas, so capturing gestures inside it is
honest, and nothing is captured before they do.

- Only a ctrl- or meta-modified wheel on the ACTIVE diagram is consumed. Every
  other wheel keeps the previous behaviour — intercepted above Streamdown's
  canvas, never `preventDefault()`ed, and re-dispatched as an uncancelable copy so
  the conversation's own wheel listeners still see it.
- The transform is written to the `<svg>`, which Streamdown injected as raw markup
  and never touches. Streamdown's own pan/zoom canvas stays pinned at
  `transform: none`, so its still-live pointer handlers cannot move anything and
  cannot fight ours.
- Geometry works in viewport coordinates (`mermaid-inline-canvas.ts`): the frame
  rectangle and the diagram's current rectangle are enough to anchor a pinch and
  to clamp a pan, and the layout offset cancels out. Modelling Streamdown's
  layout instead was tried first and was wrong — it centres a narrow diagram in a
  frame the full width of the message, which no transform can reconstruct.
- Releasing resets the transform. The copy in the conversation is a preview, not a
  saved view, and a diagram left zoomed would read as a rendering bug.
- Touch does not activate. `pointerType` is recorded from the `pointerdown` that
  precedes the click, because `click` does not carry it in every engine.

Keyboard users get the same canvas: Enter toggles it, arrows pan, `+`/`-` zoom,
Escape releases. Without that, activation would be a pointer-only capability
behind a control that is focusable.

## Evidence and limits

`tests/markdown-mermaid-fullscreen.test.tsx` covers the pure geometry (anchored
pinch, re-centring, edge clamping, the zoom ceiling, pinch reversibility) and the
DOM behaviour: a mouse click activates and rings the diagram without opening the
viewer, a pinch scales it, an unmodified wheel over an ACTIVE diagram is still
handed to the page, a drag pans, Escape restores the preview, a press elsewhere
releases it, and a touch tap opens the viewer instead. 27 tests pass;
`packages/components` typechecks and lints clean.

Chromium drove the real `MermaidStyleReview` story through Playwright. Resting: no
ring, and a 300px wheel scrolled the container by 300. Activated: the ring
appeared (`outline: rgb(255, 199, 153) solid 2px`), the same wheel still scrolled
by 300, a ctrl-modified wheel scaled the diagram to 1.284 without zooming the
window, a 60px drag moved it by exactly 60, Escape cleared both transform and
ring, and the action-bar button opened the viewer at 121%.

Limits: after a pinch, Chromium keeps routing the rest of that wheel gesture
stream to the handler that consumed it, so an immediate follow-up scroll in the
same stream does not move the page; a real trackpad gesture ends when the fingers
lift, and the same probe scrolls normally before any pinch. Touch was not
exercised on a device. The activated ring had to be written inline with
`important` after a stylesheet rule — verified correct in isolation and present in
the served CSS — was still outranked by something already applying to Streamdown's
canvas in the Storybook page; the cause was not identified, and the inline write
sidesteps it. The resting cursor comes from that same unidentified rule rather
than from this change.

## Corrections

A review of this change found four defects and one stale comment; all are fixed
in the same pull request, and the cause left unidentified above is now named.

The ring's stylesheet rule was outranked by `tailwind/index.css`'s global
`*:focus, *:focus-visible { outline: none !important }` — activating focuses the
diagram, and specificity does not beat `important`. Inline `important` was
therefore necessary, not merely expedient. Moving the ring back to a stylesheet
was tried and reproduced the failure in Chromium (`outline: 0px none`) before the
rule was found. The resting `zoom-in` cursor was likewise not unexplained: it
comes from a pre-existing `.markdown-renderer [data-streamdown='mermaid'] > div`
rule in the same file, which now carries a `grab` companion for the activated
state.

The defects, each reproduced in Chromium before the fix and re-checked after:

- The viewer closed on a plain click on the diagram. Panning takes pointer
  capture on the scroll surface, and pointer capture retargets the following
  `click` to the capturing element, so the click arrived with the surface as its
  target and read as a click on the backdrop. Where the press started is now what
  decides, and a press that really began on the backdrop still closes.
- Escape was answered document-wide while a diagram was activated: the branch sat
  above the focus check, so an Escape typed into an input elsewhere was
  `preventDefault()`ed and focus was pulled onto the diagram. Every key is now
  gated on focus being inside the canvas, and leaving by keyboard releases it.
- The disabled path restored attributes and cleared blocks but never released an
  active canvas, leaving its document listeners bound to a detached element.
- The observer re-marked every diagram on every mutation. Removing `tabindex`
  from a focused element blurs it in Chromium (checked directly), so a streaming
  turn dropped an activated canvas out of the keyboard; `aria-label` was also
  rewritten each time. Diagrams are now marked once.

Four tests cover the behaviours and were each confirmed to fail against the
unfixed code. The Chromium blur is outside what jsdom models — it does not
implement the blur — so that test observes the attribute mutations instead, and
the blur itself was verified in the browser.
