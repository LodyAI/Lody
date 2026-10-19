import { Context, type Effect } from 'effect';
import type { VaultCiphertext } from '../internal/recovery/crypto';

/**
 * Backend storage of encrypted recovery vaults (the "vault-v1" scheme of the
 * whitepaper's backup and recovery section).
 *
 * The backend only stores ciphertext: login controls who may *retrieve* a
 * vault, but this port never receives the unlock secret, the vault master key
 * or a private recovery key. Entries are immutable; the index is replaced by
 * compare-and-swap and names every entry it references.
 *
 * Contract for implementers:
 * - `putImmutable` stores an entry once; a retry must carry identical bytes.
 * - `compareAndSwapIndex` replaces the index only if it still has `expected`
 *   revision and digest (or none), returning `Conflict` otherwise.
 * - `deleteUnreferenced` deletes an entry only if the current index still equals
 *   `expectedIndex` and does not reference it.
 *
 * @category Backend ports
 */
export class RecoveryVaultStore extends Context.Service<
  RecoveryVaultStore,
  {
    /** Store exact encrypted entry bytes once; identical retries succeed and different bytes at the same id fail. */
    putImmutable(vaultId: string, entry: VaultCiphertext): Effect.Effect<void, unknown>;
    /** Read an owned encrypted entry or null; retrieval permission is not proof of its authenticity. */
    readEntry(vaultId: string, entryId: string): Effect.Effect<VaultCiphertext | null, unknown>;
    /** Read the encrypted current index or null; the client authenticates it and checks its durable pin. */
    readIndex(vaultId: string): Effect.Effect<VaultCiphertext | null, unknown>;
    /** Atomically compare index identity and replace it with next; Conflict keeps the stored index, while an error may have an uncertain outcome. */
    compareAndSwapIndex(
      vaultId: string,
      expected: { readonly revision: number; readonly digest: string } | null,
      next: VaultCiphertext,
      referencedEntryIds: readonly string[]
    ): Effect.Effect<'Committed' | 'Conflict', unknown>;
    /** Only after the caller reconciled every pending local intent and the current index. */
    deleteUnreferenced(
      vaultId: string,
      entryId: string,
      expectedIndex: { readonly revision: number; readonly digest: string }
    ): Effect.Effect<void, unknown>;
  }
>()('@lody/e2ee-core/RecoveryVaultStore') {}

/**
 * Durable local journal of a device's recovery-vault work (pending index
 * intents and pins), keyed by string. Holds no secret plaintext.
 *
 * `compareAndSwap` must atomically compare the stored bytes with `expected`,
 * store `next` and read it back before reporting `Committed`.
 *
 * @category Local storage ports
 */
export class RecoveryVaultLocalStore extends Context.Service<
  RecoveryVaultLocalStore,
  {
    /** Read an owned copy or null; a storage failure must not be treated as absence. */
    read(key: string): Effect.Effect<Uint8Array | null, unknown>;
    /** Atomically match expected bytes (null means absent), persist next and verify readback before returning Committed. */
    compareAndSwap(
      key: string,
      expected: Uint8Array | null,
      next: Uint8Array
    ): Effect.Effect<'Committed' | 'Conflict', unknown>;
    /** Return owned copies of entries with the prefix, preserving every pending intent for reconciliation after restart. */
    list(
      prefix: string
    ): Effect.Effect<readonly { readonly key: string; readonly value: Uint8Array }[], unknown>;
  }
>()('@lody/e2ee-core/RecoveryVaultLocalStore') {}
