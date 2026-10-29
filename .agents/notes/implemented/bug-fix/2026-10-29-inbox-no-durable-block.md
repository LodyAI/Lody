# Inbox availability before release proof

Status: implemented
Translation: current
Supersedes: [Manual Inbox recovery](../../archived/bug-fix/2026-10-21-manual-inbox-recovery.md)

[中文](2026-10-29-inbox-no-durable-block.zh.md)

## Abstract

In the owner-reported 0.107.2 incident, Desktop killed the CLI after three seconds, leaving no release receipt. A conversation had accumulated 153 historical PIDs; the one-shot restart probe could not prove release and permanently rejected input. Inbox now retires uncertain execution without replay and keeps subsequent input available. Orphan processes can continue running: restart orphan cleanup belongs to the next PR.

## Decision and alternatives

Overall availability takes priority over local release proof. Activation clears legacy blocks, finishes interrupted inputs and preserves unknown batches. Release uncertainty and conflicting receipts cannot lock a conversation; the first receipt wins. Restart retirement logs a warning because SQLite activation has no history writer. Runtime failure detaches the exact old Session before returning its slot. One background cleanup attempt uses only that execution's handles, with a five-second budget; it cannot release or terminate a successor. Failure is reported through the existing Stop notice and logs, and drain still allows Inbox/runtime/database shutdown. Resource registration and the current schema stay unchanged. Unknown submitted work never replays.

Longer exit deadlines only reduce one trigger. Better PID probing still cannot prove missing identities, PID reuse or Windows descendants. Keeping a durable block with a manual UI confirmation still makes availability depend on operator repair. Those options were rejected in favor of retiring the input and isolating the failed Agent. The [operation Inbox contract](../architecture/2026-10-12-operation-inbox.md) is partially superseded only for release-proof admission. The [process-tree decision](2026-10-15-unreleased-session-resources-retry.md) retains zombie/Windows termination rules, while its old successor fence is replaced. Session/ACP orchestration remains an unfinished dependency chain; no broader native Effect migration is included. The existing native execution owner and bridge bound cleanup.

## Evidence and limits

`apps/cli/src/orchestration/inbox/inbox.test.ts` exercises real SQLite retirement, legacy blocks, unknown non-replay, first-receipt wins and preserved resource identities. `apps/cli/tests/session-execution-service.test.ts` exercises failed termination, fresh ACP delivery and visible reporting. Coordinator tests cover terminal closure. The incident figures above are owner-provided, not reproduced against private data. No real orphan process cleanup, Windows host or packaged desktop acceptance is claimed.
