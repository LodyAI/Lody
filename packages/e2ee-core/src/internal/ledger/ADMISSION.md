# Public admission consent and intent

`admission.ts` (exported through `@lody/e2ee-core/protocol`) contains borrowed-signer functions and a pure ordinary-command builder. It preserves genesis v1 and join/v1 bytes and all signing domains. The owner-approved pre-freeze machine variant extends possess/v2 with machineId; personal/recovery bytes stay unchanged. Nothing starts a Runtime, creates an identity/key, stores secrets or publishes remotely.

`prepareJoinRequest` signs independently supplied Org, request ID, user ID, device signing/encryption key and nullable expiry. It is joining consent, never proof that a cloud account owns that user ID. The trusted host still authenticates account identity and checks expiry. No deadline claim, timing tolerance or enforcement policy is introduced. `prepareDeviceAdmission` fixes Org/membership/kind and new device keys before borrowing the signer; extra runtime fields cannot retarget the proof. Unknown kind/invalid expiry fails. Fixed verification always checks the borrowed signer's output.

`prepareLedgerCommand(view, signer, command)` builds only existing AdmitMember, SetRole, AdmitDevice, RevokeDevice and TransferOwner ordinary bodies. It goes through the genuine-view and existing proof/permission gate in `signing.ts` before returning a private prepared proposal. Signing remains parent-relative; competing records require an explicit fresh user intent, never automatic rebase/re-sign. Send the exact resulting bytes through `LedgerSubmission`. Non-atomic tag2 RemoveMember is absent and rejected. The selected D12 tag8 and tag7 publishers are owned by `EpochPublisher`: management-personal authority and required rotation for tag7, Owner-personal/non-Owner target for tag8, full-group staging before the unchanged submission CAS. See the [draft contract](../../../../../specs/e2ee/atomic-removal.md).

`signGenesisRecord` borrows an existing initial opaque epoch key and Ed25519 signer, derives the canonical epoch-zero commitment (which deliberately omits genesis), signs fixed public fields and verifies the complete one-record ledger before returning owned `{genesis, record}`. The caller must already retain the initial key durably before remote publication. This function neither proves that storage/backup prerequisite nor publishes/installs anything. Returned producer bytes are not independent endpoint, account or production trust. No secret byte export or protection callback is introduced.

Caller fields and signing capability are captured when the Effect runs, before signing awaits. Device private-key lifetime/cancellation belongs to its owner; existing native signer waits non-cancellable work before scratch cleanup. The workflows expose no hidden runtime or retry. Tests use real synthetic Node signatures and independent epoch-zero commitment bytes, live ledger policy, proof retargeting/replay, malformed signer outputs, Deferred request mutation, parent conflicts and unknown/legacy commands. Run `pnpm --filter @lody/e2ee-core exec vitest run test/ledger/replay.test.ts`.

Machine tag4 is `[4,1,signingKey,encryptionKey,possessionSignature,machineIdBytes,replacedSigningKeyOrNull]`.
The machine possession tuple is `[genesis,membershipId,signingKey,encryptionKey,1,machineIdBytes]`
under possess/v2. machineId is exact strict UTF-8, 1..256 bytes, without normalization;
encoding rejects unpaired surrogates and decoding rejects malformed UTF-8. Session IDs
stay only in the separate credential-binding proof. Personal/recovery tag4 and possession
remain five fields. The current-format decoder rejects old five-field machine records.
A replacement names the exact current same-member machine with that ID, retains old
identity evidence and sets rotationRequired as advice to update keys, without blocking
sends. Retries keep the signed original unchanged. Removing inherited M2 send guards
belongs to PR20; this admission change adds no send guard.
