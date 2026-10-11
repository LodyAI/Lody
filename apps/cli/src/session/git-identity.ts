import { toShared } from '@/platform/process-options';
import { isMissingEmail } from '@lody/shared';

import { runCommandTextSyncLegacy } from '@lody/shared/node/process';

export const DEFAULT_AI_GIT_AUTHOR_NAME = 'LodyAI';
export const DEFAULT_AI_GIT_AUTHOR_EMAIL = 'agent@lody.ai';

export type GitIdentity = {
  name: string;
  email: string;
};

type PartialGitIdentity = {
  name?: string | null;
  email?: string | null;
};

export type GitIdentityResolutionOptions = {
  /** Only machine-owner turns may read and prefer the machine's Git identity. */
  preferMachineIdentity: boolean;
  /**
   * The requester chose "Act as you" for GitHub. Their Lody identity then wins
   * over the machine's Git configuration, matching the credential precedence.
   */
  personalIdentityEnabled?: boolean;
  machineIdentity?: PartialGitIdentity;
};

const trimNonEmpty = (value?: string | null): string | undefined => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
};

const isUsableEmail = (email?: string | null): email is string => {
  const trimmed = trimNonEmpty(email);
  return trimmed !== undefined && !isMissingEmail(trimmed);
};

/**
 * Build the canonical GitHub no-reply commit email for an account.
 *
 * GitHub attributes commits authored with `<id>+<login>@users.noreply.github.com`
 * to that account, so this is the only usable commit identity for a user whose
 * stored account email is a missing-email placeholder (GitHub sign-up without a
 * public email). Both parts are required: the id-only form is not an attribution
 * address.
 */
export const buildGitHubNoreplyEmail = (
  githubAccountId?: string | null,
  githubLogin?: string | null
): string | undefined => {
  const accountId = trimNonEmpty(githubAccountId);
  const login = trimNonEmpty(githubLogin);
  if (!accountId || !login || !/^\d+$/.test(accountId)) {
    return undefined;
  }
  return `${accountId}+${login}@users.noreply.github.com`;
};

const normalizeName = (name: string | undefined, email: string): string => {
  if (name !== undefined && !isMissingEmail(name)) {
    return name;
  }
  return email;
};

/** `git config` blocks the caller's event loop, so a wedged git cannot stall it for long. */
const GIT_CONFIG_TIMEOUT_MS = 5_000;

// Only global identity is a host default; shared bare-repo config belongs to agents.
const readGitConfig = (key: 'user.name' | 'user.email'): string | undefined => {
  try {
    const { stdout } = runCommandTextSyncLegacy(
      {
        command: 'git',
        args: ['config', '--global', key],
        timeout: GIT_CONFIG_TIMEOUT_MS,
        check: 'exit-0',
      },
      toShared()
    );
    return trimNonEmpty(stdout);
  } catch {
    return undefined;
  }
};

export const readHostDefaultGitIdentity = (): PartialGitIdentity => ({
  name:
    trimNonEmpty(process.env.GIT_AUTHOR_NAME) ??
    trimNonEmpty(process.env.GIT_COMMITTER_NAME) ??
    readGitConfig('user.name'),
  email:
    trimNonEmpty(process.env.GIT_AUTHOR_EMAIL) ??
    trimNonEmpty(process.env.GIT_COMMITTER_EMAIL) ??
    readGitConfig('user.email'),
});

export const resolveSessionGitIdentity = (
  requested: PartialGitIdentity,
  options: GitIdentityResolutionOptions
): GitIdentity => {
  // Missing-email addresses are auth placeholders, not commit identities. A
  // non-owner must never fall back to the machine owner's Git configuration.
  const requestedEmail = trimNonEmpty(requested.email);
  const requestedIdentity = isUsableEmail(requestedEmail)
    ? { name: normalizeName(trimNonEmpty(requested.name), requestedEmail), email: requestedEmail }
    : undefined;
  if (options.personalIdentityEnabled && requestedIdentity) {
    return requestedIdentity;
  }

  if (options.preferMachineIdentity) {
    const machineIdentity = options.machineIdentity ?? readHostDefaultGitIdentity();
    const machineEmail = trimNonEmpty(machineIdentity.email);
    if (isUsableEmail(machineEmail)) {
      return {
        name: normalizeName(trimNonEmpty(machineIdentity.name), machineEmail),
        email: machineEmail,
      };
    }
  }

  if (requestedIdentity) {
    return requestedIdentity;
  }

  return {
    name: DEFAULT_AI_GIT_AUTHOR_NAME,
    email: DEFAULT_AI_GIT_AUTHOR_EMAIL,
  };
};
