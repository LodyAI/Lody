# React hooks

Root and `packages/components/AGENTS.md` also apply. `CLAUDE.md` is a symlink to
this file; edit `AGENTS.md` only.

- Conversation virtualization and bottom-following are separate concerns.
  `virtua` owns mounted rows, measurement, and index navigation.
  `use-sticky-scroll.ts` adapts `use-stick-to-bottom` to Virtua's viewport and
  content elements; do not restore a content-token effect or a distance-based
  upward-scroll threshold. Any real upward wheel, touch, selection, or scrollbar
  movement must release streaming follow immediately.
- Sticky-scroll binds through the real scroll viewport's React callback ref. Keep
  the conversation on Virtua's public `Virtualizer` primitive with that explicit
  viewport; never recover the element from a `VList` handle, DOM query, item-count
  effect, observer retry, or timer. Empty-to-populated conversations must attach
  on the viewport's actual mount commit and detach on its unmount commit.
- Treat `use-stick-to-bottom`'s `state.isAtBottom` as the follow-lock truth. Its
  returned `isAtBottom` also includes near-bottom tolerance, while
  `escapedFromLock` is escape history and does not become false merely because an
  explicit `scrollToBottom` restored the lock.
- Follow viewport-size changes from the viewport's `ResizeObserver` records.
  Keyboard and terminal transitions resize that same element, so do not restore
  custom resize-event pumps, guessed transition durations, or stop timers.
- A session composer height change sets a one-shot ref immediately before its
  inline height write. Consume that ref only for the next viewport _height_
  resize, without calling `scrollToRealBottom`; it preserves the reader's
  position while typing without changing keyboard, terminal, or window-resize
  follow behavior. Keep it separate from programmatic-jump suppression.
- Group expansion scrolls after Virtua descendants finish their layout effects,
  and releases sticky suppression in the later parent layout effect of the same
  commit. Do not reintroduce frame retries or guessed settle timers.
- Preserve the app-specific adapters around the library: per-session scroll
  restoration, search/group-expansion suppression, and viewport resize handling
  for the mobile keyboard and terminal dock. The library observes content growth;
  it does not replace Virtua or own those product-level behaviors.
- `useStableSession` treats an HTTP 401 from `authClient.useSession()` as a
  potentially stale response and verifies it once with the current credential.
  Only a second 401 for the unchanged local token is terminal: stop retrying,
  ignore cached user/bootstrap and grace state, and confirm unauthenticated so
  the root sign-out path clears both Lody auth state and platform credential
  storage. A rotated token or successful verification fences late responses from
  an older login. Native login also holds `nativeSignInInProgressAtom` from the
  first sign-in request through successful page replacement because its
  Capacitor credential and local token are not written atomically; root session
  invalidation must respect that fence. Do not extend terminal handling to
  transport failures such as timeouts, 5xx, or `Client disconnected`; those
  remain retryable and must not sign out an otherwise recoverable user.
- `use-workspace-catalog.ts` reads a ref-counted per-workspace room in
  `lib/workspace-catalog-room.ts`; it must not open the Flock document,
  subscribe, or join the room per mount. The catalog is ONE small document, but
  a consumer mounts for every visible session plus every hidden child tab and
  side chat, so per-mount leases multiply room joins and duplicate row maps for
  one list — the same problem `use-machine-flock-rows.ts` ref-counts away. The
  shared snapshot is also identity-stable across mounts, which is what lets the
  selection and composer-menu memos built on it actually hit. MCP servers and
  Agent Roles are two row families of that ONE document, so
  `use-workspace-mcp-catalog.ts` and `use-workspace-agent-roles.ts` both derive
  from that room rather than opening a second one.
- Catalog `upsert`/`remove` (Agent Roles and MCP alike) resolve on DURABILITY;
  the upload runs on its own and no surface waits for it or reports it. A dialog
  that awaited the upload sat open for the whole round trip, and the row it had
  already written showed up in the catalog underneath it — so the open create
  form reported its own name as taken (`resolveAgentRoleNameCheckExemption`)
  moments before closing on success.
- `use-workspace-agent-roles.ts` filters the catalog through the shared
  `listAccessibleAgentRoles` / `resolveAgentRoleAvailability` rules, never a
  local predicate: hiding a private Role in the UI is not an access check, and
  an availability rule copied into a component is one that can drift into a
  silent fallback. Availability stays `unknown` — not `unavailable` — until that
  machine's agent-config rows are read, which is why it subscribes exactly the
  machines the given Roles point at. The Settings list groups by machine, so a
  row states only the reasons about its own binding; `machine_offline` is left
  to the group's machine pill rather than repeated on every row under it.
- `use-app-store-review-prompt.ts` establishes its historical baseline only from
  the first ready-and-synced session snapshot. Hydrated turns seed eligibility but
  never trigger a prompt; later finalized turns are processed once, and streaming
  updates with no new outcome must not synchronously rewrite local storage. Its
  idle timer depends on the stable candidate turn id, not the derived outcomes
  array, so an identity-only history update cannot consume and cancel the prompt.
  The negative-context gate reaches the timer through a ref for that same reason.
  Persisted state (`lody:app-store-review:v2:<userId>`, device-local, not synced
  and deliberately NOT in `clear-local-cache.ts` — it is user state, not cache)
  is just the newest 50 completed-turn timestamps plus the last attempt time.
  That list answers the whole threshold — if the oldest of the newest N is
  already outside the window then fewer than N are inside it — and its last
  element doubles as the watermark that makes a repeated history scan
  idempotent, replacing v1's list of up to 512 `sessionId:turnId` strings that
  were re-serialized on every completed turn. It is also why the recording
  effect can pass the whole outcomes array instead of diffing against a
  per-mount observed set. Because that watermark is a stored timestamp, NO
  stored time may ever be in the future: turn times come from the agent
  machine's clock and `nowMs` from the phone's, so a stored future value
  swallows every genuinely newer turn until real time catches up to it. Future
  input is rejected (deferred, not lost — the next history update re-scans the
  session) and stored future times are dropped, so a phone clock corrected
  backwards heals on the next turn. It under-counts by design: a session opened OLDER than the
  watermark does not backfill, which can never manufacture eligibility. Keep the product gates at engagement + cooldown + a narrow
  negative-context check — StoreKit already caps the sheet at three per device
  per 365 days, so a second rate limiter here only makes the prompt unreachable,
  which is exactly what v1's active-day and 72h-any-failure gates did.
  StoreKit reports nothing back and every gate is device-local, so
  `mobile/app_store_review_prompt_requested` / `_blocked` are the only evidence
  that the path works at all: `requested` fires once per actual bridge call, and
  `blocked` names the FIRST gate a candidate turn died on — policy gates from
  `resolveAppStoreReviewBlockReason` plus the runtime ones (missing bridge, text
  entry, interaction cancel, hidden app). `blocked` is deduplicated per user AND
  per reason for the app process's lifetime: a candidate turn arrives on every
  completed turn, so an undeduplicated event would be among the noisiest in the
  product, while deduplicating on the user alone lets the first gate mask the
  rest. Keep both bounds when adding a gate.
- `use-session-doc.ts` publishes the initial mirror snapshot immediately, then
  coalesces history-only mirror bursts to the latest snapshot once per animation
  frame through `lib/latest-frame-subscription.ts`. Session history snapshots are
  state, not an event log: rendering every intermediate ACP/CRDT snapshot can
  queue minutes of React work behind a long active turn and retain every obsolete
  history tree. Control state (`session`, message queue, fork, preview, external
  cursor) stays synchronous; do not delay it behind transcript rendering or
  restore a direct `setState` for history-only mirror events.
- Code Collab file-index hooks borrow owner-session resources from the
  workspace-owned Effect `ScopedCache`; do not open, scan, subscribe, or join
  the same Flock once per React mount. The resource subscribes before its cold
  scan, advances by batch events, and compares the Flock version before any
  remote catch-up rescan. Each cache entry holds a loro-repo Flock lease; LRU
  eviction closes its room and Flock subscriptions, releases the lease, then
  unloads the replica; a room that finishes joining after eviction is
  unsubscribed and gets a second best-effort unload. Failed opens are not
  cached, and a failed room resource is invalidated after its last borrower
  releases. Workspace disposal closes every borrower Scope before destroying
  the repo. Cache-resource identity is part of provider memoization because a
  recreated resource restarts its local revision counter. Local-machine RPC
  snapshots seed the shared resource before it becomes visible, so first paint
  stays local while later Flock events remain deduplicated across mounts.
- `use-safe-area-insets.ts` is ONE module-level store. `DropdownMenuContent` and
  `PopoverContent` run it even when closed, so a session switch mounts hundreds
  of subscribers and a per-instance `getComputedStyle` forces a full-document
  style recalculation after the commit dirtied style. Keep the snapshot identity
  stable while values hold; keep the resize listeners for the document's life.
- `use-keyboard-navigation.ts` issues at most one session navigation per painted
  frame: with no frame outstanding a press navigates and re-anchors on the route,
  during an owed frame it only advances the target. A switch renders
  synchronously for longer than the key repeat, so a held shortcut otherwise
  queues renders nobody sees. Not a time-based debounce.
