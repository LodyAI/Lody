# Reconcile stale context compaction with live ownership evidence

Status: implemented
Translation: current

[中文](2026-09-11-stale-context-compaction-reconciliation.zh.md)

## Abstract

Sessions written before the provider-failure fix can retain a `pending` or
`in_progress` context-compaction item after the Agent has stopped, so reopening or
upgrading keeps the durable spinner visible. Lody now treats a finished owning turn
as a repair candidate and asks the Session's current owner daemon to reconcile the
exact turn and tool-call ids. The daemon writes `failed` only when live execution
ownership proves that turn is inactive; absent or ambiguous evidence leaves history
unchanged.

## Decision

The renderer remains a reader of durable compaction status. It does not reinterpret
`SessionHistory.finished`, a timeout, a restart, or missing presence as provider
termination. When the latest compaction is unresolved and its assistant turn is
finished, the renderer makes a capability-gated reconciliation request. Only a
`reconciled` result whose write was confirmed is permanently deduplicated. `active`,
`unknown`, and `unchanged` may be retried after later history activity, an
offline-to-online transition, or a new daemon presence instance. Unsupported or
unreachable daemons do not create a write fallback.

The request names `sessionId`, `turnId`, and `toolCallId`. The target daemon first
verifies that current Session metadata assigns ownership to its own machine and waits
for the Session document's initial remote state before drawing a conclusion from its
history. It acquires the existing Session history rewrite barrier only for a second
ownership/liveness check and the local history mutation. Releasing that barrier
explicitly enqueues an ordinary dispatch recheck and resolves the execution service's
barrier waiters. Goal actions retain their process-local pending request while waiting,
so neither a user turn nor a Goal turn accepted during repair can remain stranded or be
misreported as a startup failure. Remote write confirmation happens after the barrier
is released, and a failed or unavailable confirmation returns `unknown`, never durable
success. The reconciliation RPC uses the ordinary request lane because document sync
and history writes are not fast control-plane work.

The addressed turn remains unchanged when it is active or when unassigned work makes
the result indeterminate. Once the daemon can prove the turn is not its live owner,
it changes only the named unresolved `context_compaction` item to `failed`; terminal,
mismatched, unknown, and unrelated stored items are preserved.

This is lazy per opened Session rather than a startup migration. A global history
scan would activate arbitrarily many old documents and still could not establish
provider ownership. Versioned Machine capability negotiation also keeps mixed-version
clients from sending a write request to daemons that do not implement this evidence
contract.

## Alternatives and limits

Age-based cleanup was rejected because elapsed time does not prove the provider has
released the turn. UI-only suppression was rejected because it would make the
transcript disagree with durable history and other readers. Treating `finished` as
sufficient was rejected for the same reason recorded in the
[provider-failure decision](2026-09-10-context-compaction-terminal-state.md): host
finalization can precede provider termination.

An offline or old owner daemon cannot repair the item. The Session continues to show
its durable state until a compatible owner can provide evidence. This change does not
claim that every historical unresolved compaction is stale, and it does not rewrite
more than the exact activity requested by the current view.

## Verification

Behavioral coverage exercises exact-item mutation, active and indeterminate ownership
outcomes, cold/unsynced documents, write-confirmation failure, ordinary and Goal turn
dispatch after a rewrite barrier, owner-daemon generations, control-lane isolation,
local capability gating, and Loro Streams RPC dispatch. Shared schemas validate the
request and response shapes. No startup scan, storage migration, or end-to-end provider
fixture was added.
