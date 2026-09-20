# Session tabs, desktop top bar, and ?tab routing

How the desktop session chrome is assembled and how the active conversation tab is derived from the URL.

Scope: `packages/components/src/components/sessions`. Binding rules and the
pointer to this page live in
[that directory's AGENTS.md](../../packages/components/src/components/sessions/AGENTS.md);
this page is the full text of the rules summarised there.

- Desktop top bar is ONE merged row (no repo-title header row): `SessionTabBar`
  with `leftSlot` (sidebar expand + macOS traffic-light inset via `className`)
  and `rightSlot` = a `SessionChatInterface headerVariant="toolbar"` instance
  (IDE launcher / Browser / "…" menu / sidebar toggle — no title, no PR badge).
  All macOS traffic-light insets (sidebar `h-[72px] pt-7` header, this bar's
  `pl-[4.5rem]`, `reserveMacTrafficLightInset`, landing `left-[96px]`, and the
  root drag strip) are gated on `!useElectronFullscreen()` — the main process
  pushes `lody:window-fullscreen-changed` and the lights auto-hide in native
  fullscreen, so no inset is reserved there. The traffic-light CENTERLINE is
  y=23px (`trafficLightPosition {x:20, y:16}` in `apps/electron/src/main/window.ts`
  - 7px button radius); every h-7 chrome button beside the lights centers on it
    (sidebar collapse `-top-0.5` in `loro-sidebar.tsx`, landing expand `top-[9px]`
    in `web-chat-landing-screen.tsx`) — re-derive those offsets if the Electron
    position or the card `mt-2`/border/`p-[2px]` stack changes. On Windows the native title bar is
    hidden (`titleBarStyle: 'hidden'` + theme-tinted `titleBarOverlay`, see
    `apps/electron/src/main/window-theme.ts`); the window instead reserves ONE
    36px drag band at the top — root drag strip `h-9` in `routes/__root.tsx` +
    `pt-9` in `web-workspace-layout.tsx`, both gated the same way — so no page
    (this bar included) reserves its own right-side inset for the caption buttons.
    Mobile never renders `SessionTabBar`; it uses `MobileSessionTabSheet` instead.
    Desktop session tabs (not drafts or file/diff viewers) are mention drag
    sources: the parent tab uses HTML5 drag, child session tabs arm the
    in-flight store from the strip's dnd-kit pointer drag. Dropping onto the
    conversation inserts a mention of that tab; dropping onto another tab
    still reorders. Pointer-over-conversation wins over closest-tab collision.
    A lone parent Session tab is not draggable; enable tab drag only once a
    second visible tab exists. On desktop, Cmd/Ctrl+W is the native Close
    accelerator. Session-detail registers a tab closer: focused side panel or
    conversation tab closes, including the parent. Close writes shared `isTabClosed`,
    selects the next open neighbour (right then left), or enters a local draft.
    `?tab=empty` remains an entry sentinel: after hydration, reuse a local draft or
    create one and replace the URL. Mobile viewers remain active. With
    no closer mounted (Chat Landing and other surfaces) the chord closes the
    window.
    Each Session tab has ONE leading status slot, priority-ordered
    `waiting > working > unread > agent icon`, matching the sidebar row
    (`sidebar-row-shared.tsx`) and the mobile tab sheet. Test `isWaiting` BEFORE
    `isWorking`: a permission request is also live presence, so the busy spinner
    otherwise swallows the one state that needs the user. Waiting renders the
    sidebar's `Hand`, never an amber dot — `--primary` and `--status-warning` are
    both amber in the shipped themes, so an amber waiting dot beside a primary
    unread dot reads as the same marker. Unread comes from
    `sessionHasUnreadMessages` (`lib/session-read-receipt.ts`, the same
    timestamp comparison as read receipts, excluding closed/archived conversations) and is
    suppressed on the ACTIVE tab, which is the surface clearing it. A child tab
    is the only place its own unread state can surface — sub-sessions get no
    sidebar row — so do not drop the marker from any tab renderer.
    Desktop tabs share width equally whenever all can reach `ACTIVE_TAB_MIN_WIDTH`;
    below that threshold the active tab keeps that width and the others share the remainder,
    provided the strip viewport is at least 366px wide. Narrower strips divide evenly.
    Browser flex owns resting widths, including initial/restored tabs: these do not
    run an opening width animation. Item margins alone own the 6px inter-tab gap.
    A pointer-triggered close freezes every surviving tab at its current width
    (Chromium's `in_tab_close_` rapid-close mode) so the next tab's close
    button lands under the cursor; the freeze only arms on a pointerdown inside
    the strip, so keyboard/programmatic closes relayout normally. The freeze
    decision runs DURING RENDER (React's derived-state adjustment), so a
    removal commit's first painted frame already carries the frozen widths —
    deciding it in an effect let the unfrozen allocation commit first and
    flashed survivors at the fresh width for a frame. The freeze
    releases when the pointer leaves an EXPANDED region — 40px below the strip
    and 60px toward the new-tab button, like Chromium's MouseWatcher — or on a
    tab add, a viewport shrink below the captured width (a wider viewport keeps
    it), or a single remaining tab. Widths freeze by role, not by tab: a
    survivor that becomes active mid-freeze takes the captured active width
    while the deselected tab drops back to the inactive width. Closing only the
    LAST tab never enters the mode — the new last tab already ends at the right
    edge — and closing the last tab while frozen re-spreads the survivors over
    the occupied width instead of shrinking the budget, keeping that edge
    under the cursor. Frozen removals slide closed (the survivor starts with the
    freed width as an inline-start margin) over a 200ms transition that reduced-motion
    users skip. Adding or restoring tabs and releasing the freeze return directly
    to flex. See the [browser-width decision](../notes/implemented/architecture/2026-09-21-browser-owned-tab-widths.md)
    for DOM capture and ResizeObserver update ordering.
    **The tab pills' top border shares one line with the sidebar and side-panel
    cards at y=8**, since every floating card is `mt-2` (sidebar in
    `loro-app-sidebar.tsx`, side panel + terminal dock in `session-detail.tsx` /
    `terminal-dock.tsx`). The bar row therefore takes `mt-0.5`, NOT `mt-2`: its
    h-8 pills are centered in an h-11 row, so the row starts 6px higher and the
    pills land on 8 (2 + (44 − 32) / 2). Changing the row height, the pill height,
    or the cards' `mt-2` silently breaks that line — re-derive it, and measure
    with `getBoundingClientRect`, don't eyeball.
    **One canvas, and the ACTIVE tab is the heaviest thing in the row.**
    `bg-background` runs unbroken from this bar down through the message list and
    out to the frame; tabs sit ON that canvas and must not break it (do not give
    the bar row its own strip color). The active tab wears the app's
    floating-panel material — `bg-sidebar` + `border-sidebar-border/80` + the same
    drop shadow as the side panel / terminal dock — so "the one in a box" reads as
    the current page. Inactive tabs get a flat borderless wash
    (`bg-muted-foreground/[0.07]`) + dimmed text. Keep that weight order: among
    siblings in a row the eye scores chrome as selected, so anything that gives
    inactive tabs MORE chrome than the active one reads inverted (tried it — the
    active tab then looks like a static heading). A `solo` tab spans the row and
    therefore drops the fill; a full-width pill would paint the whole bar.
    **Keep the surface ladder ordered — canvas → inactive → active — and MEASURE
    it (`getComputedStyle`), don't eyeball the token names.** Light gets that
    ladder from `bg-sidebar` for free (canvas 241 → active 229). Dark does not, so
    the active pill carries `dark:bg-muted-foreground/[0.18]` +
    `dark:border-muted-foreground/[0.24]`: Vesper's `sideBar.background` is
    `#161616`, only 6 above the `#101010` canvas AND below the inactive wash (26),
    so `bg-sidebar` alone rendered the active tab as a dent with only its border
    holding it up. The override lands 16 → 26 → 42, border 70. Do NOT reach for
    `--tab-active` / `--tab-inactive` / `bg-tab-active`: both collapse onto
    `--background` in dark (Vesper `tab.inactiveBackground` == `editor.background`),
    which is why the original `/[0.22]` vs `/[0.12]` tints existed — a 10% gap that
    rendered as one gray and was the actual cause of "I can't tell which tab is
    active". Two alpha tints of one color are fine per se; the gap and the ordering
    are what matter. Text hierarchy DOES resolve in both themes — keep
    `--tab-*-foreground`. `session-side-panel-tab-bar.tsx` still uses the old alpha
    pills; its container is the floating card, not the canvas.
    Repo identity lives in the desktop-only `session-info-bar.tsx` glued above
    the composer (the "canonical cluster + fixed stage" bar detailed below; it
    replaced the header `PullRequestBadge` and the old `session-context-strip.tsx`)
    and in the "…" menu (Repository/Machine/branch info rows). `changesDiffStat`
    reads the active sidebar session's `SessionMeta.diffStats.allChange`, matching
    that sidebar row exactly; the bar must never trigger or independently total
    diff loads.
    In a multi-member workspace, `SessionAccessControl` sits in the desktop toolbar
    before the "…" menu only while effective access is `Private`; Team and unresolved
    states stay hidden. Single-member workspaces do not resolve or pass sharing state.
    Its menu action enters the existing parent-owned confirmation flow. Keep the full
    status/action in `SessionHeaderMenu` as the mobile/compact fallback.
    The "…" menu's `Change owner` submenu writes `SessionMeta.userId` — the OWNER
    field, which drives the sidebar My/Team split, the row author avatar, CLI
    Code Collab owner checks, and usage attribution. It is not sharing/visibility
    (that is machine + local-project grants, `use-session-sharing.ts`) and the two
    must stay separate actions. Gated on `useWorkspaceMembers().isMultiMember`:
    a solo workspace has nobody to hand the session to, so no owner UI renders.
    Any member may transfer, mirroring task owner assignment.
- **The `?tab` search value is the single source of truth for the active
  conversation tab.** `session-detail.tsx` DERIVES the active tab from the
  route search (`resolveActiveSessionTab` in `lib/session-tab-url.ts`; drafts
  encode as their full `draft:<id>` id, children as `session:<id>`) and tab
  activation NAVIGATES instead of setting state — user-driven switches PUSH so
  tabs participate in history back; structural rewrites (draft promotion,
  closing a dead tab) replace. Never reintroduce a mirrored
  `activeTabSessionId` state or URL↔state sync effects: two stores reconciled
  by passive effects is exactly the render-loop freeze of #193. The derivation
  is TOTAL and takes the URL at its word: a `session:` tab the meta replica
  has not delivered yet stays ACTIVE behind a pending surface, because
  treating a transient replica gap as "this tab does not exist" is what
  bounced a just-promoted draft back to the parent (#199 regression). Only
  positive evidence resolves away from the named tab (an archived/closed conversation,
  side-panel child, or a device-local draft that is provably gone). A confirmed
  shared close replaces only the still-current URL choice with an open neighbour
  or `empty` (materialized into a local draft); this narrow invalidation never reopens the parent or mirrors selection
  into React state. The old broad `shouldClearSessionUrlTab` normalizer remains dead.
  In-conversation created-Session cards can carry only the child Session id. When that id is
  already a known tab in the mounted workspace, navigation stays local; a closed target goes
  through the lifecycle-aware reopen action and waits for its open metadata projection before
  selection instead of routing through the child root URL or letting stale close metadata
  redirect the explicit request to an open sibling.
  The pending request is keyed by its source Session as well as its URL tab value, so
  switching between two tabless Session routes cancels the old request.
  Promotion keeps its `pendingDraftChildSessionIds` entry
  as a draft→child resolution alias through the send window. The ABSENT value
  means "no explicit choice" and is reserved for external entries: the session
  ROUTE's `beforeLoad` fills it from the last-active store as one replace
  redirect (the route has its own navigation's params, so no workspace-slug
  staleness to dance around), which is why in-session activation encodes the
  parent EXPLICITLY as `session:<parentId>` (`formatExplicitSessionTabSearch`)
  — an absent parent write would be re-restored. Cross-surface "go to session"
  links keep `formatSessionTabSearch` (parent → absent → restore). Every
  `session-detail.tsx` URL writer goes through `writeSessionUrlTab`, which
  drops a write whose captured session no longer matches the current route —
  an async caller resolving after a switch must not yank the router back.
