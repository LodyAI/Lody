import type { WorkspaceAdmissionDescriptor } from '@lody/cloud-api';
import type {
  E2eeWorkspaceRuntime,
  PlatformE2eeWorkspaces,
  PlatformIdentity,
} from '@lody/platform';
import { isConvexUnauthenticatedError } from '@lody/shared';
import {
  getConvexAuthRecoveryDelayMs,
  isTransientConvexQueryError,
} from '@/lib/authed-convex-query';
import { personalHostFailureCode } from '@/lib/e2ee-control-failure';
import {
  E2eeLocalEvidenceConflictError,
  E2eeLocalEvidenceCorruptError,
  retainHostEncryptedEvidence,
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
  constructor(options?: ErrorOptions) {
    super('Workspace mode verification needs a live authenticated connection', options);
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

/** One host identity read may take this long before it counts as unanswered. */
export const HOST_IDENTITY_READ_TIMEOUT_MS = 5_000;

/** The host has no identity record at all for this account and workspace. */
function isMissingHostIdentity(error: unknown): boolean {
  if (personalHostFailureCode(error) === 'approval-required') return true;
  return error instanceof Error && /\be2ee_missing-binding\b/.test(error.message);
}

class HostIdentityReadTimeoutError extends Error {
  constructor() {
    super('Device host did not answer the workspace identity read');
    this.name = 'HostIdentityReadTimeoutError';
  }
}

/** Host states that say nothing about this workspace's identity and can clear on
 * their own: account routing not ready, a closed or busy owner, an unanswered
 * read, or portable pin storage that could not open. Other failures (permissions,
 * corruption, removal) are kept as they are: unclassified, retried only by a later
 * send, online event or Retry. */
function isTransientHostIdentityError(error: unknown): boolean {
  if (error instanceof HostIdentityReadTimeoutError) return true;
  const portable = personalHostFailureCode(error);
  if (portable)
    return portable === 'closed' || portable === 'scope-mismatch' || portable === 'storage';
  return (
    error instanceof Error &&
    /\be2ee_(account_unavailable|account_mismatch|closed|identity-busy|cleanup_failed)\b/.test(
      error.message
    )
  );
}

/** A single read bounded by its own timeout and the owner's signal. A late
 * answer after timeout or abort is ignored. */
async function readHostIdentityOnce(
  readIdentity: NonNullable<E2eeWorkspaceRuntime['readIdentity']>,
  input: { accountId: string; workspaceId: string },
  signal: AbortSignal,
  timeoutMs: number
): Promise<{ workspaceId: string; genesisHash: string }> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      readIdentity(input),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HostIdentityReadTimeoutError()), timeoutMs);
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * A server answer other than encrypted is accepted only when this device's host
 * holds no encrypted identity for the workspace. Renderer storage can be cleared
 * while native or IndexedDB custody survives; the host's verified identity then
 * outranks the server, and its genesis is retained as the sticky marker.
 * Missing identity is the only answer that permits plaintext. Transient host
 * states are asked again with backoff while the workspace stays unclassified;
 * `deadlineMs` bounds that wait (null: until `signal` aborts) and its timeout
 * keeps the last host error as its cause. Other host failures are rethrown.
 */
export async function assertNoRetainedEncryptedIdentity(input: {
  runtime: Pick<E2eeWorkspaceRuntime, 'readIdentity'> | undefined;
  storage: Storage;
  accountId: string;
  workspaceId: string;
  descriptor: WorkspaceAdmissionDescriptor;
  signal: AbortSignal;
  deadlineMs: number | null;
}): Promise<void> {
  const { runtime, descriptor, signal } = input;
  if ('contentMode' in descriptor && descriptor.contentMode === 'e2ee') return;
  // Without a device host this platform cannot retain an encrypted identity.
  if (!runtime) return;
  if (!runtime.readIdentity) throw new Error('e2ee_identity_check_unavailable');
  const readIdentity = runtime.readIdentity.bind(runtime);
  const deadline = input.deadlineMs === null ? null : Date.now() + input.deadlineMs;
  let identity: { workspaceId: string; genesisHash: string } | undefined;
  for (let failures = 0; !identity; failures += 1) {
    const remaining = deadline === null ? HOST_IDENTITY_READ_TIMEOUT_MS : deadline - Date.now();
    try {
      identity = await readHostIdentityOnce(
        readIdentity,
        { accountId: input.accountId, workspaceId: input.workspaceId },
        signal,
        Math.max(0, Math.min(HOST_IDENTITY_READ_TIMEOUT_MS, remaining))
      );
    } catch (error) {
      signal.throwIfAborted();
      if (isMissingHostIdentity(error)) return;
      if (!isTransientHostIdentityError(error)) throw error;
      const wait = getConvexAuthRecoveryDelayMs(failures);
      if (deadline !== null && Date.now() + wait >= deadline)
        throw new WorkspaceModeAdmissionTimeoutError({ cause: error });
      await delay(wait, signal);
    }
  }
  if (identity.workspaceId !== input.workspaceId) throw new WorkspaceModeMismatchError();
  try {
    retainHostEncryptedEvidence(
      input.storage,
      input.accountId,
      input.workspaceId,
      identity.genesisHash
    );
  } catch (error) {
    if (
      error instanceof E2eeLocalEvidenceConflictError ||
      error instanceof E2eeLocalEvidenceCorruptError
    )
      throw error;
    // A full storage quota loses only the marker; this answer is still refused.
  }
  throw new E2eeLocalEvidenceConflictError('Workspace mode conflicts with encrypted evidence');
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
