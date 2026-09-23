# React hooks

Parent AGENTS apply. Edit `AGENTS.md`, not its `CLAUDE.md` symlink. Background: [README.md](README.md).

## Conversation scrolling

- Only viewport/tail/selection render bodies; other reads keep placeholders.
- Reveal when data and measured destination agree; ignore early range reports.
  Reapply cached offsets until reveal; navigation supersedes them.
  Key readiness/window by `factSource ?? view`; new sources reset both.
  Restore before paint; hydration follows DOM extent only with the follow lock.
- Correct content measurements in ResizeObserver before paint, even with unchanged
  row counts; no RAF deferral. Correct Virtua spacer-height commits in MutationObserver
  before deferred resize delivery. Observe spacer height and mounted row geometry
  (which may overflow it), never message subtrees/text or scroll pointer styles. Respect the live follow
  lock and explicit jump suppression.
- Virtua owns rows, measurement and index navigation; `use-sticky-scroll.ts` adapts
  `use-stick-to-bottom` to its viewport/content. No content-token effects or upward
  distance thresholds: real upward wheel, touch, selection or scrollbar movement
  releases streaming follow immediately.
- Bind through the viewport's React callback ref on Virtua's public `Virtualizer`;
  detach on unmount, including empty-to-populated transitions. Never recover it from
  a `VList` handle, DOM query, item-count effect, observer retry or timer.
- Follow-lock truth is `state.isAtBottom`: the returned `isAtBottom` includes tolerance;
  `escapedFromLock` records escape history and survives explicit re-locking.
- Handle viewport HEIGHT changes through ResizeObserver; ignore width-only records.
  No resize-event pumps, guessed transition durations or stop timers. Before a composer
  inline-height write, set a one-shot ref consumed only by the next viewport height
  resize, without `scrollToRealBottom`; keep it separate from jump suppression.
- Group toggles never scroll. Observer deliveries must never re-arm the follow
  lock — only scroll events may — so the content ResizeObserver releases a
  same-delivery re-lock while the commit-time snapshot says not-following. No
  frame retries/settle timers.
- Preserve per-session restoration, search/expansion suppression and viewport resizing
  for keyboards and terminal docks.

## Session, auth, and app shell

- History uses SessionData commands.
- A proven-undelivered steer (`no-active-turn` or `promotion-failed`) repairs ordinary
  dispatch for pending/seen entries even if CLI already changed their status. Never
  repair active, terminal, removed, or delivery-unknown turns.

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

- `use-workspace-catalog.ts` reads the ref-counted room in
  `lib/workspace-catalog-room.ts`. Never open, subscribe or join per mount. MCP servers
  and Agent Roles share that ONE Flock document; their hooks derive from the room and
  preserve snapshot identity across mounts.
- Role/MCP catalog `upsert`/`remove` resolve on DURABILITY; upload runs independently
  and no surface waits for or reports it.
- Role filtering uses shared `listAccessibleAgentRoles` / `resolveAgentRoleAvailability`,
  never local predicates. Availability stays `unknown` until bound machine configs load;
  subscribe exactly those machines. Settings rows describe their own binding;
  `machine_offline` belongs to the group pill.

## Code Collab

- File-index hooks borrow owner-session resources from the workspace Effect
  `ScopedCache`, never open/scan/subscribe/join per mount. Subscribe before cold scan,
  advance by batches and compare Flock versions before remote catch-up rescans.
- Each entry owns a loro-repo Flock lease. LRU eviction closes room and Flock
  subscriptions, releases the lease, then unloads the replica. Late room joins after
  eviction must unsubscribe and best-effort unload again. Never cache failed opens;
  invalidate failed resources after their last borrower releases.
- Workspace disposal closes borrower Scopes before destroying the repo. Provider
  memoization includes cache-resource identity. Local-machine RPC snapshots seed the
  shared resource before exposure; later Flock events stay deduplicated across mounts.

## Mobile prompts and Live Activity

- `use-app-store-review-prompt.ts` takes its baseline only from the first
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
