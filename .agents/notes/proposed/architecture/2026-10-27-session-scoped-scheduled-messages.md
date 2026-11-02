# Session-scoped scheduled messages

Status: proposed
Translation: current

[中文](2026-10-27-session-scoped-scheduled-messages.zh.md)

## Abstract

One document per one-time message adds document and registry retention to a session-local feature. Propose one durable Loro document per session, created on first use, with keyed message requests and execution receipts. A pinned machine accepts revisions and performs durable dispatch; the existing queue UI combines ordinary and scheduled sources. This replaces the storage choice in the [earlier proposal](../feature/2026-10-27-scheduled-messages.md), not general recurring Schedules. History compaction and physical deletion remain distinct from removing visible entries and require verified repository lifecycle support.

## Model and ownership

Use a proposed `smq-<sessionId>` document, separate from the executable `mq` list. Store protocol version, pinned owner, immutable requests keyed by request ID, and owner-written accepted entries/receipts keyed by message ID. Requests carry operation, expected revision, complete content/configuration and UTC send time; each revision is an indivisible value, avoiding mixed content/time from concurrent writes. Attachments remain external references. Reuse existing session discovery to derive the document ID, including closed sessions at owner startup. Do not introduce a per-message Registry; any discovery hint is non-authoritative and must be repairable by scanning owned sessions.

Only the pinned owner may accept requests or dispatch, with one active session executor. No automatic owner failover in this version. Validate workspace/session authorization and new protocol capability; legacy owners must reject this feature. The shared CRDT alone does not enforce owner authentication: existing authenticated request handling and actor checks must be integrated and verified before shipping. Protected-content capability gates remain unchanged.

## Synchronization and execution

Client persists a unique request locally, then existing repo local transport or cloud Streams transports replicate it. Owner waits for current catch-up, validates payload and attachment readiness, serializes request acceptance with due dispatch, and persists the resulting decision in its SQLite ledger. Replicate receipts after persistence; rebuild missing receipts after a crash. A request retry retains its ID and cannot become another creation.

Owner acceptance, not upload completion, starts the promise to send. Edits/cancels include expected accepted revision: stale revisions conflict. Until acceptance the previous accepted revision remains effective, which the UI must say. A dispatch decision freezes the accepted payload and stable turn/dispatch ID in the ledger before the prepared-session handoff. Cancellation accepted first prevents handoff; a committed handoff decision wins and rejects later edits/cancels. Retrying an ambiguous provider outcome must not blindly create another turn; preserve existing recovery behavior and expose uncertainty where necessary. Sent means durably handed to the session, not agent completion.

At the due instant, use the existing session send arbitration, wait for ordinary queued work and idle state, and never interrupt a turn. Scheduled candidates sort by send time then stable ID. No drag reorder. Owner offline means delay; after reconnect and catch-up send once when eligible. New unsent requests whose deadline elapsed are rejected for rescheduling; already accepted entries catch up. Failures remain visible and do not silently retry permanent errors.

## Presentation and lifecycle

Keep current compact queue UI: ordinary entries first, scheduled entries last; inline time prefix, mobile More menu and modal time picker. States distinguish waiting for owner, scheduled, due/waiting for session, sending, sent, cancelling, cancelled and failed. A pending edit shows both its requested value and the fact the old revision is still effective.

Do not put a creation TTL on the shared document: it could expire unrelated future entries. Proposed terminal-detail retention is seven days; then remove message payload and completed request detail from the current view, retaining minimal message/request IDs and final decisions to reject offline replay. Never reuse message IDs. Preserve attachment references until cancellation or dispatch is durably decided and ordinary history owns any sent attachment. CRDT deletion does not erase oplog or remote snapshots. The first implementation must not claim bounded physical storage: safe history compaction, terminal-ledger pruning and session-deletion purge need a separately verified offline-replay fence. Until that exists, keep minimal receipts and disclose residual growth.

## Compatibility, alternatives and acceptance

Existing general Schedules retain once/existing-session support. Do not silently convert existing Schedule reservations. For pre-release test data, explicitly cancel and recreate; any deployed-data migration requires a single-owner transfer that prevents both engines dispatching. Putting future items in the ordinary mq list is rejected because legacy consumers can send them early; a new root in that document is possible but couples lifecycle and requires legacy full-document writer auditing. A dedicated per-session document gives a safer initial boundary at the cost of one additional room per used session.

Code inspection confirms HEAD already supports once/existing_session; current Schedule creation sets no TTL and delete retains definition behind a Registry tombstone. This is a design proposal, with no execution changes or behavioral verification. Before implementation, reconcile the owning Spec and protocol contracts. Acceptance tests must cover real two-peer convergence, competing edits, cancel-vs-dispatch, offline owner, restart crash points, closed-session discovery, legacy capability rejection, attachment retention, offline replay after cleanup, and duplicate handoff prevention.
