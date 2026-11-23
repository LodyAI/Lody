import { Context } from 'effect';
import type * as Bytes from '../internal/foundation/bytes';
import type { DeviceSigner } from '../internal/foundation/signing';

/**
 * The encrypted workspace (Org) a Layer stack serves.
 *
 * Every durable store and workflow is bound to exactly one Org genesis. Build one
 * Layer stack per workspace; the genesis must come from an independently trusted
 * source (an invitation pin, your own creation record), never from a server reply.
 *
 * @category Workspace
 */
export class WorkspaceScope extends Context.Service<
  WorkspaceScope,
  {
    /** Hash of the Org's signed genesis record; the root of all ledger authority. */
    readonly genesis: Bytes.GenesisHash;
  }
>()('@lody/e2ee-core/WorkspaceScope') {}

/**
 * The local device's key material, supplied by the platform.
 *
 * `signer` signs ledger records, envelopes, reports and content; its public key
 * is the device identity in the ledger. `encryptionKeyPair` is the X25519 pair
 * whose public half the ledger registers for this device; it opens epoch-key
 * envelopes. The platform owns both private keys: the library never generates,
 * exports or persists them, and an injected signer cannot grant authority (every
 * signature is re-verified against the expected public key).
 *
 * @category Workspace
 */
export class DeviceIdentity extends Context.Service<
  DeviceIdentity,
  {
    /** Borrowed signer and public identity; the platform retains the private key for the workspace Scope. */
    readonly signer: DeviceSigner;
    /** Borrowed X25519 keys registered for this device; retain them until all admitted native work settles. */
    readonly encryptionKeyPair: CryptoKeyPair;
  }
>()('@lody/e2ee-core/DeviceIdentity') {}
