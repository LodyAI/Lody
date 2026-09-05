import { execFile } from 'node:child_process';
import type {
  CloudGithubTokenManager,
  CloudGithubWriteTokenContext,
} from '@lody/platform';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

/**
 * Per-repo GitHub credential resolution for the poller (plan §3).
 *
 * Unlike interactive owner gh commands, the poller uses the managed workspace token
 * wins; the ambient `gh auth token` is only a fallback (harvested one-shot
 * and cached). Resolver instances are workspace-local, while credential
 * scopes intentionally converge across workspaces that use the same GitHub
 * user or App installation.
 */
export type GitHubCredentialSource = 'managed' | 'gh';

export type ResolvedGitHubCredential = {
  token: string;
  source: GitHubCredentialSource;
  /**
   * Stable, non-secret identity of the credential for throttle buckets and
   * state-file keys. GitHub applies GraphQL quotas per authenticated user or
   * GitHub App installation — not per token string — so the scope must survive
   * token rotation. Managed credentials receive the exact scope from the
   * backend; ambient gh auth resolves the GitHub user ID once per process.
   */
  credentialScope: string;
};

type GhHarvest =
  | { outcome: 'token'; token: string }
  | { outcome: 'gh-missing' }
  | { outcome: 'not-authed' };

const defaultHarvestGhToken = (): Promise<GhHarvest> =>
  new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        resolve({ outcome: code === 'ENOENT' ? 'gh-missing' : 'not-authed' });
        return;
      }
      const token = stdout.trim();
      resolve(token ? { outcome: 'token', token } : { outcome: 'not-authed' });
    });
  });

const defaultFetchGhUserId = (): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      'gh',
      ['api', 'user', '--jq', '.id'],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const id = stdout.trim();
        resolve(id ? id : null);
      }
    );
  });

export type GitHubCredentialResolverDeps = {
  /** Workspace-bound token manager; null disables the managed tier entirely. */
  tokenManager: Pick<
    CloudGithubTokenManager,
    'getWriteTokenInfoForRepo' | 'invalidate'
  > | null;
  /** Requester context for managed write tokens (per-workspace wiring, see M3). */
  writeTokenContext: CloudGithubWriteTokenContext;
  /** Workspace identity used only for the old-backend App-token fallback scope. */
  workspaceId: string;
  logger: Logger;
  /** Injectable for tests. */
  harvestGhToken?: () => Promise<GhHarvest>;
  /** Injectable for tests; defaults to one cached `gh api user --jq .id`. */
  fetchGhUserId?: () => Promise<string | null>;
};

export class GitHubCredentialResolver {
  private readonly harvestGhToken: () => Promise<GhHarvest>;
  private readonly fetchGhUserId: () => Promise<string | null>;
  private ghHarvest: GhHarvest | null = null;
  private ghUserId: string | null | undefined;
  private loggedGhMissing = false;
  private loggedGhNotAuthed = false;
  private loggedGhIdentityUnavailable = false;

  constructor(private readonly deps: GitHubCredentialResolverDeps) {
    this.harvestGhToken = deps.harvestGhToken ?? defaultHarvestGhToken;
    this.fetchGhUserId = deps.fetchGhUserId ?? defaultFetchGhUserId;
  }

  /**
   * Resolve a credential for one repo. Returns null when neither tier can
   * authenticate — gh-missing only disables the harvest fallback, while
   * gh-not-authed disables the ambient credential scope (both logged once).
   */
  async resolve(repoFullName: string): Promise<ResolvedGitHubCredential | null> {
    const managed = await this.resolveManaged(repoFullName);
    if (managed) {
      return managed;
    }
    return await this.resolveAmbientGh();
  }

  /**
   * Token-invalid path (plan §8): drop the cached token so the next resolve
   * re-fetches. Managed invalidation goes through the token manager (which
   * also remembers invalidated personal tokens); the gh harvest cache is
   * cleared so `gh auth token` runs again.
   */
  invalidate(repoFullName: string, credential: ResolvedGitHubCredential): void {
    if (credential.source === 'managed') {
      this.deps.tokenManager?.invalidate(repoFullName, {
        requesterUserId: this.deps.writeTokenContext.requesterUserId,
        invalidatedToken: credential.token,
      });
      return;
    }
    if (this.ghHarvest?.outcome === 'token' && this.ghHarvest.token === credential.token) {
      this.ghHarvest = null;
      this.ghUserId = undefined;
    }
  }

  private async resolveManaged(repoFullName: string): Promise<ResolvedGitHubCredential | null> {
    if (!this.deps.tokenManager) {
      return null;
    }
    try {
      const { token, tokenSource, rateLimitScope } =
        await this.deps.tokenManager.getWriteTokenInfoForRepo(
          repoFullName,
          this.deps.writeTokenContext
        );
      return {
        token,
        source: 'managed',
        // Older backends do not return rateLimitScope. These fallbacks merge
        // identities rather than splitting them on token rotation, so they
        // may under-use quota but cannot mint a fresh bucket per token.
        credentialScope:
          rateLimitScope ??
          (tokenSource === 'personal'
            ? `github:managed-user:${this.deps.writeTokenContext.requesterUserId}`
            : `github:managed-workspace:${this.deps.workspaceId}`),
      };
    } catch (error) {
      this.deps.logger.debug(
        `[pr-poller] Managed GitHub token unavailable for ${repoFullName}: ${formatErrorMessage(error)}`
      );
      return null;
    }
  }

  private async resolveAmbientGh(): Promise<ResolvedGitHubCredential | null> {
    if (this.ghHarvest?.outcome === 'gh-missing') {
      return null;
    }
    if (this.ghHarvest?.outcome === 'not-authed') {
      return null;
    }
    if (this.ghHarvest === null) {
      this.ghHarvest = await this.harvestGhToken();
    }
    if (this.ghHarvest.outcome === 'gh-missing') {
      if (!this.loggedGhMissing) {
        this.loggedGhMissing = true;
        this.deps.logger.debug('[pr-poller] gh CLI not found; ambient token harvest disabled');
      }
      return null;
    }
    if (this.ghHarvest.outcome === 'not-authed') {
      if (!this.loggedGhNotAuthed) {
        this.loggedGhNotAuthed = true;
        this.deps.logger.debug(
          '[pr-poller] gh CLI is not authenticated; ambient credential scope disabled'
        );
      }
      return null;
    }
    const { token } = this.ghHarvest;
    const userId = await this.resolveGhUserId();
    if (!userId) {
      if (!this.loggedGhIdentityUnavailable) {
        this.loggedGhIdentityUnavailable = true;
        this.deps.logger.debug(
          '[pr-poller] Could not resolve the ambient GitHub user ID; polling with gh auth disabled'
        );
      }
      return null;
    }
    return {
      token,
      source: 'gh',
      credentialScope: `github:user:${userId}`,
    };
  }

  /** One-shot, cached for the process; null disables ambient polling for safety. */
  private async resolveGhUserId(): Promise<string | null> {
    if (this.ghUserId !== undefined) {
      return this.ghUserId;
    }
    try {
      this.ghUserId = await this.fetchGhUserId();
    } catch {
      this.ghUserId = null;
    }
    return this.ghUserId;
  }
}
