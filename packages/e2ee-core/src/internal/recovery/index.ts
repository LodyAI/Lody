export {
  RecoveryVaultError,
  verifiedPasskeyPrf,
  disposePrf,
  type VerifiedPasskeyPrf,
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
} from './vault';
export { deriveRecoveryAccessCredential, type RecoveryAccessCredential } from './credential';
export { generateRecoveryPackage, importRecoveryIdentity, type RecoveryIdentity } from './identity';
export {
  makeWorkspaceRecovery,
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
