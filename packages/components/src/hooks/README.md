# `src/hooks` — background

Binding rules for this directory live in [AGENTS.md](AGENTS.md); this file keeps
the reasoning behind them so the rules can stay short. It explains only the hooks
that carry an invariant — the directory itself is the list of hooks.

## Conversation scrolling (`use-sticky-scroll.ts`)

`virtua` owns mounted rows, measurement, and index navigation. `use-stick-to-bottom`
only observes content growth; it does not replace Virtua and does not own the
product-level behaviors (per-session scroll restoration, search and group-expansion
suppression, mobile keyboard and terminal-dock resizing) that the app adapters add
around it. That is why the two concerns stay separated and why recovering the
viewport element by DOM query, `VList` handle, item-count effect, observer retry, or
timer is banned: only the viewport's own React callback ref fires on the real mount
and unmount commits, which is what an empty-to-populated conversation depends on.

`ResizeObserver` records are the single source of viewport-size change because the
mobile keyboard and the terminal dock resize that same element; custom resize-event
pumps and guessed transition durations were the earlier, unreliable version. Only
height matters: a flex sibling such as the desktop sidebar can animate its width
every frame, and forwarding width-only records competes with the content observer's
bottom correction and visibly jitters the conversation.

The composer one-shot ref preserves the reader's position while typing without
changing keyboard, terminal, or window-resize follow behavior, which is why it is
consumed for exactly one height resize and is not merged into programmatic-jump
suppression.

## `useStableSession`

A single HTTP 401 can be a stale response, so it is verified once against the
current credential; only a second 401 for the unchanged local token proves the
session is gone. Native login writes its Capacitor credential and the local token
non-atomically, so `nativeSignInInProgressAtom` fences the window between the first
sign-in request and successful page replacement. Timeouts, 5xx, and
`Client disconnected` are transport failures: signing out on them would eject a user
whose session is fine.

## Workspace catalog hooks

The workspace catalog is ONE small document, but a consumer mounts for every visible
session plus every hidden child tab and side chat, so per-mount leases multiply room
joins and duplicate row maps for a single list — the same problem
`use-machine-flock-rows.ts` ref-counts away. The shared snapshot is also
identity-stable across mounts, which is what lets the selection and composer-menu
memos built on it actually hit.

Catalog `upsert`/`remove` resolve on durability because a dialog that awaited the
upload sat open for the whole round trip, and the row it had already written showed
up in the catalog underneath it — so the open create form reported its own name as
taken (`resolveAgentRoleNameCheckExemption`) moments before closing on success.

Hiding a private Agent Role in the UI is not an access check, and an availability
rule copied into a component is one that can drift into a silent fallback; both stay
in the shared `listAccessibleAgentRoles` / `resolveAgentRoleAvailability` helpers.

## `use-session-doc.ts`

Session history snapshots are state, not an event log. Rendering every intermediate
ACP/CRDT snapshot can queue minutes of React work behind a long active turn and
retain every obsolete history tree, so history-only bursts coalesce to the latest
snapshot once per animation frame while control state stays synchronous.

## `use-app-store-review-prompt.ts`

The stored list of the newest 50 completed-turn timestamps answers the whole
threshold — if the oldest of the newest N is already outside the window then fewer
than N are inside it — and its last element doubles as the watermark that makes a
repeated history scan idempotent. That replaced v1's list of up to 512
`sessionId:turnId` strings re-serialized on every completed turn, and it is why the
recording effect can pass the whole outcomes array instead of diffing against a
per-mount observed set.

Because that watermark is a stored timestamp, no stored time may be in the future:
turn times come from the agent machine's clock and `nowMs` from the phone's, so a
stored future value would swallow every genuinely newer turn until real time caught
up. Future input is deferred rather than lost (the next history update re-scans the
session), and stored future times are dropped so a phone clock corrected backwards
heals on the next turn. The scheme under-counts by design: a session opened older
than the watermark does not backfill, which can never manufacture eligibility.

StoreKit already caps the sheet at three per device per 365 days, so a second rate
limiter here only makes the prompt unreachable — exactly what v1's active-day and
72h-any-failure gates did. StoreKit reports nothing back and every gate is
device-local, so `mobile/app_store_review_prompt_requested` / `_blocked` are the only
evidence that the path works at all. A candidate turn arrives on every completed
turn, so an undeduplicated `blocked` event would be among the noisiest in the
product, while deduplicating on the user alone would let the first gate mask the
rest.

## Code Collab file-index hooks

Owner-session resources are borrowed from the workspace-owned Effect `ScopedCache`
so that opening, scanning, subscribing, and joining happen once per session rather
than once per React mount. A recreated cache resource restarts its local revision
counter, which is why resource identity is part of provider memoization.
Local-machine RPC snapshots seed the shared resource before it becomes visible, so
first paint stays local while later Flock events remain deduplicated.

## `use-safe-area-insets.ts`

`DropdownMenuContent` and `PopoverContent` run this hook even when closed, so a
session switch mounts hundreds of subscribers. A per-instance `getComputedStyle`
would force a full-document style recalculation after the commit dirtied style.

## `use-keyboard-navigation.ts`

A session switch renders synchronously for longer than the key repeat interval, so a
held shortcut would otherwise queue renders nobody sees. The one-navigation-per-
painted-frame rule is a frame budget, not a time-based debounce.

## `use-lody-live-activity.ts`

`atoms/doc-meta` republishes the session and agent-config arrays once per flushed
batch, so a cold start reset the 250ms timer before it ever fired while every batch
still paid for a full summary rebuild — hence the leading-edge throttle on the input,
anchored to the last emit. The permission candidate is a fresh object per scan, so
depending on it re-runs the payload memo every render.

The 250ms bridge debounce stays for a different job: a flush lands in the commit
after the change that requested it, and without the debounce the bridge gets both,
the stale one marking the alert shown so the fresh one is dropped by the
already-alerted early return.

`iosLiveActivitiesEnabledAtom` defaults to true, so without the native-shell check
every desktop build would rebuild a summary it can never show. The activity id is
derived outside that gate so the disable and unmount paths can still end an activity
the payload no longer describes.
