# Native chat verification

From the repository root:

```sh
pnpm verify:native --case chat
```

Settings → Debug → Native Chat Preview (`原生聊天预览`) uses the production native view with 80 history
entries and a simulated burst stream. Replay sends 48 characters every 700 ms;
Swift paces each burst using elapsed time and arrival rate; new graphemes fade in over
180 ms with a stagger based on the commit interval. Long replies keep their tail
animation. Fade ticks redraw only the affected text lines without updating list
layout. Completion waits for the final text commit and its visible fades before
merging blocks for cross-paragraph selection. The preview sends no network
writes. Sending preview input appends a local user message and starts a simulated
reply. Tapping a tool in the process sheet simulates a failure.

Each assistant turn starts with a static, text-only duration row. Local submission publishes
it immediately; an authoritative assistant shell takes over the same stable row
before server process and answer rows render below it. Running command summaries
shimmer; hidden thinking calls do not close the last visible tool group. Earlier
groups stop shimmering when visible prose follows them, and Reduce Motion suppresses
the animation. User bubbles collapse to six measured lines above Expand; expansion
and copy retain the complete message. Agent footers contain Copy, Info and Fork,
with prose-aligned glyphs 32 pt apart and time 12 pt after the last glyph.
The footer has no More menu or message-sharing actions.

Verify: scroll history; replay at the bottom; open the process entry while text
arrives inside the process sheet; completion folds intermediate rows into the process entry with a 220 ms transition;
check multiline input and interactive keyboard dismissal; repeat in dark mode.

The native session controller owns navigation and cloud actions; LodyKit owns collection cells,
Markdown, text pacing, expansion, measured row heights, keyboard and input state.
MarkdownView parses Markdown, including unfinished input; the active tail is parsed
on a serial background queue and parse results are cached by source text and streaming state.
Streaming display first runs pinned Remend in an isolated, serialized JavaScriptCore
context. Incomplete links stay plain text; completion and history bypass repair.
Neither persisted text nor copy/share source is rewritten. Row heights
come from an offscreen `MarkdownTextView` per row that keeps its document across width
changes. Presentation pacing is inspired by FlowDown's `BalancedEmitter`; MarkdownView
and Litext are SPM dependencies declared in `project.yml`.

Assistant `text` and `thought` rows render through MarkdownView (Litext + cmark-gfm):
headings, lists, task lists, blockquotes, tables, highlighted code blocks with a copy
button, links and math. User bubbles have a native copy menu; assistant text uses
Litext's own double-tap (word) and triple-tap (line) selection with the system edit menu. Per-glyph fade-in is
drawn by `ChatFadeLabelView`, a `TextLabelView` subclass injected into
`MarkdownTextView`.

Scroll drawing regression (with a booted iOS Simulator):

```sh
pnpm verify:native --case chat-render
```

The same long text must draw identically when partially offscreen and after
scrolling into view. Clipping drawing to the current window fails this check:
UIKit retains that incomplete backing store as the cell scrolls.

Stream/completion geometry regression (open the preview at the bottom first):

```sh
python3 apps/ios/verification/kit/chat/layout.py SIMULATOR_UDID
```

AXe samples the actual collection cells across replay and completion. The conclusion must remain complete and the process row must stay 44 pt high.
Flow layout uses cached TextKit heights, so updates and bottom positioning
use final geometry instead of successive estimates. Tool status slots
stay reserved when their spinner disappears, preserving line wrapping.

While streaming, text separates process segments. Completion folds all but the
last nonempty text into one process entry. Tapping
an entry uses `present` to show a form sheet with that segment’s items (or the complete process after completion), always flat. The sheet observes the parent's existing projection using
`useSyncExternalStore`; it does not call `watchSession` or `unwatchSession`.
Dismiss and reopen during a replay to verify subscriptions and live updates.

Earlier process segments stop showing processing when the next text arrives,
even while the turn continues. Live-observed segments show their frozen elapsed
time, measured with the native monotonic clock before text pacing. The protocol
does not persist segment timestamps; pre-existing segments keep completed copy
without inventing a duration. `verify:ui --case duration` checks these boundaries,
the still-running next segment and opening the earlier segment's scoped details.

Add `--send` to the geometry check to verify the preview's send-to-top behavior.
New user messages use the native smooth scroll animation. Bottom inset reserves
space for the current turn, shrinks as the reply grows, and remains after short
replies finish. Any upward manual scroll releases following. This follows
Kansoku's active-turn spacer behavior; Reduce Motion uses immediate positioning.

The preview geometry check also taps the native navigation title and verifies its
detail action, then checks live segment boundaries and conclusion-only completion.
The session title is a tappable `UINavigationItem.titleView`. The project name
lives on `UINavigationItem.subtitle` independently of changes to
`titleView` on header updates and during interactive pop.

The first history positions immediately. Subsequent snapshots preserve a visible
row's screen position before following the new bottom. A display link converges
on the current bottom without restarting on every text update, and interpolates
streaming row heights so neighboring cells move continuously. Only active height
transitions invalidate layout each frame; text keeps its natural layout and is
clipped to the expanding cell. The link stops once settled or detached.
Historical user messages never trigger the local-send anchor. A manual gesture
also cancels any deferred send anchor before an acknowledgement can restore it.

Dragging immediately pauses tracking, even inside the old 80 pt range. Tracking
resumes only after a gesture ends at the tail or the down arrow is tapped.
The floating down arrow appears beyond 80 pt from the bottom. `tracking.py` checks
returning during streaming and after completion, button dismissal at the tail,
and unchanged history position while tracking is released. Reduce Motion uses
a short crossfade for completion instead of moving rows.

Offline composer, image and chat baselines now run through `pnpm verify:ui`.
See [the shared runner](../../ui/README.md) for clean Simulator
setup, individual cases, artifacts and CI. No baseline requires a live session.
The standalone chat-render executable covers the production status label;
Markdown and selection no longer use the retired ChatMarkdown implementation.

## Send throw tuner

`throw-tuner.html` is a standalone page for the user-message send animation.
Open it in a browser, adjust the position curve, arc, landing spring and squash,
then copy the exported values into `ios/Chat/ChatThrowCurve.swift`. The page
models the same tracks Swift samples into the position keyframes; `arcHeight`
in the page is absolute, Swift scales it by path length (`arcRatio`).

Operation-event coverage lives in the existing `session-runtime` suite and
`chat-tools`, `chat-render`, and `session-rows` native cases. It checks persisted
receipt preservation and reloads, progress updates, duplicate-success visibility,
failures/cancellations/uncertain batches, saved replies, live title resolution,
five-row grouping across creation records, separate reply/navigation targets, and
cycle-safe relations with exact Tab targets and missing/archived opener roots.
Rendering checks cover aligned provider/title/status rows and live-to-completed reuse;
relation checks cover continuing ancestor rails and terminating final branches.
Contained Tabs share their root row; rendering verifies horizontal overflow,
directional fades without scrollbars, exact Tab targets and saved reply access.
The native tree reads the current catalog and subscribes to the session source;
it never owns a second history subscription.
