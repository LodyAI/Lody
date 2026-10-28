# Scheduled messages from the composer

Status: proposed
Translation: current

[中文](2026-10-27-scheduled-messages.zh.md)

## Abstract

An existing conversation offers **Schedule send…** inside its single `+` menu.
Choose a future instant, edit the message in the current composer, then confirm.
Reuse machine-owned Schedules for durable one-time delivery, with complete message
blocks and the selected execution configuration. New-chat scheduling is excluded.

## Decisions

- The composer owns the pre-send draft: one secondary action beside Send reads
  "发送定时消息 · <time>"; clicking it edits the time or removes the schedule, and
  removing the time preserves the message. The info bar has no scheduled-message
  item. The editor uses typed date/time with 30-minute, 1-hour and 5-hour presets.
  Revised 2026-10-27 after UI review; the earlier info-bar icon decision is rejected.
- The selected machine owns the clock. Presets and typed input use its IANA zone
  (device zone for legacy metadata). A sleeping/offline machine sends one catch-up;
  existing retry limits apply. A busy conversation waits without interruption.
- The composer persists its time and reservation identity per account/workspace/chat.
  Message drafts keep their existing in-memory lifetime. Removing the time preserves
  the draft; the persisted time alone is not an accepted reservation.
- Complete messages add `message.payload` to the Schedule document and
  `messageVersion: 1` to its strict definition. Freeze ordinary input blocks, MCP
  selection, Role provenance/prefix and selected agent/model/mode/options. Registry
  rows contain only a message marker, never message content. Legacy prompt tasks
  retain their fingerprints and schedules v2 support; full messages require v3.
  The strict marker prevents old peers from editing/executing a text-only projection.
- Reuse the [Schedule owner](../../implemented/feature/2026-09-24-machine-owned-scheduled-tasks.md),
  execution fingerprint and SQLite ledger. Transfer attachments through existing
  workspace `sendResources` before publishing a reservation; retain ready receipts
  on failed saves and recheck the time afterwards. A published reservation retains
  local attachment bytes even before a history entry exists. Incomplete reservation
  reads do not authorize reclamation.
- Navigation cancels preparation. An already-started durable write may still land,
  so retries reuse reservation/activity identities. Clear only the captured composer
  draft after acceptance. At the due time, the existing prepared-input handoff takes
  frozen blocks/configuration and stable Session/Turn IDs through retries/restarts.
- The queue's dedicated Scheduled section edits a reservation's time in place and
  opens Schedule details or cancels from the row; reservations never enter executable `mq`. Complete-message details retain the
  once/current-chat target and edit the full payload; generic manual-run/resume
  controls are hidden. Ownership, machine capabilities and workspace content gates
  remain required. Cancellation disables the reservation; show waiting-for-machine
  until the engine reconciles dispatch. A committed dispatch wins and shows sent;
  otherwise acknowledge cancellation after skipping prehandoff work. Agent outcome
  remains separate from handing a message to the conversation.

## Queue presentation and synchronization proposal

Reuse the queue presentation and body editor, but keep scheduled reservations out
of Session `mq`. The real-component Storybook is a UI proposal only. Ordinary queue
consumers select the head without a deadline check; adding an unknown time field
would let older CLIs send immediately. A tagged view model (`queued` / `scheduled`)
can combine both sources without copying reservations into the executable queue.
Scheduled row callbacks save/cancel Schedule operations rather than mutating `mq`;
ordinary drag order and steer actions do not apply to scheduled rows.

Keep complete content/configuration in the Schedule Loro document, discovery and
execution publication in the workspace Schedule Registry Flock, and execution
recovery in the owning machine's SQLite ledger. Use existing Repo transport and
workspace capability gates; no new cloud service or renderer timer. A registry row
without its matching full payload must remain non-executable. Attachments must be
ready before publication and retained throughout pending delivery. Times persist
as absolute instants; the picker uses the execution machine's zone.

The current repository flushes the definition before publishing its fingerprint.
This is local persistence, not proof that the owner has received or accepted it.
The engine checks fingerprints and connection-generation readiness and uses stable
prepared input identities. Those mechanisms are reusable, but they do not provide
an acknowledged, serial edit/cancel protocol. Current `save` has no expected-revision
check; CRDT convergence alone is not an execution decision.

Propose durable, idempotent create/edit/cancel requests for scheduled messages,
identified by request ID and reservation ID, with an expected accepted revision
on edits/cancels. Store requests through the existing workspace replication layer;
only the owning machine accepts them. Serialize request acceptance with due-time
handoff, record the accepted revision/result durably, and project that receipt back
to other devices. Repeated request IDs return the same result. Concurrent edits
against one revision yield one acceptance and one conflict, retaining the losing
client's draft. Immutable requested payloads must be fully available and match their
fingerprint before acceptance. This is a proposed extension to Schedule ownership,
not a second scheduler, and needs an explicit capability/version gate. Old writers
must not be able to bypass the accepted-revision path for these reservations.

Cancellation is terminal for that reservation ID and never revives through a stale
edit. The owner reconciles durable dispatch evidence before deciding: cancellation
accepted first prevents handoff; committed dispatch first returns already sent.
An offline client may save a cancellation request but cannot promise it took effect;
the previously accepted version may still send. Likewise an unacknowledged time edit
does not replace the previously accepted deadline. Owner downtime delays confirmation
and dispatch; cloud-backed handoff continues to require current sync readiness.

Expose separate synchronization and delivery dimensions:

| Dimension     | Proposed values / meaning                                                    |
| ------------- | ---------------------------------------------------------------------------- |
| Local request | preparing, saved locally, awaiting owner, rejected/conflict                  |
| Owner receipt | request ID, accepted revision/fingerprint, result, receipt sequence          |
| Delivery      | scheduled, waiting (busy/offline/sync), dispatching, sent, cancelled, failed |

Delivery transitions are owned by the machine. Offline is an availability overlay,
not a durable terminal state. A client clock passing the deadline can show time
elapsed, but cannot claim dispatching or sent. A stale receipt cannot acknowledge a
newer edit; match reservation, request/revision, machine and monotonically ordered
receipt. Keep last accepted time visible while an edit or cancellation is pending.
Treat provider completion/failure separately from sent (durable Session handoff).
After handoff, reconcile the scheduled row against its stable user-turn identity so
it disappears from pending once and becomes the ordinary conversation message.

At the due time, reuse the existing prepared-input handoff while waiting for a busy
Session; do not insert into `mq` merely to reuse its UI. Arbitration with ordinary
queued work still needs a deterministic fairness rule; the proposed baseline keeps
already queued ordinary work ahead and orders due reservations by deadline then ID.
Future reservations never block ordinary messages. No cross-kind drag ordering or
implicit send-now action is proposed.

Required validation before implementation is considered complete: two peers editing
one revision, disconnected cancel racing handoff, late/stale receipts, partial
payload publication, crashes before/after dispatch commit, owner restart, older
client capability rejection, attachment retention, and busy-session arbitration.
This pass is source-grounded design research; it adds no runtime implementation or
new end-to-end verification. Current runtime fields (`messageState`, `queueState`,
`observedDefinitionFingerprint`) are useful projections, not the complete proposed
receipt protocol.

## Current flow audit (2026-10-27)

Before this follow-up, the shipped path used the pre-queue surface: after Send,
`ScheduledMessagesSummary` rendered one ghost line below the info bar and opened the
generic Schedule detail page. The queue display already accepted scheduled-time rows,
but production passed only `mq`; the Storybook preview classified reservations by
faking `MessageQueueItem`, so it did not describe a shippable data path. The delivered
turn also loses provenance: the synthetic "Scheduled task…" source is filtered by the
conversation renderer, and the user turn looks typed.

After the follow-up, the pre-send state is the composer's secondary action and the
info bar has no scheduled item. Post-send reservations are read-only rows in the
queue's dedicated Scheduled section, supplied by a separate view model. The control
semantics are resolved: that secondary action is the state editor, and the primary
Send commits the message as scheduled. Remaining open items are the time-editor form,
a quiet delivered-turn provenance marker, and inline edit/cancel, which still depends
on the receipt protocol below.

## Terminal retention

The owner worker runs a retention sweep on every ready evaluation. When a
complete one-time message's runtime row is terminal (`sent`, `cancelled`, or
`failed`) and its `updatedAt` is at least `SCHEDULED_MESSAGE_RETENTION_MS`
(seven days) old, the owner purges the `schedule-<id>` document, removes the
Registry schedule/runtime/manual rows, and leaves a tombstone. The timer starts
at the terminal projection, not at creation. A busy document (open detail view or
in-flight sync) is left for the next pass.

Pending or active reservations and non-message Schedules are not swept. This is
owner-local cleanup: the tombstone rejects stale offline writes, but it does not
claim physical compaction of Loro history or remote replicas.

## Sync robustness audit (2026-10-27)

The current promise is replication convergence plus the owner's 15-second wake
loop, not an acknowledgement. A daemon that was stopped at the due instant plans
when it returns: `run_once` catches up and `plannedAt` is then, so there is no
expiry measured from the scheduled time. A daemon that is running but not synced
waits at the sync gate and plans after reconnect. A run that was already planned
and then cannot dispatch expires after 24 hours or five attempts from `plannedAt`;
a chat that stays busy retries every 30 seconds against the same 24-hour window.

The two hard gaps are structural: the registry row is the only discovery and
execution gate, with no owner-side repair scan from Schedule documents; and the
client has no owner receipt or retry after its local flush. A missing registry row
therefore makes a reservation invisible and unexecutable, while a locally saved
row that never reaches the owner can stay Pending forever. The failure-mode matrix
lives in the review artboard; no production behavior changed in this audit.

## Queue presentation (2026-10-28)

Scheduled rows reuse the queued row layout instead of a separate design. The send
time leads the text inline (muted, tabular, capitalized relative label) and is the
row's direct control for the time editor; a failed send turns it destructive with
an alert glyph and a "Not sent" accessible label, never a status column. Actions
always end the row, matching queued rows; a design with the time at the end and
hover-revealed actions between title and time was rejected in review.

Rows are inset tiles without hairline dividers or a header divider. Desktop rows
share a 16px gutter (index, or empty for a reservation) aligned with the chevron and
Scheduled label; phones keep #1989's index-free single line. When the sheet is
narrower than 520px, or on phones, every row folds its actions into one More
button: queued rows keep Steer, move-to-top, edit and delete; scheduled rows offer
Edit scheduled time, Edit (details) and Cancel. Touch More buttons are real 44px
boxes; the previous Button-based trigger rendered at 32px. Data path, ordering and
callbacks are unchanged.

Presentation ordering is now specified: ordinary rows retain manual order, local attachment-preparation rows follow them, and scheduled rows always form the final section sorted by ascending send instant (ties retain input order). A time edit re-sorts the view. Scheduled rows are excluded from sortable IDs, drag sources/targets, move-to-top and steer. The display uses an explicit scheduled-time accessor; it does not infer scheduling from rendered text or add reservations to durable mq. Component tests cover sorting, changed times and the absence of scheduled drag handles. Backend reservation synchronization remains separate and unimplemented for this queue proposal.

## Lifecycle and Effect assessment

Trigger: explicit scheduled submission, then the machine's existing clock wake.
Owner: workspace send-resource scope during preparation; Schedule repository/ledger
once accepted. Cancellation: navigation stops preparation, explicit cancellation
revokes a future handoff, and an accepted dispatch retains ordinary Session ownership.
Recovery: stable reservation/activity IDs, ready attachment receipts, frozen ledger
payload and durable dispatch evidence. Runtime projections restore sent/failure state.

No additional scheduler, history writer or Effect runtime is introduced. A native
migration of Schedule planning is deferred because its Repo/session orchestration
is an unfinished Promise dependency chain; transfers reuse the existing native scope.

## Verification and limits

Tests use synthetic documents, injected clocks and temporary SQLite ledgers. They
cover real composer admission/failure/cancel-mode behavior, references, machine-zone
presets, Schedule replica persistence/idempotency, payload fingerprints, attachment-only
messages, catch-up, restart recovery and cancellation racing committed dispatch.
Existing ordinary send, Schedule form/list and persisted Session handoff suites remain
the regression boundary. Storybook checks render actual components at desktop/mobile
widths and in dark mode. No production cloud reservation, live provider execution or
packaged Electron acceptance is claimed.

## Delivery identity and concurrent creation

A complete message consumes its Schedule ID on durable dispatch, across all later
activations. The owning machine checks the SQLite dispatch history both before
planning and before processing pending work; after a stale-client edit it projects
the consumed message as sent rather than scheduling another delivery. Runtime
publication may inherit a prior dispatch only within the same activation; the
message's cross-activation sent result comes from the ledger, not a stale Flock row.
This does not implement owner-acknowledged edits: a locally saved edit can still
be superseded by the owner's already-sent receipt. Machine transfer and destructive
ledger loss are outside this guarantee.

For complete messages, atomic input blocks are the canonical prompt source. The
legacy LoroText prompt remains a compatibility projection, so concurrent creation
cannot concatenate the executed text. The once trigger instant supplies the
activation floor, independent of each writer's clock; cosmetic creation/update
timestamps remain local. Duplicate activity IDs are collapsed on read for complete
messages only. Ordinary prompt-only Schedule semantics remain unchanged.

Real two-peer tests cover different creation clocks, matching publication
fingerprints and uncertain-save replay. SQLite engine tests cover a sent message
followed by a stale activation edit and an engine restart. The info-bar test fixes
the device time zone explicitly and runs under UTC and Asia/Shanghai. No lifecycle
or transport ownership changes are needed; a native Effect migration is deferred
because the fixes stay within the existing ledger and pure read normalization.

## Admission isolation

Complete messages do not reserve or restore per-Agent-config execution slots. Those
slots continue to serialize generic scheduled tasks; a message waits only for its
own destination chat and for earlier work of the same Schedule. Consequently a
long-running message or generic task in another chat cannot delay it until dispatch
expiry. Existing ownership, fingerprint, activation, per-message ledger consumption
and SESSION_BUSY checks remain in place. Ledger completion still follows the target
turn's lifecycle; it owns no Agent slot. Release calls remain safe owner-keyed no-ops
for messages and cannot release another task's slot.

Four behavioral regressions fail before the change and pass after it: message to
message, generic task to message, message to generic task across worker restart,
and target-chat busy then idle while an unrelated generic slot remains occupied.
Existing generic-task waiting coverage remains unchanged. The expiry budget for a
message whose own target stays busy is unchanged; this change removes cross-chat
blocking rather than changing retry policy or adding a new concurrency owner.
