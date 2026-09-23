# Portals restyled the whole app

Status: implemented
Translation: current

[中文](2026-09-23-portal-full-restyle.zh.md)

## Abstract

Switching sessions and hovering the sidebar felt slow on large workspaces. A Chrome trace of
the production build showed Radix `Presence` forcing a style recalculation of the entire document
(about 12,350 elements, ~30ms) every time a popover mounted. The cause was a Konsta UI utility,
`last-child-hairline-b-none`, whose unanchored `:last-child … ::after` selectors made every change
of `<body>`'s last child restyle `#root`; Konsta's sources were scanned by Tailwind although no
Konsta component is rendered. The scan is removed, a permanent sentinel keeps `#root` off
`<body>`'s tail as a second line of defence, and two smaller per-switch costs are removed. Popover
insertion dropped from ~25ms to 0.3ms in the real page; an end-to-end trace after the CSS change
has not been recorded yet.

## Evidence

- Traces were recorded over CDP from the unminified production build (`vite build --mode dev`)
  against staging, without the DevTools frontend (which crashed on this page). In the first trace,
  1.1s of 3.6s of JavaScript during session switching was `getAnimationName`; 73 forced
  `UpdateLayoutTree` events of ~15–35ms each carried that stack, each with ~12,350 elements.
- An in-page counter attributed the reads to the sidebar session hover card (`Popover`, side
  right). Mutation logging showed the card appends a popper wrapper and Radix focus guards to
  `<body>`. Appending any node to the end of `<body>` cost 23–38ms; inserting at the start cost
  nothing; inserting into a persistent sibling after `#root` cost nothing.
- Deleting CSS rules in the live page proves nothing: Blink keeps the "children affected by
  positional rules" flags once set. Instead the real DOM and all 7,302 flattened rules were cloned
  into a fresh iframe and bisected. All rules: 22–24ms; without `last-child-hairline-b-none`:
  0.2ms. A class-anchored rewrite (`> :last-child .hairline-b::after`) costs 0.3ms, while even the
  "direct child" part (`> :last-child::after`) alone costs 25.7ms. Synthetic pages with plain
  `:last-child`, `:not(:last-child)`, `~`, `:has()` or `space-y` rules did not reproduce it.
- After removing the scan, with the sentinel deliberately removed and `#root` last again, an
  append cost 0.3ms in the real page.

## Decision

- `src/tailwind/index.css` no longer `@source`-scans `konsta/react`, `konsta/shared` or
  `konsta/styles`. Only the theme, safe-area utilities and the `safe-areas` hook are used; 417
  classes (69KB) disappeared, and every flagged "still referenced" class was a false positive whose
  real variant form is still generated from our own sources.
- `lib/body-tail-sentinel.ts`, called once from `routes/__root.tsx`, inserts a hidden element right
  after `#root`, so any future positional selector from third-party CSS cannot make portal churn
  restyle the app. Web, desktop and mobile all render through that root.
- The session hover card stays shut after a press on its row until the pointer moves 4px:
  navigation re-renders rows under a still pointer, which re-fired `pointerenter` and opened a card
  in the switch commit.
- `ChatComposer` no longer measures itself with `getBoundingClientRect` in a layout effect, which
  forced style and layout of the just-committed conversation on every switch (~50ms); its
  ResizeObserver delivers the size before paint.

Rendering portals into a dedicated container was rejected as the primary fix: Radix focus guards
are always inserted on `<body>` itself, and every portal call site would need a container prop.
Overriding the Konsta utility was unnecessary once nothing references it.

## Follow-up reductions

Measured in the same production build and workspace (9k nodes):

- **Sidebar DOM.** 8,473 of 9,070 nodes were one "Chats" group mounting all 244 rows while 12
  were visible. Row lists now use `content-visibility: auto` (`sidebar-row-list`): a full-app
  style and layout pass went from 25ms to 10.6ms. JS virtualization was rejected for now: the
  sidebar's keyboard navigation, active-row scrolling and per-group sorting read mounted rows.
  The intrinsic-size estimate (50px) keeps the scroll height within 2% while rows first render.
- **GitHub trees.** `GitHubRepoFileProvider.searchFiles` fetched the recursive tree (1.7MB for
  this repository) on every search. `lib/repo-file-paths-cache.ts` now serves it and @-mention
  search from one memory/IndexedDB cache keyed by branch, with one in-flight request per key.
- **PR reads.** Each `useGitHubPrDetails` instance deduplicated only its own requests; the info
  bar and PR tab fetched the same PR twice. Identical reads are now shared module-wide.
- **Idle scroll.** The native-selection scroll handler read the `Selection` and forced a
  synchronous React flush on every scroll event even with nothing selected; it now returns
  early. The sticky-scroll `scrollHeight` reads were kept: they are the before-paint correction
  and account for about 14ms per switch, mostly layout the frame performs anyway.
- **doc-meta.** Full metadata reads that resolve together are written in one cache update per
  microtask instead of one per document, list entries keep their identity while their metadata
  object is unchanged, and value equality walks the JSON instead of serializing it.

- **Switch render.** A later production trace showed each session switch as one ~100ms
  synchronous task: ~49ms render, ~16ms passive effects, ~14ms DOM mutation. Workspace
  group rows were inline JSX inside a memoized group that receives `selectedSessionId`,
  so any selection change re-rendered every row of the group (244 in "Chats"), each with
  a hover card, context menu and tooltip. Rows are now a memoized `SessionGroupRow`
  taking `isSelected`, so a switch re-renders the old and new selected rows. The
  composer's auto-resize no longer resets to `auto` and reads `scrollHeight` when empty,
  which forced a synchronous page layout on every switch (~5ms).

- **Startup meta scans.** A cold load of a workspace with ~4,800 documents (104k meta rows)
  scanned the whole `['m']` namespace three times: the doc-meta bootstrap, the background
  eager-sync seed and the startup ACP capability pass. Each scan is one synchronous Flock
  call of 550-900ms; the cache write after it takes ~1ms. The seed and the capability pass now
  read the ready doc-meta projection (`readReadyDocMetaCache`, injected as
  `RuntimeDeps.readDocMetaCache`) and scan only when no ready projection for their repo
  exists. The projection is kept current by its own watch, so it is at least as fresh as a
  new scan. The bootstrap scan itself stays one blocking call until Flock can page a scan.

- **Keyboard switching.** Switching by keyboard at ~6/s kept the CPU busy. A React
  DevTools-hook commit census showed each switch as ~46 commits, five of them re-rendering
  ~18k components (the whole layout). Causes:
  - `useLodyLiveActivity` subscribed the top-level layout to every session, presence and its
    clock, so each ~300ms tick re-rendered the app even on web, where the feature is off. It
    now lives in the leaf `LodyLiveActivityHost`.
  - `useKeyboardNavigation` subscribed the workspace layout to the sidebar's nav items; it
    reads them at key time.
  - All 248 "Updated" rows re-rendered on every switch and tick: the select/archive handlers
    depended on the selection, and presence ticks rebuilt the live-status map and every item.
    Handlers read the selection from a ref, and the status map and items keep their previous
    objects while unchanged (`lib/json-value-equal.ts`).
  - `Notification.permission` (~3ms, a browser round trip) was read on every prompt mount; the
    latest-PR lookup is memoized per session meta; scroll debug geometry is not read while
    logging is off.

  Measured over 44 switches: main-thread tasks 6.6s → 4.3s, script 4.6s → 2.2s, blocking
  time 2.1s → 0.5s; the switch commit renders ~2k components instead of ~18k.

## Open

Konsta's `theme.css` still imports all Konsta styles; only this utility was shown to matter. No
automated guard rejects unanchored positional selectors in the compiled CSS yet. The doc-meta
lists are cheaper (above) but each cache update still derives every list in O(sessions). The
sidebar still renders every row in React; only the browser's rendering work is skipped. A per-switch
render of the new conversation (~50ms of script) remains; a clock atom of relative times still
re-renders every sidebar row when it ticks, and machine Flock readers re-encode version vectors
(~4ms) on every mount. The
bootstrap meta scan is still one synchronous Flock call (~700ms here); `scan` has no
limit/cursor, so it cannot yield between batches. `includeRaw: false` would cut ~20%. Related scrolling work: [conversation follow modes](../architecture/2026-09-23-conversation-follow-modes.md).
