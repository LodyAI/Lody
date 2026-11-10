# Signed execution intents in encrypted workspaces

Status: implemented
Translation: current
Supersedes: [queued input evidence](../../archived/bug-fix/2026-11-05-e2ee-queued-input-evidence.md)

[中文](2026-11-10-e2ee-signed-execution-intent.zh.md)

## Abstract

An encrypted machine must know who wrote an input before it runs it, including inputs that
arrive days late, through a snapshot or after the server trimmed history. Proof used to come
from signed document frames, an exact encrypted request copy stored in the session document,
or a local receipt, each with a 15-minute window. Per the owner decision of 2026-11-10, every
executable input now carries one Ed25519 signature over its message ID and a digest of what
will run, written beside the content in the same commit. The start verifies that signature and
the signer's current rights, and never judges by time. Nothing on the execution path needs an
original frame or `forkAt`, and the signed bytes depend on no Loro structure, so Roost can keep
the same meaning. The cost is one more signing step before an encrypted send is written.

## Decision

- **Record.** `version, kind, signer, signature` (98 bytes) is stored as unpadded base64url in
  `e2eeIntent` on a turn row, a queue item or a schedule declaration. The document mirror has no
  binary value type, and a byte array written through it becomes a per-byte object.
- **Signed message.** `lody-e2ee/execution-intent/v1`, kind (member input, machine input,
  schedule declaration), genesis, workspace, target machine, scope, message ID and content
  digest (`packages/e2ee-core/src/internal/foundation/execution-intent.ts`).
- **Content digest.** One shared canonical form (`packages/shared/src/e2ee-execution-intent.ts`):
  the input configuration as the history writer stores it, through its own legacy
  normalization and schema, without `resume`, plus `derivedFrom` or `scheduleRun`. A schedule
  declaration signs its definition fingerprint. Fixed vectors pin both.
- **Writers.** A client signs before it writes: the desktop and portable hosts sign through
  `prepareDispatch`, and the turn or queue item is written with the record in one commit; an
  input its host cannot sign is not sent. A changed queue edit keeps its message ID and is
  signed again by the editor. Promotion copies the queue item's record. This machine signs
  inputs it writes itself (prepared Sessions, agent messages, automations, scheduled runs).
  A schedule's setter signs through `signScheduleDeclaration`, a host capability that computes
  the fingerprint itself and signs nothing else. Both hosts provide it, independently of RPC
  support, because the shared UI offers encrypted schedules on either.
- **Start.** `execution-intent-verification.ts` recomputes the digest from what will run,
  verifies the signature for this workspace, machine, session and message, then checks the
  signer in the current ledger, refusing an unknown signer only after an authenticated read.
  Each definite refusal has its own reason; only `e2ee_sender_not_authorized` reads as a
  sender without rights. A row's display account never chooses the requester, and an
  encrypted row never chooses its resume target: the watcher takes it from Session metadata.
  The input a start runs comes only from the signed input config: the watcher never builds
  an encrypted row's body from its displayed items, which no signature covers, so another
  writer can neither substitute a body under the owner's signature nor block it by
  dropping the stored blocks. A member's host signs only a complete composer input (an
  agent is chosen and the body is not empty); an input that leaves its agent to the
  Session is machine-authored and host-signed.
- **Journal.** An `agent-start` record holds message ID and digest. An ID starts once; other
  content under a started ID is refused. A turn the machine sees cancelled before it started
  is retired. Execution records carry `expiresAt` 0, which no clock, skew check or floor
  touches; feature requests keep their deadlines.
- **Waiting.** Only an unreadable ledger waits. A received frame for the document, a confirmed
  ledger read, a key installation and an RPC reconnect wake waiting turns; a fallback timer
  doubles from one second to five minutes. Background ledger retries never stop while the
  workspace is open, with the same five-minute ceiling.

## Alternatives

- _Keep frame signers and `forkAt` (#2344 options A and B)._ They need retained frames, server
  scans and time windows, and a snapshot or trimmed history leaves an input waiting forever.
  The #2344 proposal's open decision on keeping the Schedule fork until Roost is resolved:
  Schedules use signed declarations and no fork remains.
- _Store the exact encrypted request in the session document._ It added 1.4 to 2.2 times the
  turn row, depended on the epoch that sealed it, and required a 15-minute window.
- _Bind the queue row's writer to the frame's signer._ Tried earlier and removed: it refused
  ordinary sends under normal sync and snapshot delivery. Do not reintroduce it.
- _Refuse at promotion._ Every promotion route would need the check and a refused row could
  stall the queue; the start already has one visible refusal path.
- _Trust `userId` or map the signer to an account._ `userId` is display data, and the machine has
  no account directory.
- _Sign the whole row including `resume`._ Promotion supplies `resume` from Session metadata,
  so the author cannot sign it; the watcher ignores the row's value instead.

## Consequences

- E2EE has no production data. Older clients, rows without records and journals from before
  this change are not migrated; test machines reset their execution journals.
- Accepted by the owner: an empty journal (for example after reinstalling) does not know
  earlier IDs; the server can delay delivery; revocation takes effect through this machine's
  ledger reads; waiting inputs persist.
- A direct send now waits for its host signature, up to `QUEUED_ORIGINAL_DEADLINE_MS`, before
  the turn is written.
- Retiring a cancelled input needs the machine to observe the cancelled row before it turns
  pending again; a machine offline for that whole interval cannot retire it.
- Rewriting a schedule field with the same value no longer invalidates its declaration.
- The queue signal semantics are unchanged: a failure after the row was written still counts
  as a written send.

## Verification

`packages/shared/tests/e2ee-execution-intent.test.ts` and `packages/e2ee-core/test/foundation.test.ts`
pin the digest, record and signature vectors. `apps/cli/tests/e2ee-execution-intent.test.ts`
verifies real signatures from a document and its snapshot, each refusal reason and the
unknown-signer read. `apps/cli/tests/e2ee-runtime.test.ts` covers queued inputs (late, removed,
replayed, edited, machine-signed, rewritten items, dropped blocks), rotation, scheduled runs and declarations, and background
retries. `apps/cli/src/lib/e2ee/realtime-journal.test.ts` covers one start and retirement;
`apps/cli/tests/session-dispatch-watcher.test.ts` covers wake-ups and the capped fallback;
`packages/components/tests/legacy-session-send-migration.test.ts` covers client ordering.
`packages/e2ee-client/test/runtime.browser.test.ts` saves an encrypted schedule through the
real portable host and verifies the stored declaration.
No real backend, device or mobile run was made.
