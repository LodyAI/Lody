/**
 * Platform passkey ceremonies for the recovery vault. Desktop and mobile implement this
 * one port natively; the Spec's ceremony contract lives in `@lody/e2ee-client`, which
 * decides what a result proves. A host without a passkey path leaves it undefined.
 */

/** The recovery relying party. Pre-production uses only this current RP; login must use a different RP. */
export const E2EE_PASSKEY_RP_ID = 'lody.ai';

export interface E2eePasskeyRegistrationRequest {
  readonly rpId: string;
  /** `user.id`: the 32-byte vault ID, so a device without the file can learn the vault. */
  readonly userHandle: Uint8Array;
  /** Shown by the system. Says this credential unlocks the recovery vault. */
  readonly userName: string;
  readonly prfInput: Uint8Array;
  /** Same-RP, same-`user.id` registration would otherwise overwrite these. */
  readonly excludeCredentialIds: readonly string[];
}

export interface E2eePasskeyRegistration {
  /** Unpadded base64url on every platform. */
  readonly credentialId: string;
  /** Exactly what the authenticator reported. A result here is ignored by design. */
  readonly prfEnabled: boolean;
}

export interface E2eePasskeyAssertionRequest {
  readonly rpId: string;
  readonly prfInput: Uint8Array;
  /** Empty means discoverable: a new device does not know its vault yet. */
  readonly allowCredentialIds: readonly string[];
}

export interface E2eePasskeyAssertion {
  readonly credentialId: string;
  /** Unauthenticated hint. Only decryption proves the vault. */
  readonly userHandle: Uint8Array | null;
  readonly userVerified: boolean;
  /** `results.first`, or null when the authenticator returned none. */
  readonly prfFirst: Uint8Array | null;
}

/** Hosts reject with this when the user dismisses the system prompt. */
export class E2eePasskeyCancelled extends Error {
  readonly code = 'e2ee_passkey_cancelled';
}

export interface E2eePasskeyPort {
  /** Whether this device can attempt a PRF ceremony. Only a real ceremony proves PRF. */
  available(): Promise<boolean>;
  register(request: E2eePasskeyRegistrationRequest): Promise<E2eePasskeyRegistration>;
  authenticate(request: E2eePasskeyAssertionRequest): Promise<E2eePasskeyAssertion>;
}
