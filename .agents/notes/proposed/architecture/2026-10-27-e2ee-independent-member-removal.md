# Independent member removal for the MVP

Status: proposed
Translation: current
PR: [#1979](https://github.com/LodyAI/Lody/pull/1979)

[中文](2026-10-27-e2ee-independent-member-removal.zh.md)

## Abstract

Mandatory atomic removal/rotation can postpone access revocation when key publication fails. The owner chose availability-first removal: tag10 revokes a member and every device immediately, keeps the published epoch and advises administrators to finish the key update later. Capability 1 is declared before the operation; snapshot, retained state and digest v4 preserve this gate. This draft implements the protocol boundary; server projection/credential invalidation and honest-client local deletion need separate integration. A former member retaining the old key can decrypt ciphertext it obtains until the new epoch is used.

## Decision and responsibilities

Owner personal devices may remove any non-Owner; Admin personal devices may remove Member/Guest only. Owner role changes remain tag3. Tag2 remains rejected; tag8 retains its existing Owner-only atomic behavior. Keeping tag8 costs no compatibility adapter and preserves a coherent explicit operation. Tag10 is `[10, membershipId]` under unchanged ordinary signature/hash domains. A prior tag9 capability 1 declaration is mandatory; unsupported declarations stop with upgrade-required. Authorized declarations monotonically union into the state. Current-only compact state v4 appends the sorted capability list; no old-state migration is introduced. The independent Python/PyNaCl vector changes before the first production freeze. Existing readable-ledger consumers understand tag10 as a member removal without a new epoch; member management controls remain a separate integration.

Removal shares one state transition with all target devices and machine bindings. Historical author identities, retired member/device keys and closed joins remain; returning accounts require fresh invitations, member instances and keys. Remaining writers may seal with the published epoch while rotationRequired is true. This supersedes the mandatory coupling in the [old current-decisions note](../../implemented/architecture/2026-10-15-e2ee-current-decisions.md) and composes with [manual rotation](2026-10-27-e2ee-mvp-manual-rotation.md).

The ordinary command path uses existing WorkspaceControl ownership and exact-original LedgerSubmission. Cancellation, acknowledgement, conflicts and unknown outcomes keep that owner; no automatic rebase or re-sign is added. Native Effect v4 is already present, so no additional migration unit is needed.

Server acceptance must invalidate all device projections, credentials and renewal permission in the acceptance transaction, before optional cleanup. MVP relies only on existing 15-minute content-token expiry and does not actively revoke issued tokens or disconnect long-lived connections; active disconnect is deferred. Honest clients delete this encrypted workspace's local data on the next open after learning removal, stop sync and remote execution; malicious copies cannot be erased.

## Verification and limits

The new native Ed25519 tests fail before the change and cover role/kind authority, every device's loss of current rights, retained historical authors, usable old-epoch sealing, new-instance rejoin, real command signing, capability gates and snapshot/retained equivalence. Existing real SQLite feed/reopen and epoch publication suites are run with the changed state format. Latest-main composition retains the candidate-recovery contract and the independent removal contract. CI exposed two stale vector consumers: capability 1 is now supported, and the unsupported declaration moves to capability 2 at index 13; endpoint hashes/counts follow the signed vector. Updating those expectations also exposed a real reader omission: tag10 previously threw Unsupported ledger operation. Native signed fixtures now cover the readable removal, unchanged epoch, updated membership and the genuine unsupported-capability stop (RED before the reader fix). These checks do not establish deployed token expiry, real keychain behavior, installed-client deletion or Spec approval. The public removal Spec remains draft.
