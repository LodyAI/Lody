import { ConvexHttpClient } from 'convex/browser';
import { z } from 'zod';
import { api } from '@lody/cloud-api';
import type { CloudGithubTokenManager } from '@lody/platform';
import { Logger, getLogger } from '@/utils/logger';
import { normalizeGitHubRepo } from '@/utils/github';
import { formatErrorMessage } from '@/utils/format-error';
import { GITHUB_TOKEN_CLOUD_TIMEOUT_MS } from './github-credential-runtime';

/**
 * Bounds a whole cloud request, response body included. The timer stays
 * unref'd so a finished request never holds the process open.
 */
export const withRequestDeadline =
  (timeoutMs: number, fetchImpl: typeof fetch = fetch): typeof fetch =>
  (input, init) => {
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException('GitHub token request timed out', 'TimeoutError')),
      timeoutMs
    );
    timer.unref?.();
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
    return fetchImpl(input, { ...init, signal });
  };

/**
 * Error codes returned by the backend for GitHub token operations.
 * These match the public GitHub token broker protocol in `@lody/cloud-api`.
 */
export type GitHubTokenErrorCode =
  | 'personal_unavailable'
  | 'unauthorized'
  | 'not_a_member'
  | 'repo_not_linked'
  | 'installation_not_found'
  | 'repo_not_authorized'
  | 'token_generation_failed';

const GitHubTokenSuccessSchema = z.object({
  success: z.literal(true),
  token: z.string(),
  expiresAt: z.string().optional(),
  tokenSource: z.enum(['personal', 'app']).optional(),
  rateLimitScope: z.string().optional(),
});

const GitHubTokenErrorSchema = z.object({
  success: z.literal(false),
  errorCode: z.enum([
    'personal_unavailable',
    'unauthorized',
    'not_a_member',
    'repo_not_linked',
    'installation_not_found',
    'repo_not_authorized',
    'token_generation_failed',
  ]),
  errorMessage: z.string(),
});

const GitHubTokenResponseSchema = z.union([GitHubTokenSuccessSchema, GitHubTokenErrorSchema]);

type GitHubTokenResponse = {
  token: string;
  expiresAt?: string;
  tokenSource?: 'personal' | 'app';
  rateLimitScope?: string;
};

/**
 * Result of a per-command candidate lookup. `null` means the repository is not
 * linked at all; `available: false` means the requested source exists as a
 * policy but cannot mint a token right now, with the backend's reason.
 */
export type GitHubCredentialCandidate =
  | { token: string; tokenSource: 'personal' | 'app' }
  | { available: false; reason: string }
  | null;

export type GitHubWriteTokenContext = {
  requesterUserId: string;
  machineId: string;
};

/**
 * Error thrown when GitHub token fetch fails with a structured error code.
 */
export class GitHubTokenFetchError extends Error {
  constructor(
    public readonly code: GitHubTokenErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'GitHubTokenFetchError';
  }
}

/**
 * Cache key for repo tokens - uses normalized repo full name (e.g., "owner/repo")
 *
 * Note: We cache per-repo (not per-owner) because managed GitHub tokens can
 * be scoped to a specific repository.
 */
type RepoKey = string;

type FailureBackoff = { error: unknown; retryAtMs: number; failures: number };

type RepoTokenState = {
  repoFullName: string; // Original casing for API calls
  kind: 'app' | 'write';
  requesterUserId: string | null;
  machineId: string | null;
  token: string | null;
  expiresAtMs: number | null;
  tokenSource: 'personal' | 'app' | null;
  rateLimitScope: string | null;
  invalidatedPersonalToken: string | null;
  /** Bumped by invalidation so an older fetch cannot publish into this state. */
  epoch: number;
  failure: FailureBackoff | null;
  inFlight?: Promise<boolean>;
};

type CandidateEntry =
  | { kind: 'token'; token: string; tokenSource: 'personal' | 'app'; expiresAt: number }
  | { kind: 'unavailable'; result: GitHubCredentialCandidate; expiresAt: number }
  | ({ kind: 'failed'; expiresAt: number } & Omit<FailureBackoff, 'retryAtMs'>);

type CandidateFlight = {
  promise: Promise<GitHubCredentialCandidate>;
  rejectedToken: string | undefined;
};

const REFRESH_SAFETY_WINDOW_MS = 10 * 60 * 1000;
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_PERSONAL_TOKEN_CACHE_MS = 45 * 60 * 1000;
const DEFAULT_APP_TOKEN_CACHE_MS = 15 * 60 * 1000;
const CANDIDATE_CACHE_MS = 60_000;
/** Longest a failed cloud answer is reused before the next request. */
export const GITHUB_TOKEN_FAILURE_BACKOFF_MAX_MS = 30_000;
/**
 * Per-command candidates skip a failed source during reuse and select the next
 * identity, and nothing tells the CLI about a reauthorization. Reuse there only
 * merges the helper calls of one command, so a fixed grant is used within seconds.
 */
export const GITHUB_CANDIDATE_FAILURE_REUSE_MAX_MS = 5_000;
const TRANSIENT_FAILURE_BACKOFF_BASE_MS = 1_000;

/**
 * How long a failed cloud answer stands in for the next request. Configuration
 * answers (unlinked repository, missing personal grant) hold for the full window;
 * service failures back off exponentially from their completion. An expired CLI
 * login is never reused: the login recovery path owns it.
 */
export function githubTokenFailureBackoffMs(
  error: unknown,
  previousFailures: number,
  maxMs = GITHUB_TOKEN_FAILURE_BACKOFF_MAX_MS
) {
  if (error instanceof GitHubTokenFetchError) {
    if (error.code === 'unauthorized') return null;
    if (error.code !== 'token_generation_failed') return maxMs;
  }
  return Math.min(maxMs, TRANSIENT_FAILURE_BACKOFF_BASE_MS * 2 ** previousFailures);
}

/**
 * Normalize repo name to lowercase for use as cache key.
 * This ensures "Owner/Repo" and "owner/repo" share the same cache entry.
 */
const normalizeRepoKey = (repoFullName: string, kind: 'app' | 'write', requesterUserId?: string) =>
  `${normalizeGitHubRepo(repoFullName).toLowerCase()}:${kind}${
    kind === 'write' ? `:${requesterUserId ?? ''}` : ''
  }`;

export class GitHubTokenManager {
  private readonly logger: Logger;
  private readonly client: ConvexHttpClient;
  private readonly cliToken: string;
  private readonly workspaceId: string;
  private readonly now: () => number;
  private readonly states = new Map<RepoKey, RepoTokenState>();
  private readonly candidates = new Map<string, CandidateEntry>();
  private readonly candidateFlights = new Map<string, CandidateFlight>();
  /** Bumped by invalidation; a candidate fetch publishes only within its generation. */
  private candidateGeneration = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshAllInFlight: Promise<void> | null = null;

  async getCredentialPolicy(
    context: GitHubWriteTokenContext
  ): Promise<{ personalEnabled: boolean }> {
    return z.object({ personalEnabled: z.boolean() }).parse(
      await this.client.action(api.github.getCredentialPolicyForCli, {
        cliToken: this.cliToken,
        workspaceId: this.workspaceId,
        requesterUserId: context.requesterUserId,
        machineId: context.machineId,
      })
    );
  }

  // Selection is per command. In particular, do not reuse an App candidate after
  // the user enables personal identity, or mint App tokens to inspect preference.
  async getCredentialCandidate(
    repoFullName: string,
    context: GitHubWriteTokenContext,
    source: 'personal' | 'app',
    invalidatedPersonalToken?: string
  ): Promise<GitHubCredentialCandidate> {
    const cacheKey = JSON.stringify([
      repoFullName.toLowerCase(),
      context.requesterUserId,
      context.machineId,
      source,
    ]);
    const cached = this.candidates.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) {
      if (cached.kind === 'failed') throw cached.error;
      if (cached.kind === 'unavailable') return cached.result;
      // A rejection of an older token is late: a newer candidate already replaced it.
      if (cached.token !== invalidatedPersonalToken)
        return { token: cached.token, tokenSource: cached.tokenSource };
    }
    if (cached?.kind === 'token') this.candidates.delete(cacheKey);
    const flight = this.candidateFlights.get(cacheKey);
    if (!flight)
      return await this.startCandidateFlight(
        cacheKey,
        repoFullName,
        context,
        source,
        invalidatedPersonalToken
      );
    const result = await flight.promise;
    // Only a flight that may still return the rejected token needs a second request.
    if (
      invalidatedPersonalToken === undefined ||
      flight.rejectedToken === invalidatedPersonalToken ||
      !result ||
      !('token' in result) ||
      result.token !== invalidatedPersonalToken
    )
      return result;
    const retry = this.candidateFlights.get(cacheKey);
    if (retry?.rejectedToken === invalidatedPersonalToken) return await retry.promise;
    return await this.startCandidateFlight(
      cacheKey,
      repoFullName,
      context,
      source,
      invalidatedPersonalToken
    );
  }

  private startCandidateFlight(
    cacheKey: string,
    repoFullName: string,
    context: GitHubWriteTokenContext,
    source: 'personal' | 'app',
    invalidatedPersonalToken: string | undefined
  ): Promise<GitHubCredentialCandidate> {
    const generation = this.candidateGeneration;
    const previous = this.candidates.get(cacheKey);
    const previousFailures = previous?.kind === 'failed' ? previous.failures : 0;
    const current: CandidateFlight = {
      rejectedToken: invalidatedPersonalToken,
      promise: this.fetchCredentialCandidate(
        repoFullName,
        context,
        source,
        invalidatedPersonalToken
      )
        .then(
          (entry) => {
            if (generation === this.candidateGeneration && entry.expiresAt > this.now())
              this.candidates.set(cacheKey, entry);
            return entry.kind === 'token'
              ? { token: entry.token, tokenSource: entry.tokenSource }
              : entry.result;
          },
          (error: unknown) => {
            const backoffMs = githubTokenFailureBackoffMs(
              error,
              previousFailures,
              GITHUB_CANDIDATE_FAILURE_REUSE_MAX_MS
            );
            if (generation === this.candidateGeneration && backoffMs !== null)
              this.candidates.set(cacheKey, {
                kind: 'failed',
                error,
                failures: previousFailures + 1,
                expiresAt: this.now() + backoffMs,
              });
            throw error;
          }
        )
        .finally(() => {
          if (this.candidateFlights.get(cacheKey) === current)
            this.candidateFlights.delete(cacheKey);
        }),
    };
    this.candidateFlights.set(cacheKey, current);
    return current.promise;
  }

  private async fetchCredentialCandidate(
    repoFullName: string,
    context: GitHubWriteTokenContext,
    source: 'personal' | 'app',
    invalidatedPersonalToken: string | undefined
  ): Promise<Exclude<CandidateEntry, { kind: 'failed' }>> {
    const result = GitHubTokenResponseSchema.parse(
      await this.client.action(api.github.getOperationAccessTokenByRepoNameForCli, {
        cliToken: this.cliToken,
        workspaceId: this.workspaceId,
        requesterUserId: context.requesterUserId,
        machineId: context.machineId,
        repoFullName,
        operation: 'write',
        credentialSource: source,
        invalidatedPersonalToken,
      })
    );
    const unavailableUntil = this.now() + GITHUB_CANDIDATE_FAILURE_REUSE_MAX_MS;
    if (!result.success) {
      if (result.errorCode === 'repo_not_linked')
        return { kind: 'unavailable', result: null, expiresAt: unavailableUntil };
      if (source === 'personal' && result.errorCode === 'personal_unavailable') {
        // The message carries the backend fallback reason (auth missing, token
        // expired, refresh rejected). It is not a secret; keep it for the helper's
        // stderr so a silent App fallback can be explained and repaired.
        this.logger.debug(
          `[github-token] Personal GitHub identity unavailable for ${repoFullName} (requester ${context.requesterUserId}): ${result.errorMessage}`
        );
        return {
          kind: 'unavailable',
          result: { available: false, reason: result.errorMessage },
          expiresAt: unavailableUntil,
        };
      }
      throw new GitHubTokenFetchError(result.errorCode, result.errorMessage);
    }
    const tokenSource = result.tokenSource ?? 'app';
    if (tokenSource !== source)
      throw new GitHubTokenFetchError('token_generation_failed', 'Unexpected credential source');
    const now = this.now();
    const expiresAt = Math.min(
      now + CANDIDATE_CACHE_MS,
      result.expiresAt ? Date.parse(result.expiresAt) - 5000 : now + CANDIDATE_CACHE_MS
    );
    return { kind: 'token', token: result.token, tokenSource, expiresAt };
  }

  constructor(options: {
    serverUrl: string;
    cliToken: string;
    workspaceId: string;
    logger?: Logger;
    /** Injectable for tests; defaults to Date.now. */
    now?: () => number;
  }) {
    this.logger = options.logger ?? getLogger('github-token');
    this.now = options.now ?? Date.now;
    this.client = new ConvexHttpClient(options.serverUrl, {
      logger: false,
      fetch: withRequestDeadline(GITHUB_TOKEN_CLOUD_TIMEOUT_MS),
    });
    this.cliToken = options.cliToken;
    this.workspaceId = options.workspaceId;
  }

  startAutoRefresh(options?: { intervalMs?: number }): void {
    if (this.refreshTimer) {
      return;
    }

    const intervalMs = options?.intervalMs ?? AUTO_REFRESH_INTERVAL_MS;
    const tick = () => {
      void this.refreshAllIfNeeded().catch((error: unknown) => {
        this.logger.debug(`[github-token] Auto-refresh tick failed: ${formatErrorMessage(error)}`);
      });
    };

    this.refreshTimer = setInterval(tick, intervalMs);
    this.refreshTimer.unref?.();
    tick();
  }

  stopAutoRefresh(): void {
    if (!this.refreshTimer) {
      return;
    }
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  async getAppTokenForRepo(repoFullName: string): Promise<string> {
    const { token } = await this.getAppTokenInfoForRepo(repoFullName);
    return token;
  }

  async getAppTokenInfoForRepo(
    repoFullName: string
  ): Promise<{ token: string; tokenSource: 'personal' | 'app'; rateLimitScope?: string }> {
    const repoKey = normalizeRepoKey(repoFullName, 'app');
    const state = this.getOrCreateState(repoKey, repoFullName, {
      kind: 'app',
    });

    return await this.getTokenInfoFromState(repoFullName, state);
  }

  async getWriteTokenForRepo(
    repoFullName: string,
    context: GitHubWriteTokenContext
  ): Promise<string> {
    const { token } = await this.getWriteTokenInfoForRepo(repoFullName, context);
    return token;
  }

  async getWriteTokenInfoForRepo(
    repoFullName: string,
    context: GitHubWriteTokenContext
  ): Promise<{ token: string; tokenSource: 'personal' | 'app'; rateLimitScope?: string }> {
    const repoKey = normalizeRepoKey(repoFullName, 'write', context.requesterUserId);
    const state = this.getOrCreateState(repoKey, repoFullName, {
      kind: 'write',
      requesterUserId: context.requesterUserId,
      machineId: context.machineId,
    });
    if (state.machineId !== context.machineId) {
      state.machineId = context.machineId;
      this.resetState(state);
    }

    return await this.getTokenInfoFromState(repoFullName, state);
  }

  private async getTokenInfoFromState(
    repoFullName: string,
    state: RepoTokenState
  ): Promise<{ token: string; tokenSource: 'personal' | 'app'; rateLimitScope?: string }> {
    // A refresh superseded by invalidation publishes nothing; retry once for the new epoch.
    for (let attempt = 0; attempt < 2 && this.shouldRefreshNow(state); attempt++) {
      if (await this.refreshRepoToken(state)) break;
    }

    // After refresh attempt, validate token is present and not expired.
    // This ensures we never return an expired token to the caller.
    if (!state.token || this.isTokenExpired(state)) {
      throw new GitHubTokenFetchError(
        'token_generation_failed',
        `Failed to obtain a valid GitHub token for repository "${repoFullName}". ` +
          'The token may have expired or failed to refresh.'
      );
    }

    return {
      token: state.token,
      tokenSource: state.tokenSource ?? 'app',
      ...(state.rateLimitScope ? { rateLimitScope: state.rateLimitScope } : {}),
    };
  }

  retainRepoOwner(repoFullName: string): void {
    try {
      const repoKey = normalizeRepoKey(repoFullName, 'app');
      this.getOrCreateState(repoKey, repoFullName, { kind: 'app' });
    } catch (error) {
      this.logger.debug(
        `[github-token] failed to retain repo ${repoFullName}: ${formatErrorMessage(error)}`
      );
    }
  }

  async shutdown(): Promise<void> {
    this.stopAutoRefresh();
    this.states.clear();
    this.candidates.clear();
    this.candidateFlights.clear();
    this.candidateGeneration++;
  }

  /**
   * Invalidate cached token for a specific repo.
   * Called when an auth failure is detected to force a fresh token fetch on retry.
   *
   * @param repoFullName - The repo full name (e.g., "owner/repo")
   */
  invalidate(
    repoFullName: string,
    options?: {
      requesterUserId?: string;
      invalidatedToken?: string;
      markPersonalTokenInvalid?: boolean;
    }
  ): void {
    // Clear only matching repository/requester candidates, including rejected App tokens
    // and remembered failures. A rejection of an already replaced token changes nothing.
    const matches = (key: string) => {
      const [repo, requester] = JSON.parse(key) as string[];
      return (
        repo === repoFullName.toLowerCase() &&
        (!options?.requesterUserId || requester === options.requesterUserId)
      );
    };
    let candidatesChanged = false;
    for (const [key, entry] of this.candidates) {
      if (!matches(key)) continue;
      if (
        options?.invalidatedToken &&
        (entry.kind !== 'token' || entry.token !== options.invalidatedToken)
      )
        continue;
      this.candidates.delete(key);
      candidatesChanged = true;
    }
    if (!options?.invalidatedToken) {
      for (const key of this.candidateFlights.keys()) {
        if (!matches(key)) continue;
        this.candidateFlights.delete(key);
        candidatesChanged = true;
      }
    }
    if (candidatesChanged) this.candidateGeneration++;
    try {
      const repoKeyPrefix = `${normalizeGitHubRepo(repoFullName).toLowerCase()}:`;
      const requesterRepoKey = options?.requesterUserId
        ? normalizeRepoKey(repoFullName, 'write', options.requesterUserId)
        : null;
      const states = Array.from(this.states.entries()).filter(([key]) =>
        requesterRepoKey ? key === requesterRepoKey : key.startsWith(repoKeyPrefix)
      );
      for (const [repoKey, state] of states) {
        if (
          options?.invalidatedToken &&
          state.token !== null &&
          state.token !== options.invalidatedToken
        )
          continue;
        this.logger.debug(`[github-token] Invalidating cached token for repo: ${repoKey}`);
        if (options?.invalidatedToken && state.kind === 'write') {
          state.invalidatedPersonalToken = options.invalidatedToken;
        } else if (
          options?.markPersonalTokenInvalid &&
          state.kind === 'write' &&
          state.tokenSource === 'personal' &&
          state.token
        ) {
          state.invalidatedPersonalToken = state.token;
        }
        this.resetState(state);
      }
    } catch (error) {
      this.logger.debug(
        `[github-token] Failed to invalidate token for ${repoFullName}: ${formatErrorMessage(
          error
        )}`
      );
    }
  }

  /**
   * Invalidate all cached tokens.
   * Called when a global auth issue is detected (e.g., CLI token expired).
   */
  invalidateAll(): void {
    this.candidates.clear();
    this.candidateFlights.clear();
    this.candidateGeneration++;
    this.logger.debug('[github-token] Invalidating all cached tokens');
    for (const state of this.states.values()) {
      state.invalidatedPersonalToken = null;
      this.resetState(state);
    }
  }

  /** Drops the token, remembered failure and in-flight adoption of one state. */
  private resetState(state: RepoTokenState): void {
    state.epoch++;
    state.token = null;
    state.expiresAtMs = null;
    state.tokenSource = null;
    state.rateLimitScope = null;
    state.failure = null;
    state.inFlight = undefined;
  }

  private getOrCreateState(
    repoKey: RepoKey,
    originalRepoFullName: string,
    options: {
      kind: 'app' | 'write';
      requesterUserId?: string;
      machineId?: string;
    }
  ): RepoTokenState {
    const existing = this.states.get(repoKey);
    if (existing) {
      return existing;
    }

    const state: RepoTokenState = {
      repoFullName: normalizeGitHubRepo(originalRepoFullName), // Normalized but preserves original casing
      kind: options.kind,
      requesterUserId: options.requesterUserId ?? null,
      machineId: options.machineId ?? null,
      token: null,
      expiresAtMs: null,
      tokenSource: null,
      rateLimitScope: null,
      invalidatedPersonalToken: null,
      epoch: 0,
      failure: null,
    };
    this.states.set(repoKey, state);
    return state;
  }

  private shouldRefreshNow(state: RepoTokenState): boolean {
    // No token or no expiration time - definitely need to refresh
    if (!state.token || !state.expiresAtMs) return true;
    const now = this.now();
    // Token already expired - need to refresh
    if (now >= state.expiresAtMs) return true;
    // Token expiring within safety window - need to refresh
    return state.expiresAtMs - now <= REFRESH_SAFETY_WINDOW_MS;
  }

  /**
   * Check if the token in state is currently expired.
   */
  private isTokenExpired(state: RepoTokenState): boolean {
    if (!state.expiresAtMs) return true;
    return this.now() >= state.expiresAtMs;
  }

  /**
   * Shares one fetch per state. Resolves false when invalidation superseded the
   * fetch, which then publishes neither its token nor its failure.
   */
  private refreshRepoToken(state: RepoTokenState): Promise<boolean> {
    if (state.inFlight) return state.inFlight;
    if (state.failure && this.now() < state.failure.retryAtMs)
      return Promise.reject(state.failure.error);

    const epoch = state.epoch;
    const previousFailures = state.failure?.failures ?? 0;
    const flight: Promise<boolean> = this.fetchToken(
      state,
      state.invalidatedPersonalToken ?? undefined
    )
      .then((result) => {
        if (state.epoch !== epoch) return false;
        this.applyTokenResult(state, result);
        state.failure = null;
        return true;
      })
      .catch((error: unknown) => {
        if (state.epoch === epoch) {
          const backoffMs = githubTokenFailureBackoffMs(error, previousFailures);
          state.failure =
            backoffMs === null
              ? null
              : { error, failures: previousFailures + 1, retryAtMs: this.now() + backoffMs };
        }
        throw error;
      })
      .finally(() => {
        if (state.inFlight === flight) state.inFlight = undefined;
      });
    state.inFlight = flight;
    return flight;
  }

  private async refreshAllIfNeeded(): Promise<void> {
    if (this.refreshAllInFlight) {
      return this.refreshAllInFlight;
    }

    this.refreshAllInFlight = (async () => {
      if (this.states.size === 0) {
        return;
      }
      for (const state of this.states.values()) {
        if (!this.shouldRefreshNow(state)) {
          continue;
        }
        try {
          await this.refreshRepoToken(state);
        } catch (error) {
          this.logger.debug(
            `[github-token] Auto-refresh failed for ${state.repoFullName}: ${formatErrorMessage(
              error
            )}`
          );
        }
      }
    })();

    try {
      await this.refreshAllInFlight;
    } finally {
      this.refreshAllInFlight = null;
    }
  }

  private async fetchToken(
    state: RepoTokenState,
    invalidatedPersonalToken?: string
  ): Promise<GitHubTokenResponse> {
    const requesterUserId = state.requesterUserId;
    const machineId = state.machineId;
    let raw: unknown;
    if (state.kind === 'write') {
      if (!requesterUserId || !machineId) {
        throw new GitHubTokenFetchError(
          'token_generation_failed',
          `Missing requester context for GitHub write token for repository "${state.repoFullName}".`
        );
      }
      raw = await this.client.action(api.github.getOperationAccessTokenByRepoNameForCli, {
        repoFullName: state.repoFullName,
        cliToken: this.cliToken,
        workspaceId: this.workspaceId,
        requesterUserId,
        machineId,
        operation: 'write',
        ...(invalidatedPersonalToken ? { invalidatedPersonalToken } : {}),
      });
    } else {
      raw = await this.client.action(api.github.getAccessTokenByRepoNameForCli, {
        repoFullName: state.repoFullName,
        cliToken: this.cliToken,
        workspaceId: this.workspaceId,
      });
    }
    const result = GitHubTokenResponseSchema.parse(raw);

    if (!result.success) {
      throw new GitHubTokenFetchError(result.errorCode, result.errorMessage);
    }

    return {
      token: result.token,
      expiresAt: result.expiresAt,
      tokenSource: result.tokenSource,
      rateLimitScope: result.rateLimitScope,
    };
  }

  private applyTokenResult(state: RepoTokenState, result: GitHubTokenResponse): void {
    const tokenSource = result.tokenSource ?? 'app';
    if (
      state.invalidatedPersonalToken &&
      tokenSource === 'personal' &&
      result.token === state.invalidatedPersonalToken
    ) {
      throw new GitHubTokenFetchError(
        'token_generation_failed',
        `Backend returned an invalidated personal GitHub token for repository "${state.repoFullName}".`
      );
    }
    const parsedMs = result.expiresAt ? Date.parse(result.expiresAt) : NaN;
    state.token = result.token;
    state.tokenSource = tokenSource;
    state.rateLimitScope = result.rateLimitScope ?? null;
    state.invalidatedPersonalToken = null;
    if (Number.isFinite(parsedMs)) {
      state.expiresAtMs = parsedMs;
    } else if (state.tokenSource === 'personal') {
      state.expiresAtMs = this.now() + DEFAULT_PERSONAL_TOKEN_CACHE_MS;
    } else {
      state.expiresAtMs = this.now() + DEFAULT_APP_TOKEN_CACHE_MS;
    }
  }
}

/**
 * One token manager per workspace in this process. Session execution and PR
 * polling borrow it, so their cache, in-flight requests and failure backoff are
 * shared. A lease's shutdown releases only that lease; the last one shuts the
 * manager down.
 */
export function createSharedGitHubTokenManagers(
  create: (workspaceId: string) => GitHubTokenManager
) {
  const shared = new Map<string, { manager: GitHubTokenManager; leases: number }>();
  return {
    acquire(workspaceId: string): CloudGithubTokenManager {
      let entry = shared.get(workspaceId);
      if (!entry) {
        entry = { manager: create(workspaceId), leases: 0 };
        shared.set(workspaceId, entry);
      }
      entry.leases++;
      const { manager } = entry;
      const owner = entry;
      let released = false;
      return {
        getCredentialPolicy: (context) => manager.getCredentialPolicy(context),
        getCredentialCandidate: (repoFullName, context, source, invalidatedPersonalToken) =>
          manager.getCredentialCandidate(repoFullName, context, source, invalidatedPersonalToken),
        startAutoRefresh: () => manager.startAutoRefresh(),
        getAppTokenForRepo: (repoFullName) => manager.getAppTokenForRepo(repoFullName),
        getWriteTokenForRepo: (repoFullName, context) =>
          manager.getWriteTokenForRepo(repoFullName, context),
        getAppTokenInfoForRepo: (repoFullName) => manager.getAppTokenInfoForRepo(repoFullName),
        getWriteTokenInfoForRepo: (repoFullName, context) =>
          manager.getWriteTokenInfoForRepo(repoFullName, context),
        retainRepoOwner: (repoFullName) => manager.retainRepoOwner(repoFullName),
        invalidate: (repoFullName, context) => manager.invalidate(repoFullName, context),
        invalidateAll: () => manager.invalidateAll(),
        shutdown: async () => {
          if (released) return;
          released = true;
          owner.leases--;
          if (owner.leases > 0 || shared.get(workspaceId) !== owner) return;
          shared.delete(workspaceId);
          await manager.shutdown();
        },
      };
    },
    async shutdownAll(): Promise<void> {
      const managers = [...shared.values()].map((entry) => entry.manager);
      shared.clear();
      await Promise.allSettled(managers.map(async (manager) => await manager.shutdown()));
    },
  };
}
