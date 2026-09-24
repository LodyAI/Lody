# Mobile navigation stack and drawer layering

Why the mobile surfaces in
[`packages/components/src/components/mobile`](../../packages/components/src/components/mobile/AGENTS.md)
are built the way they are. The rules themselves live in that `AGENTS.md`; the
directory index lives in its `README.md`. Read this before changing a gesture,
a z-index, or the session drawer's lifecycle.

## Two families of swipe-back

Mobile surfaces animate in two different ways, and the back gesture follows the
animation rather than the screen:

- **Full-screen Vaul `<Drawer direction="right">`** — the session
  (`mobile-workspace-stack.tsx`: SessionDetail layered over the always-mounted
  home/chat landing) and the Files / opened-file / PR / Browser drawers
  (`../../packages/components/src/components/sessions/session-detail.tsx`). These
  keep Vaul's interactive drag, so the drawer follows the finger.
- **CSS-keyframe / framer drill pages** — settings, project, file browser
  (`mobile-drill-page-layout.tsx`). Not Vaul, so there is no interactive drag: a
  48px `@use-gesture` strip fires `onBack` on release and the page then plays its
  own exit slide.

The Vaul family needs the edge zone because vaul@1.1.2 drags a right drawer from
any `pointerdown` unless the target carries `data-vaul-no-drag`. Without
`VaulDrawerBody`, code blocks, wide tables, and the no-drag image viewer all fight
dismissal. The same component marks content no-drag and mounts the single
drag-start zone, which is why nothing else may mount one.

## Stacking

The session is already a body-portal Vaul drawer at `z-50`. A second body-level
`fixed z-50` surface — for example a Browser panel rendered with
`createPortal(document.body)` — therefore lands *under* the conversation, invisible
until the session drawer closes and then flashing. Nesting the Browser drawer is
what keeps it above.

The Files drawer nests the two families: `MobileProjectFileBrowser` mounts its own
`MobileEdgeBackSwipeZone` at z-60 while inside a folder, so an edge swipe pops one
directory level, and only the root swipe reaches Vaul's z-30 strip and closes the
drawer. Those two z values are load-bearing against each other.

Body portals inside a drawer can lose touch and scroll entirely, because
Radix/Vaul's modal layer treats them as outside the drawer — hence the preference
for the nearest `data-vaul-no-drag` portal target for interactive overlays.

Closing the session drawer with a raw `history.back()` can pop duplicate session
entries left behind by the PR/Browser drawers and leave Vaul half-transformed, so
close replaces to the remembered `/chat` base instead.

## The 48px edge strip versus real controls

The strip is 48px wide and otherwise covers most of the leftmost attachment button
and the left half of the info bar's leading chip (its first chip starts at x=22),
leaving both effectively untappable. Lifting those two surfaces above the strip is
preferred over shrinking the strip, because the message body still owns the
edge-back gesture.

That `z-40` trick does not transfer into the message list: virtua's `VList` sets
`contain: strict`, so the list is its own stacking context and no row can paint
above the strip. A left-edge control in a row can only be rescued by insetting it
past `EDGE_ZONE_PX`. The assistant turn action bar does exactly that with a leading
turn-duration label; without it the copy button sat at x=24..52 with roughly 4px
tappable. The label is therefore layout, not decoration — and `WorkedGroupHeader`
drops its own duration on mobile so the same value is not printed twice.

The same reasoning explains `MobileSwipeableRow liftAboveEdgeSwipeZone`: the swipe
face is a `z-10` stacking context, so an opener's fold chevron cannot clear the
drill-page strip at `zIndex={20}` on its own. The flag costs the edge-back swipe on
that row, which is why it is passed only when the chevron actually renders.

## Chat list previews and the opened-by tree

The group preview cap exists because the workspace home buckets compete for one
screen; the in-project list does not pass it, since the user drilled in to read
exactly that list. Because the cap counts top-level rows and runs after `rootRank`,
a preview truncates the pinned-first / latest-activity order instead of reshuffling
it. It is suspended during archived multi-select because "select all" takes every
id in the list, and a capped surface would confirm a permanent delete of rows it
never showed. Collapsing the preview scrolls the toggle back into view from a
layout effect because the rows that vanish are above it, and the toggle's leading
16px slot stays empty because that column carries a row's status indicator and an
opener's fold chevron — anything else there reads as one of those.

The list is deliberately not virtualized: `VList` must own the scroll element, but
the home screen owns it (pull-to-refresh translates that subtree, the dock-collapse
listener reads it, hidden home tabs stay mounted for scroll position), and
`contain: strict` would strip the `liftAboveEdgeSwipeZone` escape the opener
chevron needs. The cap bounds the row count instead.

Resolving the opened-by tree per bucket is what keeps the Pinned, date, and project
section boundaries intact. Mobile has no row context menu, so an active opener
cannot be folded until it goes quiet — the desktop sidebar's context-menu
expand/collapse item has no mobile counterpart. That was accepted deliberately
rather than drawing both a status indicator and a chevron in the one node slot.

## Session sheets, viewers, and the frosted header

The tab sheet is the only surface that can say a *background* tab is waiting on
approval while another tab is on screen, which is why the status type — not just
presence — travels through the derived atom and why `requestPermission` outranks
the spinner. The header badge stays two-state because a dot can only differ by
colour, and `--status-warning` resolves to `--primary` in VS Code-derived themes,
so a warning dot would simply be the unread dot again. The Owner row is a
disclosure so that a large team cannot push the sheet's actions off screen.

The frosted header is an absolute overlay that content scrolls under and frosts,
which is why the top inset travels as `--conversation-top-inset` instead of layout
padding. `GlassIconButton` draws its glass disc on a canvas (radial edge glow plus
a specular arc, vertically masked so the rim lights top and bottom and melts at the
sides, colours read from the computed `color` and redrawn on theme flip) because
CSS filters and SVG could not produce it cheaply; the press interaction stays pure
CSS state so no JS runs per touch.

## Pickers and keyboards

The inline picker's fuzzy filter is shared with the desktop run-config menu so one
query behaves the same on both surfaces: a substring match cannot find
`claude-opus-5` from `op5`, and a provider's model list can run to dozens of ids.
Its search input is `type="text"` because the search type draws a UA cancel glyph
in the browser's own accent, which belongs to no theme and is no thumb's target.

`useKeyboardAwareSheet()` is three parts that only work together — lift, capped
scroller, centred focus — and sheets carrying two of the three exist and misbehave
on iOS, which is why sheets call the hook instead of assembling it.
