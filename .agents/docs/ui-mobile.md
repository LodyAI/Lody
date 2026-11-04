# Mobile navigation stack and drawer layering

Why the mobile surfaces in
[`packages/components/src/components/mobile`](../../packages/components/src/components/mobile/AGENTS.md)
are built the way they are. The rules themselves live in that `AGENTS.md`; the
directory index lives in its `README.md`. Read this before changing a gesture,
a z-index, or the session drawer's lifecycle.

## Which layout family renders

`useIsMobile()` picks the renderer: a desktop-class device — Electron shell
or desktop browser — keeps the desktop renderer at every width, and
everything else (phones, tablets, unrecognized devices) follows the
`MOBILE_LAYOUT_BREAKPOINT` viewport breakpoint — narrow is mobile, wide is
the real desktop renderer (a phone rotated to landscape earns it). A large
tablet is therefore a desktop interaction surface: the full-height mobile
new-chat sheet is phone/split-view only, and must not grow tablet-only variants.
A narrow desktop window therefore never reaches this stack — it renders the desktop
family in its compact presentation instead: the navigation sidebar and a
Session's side panel stop consuming columns and become overlays
(`useIsCompactDesktop()`, synced into `compactDesktopLayoutAtom` /
`navigationSidebarVisibleAtom` for non-hook consumers). Width-driven
adaptation inside a family belongs to local matchMedia/container queries,
never to a second global breakpoint read.
Decision record:
[compact desktop layout](../notes/implemented/feature/2026-09-25-compact-desktop-layout.md).

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
`createPortal(document.body)` — therefore lands _under_ the conversation, invisible
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

The tab sheet is the only surface that can say a _background_ tab is waiting on
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

The native iOS side rail can replace the workspace dock and selected session
header actions only when its host confirms room outside system occlusions.
The active surface owns the actions; dialogs and menus suspend the rail, and
the ordinary controls remain the fallback when room is unavailable. The host
uses the current view's reserved regions and keyboard, not device identity.
See the [side-rail decision](../notes/implemented/feature/2026-10-27-native-side-rail.md).

On native iOS, responsive layout selection reads and observes the document's
viewport width: WebKit can report an old `innerWidth` during a fold with the
keyboard open. Other hosts keep the window-width behavior. See the
[resize decision](../notes/implemented/bug-fix/2026-10-27-ios-fold-layout-width.md).

On a native iOS full-height vertical division, the wide workspace places its
sidebar and content on opposite sides using UIKit's view-relative region. The
temporary sidebar width is not saved. The native host republishes it after a
WebView reload and clears it when the region disappears. The mobile conversation places its message stream above a horizontal division
and its composer below; the existing keyboard offset takes over when the software
keyboard appears. Its tab and action sheets fit the lower panel and scroll.
On the active mobile home chat tab, whole existing groups are split between
the two panels without duplicating rows or splitting opener trees. The normal
list remains when the keyboard is visible, during search, with fewer than two
groups, or when space is insufficient. The Projects tab places recent shortcuts
and the Local/GitHub selector above the division and the selected project list
below when shortcuts exist; search and keyboard use restore the normal layout.
The embedded Schedules list uses a compact layout even when the viewport exceeds
the desktop CSS breakpoint. On the Settings category page, the upper panel places the account and current
workspace identities side by side in one card, next to
the last 7 days of workspace Token and estimated cost, using the existing settings usage
cache and capability gate. A compact daily skyline and model-share ring use the same timeline as the usage page;
tapping it opens the full usage page. Every settings category scrolls below the division. The
About page separates build information from links; GitHub settings separate connection and identity from the repository list, returning to ordinary scrolling for keyboard use. Agents settings place the remote machine selector above and providers below. The
usage detail places range and totals above the division and the charts below; the workspace
detail puts workspace identity above and members and other controls below. Account settings place the profile above and account resources below. Appearance groups theme, language and font size above, with rendering and app icons below; preferences place notifications and input above, with session controls below. Both panels scroll independently and return to ordinary scrolling while the keyboard is open. Project detail settings place editing and worktree controls above the division, with skills and other project controls below. Workspace switching, project skills, history and removal sheets fit the lower panel. New-chat, run configuration, filters, worktree editing and workspace creation/deletion sheets use that panel while the keyboard is hidden; they return to keyboard-aware sizing and lifting when it appears. Root confirmation dialogs fit the lower panel when the keyboard is hidden; nested dialogs keep their host's positioning. Other settings detail pages and general dialogs retain their ordinary layout. The archive places its first
whole group above the division and remaining groups below while retaining one
shared selection and delete-confirmation state. Search, keyboard and fewer than
two groups use the ordinary list. See the
[horizontal division decision](../notes/implemented/bug-fix/2026-10-28-ios-horizontal-division.md).

The inline picker's fuzzy filter is shared with the desktop run-config menu so one
query behaves the same on both surfaces: a substring match cannot find
`claude-opus-5` from `op5`, and a provider's model list can run to dozens of ids.
Its search input is `type="text"` because the search type draws a UA cancel glyph
in the browser's own accent, which belongs to no theme and is no thumb's target.

`useKeyboardAwareSheet()` is three parts that only work together — lift, capped
scroller, centred focus — and sheets carrying two of the three exist and misbehave
on iOS, which is why sheets call the hook instead of assembling it.

The full-screen file viewer uses the native iOS `--native-keyboard-height` as
its bottom inset and disables Vaul input repositioning, so the editor's available
height shrinks without moving its header. Other hosts explicitly opt into the
shared drawer's live visual-viewport inset, including mobile browsers. The inset
returns to zero on keyboard hide; a WebView that already resizes needs no extra
inset. Monaco's existing automatic layout follows the resized container.

Native iOS side drawers without snap points also disable Vaul's input repositioning:
the session composer already consumes the native keyboard offset. Other full-screen
PR, browser, file-list and simulator panels explicitly use `DrawerContent`'s
`nativeKeyboardInset` so their controls stay above a docked keyboard on ordinary
iPhones too. Their CSS insets follow folds and rotation without restoring a height
captured on another display.
Bottom sheets retain their separate `useKeyboardAwareSheet()` contract.
See the [resize decision](../notes/implemented/bug-fix/2026-10-27-ios-drawer-resize.md).

The mobile session drawer is portalled outside the workspace, so its composer and
question form apply the native keyboard offset themselves. In the wide workspace,
the root already applies that offset; those two surfaces must not apply it again.
See the [wide-session decision](../notes/implemented/bug-fix/2026-10-27-wide-session-keyboard.md).
