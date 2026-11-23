# Join the share reader's tree line, keep the selection off it, and let the tree resize

Status: implemented
Translation: current

[中文](2026-09-14-share-reader-tree-line-and-resize.zh.md)

## Abstract

The anonymous share reader's conversation tree reused the app's leading slot but
not the row box that slot's connector is drawn for, so every nested group rendered
as a dash per row — a measured 5.57px hole at each row boundary — and the selected
row's tint stretched across the connector gutter, cutting the line a second time
where it crossed. The rows now use the slot's row box (a 30px row plus the list's
1px `gap-px`), and selection and hover paint the title box alone, which closes the
gaps to 0px in both themes and leaves the line untouched by the mark. The sidebar
also gained a `separator` handle: pointer or arrow keys resize it between 180px and
480px, further clamped so the transcript keeps at least 320px. The trunk's ±8/9px
offsets are now documented as a contract on the caller's row box, because nothing
in the type system stops the next reuser from repeating this.

## Decision

### The connector encodes a row, not a slot

`session-row-leading-slot.tsx` draws the trunk from inside a 14px slot but sizes it
for the row around that slot: `-top-2` and `-bottom-[9px]` reach 8px above and 9px
below the slot, which spans exactly one 30px sidebar row (1px border, `py-1`, a 20px
title line) plus the 1px `gap-px` the app's lists put between rows. Under those
numbers one row's trunk ends where the next row's trunk begins, and a group of
opened Sessions reads as one vertical line.

The share reader reused the slot and invented its own row: `px-2 py-2` around a
`text-[13px]` title, in a list with no gap. That row is about 37px tall, so the
trunk floated in the middle of it and every boundary showed a hole. Measured in
Chromium with the old box restored on the live page: 5.57px between one trunk's
bottom and the next trunk's top. The tree looked like a column of unrelated dashes
rather than a tree.

The fix is not new geometry — a second set of offsets for the reader would be the
"second connector implementation" this package already forbids. The rows adopt the
box the slot is drawn for: `flex flex-col gap-px` around rows whose title button
carries `border`, `py-1` and `text-sm`. Measured gaps are now `0` in light and dark,
with the tree open at every width the handle allows.

Because the numbers are a contract and not a detail, they are now documented where
a reuser will meet them: a comment on the two constants, and a section in
[the sidebar tree doc](../../../docs/components-sidebar-session-tree.md).

### A selected row must not paint over a line it does not own

The reader tinted the whole row, gutter included, at `bg-foreground/10`. The trunk
and elbow run through the gutter of rows they do not belong to — the line that
connects two children passes through the row between them — so a full-width chip
puts a tinted box across the middle of the line, which reads as a second break on
top of the first.

Selection and hover now paint the title button only: the leading slot is its sibling,
outside the tint. Measured on the reader at the default width, the marked row's
background begins at x=34 while the elbow ends at x=28, so the mark and the line
never overlap. The app's sidebar keeps tinting its whole row, and correctly so — its
gutter is inside the row's own padded box, and shifting the highlight there would
break the flat-list alignment its `AGENTS.md` requires.

This also fixes the mark's size by accident: the old chip was 37px tall because the
title carried `py-2`. It is now the row.

### The tree is resizable, and the transcript sets the limit

A 224px tree truncated most titles ("Garbage collecti…"), and a reader who wants to
see them had only the collapse toggle. The tree keeps that toggle and gains a
`role="separator"` handle: a 12px grab area straddling the border with a 2px visible
line, absolutely positioned so the columns keep their own widths and the handle
claims no layout space of its own.

The range is 180–480px, and the upper bound tightens to `container - 320px` whenever
the layout can be measured, so a drag on a narrow window stops while the transcript
is still readable instead of at the static maximum. The same bound is re-measured
when the window resizes — otherwise a visitor who widened the tree and then narrowed
the browser would be left with a tree that crushes the transcript — and it is what
the handle reports as `aria-valuemax`. Verified in Chromium: at a 1280px viewport a
drag to x=1200 settles at 480px; at 700px the same drag settles at 380px, leaving the
transcript exactly 320px; and a 420px tree narrows to 380px when the window becomes
700px wide. An unmeasurable box (jsdom, first render) falls back to the static bound
rather than collapsing the range to its minimum, which is what keeps the behaviour
testable.

Arrow keys step the handle by 16px, so the width is reachable without a pointer.
The width transition is dropped for the duration of a drag — animating each pointer
move makes the edge trail the cursor — and restored afterwards, so the collapse
toggle still slides (measured midway at 75.47px on the way to 0) and reopens at the
width the visitor chose rather than the default.

The width is component state. It is deliberately not persisted: the reader is
forbidden to write share data to storage, and while a layout preference is not share
data, a visitor usually reads one share once, so a storage key here would be a rule
to defend for very little.

## Alternatives considered

Keeping the highlight on the row and raising the connector above it was rejected.
It would leave a tinted band across the line at every selected row — the complaint
was about the highlight touching the line at all, not only about z-order — and the
translucent chip would still change the line's background where it crossed.

Adding a `treeTrunkClassName`-style prop so the reader could keep its taller rows
was rejected for the same reason the reader may not fork the connector: two callers
with two geometries is how this defect returns. One row box, used by everyone, is
the cheaper contract.

Persisting the width in `localStorage` beside `lody-language` was considered and
deferred, as recorded above.

## Evidence and limits

`tests/session-share-page.test.tsx` gains two behavioural cases and keeps its
existing sixteen. The resize test drives the real handle with pointer events
(jsdom implements no `PointerEvent`, so the suite defines one that carries a
`pointerId`), and asserts the widths the tree settles on: a drag to 304px, both
clamps, a second pointer's moves ignored, no movement after release, a 16px arrow
step, the handle absent while collapsed, and the chosen width restored on reopen.
The selection test asserts that the marked element contains neither connector and
that the connector's row is not itself marked. Both detect their regression:
restoring the tint to the row fails the second with `expected true to be false`,
and removing the clamp fails the first with `expected '4000px' to be '480px'`.

jsdom computes no layout, so no test can see either line. Geometry was measured in
Chromium against the `Sharing/SessionShareReader` stories at 1280px and 700px, in
light and dark, with the tree's own rectangles read through `getBoundingClientRect`:
trunk gaps `0`, the marked title's background starting 6px right of the elbow's end
and resolving to a real `oklab(… / 0.1)`, the drag and keyboard widths above, and no
text selection during a drag across the transcript.

`pnpm typecheck`, `oxlint`, `check-i18n`, the three boundary guards and
`pnpm run docs check` pass. The `@lody/components` suite runs 474 of 477 files
green; `control-plane-mirror`, `conversation-view-hooks` and
`sidebar-share-only-menu` fail on the 5s default timeout under full-suite parallel
load and pass in isolation. None of the three imports anything this change touches.
No hosted share was exercised — the stories and tests use synthetic manifests.

Limits: the narrow-viewport drawer keeps its fixed width, since a drawer has no
border to drag. Clamping on window resize is lossy — a tree narrowed by a shrinking
window stays narrow when the window grows back, because no pre-clamp width is
remembered. The 320px transcript floor is a judgement, not a measured reading
width. `packages/components/src/components/sharing/AGENTS.md` was already 7 bytes
under its gate, so this change compressed existing bullets — meaning preserved,
rationale routed here and to the sidebar tree doc — to fit the two new rules.

Builds on [the reader layout note](../feature/2026-09-14-share-reader-navigation-and-foot.md),
which added the tint and the collapse animation this change corrects.
