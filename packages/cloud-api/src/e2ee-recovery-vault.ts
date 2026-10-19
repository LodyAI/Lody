/** Lody Cloud recovery-vault requests. The wire contract is defined by
 * `@lody/e2ee-core/host`; opaque encrypted recovery storage. Authentication gates
 * cloud access; it never decrypts, chooses ledger trust, or proves that a Recovery
 * device is active. */
export type {
  RecoveryVaultCiphertextDto,
  RecoveryVaultDeleteRequest,
  RecoveryVaultIndexCasReply,
  RecoveryVaultIndexCasRequest,
  RecoveryVaultIndexReadRequest,
  RecoveryVaultPutRequest,
  RecoveryVaultReadRequest,
} from '@lody/e2ee-core/host';
