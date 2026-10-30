# Inbox availability before release proof

Status: implemented
Translation: current
PR: [#2067](https://github.com/LodyAI/Lody/pull/2067)
Supersedes: [Manual Inbox recovery](../../archived/bug-fix/2026-10-21-manual-inbox-recovery.md)

[中文](2026-10-29-inbox-no-durable-block.zh.md)

## Abstract

In the owner-reported 0.107.2 incident, Desktop killed the CLI after three seconds, leaving no release receipt. A conversation had accumulated 153 historical PIDs; the one-shot restart probe could not prove release and permanently rejected input. Inbox now retires uncertain execution without replay and keeps subsequent input available. Orphan processes can continue running: restart orphan cleanup belongs to the next PR.

## Decision and alternatives

Overall availability takes priority over local release proof. Activation clears legacy blocks, finishes interrupted inputs and preserves unknown batches. Release uncertainty and conflicting receipts cannot lock a conversation; the first receipt wins. Restart retirement logs a warning because SQLite activation has no history writer. Runtime failure detaches the exact old Session before returning its slot. One background cleanup attempt uses only that execution's handles, with a five-second budget; it cannot release or terminate a successor. Failure is reported through the existing Stop notice and logs, and drain still allows Inbox/runtime/database shutdown. Resource registration and the current schema stay unchanged. Unknown submitted work never replays.

Longer exit deadlines only reduce one trigger. Better PID probing still cannot prove missing identities, PID reuse or Windows descendants. Keeping a durable block with a manual UI confirmation still makes availability depend on operator repair. Those options were rejected in favor of retiring the input and isolating the failed Agent. The [operation Inbox contract](../architecture/2026-10-12-operation-inbox.md) is partially superseded only for release-proof admission. The [process-tree decision](2026-10-15-unreleased-session-resources-retry.md) retains zombie/Windows termination rules, while its old successor fence is replaced. Session/ACP orchestration remains an unfinished dependency chain; no broader native Effect migration is included. The existing native execution owner and bridge bound cleanup.

Background cleanup always retries the old release write, including after cleanup failure. SQLite may roll back the entire release transaction on disk-full errors; admission retries retirement and begin once for a slot without a live owner. Persistent failure produces a local-database/disk-space chat notice; later input can retry after storage recovers, without replaying the old input.

## Evidence and limits

`apps/cli/src/orchestration/inbox/inbox.test.ts` exercises real SQLite retirement, legacy blocks, unknown non-replay, first-receipt wins and preserved resource identities. `apps/cli/tests/session-execution-service.test.ts` exercises failed termination, fresh ACP delivery and visible reporting. Coordinator tests cover terminal closure. The incident figures above are owner-provided, not reproduced against private data. No real orphan process cleanup, Windows host or packaged desktop acceptance is claimed.

Workspace-reading results remain before release: diff/usage persistence (including edit gap-fill), dirty/unpushed probes, branch synchronization, PR detection, diff statistics, and Code Collab's filesystem scan. Normal, error, cancellation and yielded paths share the runtime's original 20-second deadline, longer than Git observation's 15-second command timeout. Stop cannot reset it; shutdown skips error-path diff/usage too, so aborting normal statistics cannot start a replacement flush that delays the receipt. Deadline or shutdown cancels the attempt and skips remaining steps; signal checks before reads and result writes prevent late work from publishing a successor's content or clearing its flags. Aborted gap-fill is discarded rather than retried against later files. Missing diff statistics or retained old totals are acceptable degradation; deferring these reads was rejected after independent repros showed cross-turn content and metadata contamination. Batch-history projection, completion analytics, notifications and turn-bound image uploads may follow release, with bounded owned waits. A yielded chain keeps its 30-second upper wait and raw owner. Shutdown skips workspace statistics, starts all active cancellations before processor drain, and prioritizes receipts with a six-second wait inside the CLI's seven-second total budget; Desktop allows ten seconds but finishes on actual exit. Cancellation history, ACP finalization and idle ordering remain unchanged. The unfinished Session/ACP dependency chain prevents a small complete native migration. Generated-image waits share this deadline and shutdown signal; uploads continue under ownedWork and attach only to the captured turn, dropping writes if it is gone. At six seconds, shutdown alone bypasses stuck finalizers with failed Inbox releases and clears live IDs; input is unknown and never replayed. SQLite failure remains a persistence limit.
