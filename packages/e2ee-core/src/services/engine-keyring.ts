import { Context, Effect } from 'effect';
import type { EngineKeyringSinkError } from './errors';

/**
 * The local native loro-repo-rs engine connection that seals and opens this
 * workspace's content with an engine-resident keyring (the approved
 * `installIntoEngineKeyring` exception, specs/native-engine-cloud-e2ee.md).
 *
 * The adapter binds every call to one engine namespace and to this process's own
 * writer, sends key bytes only in the engine's binary secret frames, and never
 * keeps, logs or returns them. The engine exposes content sealing and opening
 * only: it never signs ledger or governance records, never returns key material
 * and never becomes ledger authority.
 *
 * `installEpoch` borrows `key`; the workflow wipes it once the call settles.
 * `installSigner` copies the platform's own device seed for this writer: the
 * library never sees or exports that private key.
 *
 * @category Platform ports
 */
export class EngineKeyringSink extends Context.Service<
  EngineKeyringSink,
  {
    /** Set the namespace's immutable workspace genesis. */
    configure(genesis: Uint8Array): Effect.Effect<void, EngineKeyringSinkError>;
    /** Admit verified, historically admitted device signing public keys (idempotent). */
    admit(publicKeys: readonly Uint8Array[]): Effect.Effect<void, EngineKeyringSinkError>;
    /** Install one verified epoch key; identical reinstalls succeed. */
    installEpoch(epoch: number, key: Uint8Array): Effect.Effect<void, EngineKeyringSinkError>;
    /** Seal new content at this installed epoch. */
    setSealEpoch(epoch: number): Effect.Effect<void, EngineKeyringSinkError>;
    /** Install this process's own writer seed from platform custody. */
    installSigner(): Effect.Effect<void, EngineKeyringSinkError>;
    /** Refuse this writer's seals (rows stay unsent) without removing admission. */
    holdSealing(): Effect.Effect<void, EngineKeyringSinkError>;
    /** End {@link holdSealing}. */
    releaseSealing(): Effect.Effect<void, EngineKeyringSinkError>;
  }
>()('@lody/e2ee-core/EngineKeyringSink') {}
