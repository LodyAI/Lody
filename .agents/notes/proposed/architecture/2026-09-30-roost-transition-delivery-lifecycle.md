# Loro-first transition boundary for Roost conversation delivery

Status: proposed
Type: architecture
Translation: current

[中文](2026-09-30-roost-transition-delivery-lifecycle.zh.md)

## Abstract

Lody currently couples queue promotion, steering, and ACP output handling to Loro history and session-local lifecycle state. That coupling is the main integration boundary that must be made explicit before new sessions can use Roost while existing sessions remain on Loro. This proposal introduces a Lody-owned session backend boundary and moves queue promotion, steer reconciliation, history reads, and the main assistant writes behind it on the existing Loro path. The Loro implementation now includes durable queue receipts, steer operation identity and delivery evidence, backend lifecycle ownership, and renderer composition seams. A future Roost backend will implement the same contract without changing the queue or steer state machines; only Roost-specific storage and projection decisions remain outside this boundary.

## Decision and scope

The immediate goal is an internal transition boundary, not a storage migration. Existing sessions continue to use Loro. Until Roost is enabled for production, newly created sessions also use Loro; every creation path writes the discriminator explicitly. After enablement, the backend is selected once when a session is created: new sessions use Roost and existing sessions keep Loro. Every later history, queue, steer, and assistant-output operation resolves the backend through the session's stored choice; call sites do not branch on Roost versus Loro.

The transition must preserve the current product contract:

- A queued message is processed once, even when promotion is retried or observed on more than one replica.
- A steer is either applied to the intended running turn, transferred to an ordinary follow-up when delivery is proven impossible, or retained as an explicitly uncertain/terminal result. It is never silently replayed after unknown delivery.
- Streaming assistant output, usage, permissions, attachments, and tool items remain attached to the logical assistant message that produced them, including output arriving during finalization.
- Editing and resending an existing message creates a replacement active branch while retaining the old sealed branch. It is the only operation that intentionally replaces a logical turn. A late ACP event does not fork the conversation.
- The UI continues to render the existing `SessionHistoryInput` shape and current status vocabulary. Backend choice, physical Roost segments, recovery records, and operation identifiers are internal.

This proposal does not migrate old Loro history, change the Loro upstream library, change the Roost Rust core, or introduce a second user-visible conversation model. It covers the Lody CLI/session execution path and the shared session-facing APIs used by its clients. Platform-specific clients consume the same contracts; they do not implement a separate queue or steer protocol.

The transition boundary is wired at both sides of the session: the CLI binds one backend instance to each opened document and releases it with the document, while the renderer composes `SessionData` from the persisted discriminator and rejects a Roost document when no renderer factory is installed. The CLI composes the Loro history surface only for a Loro selection; a Roost open gets the control plane and lets the adapter own history storage. Session creation writes metadata before the first document or history write, so backend selection cannot be inferred from a partially-created conversation.

## The four transition boundaries

### `HistoryEngine`

`HistoryEngine` owns logical conversation operations. It creates and reads user turns, starts and finalizes assistant targets, applies user status changes, performs Edit & Resend, and exposes the projected history consumed by the UI and dispatch watcher. It does not expose Loro containers or Roost segments to callers.

The Loro implementation delegates to `SessionDocument`, `HistoryWriter`, the existing activation metadata, and the current history reader. It must keep the existing last-copy identity lookup and replacement-turn behavior. The Roost implementation will append or seal Roost records and use the adapter's projection to return the same logical history. The public result of an operation includes a stable logical identifier and an idempotent outcome such as `applied`, `already-applied`, `not-ready`, or `conflict`; it does not expose a storage-specific cursor.

### `DeliveryLedger`

`DeliveryLedger` owns durable intent and delivery state for queue and steer operations. It gives every user input a stable `userTurnId` and every mutation attempt an `operationId`. A retry uses the same identifiers and therefore asks the backend to complete or report the same operation instead of appending a second turn.

The ledger is deliberately separate from provider delivery. A history write proves that a logical turn exists; it does not prove that an ACP steer reached the provider. Provider results remain `applied`, `not-applied`, or `unknown`, and the existing user-facing dispositions remain derived from those results and the history evidence.

### `AssistantTargetResolver`

`AssistantTargetResolver` binds an ACP run to the logical assistant entry that owns its output. The binding is captured when the run starts and is carried on every buffered notification. Flush code never discovers its target by reading whichever turn is active at flush time. This is the boundary that prevents an old run's tail from being written into a newer user turn.

The resolver also owns the finalization tail: a target remains addressable after `finish-assistant` so late output, usage, permission results, attachments, and tool events can finish against the same logical assistant message. A subsequent turn takes ownership only when its own run is initialized.

### `HistoryProjection`

`HistoryProjection` converts backend records into the existing logical history model. Loro can project directly from its mutable assistant entry. Roost may have a sealed primary segment followed by late-output segments, so its projection groups records by `businessId` and returns one logical assistant entry in the same order as Loro. Projection is an adapter concern; callers must not inspect physical segment IDs.

The projection is incremental. A read of a visible window must not rebuild the entire long conversation merely because one assistant segment changed. The adapter may cache the business-ID grouping and invalidate only affected logical entries.

## Backend selection and ownership

The session record stores a backend discriminator at creation. Legacy sessions without that field are interpreted as `loro`. Lody binds one backend object to each opened `SessionDocument`, and all callers resolving that document receive the same object. A restart creates a new in-memory object after re-reading the persisted discriminator; a change of kind on an already-open document fails closed.

The selection rules are:

| Session                                                  | Backend before Roost launch  | Backend after Roost launch                                                    |
| -------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| Existing Loro session                                    | Loro                         | Loro                                                                          |
| New session                                              | Loro                         | Roost                                                                         |
| A session created during a failed backend initialization | No partially-created session | No silent mixed backend; creation reports a normal failure and may be retried |

There is no per-message fallback from Roost to Loro. Such a fallback would split one logical conversation across two histories and make queue, steer, and late-output recovery ambiguous. A backend migration, if ever needed, is a separate operation with an explicit snapshot and verification protocol.

## Queue promotion

### Existing behavior to preserve

The dispatch watcher checks turn sources in this order: local history, the durable message queue, then the RPC stash. Queue promotion is serialized by the existing rewrite-conflict lease and dispatch checks are coalesced per session. The watcher already protects against duplicate copies, settled turns, refused steers, and a missing activation pointer. Those protections remain product rules, not Loro-specific implementation details.

### Loro-first implementation

The Loro backend exposes one logical operation, `promoteQueuedTurn`. Its input contains the queue row identity, the stable `userTurnId`, and the `operationId`, together with the normalized turn payload. The watcher supplies the history copy it already read; a direct backend caller falls back to one targeted `readTurn`, never a second full-history materialization. The existing rewrite-conflict lease serializes the operation with Edit & Resend. The operation advances a recoverable receipt around these writes:

1. Read the queue row and the last logical history copy for `userTurnId`.
2. Record `prepared`, append the user turn when no exact copy exists, and record `history_accepted`.
3. Publish the activation pointer and record `activation_published`.
4. Remove the exact queue row and record `queue_consumed`.
5. Return the logical turn that dispatch should execute. Settled/refused-steer decisions remain in the watcher because they depend on execution-owned evidence.

The operation is idempotent. Repeating the same `operationId` after a completed phase returns the recorded logical turn without appending history. A retry after any individual write failure re-reads the ledger and only the exact turn needed to complete the missing phase. Startup reconciliation scans incomplete receipts, preserves queue order and editing leases, and closes receipts whose queue row is already gone but whose user turn was accepted. The legacy fallback identifier `queue:${$cid}` is used only when an old queue row lacks `operationId`; new writes persist the stable identifier.

The Loro command must retain the existing last-copy-wins lookup. It must not delete duplicate historical copies merely to make promotion easier. A no-op status write, a settled terminal status, an active execution owner, or an existing activation pointer can independently prove that the queue row no longer needs promotion.

### Future Roost implementation

Roost cannot assume one atomic transaction covers Roost history, the Loro control-plane activation pointer, and the queue row. The Roost adapter therefore records the same `operationId` and advances a small recoverable operation state in the delivery ledger. The durable phases are `prepared`, `history-accepted`, `activation-published`, and `queue-consumed`; the terminal result is `applied` or `already-applied`.

Recovery scans incomplete operations before normal dispatch. If history was accepted but activation was not published, it publishes activation using the recorded logical turn. If activation was published but queue consumption was not recorded, it removes the exact row and closes the operation. If neither durable phase is present, the queue row remains eligible. No phase causes a second Roost acceptance because acceptance is keyed by `operationId` and `userTurnId`.

The user sees the same behavior as the Loro path. The recovery record is not a second message and is never projected into conversation history.

### Queue failure matrix

| Failure point                | Loro result                                                 | Roost adapter result                                     | User-visible result    |
| ---------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- | ---------------------- |
| Before history acceptance    | `prepared` receipt remains; queue row remains               | `prepared` operation remains recoverable                 | Message stays queued   |
| After history acceptance     | Resume from `history_accepted`                              | Resume from `history-accepted`                           | One ordinary turn      |
| After activation publication | Resume from `activation_published` and consume exact row    | Resume from `activation-published` and consume exact row | One ordinary turn      |
| Retry after commit           | Recorded idempotent result                                  | Operation ledger returns `already-applied`               | No duplicate turn      |
| Concurrent promotion         | Rewrite lease plus identity checks select one logical owner | Operation identity and recovery select one owner         | No duplicate execution |

## Steer lifecycle

### Existing state machine

Steer is a delivery protocol, not just a history append. The existing `steerMutationQueue` serializes ownership changes per session, while `steerStatusQueue` serializes status projection and reconciliation. The rewrite-conflict lease protects Edit & Resend and other history replacement operations. The expected turn ID is checked before provider submission and again at handoff boundaries.

The exact statuses remain:

- `pending_apply`: the user input has been recorded but has not yet been accepted by the running turn;
- `processing`: the daemon owns the steer handoff and is waiting for provider evidence;
- `handled`: provider application and local history projection completed;
- `canceled`: the exact input was canceled and must not be replayed;
- `delivery_unknown`: the provider outcome cannot prove whether the input was accepted.

The response dispositions (`applied`, `no-active-turn`, `stale-turn`, `busy`, `unsupported`, `delivery-unknown`, `promotion-failed`, and ordinary error paths) remain mapped from this state machine. A provider refusal that is proven to happen before submission may be requeued as an ordinary follow-up. A timeout, missing result, or transport ambiguity never authorizes an automatic resend.

### Loro-first implementation

The Loro backend keeps the existing user history row and `steerTurnStatuses` metadata. It also persists a bounded steer operation ledger keyed by a stable operation ID. It exposes backend methods for:

- recording a steer intent with its `userTurnId` and `operationId`;
- recording a provider delivery result for that exact identity;
- applying the status projection to the matching history row;
- reading history evidence for reconciliation;
- clearing the status only after the row is terminal or has been handed to ordinary execution.

`reconcileSteerHistory` calls the backend methods rather than directly calling `sessionDoc.sessionData.history.readTurn`. The current ordering remains significant: settled history evidence is checked before a refused/pending steer is held or requeued; recovery writes its operation record before clearing the steer status. A cancellation that wins while the history document is opening writes this control-plane record without waiting for the document; reconciliation later projects it through the bound backend. If the exact history row has already crossed the requeue fence, the compact status mirror is removed rather than resurrecting the input.

The Loro implementation may keep the status mirror in session metadata because that is already the durable control plane. The abstraction prevents callers from depending on that representation.

### Future Roost implementation

The Roost backend must persist steer identity, input, expected target, delivery kind, and status durably enough to recover after process restart. The representation is intentionally open: Roost message metadata, a dispatch-intent extension, or an adapter-owned record can satisfy the contract. A new top-level Roost `steer_intent` message kind is not required by this proposal.

The Loro control plane may continue to carry a compact status mirror for wakeups and existing clients. The mirror is advisory for dispatch; the Roost ledger is the source of truth for delivery identity and replay safety. Reconciliation imports terminal evidence into the ordinary logical history projection and removes only the exact pending identity.

### Steer failure rules

The following rules are mandatory in both backends:

- A steer can settle only the exact `userTurnId` it names.
- An `unknown` result remains unknown until later provider or history evidence resolves it; it is never converted to a safe-to-retry result merely because the local process stopped waiting.
- Stop may promote only a steer proven `not-applied` under the existing cancellation policy.
- A successor turn may take ownership only after the previous run's handoff decision is serialized through `steerMutationQueue`.
- A rewrite conflict returns `busy` and leaves the steer pending; it does not promote the input as a normal turn while Edit & Resend owns the session.

## MessageHandler and ACP output

### Target creation and correlation

At the beginning of an ACP run, MessageHandler creates an assistant target containing the logical `userTurnId`, `assistantEntryId`, `turnId`, and a monotonic local `turnEpoch`. It also creates an ACP run token. If a provider exposes a run identity, the token incorporates it; otherwise AgentClient generates the token locally and keeps it for the complete provider invocation. Each buffered notification receives its own stable operation ID. A retry after a backend partially commits a batch reuses the same IDs, and backend implementations must not apply an accepted ID twice. Filtering and batch splitting preserve ID alignment; separately enqueued notifications remain distinct.

Every ACP notification is stamped with that target before it enters `acpUpdateBuffer`. The stamp travels through batching, retry, finalization, and shutdown. A flush does not call `getCurrentACPUpdateTarget` to rebind old events to the current turn. This is required even when the provider sends sparse updates or sends callbacks after prompt completion.

The target lifecycle is:

1. `begin`: create or claim the logical assistant entry and bind the ACP run.
2. `append`: batch text, thoughts, tool items, attachments, permission results, runtime configuration, and usage against the stamped target.
3. `finalize`: wait for the history gate, drain bounded flush rounds, mark the target finished, and retain a late-output target.
4. `late-append`: accept output from the same run against the retained target, with at-least-once retry and per-notification progress.
5. `retire`: discard the target only after session deletion has quiesced timers and in-flight flushes.

The existing distinction between clearing a turn and deleting a session remains. Clearing a turn must preserve buffered ACP updates and in-flight flushes. Deleting a session must first stop new notifications, drain or record failures, and then remove all target state.

### Loro-first implementation

The Loro backend writes ACP output into the existing mutable assistant entry. Finalization sets its terminal fields through the existing history action. Late output updates the same entry, so the UI sees one assistant message. The current batching window, bounded retry rounds, target-local grouping, unread marker, usage flush, permission wait, and attachment/tool binding remain unchanged in meaning.

The adapter boundary is placed around `appendACPUpdatesToAssistantEntry`, `finish-assistant`, usage persistence, and rich-content persistence. MessageHandler owns event ordering and target identity; the backend owns how a logical target is represented.

### Future Roost implementation

Roost writes ordinary streaming output to a primary segment for the logical assistant `businessId`. Finalization seals that segment. Output arriving after sealing is appended to a later segment with the same `businessId` and a new `segmentId`. `HistoryProjection` merges those segments into one logical assistant entry, preserving event order and terminal metadata.

Late output must not call `forkAndActivate`. `forkAndActivate` remains reserved for Edit & Resend, where the user intentionally creates a replacement active branch. Applying it to every late callback would create user-visible branch churn, complicate activation, and make provider timing visible in history.

Usage, permission results, attachments, and tool items carry the same `businessId` and ACP run token. If a late item has no matching target, it is retained in the existing bounded retry/error path and never attached to the newest active turn by guesswork.

Roost's current physical `businessId`/`segmentId` representation is compatible with this plan, but an adapter or projection layer is still required because a raw active-branch read can expose physical segments rather than one logical assistant entry.

### MessageHandler failure matrix

| Failure point                             | Required behavior                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Notification before user history is local | History gate delays the write; notification remains buffered with its target                            |
| Prompt returns while provider still emits | Finalization retains the target; late notifications update that target                                  |
| Flush partially persists a batch          | Per-notification progress requeues only unwritten items; persisted prefixes are not duplicated          |
| Flush fails repeatedly                    | Bounded automatic retries stop; buffered items remain for a later explicit or lifecycle-triggered drain |
| New turn starts during old tail           | New run gets a new token; old events remain bound to the old target                                     |
| Session deletion races a callback         | Deletion boundary rejects new updates, waits for in-flight work, then removes target state              |

## Edit & Resend and sealed turns

The sealed-turn constraint is already addressed at the Roost operation level: editing an existing message retains the sealed old turn and creates a replacement turn, then atomically switches the active branch with `forkAndActivate`. The transition boundary must expose this as `HistoryEngine.editAndResend`; callers do not mutate a sealed turn and do not need to know whether the replacement is a Loro copy or a Roost fork.

Queue and steer operations must respect the rewrite-conflict lease while Edit & Resend is in progress. A concurrent steer returns `busy` and stays pending. A queue promotion observes the lease and does not claim the input as a normal turn. Once the replacement branch is active, ordinary dispatch reads the new active logical history. Old sealed content remains available for branch/history inspection but is not duplicated into the active conversation.

This boundary is why late ACP output is a separate operation: a provider callback is evidence for an already-owned assistant target, not an edit request.

## Performance and user-visible behavior

The transition adds an interface call and stable identifiers to each operation. It must not add a second full-history scan to the hot path. Queue promotion and steer reconciliation read only the identities and rows needed for the exact operation; assistant streaming continues to batch target-local updates. The Loro backend keeps the current document write model, so the abstraction itself does not solve the known long-conversation LoroDoc cost. The practical performance gain comes when new sessions use Roost, while old sessions remain behaviorally compatible on Loro.

The Roost projection must be incremental and bounded. It should cache the mapping from `businessId` to logical assistant entry, invalidate only changed IDs, and avoid materializing all old segments for every token batch. Any projection cost is internal; users should see the same streaming cadence, queue status, steer result, edit result, and message ordering.

Instrumentation should record backend-independent operation timings and outcome counts: queue promotion latency and retries, steer status transitions, target flush latency and buffered bytes, projection work, and recovery phases. Logs may include opaque IDs and phase names but must not include prompt or assistant content by default.

## Implementation sequence

### Phase 1: Loro-only transition API

- Define the four boundaries and result types in the Lody session layer.
- Implement them over the existing Loro `SessionDocument`, history commands, metadata, and transient target state.
- Move queue promotion, steer reconciliation, assistant lifecycle, and history reads behind those interfaces.
- Keep the current UI protocol and status/disposition vocabulary unchanged.
- Add the session backend discriminator with legacy default `loro`.

Phase 1 is implemented in the current Lody branch. The contract now includes history reads and commands, queue promotion receipts, steer operation records, fork snapshots, lifecycle initialization/disposal, synchronization, and stable turn-order metadata. The renderer has a matching `SessionData` factory seam, the CLI avoids composing Loro history for a Roost selection, and every new-session creation path writes the discriminator before accepting the first turn.

### Phase 2: contract and failure tests

The Lody-side preparation is complete for starting the adapter:

- `apps/cli/tests/session-backend-contract.ts` defines one reusable queue contract. It runs against an injected command harness and real `LoroRepo`/`LoroDoc` storage, injecting failure after every durable receipt, history acceptance, activation publication, and queue consumption. It checks the logical turn, remaining queue rows, activation, and final receipt.
- Focused tests cover settled/refused/unknown steer results, Stop during handoff, Edit & Resend conflicts, dispatch recovery, forked-replica duplicate turn copies, late ACP output, partial batch retry, and session deletion. ACP operation IDs remain aligned through invalid-input filtering and history compaction, and remain unchanged when a partially applied batch is retried.
- Backend selection and document lifecycle tests cover legacy Loro defaulting, one backend per opened document, explicit selection before initialization, closed failure when no factory exists, and renderer factory composition. Production history accesses are routed through the backend; the remaining raw access is confined to the Loro implementation and the guarded data-only ACP fixture fallback.

The queue contract can run unchanged against the adapter fixture in Phase 3. These Lody tests do not validate Roost's durable record placement or branch projection. A long-history comparison also requires both implementations: measure Loro as the baseline when the adapter is ready, then compare Roost under the same workload.

### Phase 3: Roost adapter without production selection

- Implement Roost history acceptance, durable delivery operation records, assistant segment projection, and recovery behind the same contracts.
- Validate `businessId` grouping, sealed primary plus late segments, restart recovery at every queue phase, and idempotent steer settlement.
- Keep Roost behind a test-only/session-fixture selector until the adapter passes the contract suite.

### Phase 4: new-session selection

- Enable Roost only for newly created sessions through the session factory.
- Keep legacy sessions pinned to Loro and expose their backend choice in diagnostics only.
- Monitor backend-independent metrics and recovery outcomes before expanding the selection policy.

## Verification plan

The minimum acceptance suite has four layers:

1. Pure state-machine tests for queue and steer identity, status transitions, retry classification, and operation idempotence.
2. Real Loro integration tests using `SessionDocument`, `HistoryWriter`, metadata, and forked replicas. These verify that the abstraction preserves last-copy lookup, activation semantics, duplicate-copy safeguards, and the persisted steer ledger.
3. MessageHandler lifecycle tests with a fake ACP provider that emits output before history sync, after prompt completion, during a new turn, after partial persistence, and during deletion. Assertions use logical assistant IDs and content order.
4. Backend contract tests run unchanged against Loro and Roost adapters. Roost-specific crash injection covers each cross-store phase; Loro-specific tests cover the receipt phases, targeted retry reads, activation repair, and queue-order preservation.

No comparative performance number is claimed until the adapter exists and the long-history benchmark runs against both backends. No Roost-specific API is treated as confirmed until the adapter is exercised against the production Roost library. These are verification limits, not reasons to change the Loro-first boundary.

## Open points that require evidence

Only the following items remain genuinely Roost-specific and unverified:

- Which Roost persistence hook and metadata shape should carry the delivery ledger so operation recovery is durable without adding a mandatory top-level message kind.
- Whether Roost can expose an efficient active-branch projection hook, or whether the Lody adapter must maintain its own incremental business-ID index.
- Measured segment/projection and persistence costs under a long streaming response, especially after finalization with late output.

These points do not alter the Loro implementation plan. They are adapter validation tasks to complete before enabling Roost for new production sessions.
