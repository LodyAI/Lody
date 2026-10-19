# 公开接口

[English](surface.md) · [导读](../README.zh.md)

按用途分组列出每个公开入口的全部导出。每个导出、命名空间内的导出与 service 成员都有 JSDoc（由 `pnpm --filter @lody/e2ee-core check:docs` 与 `test/public-docs.test.ts` 保证）。检查器只检查注释存在性；所有权、失败与重试语义是否说明充分仍需人工检查。用 `pnpm --filter @lody/e2ee-core exec tsx scripts/check-public-docs.ts --list` 打印当前的精确列表。

`@lody/e2ee-core/internal` 不是公开接口：它为本仓库测试与 Lab 重新导出内部实现，不做任何兼容性承诺。

## `@lody/e2ee-core` — 流程

| 分组 | 导出 |
| --- | --- |
| 组合 | `E2eeWorkflows` |
| 账本 | `VerifiedLedger`, `VerifiedLedgerError`, `LedgerFeed`, `LedgerFeedOptions`, `LedgerFeedOrigin`, `SnapshotFeedOrigin`, `LedgerSubmission`, `SubmissionError`, `SubmissionFailure` |
| 已安装密钥 | `InstalledEpochKeys`, `InstalledEpochHistory`, `InstalledKeyError`, `MAX_PROTECTED_EPOCH_BYTES` |
| 接收 | `KeyReceiver`, `ReceiveError`, `ReceiveFailure`, `ReceiveBatch`, `MailboxInstallError` |
| 修复 | `KeyRepair`, `RepairError`, `RepairBatch` |
| 分发 | `KeyDistributor`, `DistributionError`, `DistributionFailure`, `DistributionBatch`, `DistributionResult`, `DeliveryError`, `DeliveryOutcome` |
| 发布 | `EpochPublisher`, `EpochPublishError`, `EpochPublishFailure`, `EpochPublishResult` |
| 值类型 | `Bytes`（命名空间）, `LedgerView`, `LedgerCheckpoint`, `LedgerState`, `LedgerFeedState`, `LedgerReadPage`, `DeviceSigner`, `EpochStagedGroup` |
| 协议错误 | `LedgerError`, `LedgerFeedError`, `ContentError`, `ValidationError`, `EpochKeyError` |
| 恢复 | `RecoveryVaults`, `makeWorkspaceRecovery`, `RecoveryVaultError`, `RecoveryVault`, `RecoveryEntryReference`, `RecoveryPrivatePackage`, `WorkspaceRecoveryInput`, `RecoverySubmitResult`, `RecoveryEnvelope` |
| 工作区门面 | `E2eeWorkspace`, `makeE2eeWorkspace`, `E2eeWorkspaceHandle`, `WorkspacePlatform`, `WorkspacePorts`, `WorkspaceRecoveryConfiguration`, `WorkspaceResources`, `WorkspaceDocumentState`, `WorkspaceModel`, `WorkspaceRotationStatus`, `WorkspaceRestoreRequest`, `WorkspaceRestorePlan`, `WorkspaceError`, `unavailableWorkspaceRecovery`, `WorkspaceControl`, `WorkspaceControlError`, `runWorkspaceKeyRound`, `WorkspaceKeyRoundCursors`, `WorkspaceKeyRoundError`, `issueWorkspaceInvitation`, `verifyWorkspaceInvitationSnapshot`, `verifyRetainedWorkspaceGenesis`, `WorkspaceInvitation`, `WorkspaceInvitationMailbox`, `WorkspaceInvitationSnapshot` |

## `@lody/e2ee-core/services` — 端口

| 分组 | 导出 |
| --- | --- |
| 后端 | `LedgerLog`, `LedgerFeedSource`, `KeyMailbox`, `KeyMailboxStatus`, `EpochStagingStore` |
| 平台 | `DeviceIdentity`, `KeyProtector`, `CandidateProtector`, `nativeDeviceSigner`, `DeviceSigner` |
| 应用 | `WorkspaceScope`, `LedgerViewSource`, `LedgerSync`, `EpochPublicationSource` |
| 本地存储 | `LedgerPinStore`, `LedgerFeedStore`, `LedgerFeedContents`, `LedgerFeedTail`, `InstalledKeyStore`, `ReceiveJournal`, `ReceiveTaskRow`, `ReceiveTaskPhase`, `RepairJournal`, `RepairTaskRow`, `RepairTaskPhase`, `DistributionJournal`, `DistributionTaskRow`, `DistributionTaskPhase`, `DeliveryOutbox`, `EpochCandidateStore`, `EpochCandidateRow`, `SubmissionJournal`, `SubmissionEntry`, `SubmissionOutcome`, `SubmissionResult` |
| 端口错误 | `BackendError`, `LedgerLogError`, `LedgerViewSourceError`, `LocalStoreError`, `KeyProtectorError`, `LedgerFeedError` |
| 值类型 | `GenesisHash`, `SigningPublicKey`, `LedgerView`, `LedgerCheckpoint`, `LedgerReadPage`, `LedgerFeedState`, `MailboxSlot`, `EpochStagedGroup`, `EpochStagedGroupKey` |
| 恢复 | `RecoveryVaultStore`, `RecoveryVaultLocalStore`, `VaultCiphertext` |

## `@lody/e2ee-core/protocol` — 纯协议

| 分组 | 导出 |
| --- | --- |
| 字节与编码 | `Bytes`, `encodeCbor`, `decodeCbor`, `CborValue`, `ValidationError`, `ValidationErrorCode`, `ContentError` |
| 签名 | `verifySignature`, `verifyContentSignature`, `signVerified`, `nativeDeviceSigner`, `DeviceSigner` |
| 内容格式 | `encodeDocumentContext`, `encodeContentContext`, `encodeContentHeader`, `contentKeyInfo`, `contentHkdfSalt`, `contentAad`, `contentSigningBytes`, `inspectContentFrame`, `DocumentScope`, `ContentScope`, `ContentPurpose`, `ContentHeader`, `ContentMetadata` |
| 文档 | `sealDocument`, `openDocument`, `authenticateDocument`, `admitDocument`, `deriveDocumentKey`, `scopedDocumentKey`, `importDocumentKey`, `exportDocumentKey`, `disposeDocumentKey`, `DocumentKey` |
| 内容加密 | `deriveContentKey`, `disposeContentKey`, `sealContentAead`, `openContentAead`, `ContentKey`, `SealedContentAead` |
| 纪元 HPKE | `epochHpkeAad`, `sealEpochKeyHpke`, `openEpochKeyHpke`, `HpkePrimitiveError`, `EpochHpkeContext`, `SealedEpochHpke` |
| 记录 | `decodeRecord`, `hashRecordBytes`, `recordSigningBytes`, `joinRequestSigningBytes`, `possessionSigningBytes`, `DecodedRecord`, `RecordBody`, `Operation`, `JoinRequest`, `Role`, `DeviceKind`, `LedgerError`, `LedgerErrorCode` |
| 重放与视图 | `verifyLedger`, `verifyLedgerEffect`, `extendLedger`, `extendLedgerEffect`, `requireLedgerContinuation`, `hasVerifiedRecordHash`, `hasVerifiedCheckpoint`, `contentPermissions`, `epochHistoryPacket`, `epochPublicationRecord`, `LedgerView`, `LedgerCheckpoint`, `LedgerState`, `Member`, `Device`, `ContentPermissions`, `EpochHistoryPacket`, `HistoricalContentAuthor` |
| 保留状态 | `exportVerifiedState`, `restoreVerifiedState`, `RetainedLedgerState` |
| 记录签名 | `prepareLedgerRecord`, `signLedgerRecord`, `PreparedLedgerRecord` |
| 准入与创世 | `prepareJoinRequest`, `prepareDeviceAdmission`, `prepareLedgerCommand`, `signGenesisRecord`, `LedgerCommand` |
| 快照 | `verifyLedgerSnapshot`, `prepareLedgerSnapshot`, `signLedgerSnapshot`, `snapshotTrustFromView`, `authenticateLedgerSnapshotEvidence`, `encodeSignedSnapshot`, `snapshotSigningBytes`, `headAttestationSigningBytes`, `historicalContentIdentity`, `comparisonNote`, `compareNotes`, `confirmIndependentComparison`, `SnapshotTrust`, `VerifiedViewSnapshotTrust`, `SnapshotIdentityPin`, `SnapshotEvidence`, `SnapshotProposal`, `ComparisonNote`, `Comparison`, `IndependentConfirmation`, `HistoricalContentIdentity` |
| Feed 分页 | `prepareLedgerPage`, `prepareLedgerPageEffect`, `frameLedgerRecord`, `validLedgerOffset`, `LedgerFeedError`, `LedgerFeedState`, `LedgerReadPage` |
| 纪元密钥 | `commitEpochKey`, `sealHistoryPacket`, `openHistoryPacket`, `recoverLedgerHistory`, `EpochKeyError` |
| 信封 | `prepareEpochEnvelope`, `openEpochEnvelope`, `authenticateEpochEnvelope`, `authenticateEpochEnvelopeSignature`, `epochDeliveryId`, `EpochEnvelopeContext` |
| 暂存组 | `ownEpochStagedGroup`, `ownEpochStagedGroupKey`, `sameEpochStagedGroup`, `authenticateEpochStagedGroup`, `obsoleteEpochStagedGroup`, `getCommittedEpochStagingKey`, `EpochStagingError`, `EpochStagedGroup`, `EpochStagedGroupKey` |
| 报告 | `installationBody`, `installationSigningBytes`, `encodeInstallationReport`, `decodeInstallationReport`, `authenticateInstallationReport`, `checkInstallationContext`, `checkLocalPublication`, `envelopeRouting`, `mailboxDigest`, `slotId`, `MailboxSlot`, `InstallationSource`, `InstallationContext` |
| 恢复 | `generateRecoveryPackage`, `importRecoveryIdentity`, `parseRecoveryFile`, `wipeRecoveryPackage`, `verifiedPasskeyPrf`, `disposePrf`, `ownVaultCiphertext`, `vaultCiphertextDigest`, `sameVaultCiphertext`, `RecoveryVaultError`, `RecoveryIdentity`, `RecoveryPrivatePackage`, `VerifiedPasskeyPrf`, `VaultCiphertext` |

## `@lody/e2ee-core/host` — 后端合同

| 分组 | 导出 |
| --- | --- |
| 暂存线上合同 | `EpochStagedGroupDto`, `EpochStagedGroupKeyDto`, `EpochStagedEnvelopeDto`, `EpochStagingRequestProofDto`, `encodeEpochStagedGroup`, `decodeEpochStagedGroup`, `decodeEpochStagedGroupKey`, `epochStagingRequestSigningBytes` |
| 暂存规则 | `checkEpochStageRequest`, `ownEpochStagedGroup`, `ownEpochStagedGroupKey`, `sameEpochStagedGroup`, `obsoleteEpochStagedGroup`, `getCommittedEpochStagingKey`, `EpochStagingError`, `EpochStagedGroup`, `EpochStagedGroupKey` |
| 邮箱规则 | `envelopeRouting`, `authenticateEpochEnvelope`, `authenticateInstallationReport`, `checkLocalPublication`, `decodeInstallationReport`, `mailboxDigest`, `slotId`, `validSlot`, `MailboxSlot`, `InstallationContext` |
| 文档准入 | `admitDocument`, `admitStreamsUpdateBatch`, `admitStreamsUpdateBatchEffect`, `admitStreamsSnapshot`, `admitStreamsSnapshotEffect`, `authenticateStreamsSnapshotEffect`, `StreamsRecordBoundary`, `StreamsRecordBoundaryPort` |
| 端口类型 | `KeyMailbox`, `KeyMailboxStatus`, `EpochStagingStore` |
| 恢复 vault 线上合同 | `RecoveryVaultCiphertextDto`, `RecoveryVaultPutRequest`, `RecoveryVaultReadRequest`, `RecoveryVaultIndexReadRequest`, `RecoveryVaultIndexCasRequest`, `RecoveryVaultIndexCasReply`, `RecoveryVaultDeleteRequest`, `encodeRecoveryVaultCiphertext`, `decodeRecoveryVaultCiphertext`, `RecoveryVaultStore` |

## `@lody/e2ee-core/adapters/node-sqlite`

| 分组 | 导出 |
| --- | --- |
| 全部存储 | `sqliteLocalStores`, `SQLITE_STORE_FILES`, `SqliteFileOptions` |
| 单个存储 | `sqliteLedgerPinStore`, `sqliteLedgerFeedStore`, `sqliteInstalledKeyStore`, `sqliteReceiveJournal`, `sqliteRepairJournal`, `sqliteDistributionJournal`, `SqliteDistributionJournalOptions`, `sqliteDeliveryOutbox`, `sqliteEpochCandidateStore`, `sqliteSubmissionJournal` |
| 参考邮箱后端 | `makeSqliteKeyMailbox`, `referenceKeyMailbox`, `MailboxError`, `MailboxStatus`, `MailboxTarget` |
| 参考快照日志 | `makeSqliteSnapshotPublication`, `snapshotPublicationDigest`, `SnapshotPublicationError`, `SnapshotPublicationRow` |

## `@lody/e2ee-core/adapters/loro-streams`

`streamsLedgerLog`, `makeStreamsLedgerLog`, `StreamsLedgerLogOptions`,
`LedgerSubmissionStream`, `streamsLedgerFeedSource`, `makeLedgerStreamReader`,
`LedgerStreamReader`, `streamsDocumentBinding`, `StreamsDocumentBindingOptions`,
`makeStreamsUpdateBinding`.
