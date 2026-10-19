# Public surface

[中文](surface.zh.md) · [Reading guide](../README.md)

Every export of every public entry, grouped by purpose. Each export, namespace export and service member has JSDoc
(enforced by `pnpm --filter @lody/e2ee-core check:docs` and
`test/public-docs.test.ts`). This checks comment presence, not whether an
explanation is sufficient; reviewers must still check ownership, failures and
retry semantics. Print the exact current list with
`pnpm --filter @lody/e2ee-core exec tsx scripts/check-public-docs.ts --list`.

`@lody/e2ee-core/internal` is not public: it re-exports internals for this
repository's tests and the Lab, with no compatibility promise.

## `@lody/e2ee-core` — workflows

| Group | Exports |
| --- | --- |
| Composition | `E2eeWorkflows` |
| Ledger | `VerifiedLedger`, `VerifiedLedgerError`, `LedgerFeed`, `LedgerFeedOptions`, `LedgerFeedOrigin`, `SnapshotFeedOrigin`, `LedgerSubmission`, `SubmissionError`, `SubmissionFailure` |
| Installed keys | `InstalledEpochKeys`, `InstalledEpochHistory`, `InstalledKeyError`, `MAX_PROTECTED_EPOCH_BYTES` |
| Receiving | `KeyReceiver`, `ReceiveError`, `ReceiveFailure`, `ReceiveBatch`, `MailboxInstallError` |
| Repair | `KeyRepair`, `RepairError`, `RepairBatch` |
| Distribution | `KeyDistributor`, `DistributionError`, `DistributionFailure`, `DistributionBatch`, `DistributionResult`, `DeliveryError`, `DeliveryOutcome` |
| Publication | `EpochPublisher`, `EpochPublishError`, `EpochPublishFailure`, `EpochPublishResult` |
| Value types | `Bytes` (namespace), `LedgerView`, `LedgerCheckpoint`, `LedgerState`, `LedgerFeedState`, `LedgerReadPage`, `DeviceSigner`, `EpochStagedGroup` |
| Protocol errors | `LedgerError`, `LedgerFeedError`, `ContentError`, `ValidationError`, `EpochKeyError` |
| Recovery | `RecoveryVaults`, `makeWorkspaceRecovery`, `RecoveryVaultError`, `RecoveryVault`, `RecoveryEntryReference`, `RecoveryPrivatePackage`, `WorkspaceRecoveryInput`, `RecoverySubmitResult`, `RecoveryEnvelope` |
| Workspace facade | `E2eeWorkspace`, `makeE2eeWorkspace`, `E2eeWorkspaceHandle`, `WorkspacePlatform`, `WorkspacePorts`, `WorkspaceRecoveryConfiguration`, `WorkspaceResources`, `WorkspaceDocumentState`, `WorkspaceModel`, `WorkspaceRotationStatus`, `WorkspaceRestoreRequest`, `WorkspaceRestorePlan`, `WorkspaceError`, `unavailableWorkspaceRecovery`, `WorkspaceControl`, `WorkspaceControlError`, `runWorkspaceKeyRound`, `WorkspaceKeyRoundCursors`, `WorkspaceKeyRoundError`, `issueWorkspaceInvitation`, `verifyWorkspaceInvitationSnapshot`, `verifyRetainedWorkspaceGenesis`, `WorkspaceInvitation`, `WorkspaceInvitationMailbox`, `WorkspaceInvitationSnapshot` |

## `@lody/e2ee-core/services` — ports

| Group | Exports |
| --- | --- |
| Backend | `LedgerLog`, `LedgerFeedSource`, `KeyMailbox`, `KeyMailboxStatus`, `EpochStagingStore` |
| Platform | `DeviceIdentity`, `KeyProtector`, `CandidateProtector`, `nativeDeviceSigner`, `DeviceSigner` |
| Application | `WorkspaceScope`, `LedgerViewSource`, `LedgerSync`, `EpochPublicationSource` |
| Local storage | `LedgerPinStore`, `LedgerFeedStore`, `LedgerFeedContents`, `LedgerFeedTail`, `InstalledKeyStore`, `ReceiveJournal`, `ReceiveTaskRow`, `ReceiveTaskPhase`, `RepairJournal`, `RepairTaskRow`, `RepairTaskPhase`, `DistributionJournal`, `DistributionTaskRow`, `DistributionTaskPhase`, `DeliveryOutbox`, `EpochCandidateStore`, `EpochCandidateRow`, `SubmissionJournal`, `SubmissionEntry`, `SubmissionOutcome`, `SubmissionResult` |
| Port errors | `BackendError`, `LedgerLogError`, `LedgerViewSourceError`, `LocalStoreError`, `KeyProtectorError`, `LedgerFeedError` |
| Value types | `GenesisHash`, `SigningPublicKey`, `LedgerView`, `LedgerCheckpoint`, `LedgerReadPage`, `LedgerFeedState`, `MailboxSlot`, `EpochStagedGroup`, `EpochStagedGroupKey` |
| Recovery | `RecoveryVaultStore`, `RecoveryVaultLocalStore`, `VaultCiphertext` |

## `@lody/e2ee-core/protocol` — pure protocol

| Group | Exports |
| --- | --- |
| Bytes and encoding | `Bytes`, `encodeCbor`, `decodeCbor`, `CborValue`, `ValidationError`, `ValidationErrorCode`, `ContentError` |
| Signatures | `verifySignature`, `verifyContentSignature`, `signVerified`, `nativeDeviceSigner`, `DeviceSigner` |
| Content format | `encodeDocumentContext`, `encodeContentContext`, `encodeContentHeader`, `contentKeyInfo`, `contentHkdfSalt`, `contentAad`, `contentSigningBytes`, `inspectContentFrame`, `DocumentScope`, `ContentScope`, `ContentPurpose`, `ContentHeader`, `ContentMetadata` |
| Documents | `sealDocument`, `openDocument`, `authenticateDocument`, `admitDocument`, `deriveDocumentKey`, `scopedDocumentKey`, `importDocumentKey`, `exportDocumentKey`, `disposeDocumentKey`, `DocumentKey` |
| Content crypto | `deriveContentKey`, `disposeContentKey`, `sealContentAead`, `openContentAead`, `ContentKey`, `SealedContentAead` |
| Epoch HPKE | `epochHpkeAad`, `sealEpochKeyHpke`, `openEpochKeyHpke`, `HpkePrimitiveError`, `EpochHpkeContext`, `SealedEpochHpke` |
| Records | `decodeRecord`, `hashRecordBytes`, `recordSigningBytes`, `joinRequestSigningBytes`, `possessionSigningBytes`, `DecodedRecord`, `RecordBody`, `Operation`, `JoinRequest`, `Role`, `DeviceKind`, `LedgerError`, `LedgerErrorCode` |
| Replay and views | `verifyLedger`, `verifyLedgerEffect`, `extendLedger`, `extendLedgerEffect`, `requireLedgerContinuation`, `hasVerifiedRecordHash`, `hasVerifiedCheckpoint`, `contentPermissions`, `epochHistoryPacket`, `epochPublicationRecord`, `LedgerView`, `LedgerCheckpoint`, `LedgerState`, `Member`, `Device`, `ContentPermissions`, `EpochHistoryPacket`, `HistoricalContentAuthor` |
| Record signing | `prepareLedgerRecord`, `signLedgerRecord`, `PreparedLedgerRecord` |
| Admission and genesis | `prepareJoinRequest`, `prepareDeviceAdmission`, `prepareLedgerCommand`, `signGenesisRecord`, `LedgerCommand` |
| Snapshots | `verifyLedgerSnapshot`, `prepareLedgerSnapshot`, `signLedgerSnapshot`, `snapshotTrustFromView`, `authenticateLedgerSnapshotEvidence`, `encodeSignedSnapshot`, `snapshotSigningBytes`, `headAttestationSigningBytes`, `historicalContentIdentity`, `comparisonNote`, `compareNotes`, `confirmIndependentComparison`, `SnapshotTrust`, `VerifiedViewSnapshotTrust`, `SnapshotIdentityPin`, `SnapshotEvidence`, `SnapshotProposal`, `ComparisonNote`, `Comparison`, `IndependentConfirmation`, `HistoricalContentIdentity` |
| Feed pages | `prepareLedgerPage`, `prepareLedgerPageEffect`, `frameLedgerRecord`, `validLedgerOffset`, `LedgerFeedError`, `LedgerFeedState`, `LedgerReadPage` |
| Epoch keys | `commitEpochKey`, `sealHistoryPacket`, `openHistoryPacket`, `recoverLedgerHistory`, `EpochKeyError` |
| Envelopes | `prepareEpochEnvelope`, `openEpochEnvelope`, `authenticateEpochEnvelope`, `authenticateEpochEnvelopeSignature`, `epochDeliveryId`, `EpochEnvelopeContext` |
| Staged groups | `ownEpochStagedGroup`, `ownEpochStagedGroupKey`, `sameEpochStagedGroup`, `authenticateEpochStagedGroup`, `obsoleteEpochStagedGroup`, `getCommittedEpochStagingKey`, `EpochStagingError`, `EpochStagedGroup`, `EpochStagedGroupKey` |
| Reports | `installationBody`, `installationSigningBytes`, `encodeInstallationReport`, `decodeInstallationReport`, `authenticateInstallationReport`, `checkInstallationContext`, `checkLocalPublication`, `envelopeRouting`, `mailboxDigest`, `slotId`, `MailboxSlot`, `InstallationSource`, `InstallationContext` |
| Recovery | `generateRecoveryPackage`, `importRecoveryIdentity`, `parseRecoveryFile`, `wipeRecoveryPackage`, `verifiedPasskeyPrf`, `disposePrf`, `ownVaultCiphertext`, `vaultCiphertextDigest`, `sameVaultCiphertext`, `RecoveryVaultError`, `RecoveryIdentity`, `RecoveryPrivatePackage`, `VerifiedPasskeyPrf`, `VaultCiphertext` |

## `@lody/e2ee-core/host` — backend contract

| Group | Exports |
| --- | --- |
| Staging wire contract | `EpochStagedGroupDto`, `EpochStagedGroupKeyDto`, `EpochStagedEnvelopeDto`, `EpochStagingRequestProofDto`, `encodeEpochStagedGroup`, `decodeEpochStagedGroup`, `decodeEpochStagedGroupKey`, `epochStagingRequestSigningBytes` |
| Staging rules | `checkEpochStageRequest`, `ownEpochStagedGroup`, `ownEpochStagedGroupKey`, `sameEpochStagedGroup`, `obsoleteEpochStagedGroup`, `getCommittedEpochStagingKey`, `EpochStagingError`, `EpochStagedGroup`, `EpochStagedGroupKey` |
| Mailbox rules | `envelopeRouting`, `authenticateEpochEnvelope`, `authenticateInstallationReport`, `checkLocalPublication`, `decodeInstallationReport`, `mailboxDigest`, `slotId`, `validSlot`, `MailboxSlot`, `InstallationContext` |
| Document admission | `admitDocument`, `admitStreamsUpdateBatch`, `admitStreamsUpdateBatchEffect`, `admitStreamsSnapshot`, `admitStreamsSnapshotEffect`, `authenticateStreamsSnapshotEffect`, `StreamsRecordBoundary`, `StreamsRecordBoundaryPort` |
| Port types | `KeyMailbox`, `KeyMailboxStatus`, `EpochStagingStore` |
| Recovery vault wire contract | `RecoveryVaultCiphertextDto`, `RecoveryVaultPutRequest`, `RecoveryVaultReadRequest`, `RecoveryVaultIndexReadRequest`, `RecoveryVaultIndexCasRequest`, `RecoveryVaultIndexCasReply`, `RecoveryVaultDeleteRequest`, `encodeRecoveryVaultCiphertext`, `decodeRecoveryVaultCiphertext`, `RecoveryVaultStore` |

## `@lody/e2ee-core/adapters/node-sqlite`

| Group | Exports |
| --- | --- |
| All stores | `sqliteLocalStores`, `SQLITE_STORE_FILES`, `SqliteFileOptions` |
| One store each | `sqliteLedgerPinStore`, `sqliteLedgerFeedStore`, `sqliteInstalledKeyStore`, `sqliteReceiveJournal`, `sqliteRepairJournal`, `sqliteDistributionJournal`, `SqliteDistributionJournalOptions`, `sqliteDeliveryOutbox`, `sqliteEpochCandidateStore`, `sqliteSubmissionJournal` |
| Reference mailbox backend | `makeSqliteKeyMailbox`, `referenceKeyMailbox`, `MailboxError`, `MailboxStatus`, `MailboxTarget` |
| Reference snapshot journal | `makeSqliteSnapshotPublication`, `snapshotPublicationDigest`, `SnapshotPublicationError`, `SnapshotPublicationRow` |

## `@lody/e2ee-core/adapters/loro-streams`

`streamsLedgerLog`, `makeStreamsLedgerLog`, `StreamsLedgerLogOptions`,
`LedgerSubmissionStream`, `streamsLedgerFeedSource`, `makeLedgerStreamReader`,
`LedgerStreamReader`, `streamsDocumentBinding`, `StreamsDocumentBindingOptions`,
`makeStreamsUpdateBinding`.
