# The mobile turn footer counts up while the turn runs

Status: implemented
Translation: current

[中文](2026-09-14-mobile-live-turn-duration.zh.md)

## Abstract

On mobile the assistant turn's action bar reserves a leading duration slot whose
width is load-bearing — it is what pushes the copy and fork buttons out of the
session drawer's left-edge back-swipe strip — but it was only ever filled for a
finished turn. While the agent was still working the bar therefore rendered two
icons beside a conspicuously empty gutter, and the one question a user has at
that moment (how long has this been going?) had no answer on screen. The slot now
counts up once a second from the turn's own `timestamp`, the same anchor the
finished label resolves from, so a turn that never waited on permission stops
rather than jumps — one that did steps down by the length of the wait, because
the machine writes `permissionWaitMs` only at finalization. The ticking is
confined to a leaf component subscribed to the shared `useStableNow` ticker, so
one live turn costs one re-rendering span rather than a re-render of every
visible footer. The limit worth naming: "live" means
the conversation's last assistant turn with `finished !== true`, which is a
structural claim, not a liveness probe — a turn the machine abandoned without
writing `finished` keeps the slot empty rather than counting forever, but only
because a newer turn displaces it.

## Decision

### The anchor is the turn, not the session

The obvious source for "how long has the agent been working" is session presence,
since that is what already drives every working indicator. It is the wrong source
here: `LodySessionPresenceState` reports *that* a session is active and its status
type, but carries no start instant — `updatedAt` is a 30-second heartbeat. A
presence-anchored timer would have to reconstruct the start from a client-observed
transition plus `SessionMeta.lastRunningSeen`, and `lastRunningSeen` is rewritten
on every non-idle transition, so a permission round-trip restarts it.

The turn already carries the right number. `resolveSessionHistoryDurationMs`
defines the finished label as `(endedAt - timestamp) - permissionWaitMs`;
`resolveLiveSessionHistoryDurationMs` is the same expression with `now` in place
of `endedAt`. That equality is the point: the live and finished labels are one
quantity observed at two moments, so the transition at turn end is a stop, not a
correction.

### The permission wait is the one term the live path cannot see

That equality holds for the `timestamp` term and breaks for `permissionWaitMs`.
The CLI accumulates the wait in its transient store
(`apps/cli/src/lib/session-transient-store.ts`) as each request resolves and puts
it on the history entry only through the `finish-assistant` action
(`message-handler.ts`). A live entry therefore has no `permissionWaitMs` at all,
so the live label counts the user's own thinking time, and at finalization it
steps DOWN by the whole wait. For a turn with no permission card — the common
case, and every case under an auto-approving mode — the two agree exactly.

No client-side repair is sound. The client can see *that* a request is
unanswered (a `tool_call` whose `permissionRequest` has no `outcome`) but not
when the wait began: `PermissionRequestInfoSchema` carries no timestamp.
Accumulating the pause by observation fails for a second reason — the footer
lives in a virtualized list, so scrolling the live turn out of view unmounts the
observer and loses the total. Closing this properly means publishing the live
wait from the machine: the running `permissionWaitMs` written as each request
resolves, plus the start of an in-flight wait, so a client can subtract both
without local state. That is a schema plus CLI change and is deliberately not in
this one.

The one deliberate divergence: a start in the future (a machine clock running
ahead) clamps to `0s` instead of returning null as the finished form does. The
slot is reserved either way, and the whole reason for this change is that an
empty reserved slot reads as a layout bug.

### Which turn is live

`isLive` is computed where the rows are built, as
`isLastAssistantMessage && message.finished !== true`, and travels on the footer
row. `finished !== true` alone is not enough: an interrupted or abandoned turn
stays unfinished in history forever, and every such turn would have counted up
side by side. Requiring it to be the last assistant turn bounds that to at most
one row, and the row cache already invalidates on `isLastAssistantMessage`, so no
new invalidation had to be invented.

This is structural, not a liveness check. A session whose machine died mid-turn
leaves its last turn unfinished, and that turn will keep counting until something
displaces it. Reading presence in the footer would fix that case at the cost of a
per-turn atom subscription in the most-mounted component in the conversation,
which is not a trade worth making for a state the user resolves by looking at the
composer.

### Why a leaf component

`useStableNow` is a shared ticker: subscribers get one interval between them and
a tick re-renders only what subscribed. Calling it in `AssistantTurnFooter` would
have re-rendered every visible turn's footer on every tick, including finished
ones with nothing to update. `LiveTurnDurationLabel` is mounted only on the live
turn, so the subscription exists exactly when there is something to count.

### Sampled faster than it is displayed

The label changes once a second but samples at 300ms, because "once a second" and
"on the second" are not the same thing here. The shared ticker's phase is set by
whichever subscriber mounted first — it has no relation to when this turn
started — so a 1s sample can land anywhere inside the elapsed second. The digit
would then change at a visibly arbitrary instant and, worse, sit up to a full
second behind the truth: a turn 5.4s old reads `5s` until the sample fires, which
may be 600ms after it should already have read `6s`.

Sampling at 300ms bounds that error to 300ms without changing what is rendered:
the formatted string is identical across the extra samples, so React reconciles
the same text and writes nothing to the DOM. The cost is two additional leaf
renders per second, on one span, and only while a turn is live. Anchoring a
private `setTimeout` to the turn's own start would be exact rather than bounded,
but it trades the shared ticker for a timer per live turn and re-introduces the
drift handling `useStableNow` already owns; 300ms is close enough that the
difference is not observable.

`SessionChatActionContext` is now exported. An unfinished turn's action bar is
gated on a copy-context handler existing, so that gate is part of the state under
test, not scaffolding around it; the test drives the real component through it.

## Verification

`tests/session-history-duration.test.ts` pins the live resolver, including that it
agrees with the finished form on the same turn and clamps a future start.
`tests/assistant-turn-action-inset.test.ts` renders the mobile footer under fake
timers: a live turn advances `Worked for 5s` → `Worked for 7s`; a turn whose
start is offset from the ticker's phase by 400ms holds `5s` at 5.9s elapsed and
already reads `6s` at 6.1s; a finished turn holds its recorded value across five
seconds; and a non-live unfinished turn leaves the slot empty with its reserved
`min-width` intact. Removing the live branch fails the first of those and only
that one; restoring a 1s sample period fails the phase case and only that one.

`MobileTurnDurationSlot.stories.tsx` renders both states in a phone frame;
driving the live story in a browser read `Worked for 48s` and `Worked for 51s`
three seconds apart.

`tests/chat-virtual-rows-identity.test.ts` pins the memo: when a newer turn
displaces an abandoned unfinished one, the displaced footer's rebuilt row must
NOT compare equal to the mounted one. Without `isLive` in that comparison the
memo skips the re-render and the old label keeps counting beside the new turn's,
defeating the one-row bound; the test fails in exactly that state.

Not verified: behavior across a device sleep/resume, where the interval is
throttled — the next tick corrects the value, but the interim frame was not
observed on a real device. The permission-wait step-down above is a known unfixed
gap, not a verification limit.
