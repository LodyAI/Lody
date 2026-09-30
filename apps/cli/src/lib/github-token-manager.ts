import { ConvexHttpClient } from 'convex/browser';
import { z } from 'zod';
import { api } from '@lody/cloud-api';
import { Logger, getLogger } from '@/utils/logger';
import { normalizeGitHubRepo } from '@/utils/github';
import { formatErrorMessage } from '@/utils/format-error';

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
  inFlight?: Promise<GitHubTokenResponse>;
};

const REFRESH_SAFETY_WINDOW_MS = 10 * 60 * 1000;
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_PERSONAL_TOKEN_CACHE_MS = 45 * 60 * 1000;
const DEFAULT_APP_TOKEN_CACHE_MS = 15 * 60 * 1000;

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
  private readonly states = new Map<RepoKey, RepoTokenState>();
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
    if (!result.success) {
      if (result.errorCode === 'repo_not_linked') return null;
      if (source === 'personal' && result.errorCode === 'personal_unavailable') {
        // The message carries the backend fallback reason (auth missing, token
        // expired, refresh rejected). It is not a secret; keep it for the helper's
        // stderr so a silent App fallback can be explained and repaired.
        this.logger.debug(
          `[github-token] Personal GitHub identity unavailable for ${repoFullName} (requester ${context.requesterUserId}): ${result.errorMessage}`
        );
        return { available: false, reason: result.errorMessage };
      }
      throw new GitHubTokenFetchError(result.errorCode, result.errorMessage);
    }
    return { token: result.token, tokenSource: result.tokenSource ?? 'app' };
  }

  constructor(options: {
    serverUrl: string;
    cliToken: string;
    workspaceId: string;
    logger?: Logger;
  }) {
    this.logger = options.logger ?? getLogger('github-token');
    this.client = new ConvexHttpClient(options.serverUrl);
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
      state.token = null;
      state.expiresAtMs = null;
      state.tokenSource = null;
      state.rateLimitScope = null;
      state.inFlight = undefined;
    }

    return await this.getTokenInfoFromState(repoFullName, state);
  }

  private async getTokenInfoFromState(
    repoFullName: string,
    state: RepoTokenState
  ): Promise<{ token: string; tokenSource: 'personal' | 'app'; rateLimitScope?: string }> {
    if (this.shouldRefreshNow(state)) {
      await this.refreshRepoToken(state);
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
    try {
      const repoKeyPrefix = `${normalizeGitHubRepo(repoFullName).toLowerCase()}:`;
      const requesterRepoKey = options?.requesterUserId
        ? normalizeRepoKey(repoFullName, 'write', options.requesterUserId)
        : null;
      const states = Array.from(this.states.entries()).filter(([key]) =>
        requesterRepoKey ? key === requesterRepoKey : key.startsWith(repoKeyPrefix)
      );
      for (const [repoKey, state] of states) {
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
        state.token = null;
        state.expiresAtMs = null;
        state.tokenSource = null;
        state.rateLimitScope = null;
        state.inFlight = undefined;
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
    this.logger.debug('[github-token] Invalidating all cached tokens');
    for (const state of this.states.values()) {
      state.token = null;
      state.expiresAtMs = null;
      state.tokenSource = null;
      state.rateLimitScope = null;
      state.invalidatedPersonalToken = null;
      state.inFlight = undefined;
    }
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
    };
    this.states.set(repoKey, state);
    return state;
  }

  private shouldRefreshNow(state: RepoTokenState): boolean {
    // No token or no expiration time - definitely need to refresh
    if (!state.token || !state.expiresAtMs) return true;
    const now = Date.now();
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
    return Date.now() >= state.expiresAtMs;
  }

  private async refreshRepoToken(state: RepoTokenState): Promise<void> {
    if (state.inFlight) {
      const result = await state.inFlight;
      this.applyTokenResult(state, result);
      return;
    }

    state.inFlight = this.fetchToken(state, state.invalidatedPersonalToken ?? undefined);
    try {
      const result = await state.inFlight;
      this.applyTokenResult(state, result);
    } finally {
      state.inFlight = undefined;
    }
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
      state.expiresAtMs = Date.now() + DEFAULT_PERSONAL_TOKEN_CACHE_MS;
    } else {
      state.expiresAtMs = Date.now() + DEFAULT_APP_TOKEN_CACHE_MS;
    }
  }
}
