import { buildMissingEmail, type WorkspaceId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { buildGitHubNoreplyEmail } from './git-identity';
import type { CloudWorkspaceUserProfile } from '@lody/platform';

export type SessionUserProfile = {
  id: string;
  name: string;
  email: string;
  /**
   * Canonical GitHub attribution address for the account, when it has one.
   *
   * Kept separate from `email` because it is a commit identity only on a
   * github.com remote, and this resolver cannot see the session workdir.
   */
  githubNoreplyEmail?: string;
};

/** Raw workspace-member profile as returned by the CLI-token Convex query. */
type WorkspaceUserProfileQuery = (userId: string) => Promise<CloudWorkspaceUserProfile | null>;

const trimNonEmpty = (value?: string | null): string | undefined => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Resolves the requesting user's commit identity for a session turn.
 *
 * This must go through the CLI-token query: the daemon holds an API-key CLI
 * token rather than a Convex JWT, so the JWT-only `auth.getUserById` always
 * resolved to nothing here and every session ended up committing under the
 * host's git identity (the machine owner) instead of the user who started it.
 */
export class SessionUserResolver {
  private readonly queryProfile: WorkspaceUserProfileQuery;
  private readonly cache = new Map<string, Promise<SessionUserProfile>>();

  constructor(
    private readonly logger: Logger,
    private readonly workspaceId: WorkspaceId,
    queryProfile: WorkspaceUserProfileQuery
  ) {
    this.queryProfile = queryProfile;
  }

  async resolve(userId: string): Promise<SessionUserProfile> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return {
        id: userId,
        name: userId,
        email: buildMissingEmail('lody', userId),
      };
    }

    const existing = this.cache.get(normalizedUserId);
    if (existing) {
      return await existing;
    }

    const request = this.fetchUser(normalizedUserId).catch((error: unknown) => {
      this.cache.delete(normalizedUserId);
      throw error;
    });
    this.cache.set(normalizedUserId, request);
    return await request;
  }

  clear(): void {
    this.cache.clear();
  }

  private async fetchUser(userId: string): Promise<SessionUserProfile> {
    try {
      const profile = await this.queryProfile(userId);
      if (!profile) {
        this.logger.debug(
          `[session-user-resolver] User ${userId} not resolvable in workspace ${this.workspaceId}; using placeholder identity`
        );
        return this.fallbackUser(userId);
      }
      return this.toSessionUserProfile(userId, profile);
    } catch (error) {
      this.logger.debug(
        `[session-user-resolver] Failed to resolve user ${userId} in workspace ${this.workspaceId}: ${formatErrorMessage(
          error
        )}`
      );
      return this.fallbackUser(userId);
    }
  }

  private toSessionUserProfile(
    userId: string,
    profile: CloudWorkspaceUserProfile
  ): SessionUserProfile {
    const accountEmail = trimNonEmpty(profile.email);
    const email = accountEmail ?? buildMissingEmail('lody', userId);
    const name = trimNonEmpty(profile.name) ?? trimNonEmpty(profile.githubLogin) ?? email;
    // Reported alongside the account email rather than instead of it: only the
    // session workdir's remote decides which of the two can attribute a commit.
    const githubNoreplyEmail = buildGitHubNoreplyEmail(
      profile.githubAccountId,
      profile.githubLogin
    );
    return { id: userId, name, email, ...(githubNoreplyEmail ? { githubNoreplyEmail } : {}) };
  }

  private fallbackUser(userId: string): SessionUserProfile {
    const email = buildMissingEmail('lody', userId);
    return {
      id: userId,
      name: email,
      email,
    };
  }
}
