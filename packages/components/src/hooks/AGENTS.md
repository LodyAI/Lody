# React hooks

Root and `packages/components/AGENTS.md` also apply. `CLAUDE.md` is a symlink;
edit `AGENTS.md` only. Per-hook background and reasoning: [README.md](README.md).

## Conversation scrolling

- Keep virtualization and bottom-following separate: `virtua` owns mounted rows,
  measurement, and index navigation; `use-sticky-scroll.ts` adapts `use-stick-to-bottom`
  to Virtua's viewport and content elements. Never restore a content-token effect or a
  distance-based upward-scroll threshold. Any real upward wheel, touch, selection, or
  scrollbar movement releases streaming follow at once.
- Sticky-scroll binds through the real scroll viewport's React callback ref, on Virtua's
  public `Virtualizer` primitive with that explicit viewport. Never recover the element
  from a `VList` handle, DOM query, item-count effect, observer retry, or timer.
  Empty-to-populated conversations attach on the viewport's mount commit and detach on
  its unmount commit.
- Treat `use-stick-to-bottom`'s `state.isAtBottom` as the follow-lock truth: the returned
  `isAtBottom` adds near-bottom tolerance, and `escapedFromLock` is escape history that
  stays true after an explicit `scrollToBottom` restored the lock.
- Follow viewport-size changes from the viewport's `ResizeObserver` records; never
  restore resize-event pumps, guessed transition durations, or stop timers. Only HEIGHT
  changes may re-anchor the viewport; never forward width-only records.
- A session composer height change sets a one-shot ref immediately before its inline
  height write. Consume that ref only for the next viewport _height_ resize, without
  calling `scrollToRealBottom`, and keep it separate from jump suppression.
- Group expansion scrolls after Virtua descendants finish their layout effects and
  releases sticky suppression in the later parent layout effect of the same commit;
  no frame retries or guessed settle timers.
- Preserve the app-specific adapters: per-session scroll restoration,
  search/group-expansion suppression, and viewport resize handling for the mobile
  keyboard and terminal dock.

## Session, auth, and app shell

- `useStableSession` treats an HTTP 401 from `authClient.useSession()` as potentially
  stale and verifies it once with the current credential. Only a second 401 for the
  unchanged local token is terminal: stop retrying, ignore cached user/bootstrap and
  grace state, and confirm unauthenticated so the root sign-out path clears both Lody
  auth state and platform credential storage. A rotated token or successful
  verification fences late responses from an older login. Native login holds
  `nativeSignInInProgressAtom` from the first sign-in request through successful page
  replacement, and root session invalidation must respect that fence. Never treat a
  transport failure (timeout, 5xx, `Client disconnected`) as terminal; those stay
  retryable and must not sign out a recoverable user.
- `use-session-doc.ts` publishes the initial mirror snapshot immediately, then coalesces
  history-only mirror bursts to the latest snapshot once per animation frame through
  `lib/latest-frame-subscription.ts`. Control state (`session`, message queue, fork,
  preview, external cursor) stays synchronous: never delay it behind transcript rendering
  or restore a direct `setState` for history-only mirror events.
- `use-safe-area-insets.ts` is ONE module-level store: never add a per-instance
  `getComputedStyle`. Keep the snapshot identity stable while values hold, and the resize
  listeners for the document's life.
- `use-keyboard-navigation.ts` issues at most one session navigation per painted frame:
  with no frame outstanding a press navigates and re-anchors on the route; during an owed
  frame it only advances the target. Not a time-based debounce.

## Workspace catalog

- `use-workspace-catalog.ts` reads a ref-counted per-workspace room in
  `lib/workspace-catalog-room.ts`; it must not open the Flock document, subscribe, or
  join the room per mount. MCP servers and Agent Roles are two row families of that ONE
  document, so `use-workspace-mcp-catalog.ts` and `use-workspace-agent-roles.ts` derive
  from that room instead of opening a second one. Keep the shared snapshot identity
  stable across mounts.
- Catalog `upsert`/`remove` (Agent Roles and MCP alike) resolve on DURABILITY; the
  upload runs on its own and no surface waits for it or reports it.
- `use-workspace-agent-roles.ts` filters the catalog through the shared
  `listAccessibleAgentRoles` / `resolveAgentRoleAvailability` rules, never a local
  predicate. Availability stays `unknown` — not `unavailable` — until that machine's
  agent-config rows are read, so subscribe exactly the machines the given Roles point at.
  A Settings row states only reasons about its own binding; `machine_offline` belongs to
  the group's machine pill.

## Code Collab

- Code Collab file-index hooks borrow owner-session resources from the workspace-owned
  Effect `ScopedCache`; do not open, scan, subscribe, or join the same Flock once per
  React mount. The resource subscribes before its cold scan, advances by batch events,
  and compares the Flock version before any remote catch-up rescan. Each entry holds a
  loro-repo Flock lease: LRU eviction closes its room and Flock subscriptions, releases
  the lease, then unloads the replica, in that order; a room that finishes joining after
  eviction is unsubscribed and best-effort unloaded again. Never cache a failed open;
  invalidate a failed room resource after its last borrower releases. Workspace disposal
  closes every borrower Scope before destroying the repo, and cache-resource identity is
  part of provider memoization. Local-machine RPC snapshots seed the shared resource
  before it is visible; later Flock events stay deduplicated across mounts.

## Mobile prompts and Live Activity

- `use-app-store-review-prompt.ts` takes its historical baseline only from the first
  ready-and-synced session snapshot. Hydrated turns seed eligibility but never trigger
  a prompt; later finalized turns are processed once, and streaming updates with no new
  outcome must not synchronously rewrite local storage. Its idle timer depends on the
  stable candidate turn id, not the derived outcomes array, and the negative-context
  gate reaches that timer through a ref.
- Persisted state (`lody:app-store-review:v2:<userId>`) is device-local, not synced, and
  deliberately NOT in `clear-local-cache.ts` (user state, not cache). Store only the
  newest 50 completed-turn timestamps plus the last attempt time.
- NO stored time may ever be in the future: reject future input (deferred, not lost)
  and drop stored future times.
- Keep the product gates at engagement + cooldown + a narrow negative-context check;
  never add a rate limiter on top of StoreKit's own cap.
- `mobile/app_store_review_prompt_requested` fires once per actual bridge call;
  `_blocked` names the FIRST gate a candidate turn died on (policy gates from
  `resolveAppStoreReviewBlockReason`, plus missing bridge, text entry, interaction
  cancel, hidden app) and is deduplicated per user AND per reason for the process
  lifetime. Keep both bounds when adding a gate.
- `use-lody-live-activity.ts` throttles the summary INPUT; the bridge debounce cannot do
  that job. EVERY summary input goes through one leading-edge throttle whose trailing
  deadline is anchored to the last EMIT; one input left outside it restores starvation.
- Nothing reaching the payload memo may carry a per-render identity: depend on the
  permission candidate's key and title, not on the object.
- Keep the 250ms bridge debounce.
- Scan a pending permission request from the UNTHROTTLED list and flush the window, so
  the alert ships promptly with a summary that contains it; `shownPermissionAlertKeysRef`
  still shows one alert per candidate key.
- Compute nothing when the feature is off: `iosLiveActivitiesEnabledAtom` and the
  native iOS shell are BOTH required and are not equivalent. Derive the activity id
  separately from that gate so the disable and unmount paths can still end an activity
  the payload no longer describes.
