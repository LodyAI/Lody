import { Context, Effect, Layer } from 'effect';
import { own } from '../lifecycle';
import { RecoveryVaultLocalStore, RecoveryVaultStore } from '../../services/recovery';
import { createRecoveryVault, openRecoveryVault, openRecoveryVaultWithPasskey } from './vault';

type WithoutStores<F extends (input: never) => unknown> = Omit<Parameters<F>[0], 'store' | 'local'>;

/**
 * Create and open encrypted recovery vaults (vault-v1) on the
 * {@link RecoveryVaultStore} backend, with progress journaled in
 * {@link RecoveryVaultLocalStore}.
 *
 * `create` generates a new vault and returns its session together with the
 * recovery file the user keeps offline; `open` unlocks one from that file;
 * `openWithPasskey` unlocks one with a verified passkey PRF. A session's
 * operations are described in the whitepaper's backup and recovery section.
 *
 * @category Workflows
 */
export class RecoveryVaults extends Context.Service<
  RecoveryVaults,
  {
    /** A new vault session (owned by the caller's Scope) and its offline recovery file. */
    create(
      input: WithoutStores<typeof createRecoveryVault>
    ): ReturnType<typeof createRecoveryVault>;
    /** Unlock a vault from its recovery file; the session lives in the caller's Scope. */
    open(input: WithoutStores<typeof openRecoveryVault>): ReturnType<typeof openRecoveryVault>;
    /** Unlock a vault with a verified passkey PRF; the session lives in the caller's Scope. */
    openWithPasskey(
      input: WithoutStores<typeof openRecoveryVaultWithPasskey>
    ): ReturnType<typeof openRecoveryVaultWithPasskey>;
  }
>()('@lody/e2ee-core/RecoveryVaults') {
  /** Requires {@link RecoveryVaultStore} and {@link RecoveryVaultLocalStore}. */
  static readonly layer = Layer.effect(
    RecoveryVaults,
    Effect.gen(function* () {
      const store = own(yield* RecoveryVaultStore);
      const local = own(yield* RecoveryVaultLocalStore);
      return RecoveryVaults.of({
        create: (input) =>
          createRecoveryVault({ ...input, store, local }).pipe(
            Effect.withSpan('@lody/e2ee-core/RecoveryVaults.create')
          ),
        open: (input) =>
          openRecoveryVault({ ...input, store, local }).pipe(
            Effect.withSpan('@lody/e2ee-core/RecoveryVaults.open')
          ),
        openWithPasskey: (input) =>
          openRecoveryVaultWithPasskey({ ...input, store, local }).pipe(
            Effect.withSpan('@lody/e2ee-core/RecoveryVaults.openWithPasskey')
          ),
      });
    })
  );
}
