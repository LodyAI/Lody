import { Cause, Effect, Exit, Scope } from 'effect';
import {
  GitCredentialBroker,
  type GitCredentialBrokerSessionContext,
  type GitCredentialLease,
} from '@/lib/git-credential-broker';

/** Runtime capability, deliberately excluded from serializable/mutable SessionConfig. */
export type SessionCredentials =
  | { readonly mode: 'native'; release(): Promise<void> }
  | { readonly mode: 'managed'; readonly lease: GitCredentialLease; release(): Promise<void> };

export const nativeSessionCredentials: SessionCredentials = {
  mode: 'native',
  release: async () => {},
};

/**
 * Temporary Promise boundary for Session/SessionManager. The broker acquisition
 * is Effect-native; the same scope follows preparation into the adopted Session.
 * No scope or authority is copied through launch-config merges.
 * @deprecated Effect owners should acquire broker.acquireContext in their scope.
 */
export function acquireSessionCredentialsLegacy(
  broker: GitCredentialBroker,
  context: GitCredentialBrokerSessionContext
): SessionCredentials {
  const scope = Scope.makeUnsafe();
  const acquired = Effect.runSyncExit(Scope.provide(broker.acquireContext(context), scope));
  if (Exit.isFailure(acquired)) {
    Effect.runSync(Scope.close(scope, acquired));
    throw Cause.squash(acquired.cause);
  }
  let closing: Promise<void> | undefined;
  return {
    mode: 'managed',
    lease: acquired.value,
    release: () =>
      (closing ??= Effect.runPromiseExit(Scope.close(scope, Exit.void)).then((exit) => {
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
      })),
  };
}
