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

- The info bar owns one unstaged scheduled-message icon. Its popover shows the
  send time and an Edit pill; the composer has no inline time bar. The editor uses
  typed date/time with 30-minute, 1-hour and 5-hour presets; removing the time
  preserves the message. Composer and info-bar controls share the same scoped
  draft and save lock, so an accepted edit changes the actual send time.
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
- The leaf pending summary opens Schedule details. Complete-message details retain
  the once/current-chat target and edit the full payload; generic manual-run/resume
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

| Dimension | Proposed values / meaning |
| --- | --- |
| Local request | preparing, saved locally, awaiting owner, rejected/conflict |
| Owner receipt | request ID, accepted revision/fingerprint, result, receipt sequence |
| Delivery | scheduled, waiting (busy/offline/sync), dispatching, sent, cancelled, failed |

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

## Visual alternatives under review

The real queue exposes optional roomy rows and inline leading/trailing metadata.
Three Storybook alternatives compare time first, content first, and a more spacious
content-first row. Their title is simply Message queue; time is muted, regular-weight
underlined text on the message line. The shared calendar/time picker removes its
repeated timestamp/timezone summary and uses one confirmation action. These options
are preview-only pending visual selection; ordinary queue defaults are preserved.
Real-row editing tests (12) and component typecheck pass; browser checks exercise
editing and time changes. No backend scheduling behavior changes in this iteration.

Mobile preview hides row numbers and keeps time plus message inline on one ellipsized line. Rows retain 12px leading padding, no vertical padding, and one trailing More menu containing icon-labelled Edit and destructive Delete; ordinary non-scheduled rows additionally offer Move to top through the existing reorder callback (disabled at the head), while scheduled rows never do. The queue sheet extends 16px behind the composer corners with a matching negative bottom margin, joining the side edges without adding visible spacing. The surrounding preview inset is reduced. Time editing uses the existing modal primitive on mobile devices; desktop retains its popover. Final rendered screenshots at 320/390/430px were inspected, and phone emulation verifies modal time changes plus menu edit/save/remove without overflow.

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
