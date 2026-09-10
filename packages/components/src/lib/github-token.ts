/**
 * Client-side GitHub token manager.
 *
 * Tokens are obtained from the backend and cached locally. The client then uses
 * these tokens to call the GitHub API directly, without routing through our
 * backend.
 */

import { GitHubAuthError, GitHubMergeError, GitHubPermissionError } from '@lody/shared';
import { requireGitHubTokenPort } from './github-token-port';

type GitHubOperation = 'read' | 'write';
type GitHubTokenSource = 'personal' | 'app';

type TokenEntry = {
  token: string;
  expiresAt: number; // epoch ms
  tokenSource: GitHubTokenSource;
};

const SAFETY_WINDOW_MS = 10 * 60 * 1000; // refresh 10 min before expiry
const DEFAULT_PERSONAL_TOKEN_CACHE_MS = 45 * 60 * 1000;
const DEFAULT_APP_TOKEN_CACHE_MS = 15 * 60 * 1000;

const tokenCache = new Map<string, TokenEntry>();
const inFlightRequests = new Map<string, Promise<TokenEntry>>();
let tokenCacheGeneration = 0;

const GITHUB_TOKEN_INVALIDATION_CHANNEL = 'lody:github-token-invalidation';
const githubTokenInvalidationChannel =
  typeof window !== 'undefined' && 'BroadcastChannel' in window
    ? new BroadcastChannel(GITHUB_TOKEN_INVALIDATION_CHANNEL)
    : null;

githubTokenInvalidationChannel?.addEventListener('message', (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (
    data &&
    typeof data === 'object' &&
    'type' in data &&
    data.type === 'invalidate-workspace' &&
    'workspaceId' in data &&
    typeof data.workspaceId === 'string'
  ) {
    clearGitHubTokensForWorkspace(data.workspaceId);
  }
});

function cacheKey(workspaceId: string, repoFullName: string) {
  return `${workspaceId}:${repoFullName.toLowerCase()}`;
}

function operationCacheKey(workspaceId: string, repoFullName: string, operation: GitHubOperation) {
  return `${cacheKey(workspaceId, repoFullName)}:${operation}`;
}

/**
 * Error thrown when the backend token action returns a structured failure
 * (`{ success: false, errorCode, errorMessage }`). Carries `code` so callers
 * can distinguish a transient `unauthorized` (Convex session re-establishing
 * after idle — retryable) from terminal config errors like `repo_not_linked`.
 */
export class GitHubClientTokenError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'GitHubClientTokenError';
  }
}

/**
 * True when a token fetch failed because the Convex session wasn't
 * authenticated (expired JWT, or mid-reconnect right after a long idle).
 * Callers treat this as transient and retry, rather than surfacing it as a
 * hard "Failed to load" error.
 */
export function isGitHubUnauthorizedTokenError(error: unknown): boolean {
  return error instanceof GitHubClientTokenError && error.code === 'unauthorized';
}

/**
 * A Convex action was sent but its result was lost during a reconnect. This is
 * safe to retry for token minting because no GitHub operation has started yet.
 */
export function isGitHubOperationTokenConnectionLostError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Connection lost while action was in flight';
}

function normalizeExpiresAt(expiresAt: string | undefined, tokenSource: GitHubTokenSource) {
  if (expiresAt) {
    const parsed = Date.parse(expiresAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (tokenSource === 'personal') {
    return Date.now() + DEFAULT_PERSONAL_TOKEN_CACHE_MS;
  }
  return Date.now() + DEFAULT_APP_TOKEN_CACHE_MS;
}

function clearGitHubTokensForWorkspace(workspaceId: string) {
  tokenCacheGeneration++;
  const prefix = `${workspaceId}:`;
  for (const key of tokenCache.keys()) {
    if (key.startsWith(prefix)) {
      tokenCache.delete(key);
    }
  }
  for (const key of inFlightRequests.keys()) {
    if (key.startsWith(prefix)) {
      inFlightRequests.delete(key);
    }
  }
}

function isGitHubPermissionFailure(error: unknown): boolean {
  if (error instanceof GitHubPermissionError && error.status === 403) return true;
  if (error instanceof GitHubMergeError && error.status === 403) return true;
  return error instanceof Error && /\b403\b/.test(error.message);
}

export class GitHubPersonalIdentityPermissionError extends Error {
  constructor(repoFullName: string) {
    super(
      `Your personal GitHub identity cannot write to ${repoFullName}. Re-authorize GitHub in Settings -> Integrations -> GitHub, make sure your GitHub account has repository write access and any required SSO authorization, or turn off personal identity for this workspace.`
    );
    this.name = 'GitHubPersonalIdentityPermissionError';
  }
}

/**
 * Get a repo-scoped GitHub token.
 *
 * Returns a cached token when possible; otherwise fetches a fresh one from
 * the backend and caches it.  Concurrent requests for the same repo are
 * deduplicated.
 */
export async function getGitHubRepoToken(
  workspaceId: string,
  repoFullName: string
): Promise<string> {
  const key = cacheKey(workspaceId, repoFullName);

  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - Date.now() > SAFETY_WINDOW_MS) {
    return cached.token;
  }

  const existing = inFlightRequests.get(key);
  if (existing) {
    const entry = await existing;
    return entry.token;
  }

  const requestGeneration = tokenCacheGeneration;
  const request = (async (): Promise<TokenEntry> => {
    const result = await requireGitHubTokenPort().getRepoToken({ workspaceId, repoFullName });

    if (!result.success) {
      throw new GitHubClientTokenError(result.errorCode, result.errorMessage);
    }

    const entry: TokenEntry = {
      token: result.token,
      expiresAt: normalizeExpiresAt(result.expiresAt, 'app'),
      tokenSource: 'app',
    };
    if (requestGeneration === tokenCacheGeneration) {
      tokenCache.set(key, entry);
    }
    return entry;
  })();

  inFlightRequests.set(key, request);

  try {
    const entry = await request;
    return entry.token;
  } finally {
    if (inFlightRequests.get(key) === request) {
      inFlightRequests.delete(key);
    }
  }
}

/**
 * Invalidate cached token for a repo (e.g. after a 401 from GitHub).
 */
export function invalidateGitHubRepoToken(workspaceId: string, repoFullName: string) {
  tokenCache.delete(cacheKey(workspaceId, repoFullName));
}

export async function getGitHubOperationToken(
  workspaceId: string,
  repoFullName: string,
  operation: GitHubOperation,
  options?: { invalidatedPersonalToken?: string }
): Promise<TokenEntry> {
  const key = operationCacheKey(workspaceId, repoFullName, operation);

  if (!options?.invalidatedPersonalToken) {
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt - Date.now() > SAFETY_WINDOW_MS) {
      return cached;
    }

    const existing = inFlightRequests.get(key);
    if (existing) {
      return await existing;
    }
  }

  const requestGeneration = tokenCacheGeneration;
  const request = (async (): Promise<TokenEntry> => {
    const fetchToken = async (): Promise<TokenEntry> => {
      const result = await requireGitHubTokenPort().getOperationToken({
        workspaceId,
        repoFullName,
        operation,
        ...(options?.invalidatedPersonalToken
          ? { invalidatedPersonalToken: options.invalidatedPersonalToken }
          : {}),
      });

      if (!result.success) {
        throw new GitHubClientTokenError(result.errorCode, result.errorMessage);
      }

      const tokenSource: GitHubTokenSource = result.tokenSource === 'personal' ? 'personal' : 'app';
      const entry: TokenEntry = {
        token: result.token,
        expiresAt: normalizeExpiresAt(result.expiresAt, tokenSource),
        tokenSource,
      };
      return entry;
    };

    let entry: TokenEntry;
    try {
      entry = await fetchToken();
    } catch (error) {
      if (!isGitHubOperationTokenConnectionLostError(error)) throw error;
      entry = await fetchToken();
    }
    if (requestGeneration === tokenCacheGeneration) {
      tokenCache.set(key, entry);
    }
    return entry;
  })();

  inFlightRequests.set(key, request);

  try {
    return await request;
  } finally {
    if (inFlightRequests.get(key) === request) {
      inFlightRequests.delete(key);
    }
  }
}

export function invalidateGitHubOperationToken(
  workspaceId: string,
  repoFullName: string,
  operation: GitHubOperation
) {
  tokenCache.delete(operationCacheKey(workspaceId, repoFullName, operation));
}

export function invalidateGitHubTokensForWorkspace(workspaceId: string) {
  clearGitHubTokensForWorkspace(workspaceId);
  githubTokenInvalidationChannel?.postMessage({
    type: 'invalidate-workspace',
    workspaceId,
  });
}

/**
 * Run a GitHub API call with automatic token retry on 401.
 *
 * On `GitHubAuthError` the cached token is invalidated, a fresh token is
 * fetched, and the call is retried exactly once.
 */
export async function withGitHubTokenRetry<T>(
  workspaceId: string,
  repoFullName: string,
  fn: (token: string) => Promise<T>
): Promise<T> {
  const token = await getGitHubRepoToken(workspaceId, repoFullName);
  try {
    return await fn(token);
  } catch (error) {
    if (error instanceof GitHubAuthError) {
      invalidateGitHubRepoToken(workspaceId, repoFullName);
      const freshToken = await getGitHubRepoToken(workspaceId, repoFullName);
      return fn(freshToken);
    }
    throw error;
  }
}

export async function withGitHubOperationTokenRetry<T>(
  workspaceId: string,
  repoFullName: string,
  operation: GitHubOperation,
  fn: (token: string) => Promise<T>
): Promise<T> {
  const entry = await getGitHubOperationToken(workspaceId, repoFullName, operation);
  try {
    return await fn(entry.token);
  } catch (error) {
    if (entry.tokenSource === 'personal' && isGitHubPermissionFailure(error)) {
      throw new GitHubPersonalIdentityPermissionError(repoFullName);
    }

    if (error instanceof GitHubAuthError) {
      invalidateGitHubOperationToken(workspaceId, repoFullName, operation);
      const freshEntry = await getGitHubOperationToken(workspaceId, repoFullName, operation, {
        ...(entry.tokenSource === 'personal' ? { invalidatedPersonalToken: entry.token } : {}),
      });
      return fn(freshEntry.token);
    }

    throw error;
  }
}
