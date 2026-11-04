# Prevent repeated agent completion consumption

Status: implemented
Translation: current

PR: [#1422](https://github.com/LodyAI/Lody/pull/1422)

[中文](2026-10-10-agent-message-idempotency.zh.md)

## Abstract

Agent completion Delivery already had stable ids and durable claims, but stale
connection recovery could submit its prompt again after the start fence. Result
cleanup also erased the identity needed to reject a much later retry. Delivery
now stops automatic submission after a transport failure, while cleanup retains
compact retired ids and fences old database writers. This provides at-most-once
submission per Operation in the same local store, at the cost of uncertain
delivery after a crash and steadily growing id records; it cannot prove exactly
one successful provider consumption.

## Findings and decision

This extends the
[local orchestration decision](../architecture/2026-09-29-local-session-orchestration.md)
without changing its daemon ownership. Current intent is the
[Session orchestration Spec](../../../../specs/session-orchestration.md#idempotent-message-consumption).

`promptWithStaleACPRecovery` retried a disconnected connection when no ACP output
had been observed. Delivery's `runtime.promptStarted` skipped the start callback
on that retry. A provider can have received input before the transport fails;
output absence cannot prove non-consumption. Delivery now bypasses this recovery
and settles post-submission disconnects as `uncertain`. Existing SQLite claims,
settlement-only retries, Worker recovery and fixed history ids remain the owners.
Ordinary user turns retain their established recovery policy. The synthetic
regression demonstrates this gap; no affected user's runtime trace was captured,
so it does not establish that every reported duplicate had this cause.

Consumed rows expire after seven days. Deletion previously allowed the same key
to be accepted anew. A separate `operation_retired_ids` table retains only the
Session/Operation key. A delete trigger atomically captures it; an insert trigger
rejects reacceptance, including older writers that do not know about the table.
Modern callers receive non-retryable `OPERATION_ID_REUSED`. Separate storage keeps
strict legacy row readers compatible, and expired result lookup still reports
absence. Migration detects missing tables/triggers before maintenance cleanup.

Content deduplication would suppress legitimate identical messages. Keeping all
payloads forever would retain prompts/output unnecessarily. Retaining only keys
has a smaller ongoing storage cost, but no time-based purge: purging keys would
reintroduce late replay. Previously deleted keys cannot be recovered, deleting the
database resets protection, and downgraded Workers still use their old ACP retry
policy. Exactly-once successful native model execution would require a stronger
executor contract; that is separate from the message-consumption request. Durable
deduplication and consumption acknowledgement belong to the orchestration store
and need no new ACP capability.

The subsequent [scope correction](../../rejected/architecture/2026-10-10-provider-prompt-receipts.md)
withdraws the mistakenly added ACP receipt protocol. Final changes stay in message
orchestration and generic execution.

## Verification and limits

The final execution/coordinator/store/model suites passed all 379 tests. The execution
regression records submitted sessions before a disconnect and checks one submission
plus uncertain settlement for Delivery, while ordinary recovery still submits
to the restored session. Real SQLite tests cover expiration, reopen, late retry,
old SQL writers and separate requester identity. The model counts provider
submissions across duplicate scheduling, interruption, retirement and recovery.

Validation used cached dependencies, including the pinned `loro-repo` 0.21.2,
and initialized pinned public ACP submodules. CLI typecheck, scoped formatting,
lint and documentation checks passed. Shipped desktop reproduction and
deployed-provider acceptance were not performed.

Deep review checked the retired-id migration before cleanup, transactional delete/
insert fencing, requester-scoped keys, concurrent Worker claims, orphan recovery,
settlement-only retries and the ordinary user-turn recovery boundary. No P0/P1
issue was found. The five owning suites, including ACP error classification,
passed 407 tests. ACP clients, adapter submodules and dependency manifests have
no task diff. Persistent id growth, previously deleted ids and downgraded Worker
retry behavior remain the limits described above.

Before PR creation, root `pnpm format` passed. Root `pnpm check` was attempted but
stopped in the unchanged Devin adapter's build because its local `node_modules`
and dependency/type declarations were missing. It did not reach the full-root
lint/test stages; scoped validation above remains the implementation evidence.
