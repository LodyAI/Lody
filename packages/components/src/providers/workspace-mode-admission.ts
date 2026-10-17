import type { PlatformE2eeWorkspaces, PlatformIdentity } from '@lody/platform';
import { E2eeAccountUnavailableError } from './cloud-e2ee-workspaces';

function waitForAccount(
  session: PlatformIdentity['session'],
  accountId: string,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      unsubscribe();
      signal.removeEventListener('abort', check);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (signal.aborted) {
        finish(signal.reason ?? new Error('Runtime disposed'));
        return;
      }
      const current = session.get();
      if (current.status !== 'authenticated') return;
      finish(current.user.id === accountId ? undefined : new Error('e2ee_account_changed'));
    };
    const unsubscribe = session.subscribe(check);
    signal.addEventListener('abort', check, { once: true });
    check();
  });
}

/** Wait for live authentication only when no retained admission exists.
 * The initialization owns this wait; replacing its target cancels the subscription.
 * A later auth refresh never owns or tears down an already admitted runtime.
 */
export async function describeAuthenticatedWorkspace(input: {
  session: PlatformIdentity['session'];
  workspaces: PlatformE2eeWorkspaces;
  accountId: string;
  workspaceId: string;
  signal: AbortSignal;
}) {
  const assertCurrentAccount = () => {
    input.signal.throwIfAborted();
    const current = input.session.get();
    if (current.status !== 'authenticated') throw new E2eeAccountUnavailableError();
    if (current.user.id !== input.accountId) throw new Error('e2ee_account_changed');
  };
  for (;;) {
    await waitForAccount(input.session, input.accountId, input.signal);
    try {
      // Readiness can change between resolving the wait and this continuation.
      assertCurrentAccount();
      const descriptor = await input.workspaces.describe({ workspaceId: input.workspaceId });
      assertCurrentAccount();
      return descriptor;
    } catch (error) {
      // Authentication can return to loading while the read is in flight. Wait
      // for the same account again; an ordinary server/validation error remains
      // visible, and a different account must never inherit this request.
      if (input.signal.aborted) throw error;
      if (
        !(error instanceof E2eeAccountUnavailableError) &&
        input.session.get().status === 'authenticated'
      )
        throw error;
    }
  }
}
