/** Recovery-vault password wraps, shared by every host so each applies the same checks. */
import { Effect, Exit } from 'effect';
import { RecoveryVaults, type PasswordKdfParams, type RecoveryVault } from '@lody/e2ee-core';

/**
 * Set or rotate the vault's Argon2id password wrap, then prove the password reopens this
 * same vault. Returns the reopened session so the host can refresh its method summary.
 * Fails as `authentication` when the password opens another vault.
 */
export const setVaultPasswordVerified = (
  vault: RecoveryVault,
  input: { readonly password: string; readonly kdf?: PasswordKdfParams }
) =>
  Effect.gen(function* () {
    yield* vault.setPassword({
      password: input.password,
      ...(input.kdf ? { kdf: input.kdf } : {}),
    });
    const reopened = yield* (yield* RecoveryVaults).openWithPassword({
      vaultId: vault.vaultId,
      locator: vault.locator,
      password: input.password,
    });
    if (reopened.vaultId !== vault.vaultId) return yield* Effect.fail({ code: 'authentication' });
    return reopened;
  });

/**
 * Remove the vault's password wrap once a recovery file or passkey still unlocks it
 * (otherwise `conflict`). A removal that failed after its intent was journaled is
 * reported as `removed: false` with `pending: true`, never as a plain failure.
 */
export const removeVaultPasswordGuarded = (vault: RecoveryVault) =>
  Effect.gen(function* () {
    const hasFile = yield* vault.hasRecoveryFile();
    const passkeys = yield* vault.listPasskeys();
    if (!hasFile && passkeys.length === 0) return yield* Effect.fail({ code: 'conflict' });
    const removed = yield* Effect.exit(vault.removePassword());
    const pending = yield* vault.pendingPasswordRemovals();
    if (Exit.isFailure(removed) && pending.length === 0)
      return yield* Effect.failCause(removed.cause);
    return { removed: Exit.isSuccess(removed), pending: pending.length > 0 };
  });
