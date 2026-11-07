export {
  RecoveryVaultError,
  verifiedPasskeyPrf,
  verifiedPasskeyRegistration,
  vaultPrfInput,
  passkeyUserHandle,
  vaultIdFromPasskeyUserHandle,
  disposePrf,
  type VerifiedPasskeyPrf,
  type VerifiedPasskeyRegistration,
  type VaultCiphertext,
} from './crypto';
export {
  createRecoveryVault,
  openRecoveryVault,
  openRecoveryVaultWithPasskey,
  parseRecoveryFile,
  wipeRecoveryPackage,
  type RecoveryVault,
  type RecoveryVaultStore,
  type RecoveryVaultLocalStore,
  type RecoveryPrivatePackage,
  type RecoveryEntryReference,
  type RecoveryPasskeyReference,
} from './vault';
export { deriveRecoveryAccessCredential, type RecoveryAccessCredential } from './credential';
export { generateRecoveryPackage, importRecoveryIdentity, type RecoveryIdentity } from './identity';
export {
  makeWorkspaceRecovery,
  abandonWorkspaceRecovery,
  memoryRecoveryEpochKeys,
  readWorkspaceRecoveryProgress,
  type WorkspaceRecoveryInput,
  type RecoveryCredentialRegistration,
  type RecoverySubmitResult,
  type RecoveryEnvelope,
} from './workspace';
export {
  ownCiphertext as ownVaultCiphertext,
  ciphertextDigest as vaultCiphertextDigest,
  sameCiphertext as sameVaultCiphertext,
} from './crypto';
