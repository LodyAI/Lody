# Conversation outline

The reader-position rail beside a long conversation: `conversation-outline-rail.tsx`
paints it, `conversation-outline-rail-geometry.ts` owns its widths, and
`conversation-outline-arrival-intent.ts` decides when a pointer approach counts
as intent. Binding rules live in [AGENTS.md](AGENTS.md); this file holds them in
full because the topic outgrew that index.

## Invariants

- Build entries from `items`, never DOM. The rail mounts only once user rounds
  reach `OUTLINE_MIN_USER_ROUNDS`. Reader position is the last round
  anchored above the viewport top, resolved from the list's offsets; it never
  enters tick-list props. Paint one arithmetic active bar; sync `aria-current`
  imperatively. Mount a viewport slice with overscan and retain keyboard-focus,
  pointer and hover-card anchors outside it. Preserve the full fixed-pitch scroll
  extent and accessible set positions. Scrolling updates the slice only; pointer
  magnification updates memoized widths. `buildConversationOutline` runs at token rate, so memoize per message
  and clean only a bounded markdown prefix.
- The rail is a page-level absolute portal outside the shrinking message area,
  not a Virtua row or viewport child. It stays page-centred as the composer
  grows, pane-local in splits; never `position: fixed` or composer height. Blend
  magnification into resting widths so the pointer's tick stays longest; derive
  `RAIL_TRACK_WIDTH` from the peak.
- Arrival intent belongs to `conversation-outline-arrival-intent.ts`. A directed,
  braking approach gets one short-lived delay bypass; uncertainty waits 200ms.
  Only waiting out that delay arms rapid browsing and its 2.5s close window;
  predictor-opened cards never do. Removing `enableArrivalIntent` installs no
  detector/listener. Keep inputs numeric and replayable, independent of Session,
  lifecycle, telemetry, and platform capabilities. The Storybook Lab records only
  explicit in-memory, rail-relative data; it never persists or uploads.
- `scrollRowToTop` is the only row-index-to-scroll conversion: it adds
  `leadingRowCount` and compensates viewport top padding so reads and writes
  share one coordinate space. Outline jumps, search, and imperative scrolling
  use it; do not scroll the conversation list any other way. Group toggles never
  scroll — expansion reveals rows in place.
- A jump is issued once. It sets the scroll engine's reading anchor to the
  round's row, which stays at the top while rows around it are measured and
  placeholders hydrate, and which releases follow-output by itself. Never
  re-issue a jump by a stored row index: indexes shift as placeholders expand.
