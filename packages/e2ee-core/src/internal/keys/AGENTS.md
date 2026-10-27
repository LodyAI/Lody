# Epoch keys

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Behavior: [workflows](../../../docs/workflows.md). Ports: [services](../../../docs/services.md).

- Only `InstalledEpochKeys` touches installed key material; every other workflow
  borrows its `saveAndReload`/`read` and receives opaque keys. Never add a generic
  secret export, per-call protection callback, or a second owner of the store.
- Protection authenticates the whole fixed purpose/genesis/device/epoch/commitment
  /key payload; epoch-zero's genesis-free commitment cannot let a blob move between
  workspaces. No plaintext fallback, new wire algorithm or recovery format.
- Await native settlement and wipe operation-owned plaintext on success, failure
  and interruption. Scope close refuses admission, waits native work, then closes
  storage; a timeout does not prove native work stopped.
- Save/reload/unprotect/commitment checks precede any installation report. Valid
  stored originals win; an unreadable blob is replaced only after the new blob
  opened and matched the same verified commitment. Reports are claims.

- `KeyReceiver`: every pending envelope installation repeats real HPKE and
  commitment checks, including after reopen; a disk phase or old report never
  stands in. Queued reports retry their original bytes without re-signing. Copy
  and validate a whole fetched page before any write; a failed install returns no
  `next`. Skip routing/hint mismatches for this fetch, without saving/rejecting them.
  `MailboxInstallError` diagnoses the exact frame; it never rejects it.
- Discovery/repair revisions and mailbox statuses are hints, never authority. Only
  a genuine current ledger ends a task as Obsolete/Revoked. Finite pages let blocked
  work be skipped without starving later tasks; no hidden loop.
- Reported/Repaired/Observed are local attempt history, never custody or
  installation proof. Keep originals and results until explicit acknowledgement.

- `KeyRepair` binds stable caller ids to workspace/device/epoch/rejected digest
  before dispatch; retries never invent another id. Never dispatch through a view
  older than one already observed, even after a failed pin write.
- `KeyDistributor` discovers targets from the genuine ledger, never a server list.
  The first outbox ciphertext per recipient/epoch is immutable and re-sent on every
  revision; Recovery devices never send. Capacity blocks new tasks, never deletes.

- `EpochPublisher` candidates use `CandidateProtector`, never installed-key
  protection, and authenticate purpose/context/original record/envelope digest.
  Persist and open the candidate, stage the complete post-transition group and
  compare exact readback before first submission. A matching journal original resumes
  CAS without staging/readback again. Retry exact records; install only
  genuinely committed epochs; Conflict discards the candidate key. Retained submission
  recovery requires genuine checkpoint/key proof before ACK; damaged candidate keys
  require independent committed-key receipt. Never bypass CandidateProtector for
  unpublished keys or re-sign an uncertain record. Delete staged
  groups only for a genuine different commitment at the same epoch, by the group's
  signing device. Storage never supplies ledger authority.
- `InstalledEpochHistory` recovers from the installed latest key only, verifies the
  whole chain before writes, wipes copies on every exit and retries only genuinely
  missing keys. It restores no envelopes, publishes nothing, selects no vault.

- Envelopes keep `AAD || enc32 || ct48 || signature64` and `lody-e2ee/epoch-env/v1\0`;
  context comes from the caller, never the frame. Check the outer signature before
  decryption and current authority after it. Recovery devices cannot send.
- History packets keep the v1 commitment/AAD domains and epoch-zero exception; no
  nonce override. `recoverLedgerHistory` requires a genuine view and returns all
  epochs or none.
