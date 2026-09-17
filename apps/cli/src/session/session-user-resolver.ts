import { Effect } from 'effect';
import { buildMissingEmail, isMissingEmail, type WorkspaceId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { buildGitHubNoreplyEmail } from './git-identity';
import type { CloudWorkspaceUserProfile } from '@lody/platform';

export type SessionUserProfile = {
  id: string;
  name: string;
  email: string;
};

/** Raw workspace-member profile as returned by the CLI-token Convex query. */
type WorkspaceUserProfileQuery = (userId: string) => Promise<CloudWorkspaceUserProfile | null>;

const USER_PROFILE_TIMEOUT_MS = 60_000;

const trimNonEmpty = (value?: string | null): string | undefined => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Resolves the requesting user's commit identity for a session turn.
 *
 * Non-owner profiles must go through the CLI-token query: the daemon holds an API-key CLI
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
    queryProfile: WorkspaceUserProfileQuery,
    private readonly machineOwnerUserId?: string
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

    // The Session reads Git configuration in the actual worktree when binding
    // the owner turn. Do not block that local path on a cloud profile query.
    if (normalizedUserId === this.machineOwnerUserId) {
      return this.fallbackUser(normalizedUserId);
    }

    const existing = this.cache.get(normalizedUserId);
    if (existing) {
      return await existing;
    }

    const request = this.fetchUser(normalizedUserId).catch((error: unknown) => {
      if (this.cache.get(normalizedUserId) === request) {
        this.cache.delete(normalizedUserId);
      }
      this.logger.debug(
        `[session-user-resolver] Failed to resolve user ${normalizedUserId} in workspace ${this.workspaceId}: ${formatErrorMessage(error)}`
      );
      return this.fallbackUser(normalizedUserId);
    });
    this.cache.set(normalizedUserId, request);
    return await request;
  }

  clear(): void {
    this.cache.clear();
  }

  private async fetchUser(userId: string): Promise<SessionUserProfile> {
    const profile = await Effect.runPromise(
      Effect.tryPromise(() => this.queryProfile(userId)).pipe(
        Effect.timeout(USER_PROFILE_TIMEOUT_MS)
      )
    );
    if (!profile) {
      this.logger.debug(
        `[session-user-resolver] User ${userId} not resolvable in workspace ${this.workspaceId}; using placeholder identity`
      );
      return this.fallbackUser(userId);
    }
    return this.toSessionUserProfile(userId, profile);
  }

  private toSessionUserProfile(
    userId: string,
    profile: CloudWorkspaceUserProfile
  ): SessionUserProfile {
    const accountEmail = trimNonEmpty(profile.email);
    // A stored missing-email placeholder is not a commit identity; a GitHub
    // no-reply address is, and it keeps the commit attributed to the same
    // GitHub account that opens the pull request.
    const email =
      (accountEmail && !isMissingEmail(accountEmail) ? accountEmail : undefined) ??
      buildGitHubNoreplyEmail(profile.githubAccountId, profile.githubLogin) ??
      accountEmail ??
      buildMissingEmail('lody', userId);
    const name = trimNonEmpty(profile.name) ?? trimNonEmpty(profile.githubLogin) ?? email;
    return { id: userId, name, email };
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
