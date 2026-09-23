export const DEFAULT_AUTHENTICATED_SESSION_GRACE_MS = 2_000;
export const DEFAULT_SESSION_RESUME_REFETCH_THROTTLE_MS = 30_000;
export const DEFAULT_SESSION_KEEPALIVE_REFETCH_INTERVAL_MS = 5 * 60_000;

export type AuthSessionLike =
  | {
      user?: unknown;
    }
  | null
  | undefined;

type SessionGraceStartOptions = {
  hasLocalToken: boolean;
  hasRawUser: boolean;
  hasLastAuthenticatedUser: boolean;
  previousHadRawUser: boolean;
  hasBootstrapSnapshot: boolean;
  hasConsumedInitialBootstrapGrace: boolean;
  isPending: boolean;
  shouldRetry: boolean;
  hasFinalError: boolean;
  preserveUntilMs: number | null;
};

type PreserveSessionOptions = {
  hasLocalToken: boolean;
  hasRawUser: boolean;
  hasLastAuthenticatedUser: boolean;
  preserveUntilMs: number | null;
  now: number;
};

type ConfirmUnauthenticatedOptions = {
  hasLocalToken: boolean;
  hasRawUser: boolean;
  isPending: boolean;
  shouldRetry: boolean;
  hasFinalError: boolean;
  isSessionUnauthorized: boolean;
  preserveUntilMs: number | null;
  now: number;
};

type SessionErrorRetryOptions = {
  hasError: boolean;
  isPending: boolean;
  isSessionUnauthorized: boolean;
  retryCount: number;
  maxRetries: number;
};

type UsableSessionUserOptions = {
  hasRawUser: boolean;
  isRetrying: boolean;
  hasError: boolean;
  confirmedUnauthenticated: boolean;
};

type BrowserResumeRefetchOptions = {
  now: number;
  lastRefetchAtMs: number | null;
  throttleMs: number;
  isDocumentVisible: boolean;
  isBrowserOnline: boolean;
  isPending: boolean;
};

type MissingAuthenticatedSessionRetryOptions = {
  hasLocalToken: boolean;
  hasRawUser: boolean;
  isPending: boolean;
  hasError: boolean;
  retryCount: number;
  maxRetries: number;
};

export function hasAuthenticatedUser(data: AuthSessionLike): boolean {
  return Boolean(data?.user);
}

export function hasUsableSessionUser(options: UsableSessionUserOptions): boolean {
  return (
    options.hasRawUser &&
    !options.isRetrying &&
    !options.hasError &&
    !options.confirmedUnauthenticated
  );
}

function readHttpStatus(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;

  const record = value as Record<string, unknown>;
  if (typeof record.status === 'number') return record.status;
  if (typeof record.statusCode === 'number') return record.statusCode;
  return null;
}

export function isUnauthorizedSessionError(error: unknown): boolean {
  const directStatus = readHttpStatus(error);
  if (directStatus !== null) return directStatus === 401;

  if (typeof error !== 'object' || error === null) return false;
  const record = error as Record<string, unknown>;
  const responseStatus = readHttpStatus(record.response);
  if (responseStatus !== null) return responseStatus === 401;

  return readHttpStatus(record.error) === 401;
}

export function shouldRetrySessionError(options: SessionErrorRetryOptions): boolean {
  return (
    options.hasError &&
    !options.isPending &&
    !options.isSessionUnauthorized &&
    options.retryCount < options.maxRetries
  );
}

export function shouldRetryMissingAuthenticatedSession(
  options: MissingAuthenticatedSessionRetryOptions
): boolean {
  return (
    options.hasLocalToken &&
    !options.hasRawUser &&
    !options.isPending &&
    !options.hasError &&
    options.retryCount < options.maxRetries
  );
}

export function shouldStartAuthenticatedSessionGrace(options: SessionGraceStartOptions): boolean {
  if (
    !options.hasLocalToken ||
    options.hasRawUser ||
    options.isPending ||
    options.shouldRetry ||
    options.hasFinalError ||
    options.preserveUntilMs !== null
  ) {
    return false;
  }

  if (options.previousHadRawUser && options.hasLastAuthenticatedUser) {
    return true;
  }

  if (!options.hasConsumedInitialBootstrapGrace && options.hasBootstrapSnapshot) {
    return true;
  }

  return false;
}

export function shouldUsePreservedAuthenticatedSession(options: PreserveSessionOptions): boolean {
  return (
    options.hasLocalToken &&
    !options.hasRawUser &&
    options.hasLastAuthenticatedUser &&
    options.preserveUntilMs !== null &&
    options.now < options.preserveUntilMs
  );
}

export function shouldConfirmUnauthenticated(options: ConfirmUnauthenticatedOptions): boolean {
  // A 401 from useSession() means the session endpoint rejected the credential.
  // Cached user/bootstrap data must not keep that terminal state authenticated.
  if (options.isSessionUnauthorized) {
    return !options.isPending;
  }

  return (
    options.hasLocalToken &&
    !options.hasRawUser &&
    !options.isPending &&
    !options.shouldRetry &&
    !options.hasFinalError &&
    (options.preserveUntilMs === null || options.now >= options.preserveUntilMs)
  );
}

export function shouldRefetchSessionOnBrowserResume(options: BrowserResumeRefetchOptions): boolean {
  if (!options.isDocumentVisible || !options.isBrowserOnline || options.isPending) {
    return false;
  }

  if (
    options.lastRefetchAtMs !== null &&
    options.now - options.lastRefetchAtMs < options.throttleMs
  ) {
    return false;
  }

  return true;
}
