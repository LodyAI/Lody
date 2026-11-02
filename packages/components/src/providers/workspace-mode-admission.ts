import type { PlatformE2eeWorkspaces, PlatformIdentity } from '@lody/platform';
import { isConvexUnauthenticatedError } from '@lody/shared';
import {
  getConvexAuthRecoveryDelayMs,
  isTransientConvexQueryError,
} from '@/lib/authed-convex-query';
import {
  E2eeLocalEvidenceConflictError,
  E2eeLocalEvidenceCorruptError,
} from '@/lib/e2ee-workspace-storage';
import {
  E2eeAccountUnavailableError,
  E2eeClientUpgradeRequiredError,
} from './cloud-e2ee-workspaces';

export const WORKSPACE_MODE_ADMISSION_TIMEOUT_MS = 15_000;

/** Cancelling an outbound operation releases only its waiter. The provider
 * retains ownership of the read that classifies this workspace. */
export async function waitForWorkspaceContentAdmission(
  admission: Promise<void>,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    await Promise.race([admission, interrupted]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export class WorkspaceModeAdmissionTimeoutError extends Error {
  constructor() {
    super('Workspace mode verification needs a live authenticated connection');
    this.name = 'WorkspaceModeAdmissionTimeoutError';
  }
}

/** The server answered for a different workspace than the one being opened. */
export class WorkspaceModeMismatchError extends Error {
  constructor() {
    super('Unsupported workspace content mode');
    this.name = 'WorkspaceModeMismatchError';
  }
}

/** Failures that say nothing about the workspace's mode: authentication that has
 * not reached the backend yet (the app's Convex auth-mismatch recovery case), an
 * opaque query server failure, or a failed network request. Retry them. */
export function isRetryableWorkspaceModeError(error: unknown): boolean {
  if (error instanceof E2eeAccountUnavailableError || isConvexUnauthenticatedError(error))
    return true;
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'TypeError' ||
    error.name === 'NetworkError' ||
    isTransientConvexQueryError(error)
  );
}

/** Answers that may describe an encrypted or newer mode, or contradict local
 * encrypted evidence. A provisionally opened ordinary runtime must close on these. */
export function isWorkspaceModeRejection(error: unknown): boolean {
  return (
    error instanceof E2eeClientUpgradeRequiredError ||
    error instanceof E2eeLocalEvidenceConflictError ||
    error instanceof E2eeLocalEvidenceCorruptError ||
    error instanceof WorkspaceModeMismatchError ||
    (error instanceof Error && error.message === 'e2ee_workspace_mode_unavailable')
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

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
async function describeWhileAuthenticated(input: {
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
  let failures = 0;
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
      // for the same account again; a different account must never inherit
      // this request.
      if (input.signal.aborted) throw error;
      if (
        error instanceof E2eeAccountUnavailableError ||
        input.session.get().status !== 'authenticated'
      )
        continue;
      // Backend authentication lagging the session, or a transient server or
      // network failure, retries with the auth-recovery backoff. Validation and
      // application errors remain visible.
      if (!isRetryableWorkspaceModeError(error)) throw error;
      await delay(getConvexAuthRecoveryDelayMs(failures++), input.signal);
    }
  }
}

/** Bound first admission without treating a missing mode proof as plaintext.
 * A timed-out read may still complete, so its result is never used to open a runtime.
 * `timeoutMs: null` is background verification: it waits for authentication and
 * retries transient failures until the owner cancels it.
 */
export async function describeAuthenticatedWorkspace(
  input: {
    session: PlatformIdentity['session'];
    workspaces: PlatformE2eeWorkspaces;
    accountId: string;
    workspaceId: string;
    signal: AbortSignal;
  },
  timeoutMs: number | null = WORKSPACE_MODE_ADMISSION_TIMEOUT_MS
) {
  input.signal.throwIfAborted();
  const attempt = new AbortController();
  const forwardAbort = () => attempt.abort(input.signal.reason);
  input.signal.addEventListener('abort', forwardAbort, { once: true });
  let rejectInterrupted!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterrupted = reject;
  });
  const onAbort = () => rejectInterrupted(attempt.signal.reason);
  attempt.signal.addEventListener('abort', onAbort, { once: true });
  const timeout =
    timeoutMs === null
      ? undefined
      : setTimeout(() => attempt.abort(new WorkspaceModeAdmissionTimeoutError()), timeoutMs);
  try {
    return await Promise.race([
      describeWhileAuthenticated({ ...input, signal: attempt.signal }),
      interrupted,
    ]);
  } finally {
    clearTimeout(timeout);
    input.signal.removeEventListener('abort', forwardAbort);
    attempt.signal.removeEventListener('abort', onAbort);
    attempt.abort(new Error('Runtime disposed'));
  }
}
