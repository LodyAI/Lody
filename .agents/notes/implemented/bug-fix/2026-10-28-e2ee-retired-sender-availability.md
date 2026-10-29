# E2EE retired-sender availability

Status: implemented
Translation: current

[中文](2026-10-28-e2ee-retired-sender-availability.zh.md)

## Abstract

A valid current-epoch mailbox envelope can outlive its sender's membership. Refusing
that key previously aborted the owner's receive page and prevented independent
key distribution, leaving newly admitted recipients without a current key. Receive
and distribution now report separate outcomes and retry cursors. Fetch skips
retired and unknown senders without installation; only verified retirement permits
digest repair, while unknown identities request ledger refresh and remain retryable.

## Decision and boundaries

This extends [key maintenance availability](2026-10-27-e2ee-key-maintenance-availability.md)
without changing its restriction to deterministic digest rejection. A genuine
`VerifiedLedger` view retains every admitted device's historical identity across full
replay, retained state and qualified snapshots. A key present in that history but
absent from current devices/membership is retired, and ledger policy forbids reusing
it. Strict signature verification binds the frame's exact workspace, epoch, sender
and recipient before returning its digest for repair. Server sender hints or absence
from a server list cannot establish retirement; mismatched routing still skips without
rejection. Unknown keys are never classified as retired, installed or journaled.

`fetchAndInstall` continues later rows and returns their cursor with bounded retirement
diagnostics and a refresh request. The native round queues deterministic repairs
through the existing durable journal. Desktop maintenance requests verified history
refresh once after independent distribution, then retries original mailbox bytes.
An unavailable refresh never authorizes installation or rejection of unknown keys.

The existing workspace owner serializes each finite round. Receive (including its
staging pre-step), distribution and the final report flush preserve separate Results
on `WorkspaceKeyRoundFailure`; callers can observe/acknowledge the successful sibling
and retry using the supplied cursor hints. Failed phases retain their input cursors.
Desktop cryptographic repair still inspects the original `MailboxInstallError` diagnosis,
never a general phase failure. Ordinary typed failures are contained; defects and
interruption propagate. Existing close/drain, native settlement, exact originals and
store ownership remain; there is no new retry timer, writer or retained resource.
These modules already use native Effect v4, so no migration unit changes.

Keeping receive as a gate would preserve the reproduced outage. Accepting keys from
retired senders, clearing the mailbox, or rejecting unknown identities would weaken
permission or recovery. Filtering on the backend alone cannot protect the client
against retained or hostile responses, so client behavior stands independently.

## Evidence and limits

Real crypto/SQLite regressions first failed on non-current-sender page starvation
and receive-error gating of delivery. The fixed suites also exercise retry of an
unknown sender after verified admission, independent delivery results and cursor
retention, strict signature/HPKE rejection, local installation failures, and retained
originals. Local full-stack evidence and exact checks are reported in the PR.
No production deployment, real OS keystore, installed desktop or physical-device
acceptance is implied. The local additional-device scenario extends the acceptance
harness without changing its existing assertions; it is not public product source.
