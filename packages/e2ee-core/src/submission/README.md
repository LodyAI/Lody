# Durable ledger submission

`@lody/e2ee-core/submission` is a finite Effect 4.0.2 workflow for ordinary records
on an existing ledger. `./submission/sqlite` supplies a real local SQLite journal
using the repository's better-sqlite3 13.0.3. It enables no production feature.
The root foundation and synchronous ledger exports remain separate.

The application Scope owns the journal Layer and provides `SubmissionRemote`.
That trusted host port must return complete history and an independently expected
head/count for the caller-pinned genesis, and perform conditional append with
exact-body idempotency. It must enforce the same P08 signature/permission rules;
a packet's endpoint or document credential is insufficient. No production
Convex/Streams adapter, background runtime or retry scheduler is supplied.

```text
submitRecord(anchor, original signed bytes)
  verify full history and original operation at its authenticated parent
  journal.prepare: persist exact bytes before CAS
  resumeSubmission:
    read + verify entire history; reject rollback from saved head/count
    original bytes present -> Committed
    parent occupied -> Conflict; never re-sign
    parent still head -> save verified pin -> CAS(same bytes) -> verified readback
  journal.finish: one transaction saves result/pin and clears pending
acknowledgeSubmission(anchor, exact result)
  clear result; retain verified rollback pin
```

One pending attempt or unconsumed result per genesis per journal is supported.
Different bytes cannot replace it, even with the same operation/producer identity.
The result retains the original record for downstream consumers. Until explicit
acknowledgement, new attempts return `busy`. Typed append failures trigger
readback; unavailable reads, invalid history, interruption, or storage failures
leave pending intact. `unconfirmed` means neither success nor definitive failure.
Call recovery again at startup or connectivity return; no new signature is made.

The journal stores bytes and rollback pins, never permissions or a serialized
`LedgerView`. Recovery always replays from the external trusted genesis; even
terminal rows are revalidated. Imported legacy journals and foreign databases
are refused. Do not repin genesis, erase evidence, or replace a bad chain with
a new snapshot. This slice requires full retained history; authenticated
checkpoint restore, bounded-page persistence, genesis creation, vault/key custody,
P12 atomic removal, and durable downstream key distribution remain separate work.

Use a dedicated application-owned filesystem path with a persistent parent
directory. The adapter rejects `:memory:`, uses WAL/FULL, bounds lock waits, and
closes the handle on Scope exit without deleting data. SQLite transaction failures
roll back together; disk destruction or a filesystem/hardware that fails durability
is not repaired by this workflow. A head/count prevents rollback relative to local
accepted evidence, not a global freshness proof or resistance to disk replacement.

Run package `typecheck` and `test`. The synthetic local SQLite host in
`test/submission/fixture.ts` calls real P08 verification and CAS. Independent Node
processes exit after pending save / after durable CAS before response, then reopen
the same files through the public package entries. Tests also inject real SQLite
transaction failures, revoked signers, bad histories, forged terminal rows and
Scope interruption. Vitest remains 3.2.4: @effect/vitest 4.0.2 requires Vitest 5,
so these tests use Vitest with `Effect.scoped` and explicit Deferred signals.

[Decision and limits](../../../../.agents/notes/implemented/architecture/2026-10-11-e2ee-pending-recovery.md)
 · [Main source fingerprints](provenance.json).
