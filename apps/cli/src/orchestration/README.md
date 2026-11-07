# Reconciliation feedback

Binding constraints live in [AGENTS.md](AGENTS.md). This page explains why
connection lifetime and change notifications matter to the coordinator.

`operation-store.ts` uses SQLite WAL. Closing the last connection checkpoints
and removes WAL/SHM sidecars. Opening and closing for each reconciliation makes
`operation-coordinator.ts` observe its own filesystem churn. Multiple workspace
coordinators share the machine store and can amplify those notifications.
Per-call MCP opens can also perform maintenance writes and trigger lock contention;
the coordinator owns maintenance, while MCP keeps a read-only schema probe before
any required migration.

`operation-progress-history.ts` projects target execution into a requester card.
With nested A -> B -> C sessions, A observes B, while B contains a card for C.
Mirror notifies subscribers even when a state updater returns unchanged history.
Writing the same card can therefore schedule another reconciliation indefinitely.
The preflight comparison avoids entering Mirror; real writes recompute against
current history so a preflight snapshot cannot overwrite an intervening update.

The real-Mirror regression is in
[operation-progress-feedback.test.ts](../../tests/operation-progress-feedback.test.ts).

## Database startup degradation

Synchronous Inbox startup failure leaves ordinary human dispatch available without Inbox. Dependent MCP tools return retryable `INBOX_UNAVAILABLE` before accessing even cached storage; the local runtime warning clears after recovery or stop.
Temporary failures retry from 30 seconds, doubling to a 10-minute cap; incompatible schema/protocol does not auto-retry. `stop` and `recoverStop` cancel retry.
Partial startup detaches Inbox and drains its resources through the stop owner before replacement, without canceling or waiting for ordinary turns. Unknown input is never replayed; the [Inbox decision record](../../../../.agents/notes/implemented/architecture/2026-10-12-operation-inbox.md#database-startup-degradation) explains the remaining adapter scope.

## Effect and transaction ownership

The native coordinator lives in `coordinator-workflow.ts`; `coordinator-model.ts`
contains pure decisions. `coordinator-activity.ts` owns the scoped queue, coalesced
wake tickets and retry fibers. The old coordinator class is a registered application
entry point, not a second reconciliation loop. Concrete Session/history/OS effects
are in `platform/`; these upstream Promise adapters still require their own migration.

Ordinary coordinator steps compose directly with `yield*`. Only deadline,
materialization retry and best-effort progress boundaries inspect failure Causes.
Interruption propagates instead of becoming a completed Operation or a progress
warning; recoverable failures keep the complete Cause. Activity/epoch admission
remains authoritative; immutable repository aliases need no replacement checks.

`OrchestrationDatabase` owns one scoped SQLite connection. Disk and `:memory:` Layers
use the same schema, SQL and repositories. In-memory SQLite is still mutable I/O,
not a pure function; it makes isolated tests reproducible without changing semantics.
Operation and Inbox repositories borrow the same connection. A semantic repository
operation runs one synchronous `BEGIN IMMEDIATE` transaction: reads, conditions and
writes commit together. Transaction callbacks reject Promise and Effect returns;
transport, history writes and waits happen outside the transaction. SQL failures keep
the original cause and a busy/storage/invariant classification. Reopen and multi-Worker
behavior still require disk tests. Session configuration is frozen in intents/batches;
the unused session-row configuration read/write is removed without a schema migration.

`inbox/execution-owner.ts` hides input/batch identity, cleanup terminate handles, raw
requests, submission, settlement and release recovery. Session callers use this
handle rather than SQL. Its `submit` starts transport and records the submitted
receipt; callers cannot manually interleave begin/prepare/submit/settle through the
Legacy facade. Read queries use a plain Effect-valued port interface; concrete SQL
remains in platform, without an unused Service/Layer. `inbox/close-owner.ts` retains the original close receipt and
a raw disposal fiber; independent recovery repairs receipts without repeating requests.
Fleet startup and normal stop use the same phased cleanup owner. Automatic startup
retry first recovers retained resources, then starts a replacement.

## Completion consumption

`inbox/sqlite.ts` indexes results in the existing completion transaction, fixes release
watermarks and persists input/batch/release receipts. `inbox/service.ts` owns coalesced
signals, scoped workers and the shared admission gate. `inbox/legacy.ts` registers the
single host runtime and the unfinished Session adapter. Interrupted executions retire without replay. Startup retires old active inputs and clears legacy
blocks; `blocked` and `inbox_resources` are otherwise neither read nor written. Restart retirement
currently emits a warning rather than a history notice because activation owns SQLite only.

Unconfirmed release returns the slot and detaches the old
Agent before waking a successor. Cleanup gets one background attempt with a five-second
budget; cleanup failure is logged and cannot gate input or shutdown. Cleanup completion
always retries the old execution's release write. Admission retries retirement once for a
slot absent from the service's live execution ID set; a persistent write failure emits a disk-space chat notice instead
of leaving the session dependent on restart. IDs stay live until successful release or
detached retirement, independently of the replaceable turn runtime index. Preparation failure
always drops its matching runtime/current-turn registration and any owned live execution ID,
even if the compensating release rolls back; later admission can retry that stale database slot.
Cleanup addresses only the
retired execution, so it cannot clear a successor's slot. Failed exits grant no automatic
intent, but later wakeable receipts can proceed. Process identities are not journaled;
restart orphan-process cleanup is deferred. The offline recovery command and startup PID
proof are removed. See the [availability decision](../../../../.agents/notes/implemented/bug-fix/2026-10-29-inbox-no-durable-block.md).

Session admission locks retain waiters and holders until zero references. Projected
receipt caches follow SQLite identities/statuses; release retries own a private receipt.

`session-execution-service.ts` calls`session-execution-service.ts` calls the actual prompt primitive while holding admission.
A batch is one system history item plus one model input, even when details require pages.
Inline context intentionally previews at most 50 members and 64 KiB; batch_get reads all fixed members.
`batch-page.ts` returns complete large members in bounded JSON fragments. The execution
owner retains raw requests and full failures; `recoverInboxExecution` retries cleanup.
Coordinator `stop()` now has a shared awaited drain receipt; `recoverStop()` is its
independent retry entry. Old coordinator handoff and per-result execution APIs are removed.
`recoverStop()` invokes the bridge's `recoverClose()` for failed close receipts, using
an independent connection to retry only settlement/release/pause writes. The original
failed close receipt remains unchanged; requests are never resubmitted.

A wakeable receipt grants an automatic intent when idle; normal release grants one for queued wakeable receipts. Inbox-aware Stop cancels queued
human execution eligibility and pauses automatic work. Fresh human or Agent-chat input
clears that pause and carries saved results, and a failed/unreleased execution cannot manufacture another wake. See the
[contract](../../../../specs/session-orchestration.md#idempotent-message-consumption).

New Stop producers negotiate Inbox v2 with the target machine before adding `cancelId`
and `pauseInbox` or publishing a control-request marker. Without that capability they
send the released cancel RPC fields and write the exact assistant Turn ID. The new
CLI accepts that legacy Stop as execution cancellation, without a persistent Inbox
pause that the old client cannot resume. No missing receipt is guessed to be human.
Explicit no-pause cancellation and Operation cancellation remain supported.

### Batch transactions

Batch membership is immutable. History projection is an idempotent stable-ID write outside the transaction and grants no dispatch permission. Enforce unique release records, intent-to-automatic-batch binding, human-input-to-submittable-batch binding, and at most one live claim per result. Superseded batches retain member history; only current claims/bindings grant eligibility. Automatic batches require `memberCount > 0`, consistent with actual membership; both batch creation and submission fencing validate this condition.

| Transition | Atomic write set and conditions |
| --- | --- |
| Completion → queued receipt/pending intent | Persist result and wake eligibility in the completion transaction. If idle, unpaused, unblocked, without accepted input or an existing live intent, record one pending intent. Busy/paused results stay queued |
| First normal release → boundary record/pending intent | Atomically save the unique release record. Create one pending intent only if wakeable results remain and no queued input takes priority. Duplicate releases never grant another intent |
| Pending intent → prepared/settled_empty | Conditionally claim intent, snapshot the current queue watermark, require a wakeable result and include all unconsumed/unclaimed results through that watermark. Only nonempty results atomically create fixed batch/members, live claims and input binding. Empty results atomically settle intent as terminal settled_empty without batch/execution or reactivation. Pending human input prevents this automatic branch |
| Human input → prepared/original batch-free path | With results, bind trusted input receipt to a nonempty batch; without results, create no batch and retain the ordinary human-input path. Freeze original prompt/attachments/configuration |
| Unsubmitted automatic batch → yield to human | Require old batch still prepared; supersede old intent/batch, transfer all live claims, create new fixed membership and human-input binding in one transaction. Failure rolls everything back; never release and bind in separate transactions |
| Prepared → submitting | Under the shared gate, conditionally update owner/pause/acceptance sequence/execution identity/claim/binding, also verify automatic batch memberCount > 0, and persist unique submission token; immediately start transport afterward |
| Begun, unsubmitted → withdrawn | Only the active execution with no release receipt, journaled resource, or fenced/submitted batch for its input may clear the active slot. Write no receipt and leave the input unfinished, so the same execution ID may begin it again and its prepared batch keeps its claims. A turn that stays pending after an unverified machine-access check uses this instead of release |
| Prepared → paused/invalid | Require no submission fence; invalidate intent/binding and release claims as passive queued data, with pause in the same transaction; do not restore automatic eligibility |
| Submitting → submitted/unknown | Persist receipt and retain non-resubmittable members. Unknown never returns to prepared/queued. Proven non-invocation records not_submitted for the recovery entry, without automatic replay |
| Submitted/unknown → settled | Update settlement/consumption and Cause only; duplicate settlement is idempotent and invokes no provider. Settled uncertainty is not confirmed model success |

Use `BEGIN IMMEDIATE` for claims. All batches snapshot the current watermark at claim. Wake eligibility grants admission, not a membership filter. The replacement batch may include newly available results; old membership history stays unchanged. Post-claim arrivals remain queued. History failure is pre-submission; uncertainty beyond the fence remains unknown and rebuilding history cannot restore submission eligibility.

### Storage and retirement

Operation completion writes directly into `inbox_results` in the same transaction;
there is no Delivery table, insert trigger or separate per-result execution claim.
A persistent sequence counter survives deletion so post-claim results cannot enter a fixed batch.
Settlement records consumption time; consumed payloads expire after seven days, while
unfinished creation progress keeps its Operation until projection is settled. Retired
Operation IDs still prevent replay. Pending result data is passive, not busy work;
automation admission observes active Operations, executions and runnable intents.

Schema v2 deletes only `deliveries` and `delivery_execution_state`. Released Operation
rows, author/input snapshots, materialization/progress state and retired IDs survive
the upgrade; active Operations continue normal reconciliation. Finished legacy
Delivery backlog is not imported or replayed. Previously imported, unclaimed
compatibility results are discarded; current batches, pause and resource ownership remain.
The cleanup is transactional and is retried after storage failure. Inbox protocol v2
requires supervisor contract v3; earlier supervised workers are rejected before storage access.
No old binary downgrade or same-process Delivery scheduler handoff is supported.

`inbox/legacy.ts` remains the registered Promise-to-Effect bridge for the current
Session/ACP consumers. It is not an old Delivery scheduler or data compatibility layer.
`operation_completion` and its stable `deliveryId` remain the batch member's display
format; old per-member continuation statuses and notices are removed.

## Message-author snapshots

`operation_authors` stores source identity and per-target Role display snapshots in
the Operation acceptance transaction, with cascading cleanup. Separate storage
keeps Operation records separate from display snapshots. A missing author snapshot
on a delegated Operation retains its frozen requester Session and source Turn as
minimal Agent provenance, with the generic label `Agent` and no Role/model details.
Create/chat reject delegation without source identity rather than defaulting to human.
Never reconstruct historical display details from current catalogs. See the [contract](../../../../specs/message-author-identity.md).

Decision rationale, verification limits and future steer conditions are maintained in
the [implementation record](../../../../.agents/notes/implemented/architecture/2026-10-12-operation-inbox.md).


## Silent target Stop

Inbox records `user_stop` on the exact canceled input in the Stop transaction.
Coordinator checks this local record before stale history or deadlines; remote
requesters read its history projection. Cancellation history projects the same cause through HistoryWriter, including
queued/late history recovery and shallow Loro/Roost reads. This is a turn field,
not Session metadata, so remote requesters can reconcile the frozen target input.
The pure `operationInboxCompletion` filter omits these canceled targets from
model receipts. Finalization rechecks local Stop under the writer lock and normalizes the stored
items/completion, so a precomputed success cannot overtake a committed Stop.
The complete Operation remains queryable. Fully omitted results
have a consumed Inbox tombstone in the finish transaction: no intent, no future
human batch, and no duplicate/restart replay, while normal retention still works.
Partial batches deliver the remaining targets. Requester cancellation, failed
turns and timeouts do not acquire a user-stop cause.
