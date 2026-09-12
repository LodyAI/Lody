import { execFileSync } from 'node:child_process';

import { isMissingEmail } from '@lody/shared';

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

export type GitRemote = {
  name: string;
  url: string;
};

export type GitIdentityResolutionOptions = {
  /** Only machine-owner turns may read and prefer the machine's Git identity. */
  preferMachineIdentity: boolean;
  machineIdentity?: PartialGitIdentity;
  cwd?: string;
  /**
   * The requester's GitHub no-reply address. It is a commit identity only on a
   * github.com remote, so it is never used as a generic fallback.
   */
  githubNoreplyEmail?: string | null;
  /** Session workdir remotes; read from `cwd` when omitted. */
  remotes?: readonly GitRemote[];
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

const readGitConfig = (key: 'user.name' | 'user.email', cwd?: string): string | undefined => {
  try {
    const output = execFileSync('git', ['config', key], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return trimNonEmpty(output);
  } catch {
    return undefined;
  }
};

/** Hosts whose pushes GitHub itself authorizes, and therefore the only hosts a
 * `users.noreply.github.com` author address can be attributed by. GitHub
 * Enterprise installations and every other forge are deliberately excluded. */
const GITHUB_REMOTE_HOSTS = new Set(['github.com', 'gist.github.com']);

/**
 * Host of a Git remote URL, or undefined for a local path or unparsable value.
 *
 * Handles the scp-like `git@host:owner/repo.git` form separately: it has no
 * scheme, so `URL` rejects it.
 */
export const parseGitRemoteHost = (remoteUrl: string): string | undefined => {
  const url = remoteUrl.trim();
  if (!url) {
    return undefined;
  }
  if (!url.includes('://')) {
    const scpLike = /^(?:[^@\s/]+@)?([^\s/:]+):/.exec(url);
    return scpLike?.[1]?.toLowerCase();
  }
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

const isGitHubRemote = (remote: GitRemote): boolean => {
  const host = parseGitRemoteHost(remote.url);
  return host !== undefined && GITHUB_REMOTE_HOSTS.has(host);
};

/**
 * Whether commits made here are pushed to github.com.
 *
 * `origin` decides alone when it exists: a repository whose origin is another
 * forge is not a GitHub repository just because it also has a GitHub mirror.
 */
export const remotesTargetGitHub = (remotes: readonly GitRemote[]): boolean => {
  const origin = remotes.find((remote) => remote.name === 'origin');
  if (origin) {
    return isGitHubRemote(origin);
  }
  return remotes.some(isGitHubRemote);
};

/**
 * Parse `git remote -v`. The push URL wins when it differs from the fetch URL,
 * because the push is what GitHub's private-email protection rejects.
 */
export const parseGitRemoteList = (output: string): GitRemote[] => {
  const fetchUrls = new Map<string, string>();
  const pushUrls = new Map<string, string>();
  for (const line of output.split('\n')) {
    const [name, url, direction] = line.trim().split(/\s+/);
    if (!name || !url) {
      continue;
    }
    const target = direction === '(push)' ? pushUrls : fetchUrls;
    if (!target.has(name)) {
      target.set(name, url);
    }
  }
  const names = new Set([...fetchUrls.keys(), ...pushUrls.keys()]);
  return [...names].flatMap((name) => {
    const url = pushUrls.get(name) ?? fetchUrls.get(name);
    return url ? [{ name, url }] : [];
  });
};

const readGitRemotes = (cwd?: string): GitRemote[] => {
  try {
    const output = execFileSync('git', ['remote', '-v'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return parseGitRemoteList(output);
  } catch {
    return [];
  }
};

export const readHostDefaultGitIdentity = (cwd?: string): PartialGitIdentity => ({
  name:
    trimNonEmpty(process.env.GIT_AUTHOR_NAME) ??
    trimNonEmpty(process.env.GIT_COMMITTER_NAME) ??
    readGitConfig('user.name', cwd),
  email:
    trimNonEmpty(process.env.GIT_AUTHOR_EMAIL) ??
    trimNonEmpty(process.env.GIT_COMMITTER_EMAIL) ??
    readGitConfig('user.email', cwd),
});

export const resolveSessionGitIdentity = (
  requested: PartialGitIdentity,
  options: GitIdentityResolutionOptions
): GitIdentity => {
  // A GitHub no-reply address is the requester's best commit identity on a
  // github.com remote: it attributes the commit to the same account that opens
  // the pull request, and it is the only address accepted by an account that
  // keeps its email private and blocks command-line pushes (GH007). It is worth
  // nothing on any other host, so it never displaces Git configuration there.
  const githubNoreplyEmail = trimNonEmpty(options.githubNoreplyEmail);
  if (githubNoreplyEmail !== undefined) {
    const remotes = options.remotes ?? readGitRemotes(options.cwd);
    if (remotesTargetGitHub(remotes)) {
      return {
        name: normalizeName(trimNonEmpty(requested.name), githubNoreplyEmail),
        email: githubNoreplyEmail,
      };
    }
  }

  if (options.preferMachineIdentity) {
    const machineIdentity = options.machineIdentity ?? readHostDefaultGitIdentity(options.cwd);
    const machineEmail = trimNonEmpty(machineIdentity.email);
    if (isUsableEmail(machineEmail)) {
      return {
        name: normalizeName(trimNonEmpty(machineIdentity.name), machineEmail),
        email: machineEmail,
      };
    }
  }

  // Missing-email addresses are auth placeholders, not commit identities. A
  // non-owner must never fall back to the machine owner's Git configuration.
  const requestedEmail = trimNonEmpty(requested.email);
  if (isUsableEmail(requestedEmail)) {
    return {
      name: normalizeName(trimNonEmpty(requested.name), requestedEmail),
      email: requestedEmail,
    };
  }

  return {
    name: DEFAULT_AI_GIT_AUTHOR_NAME,
    email: DEFAULT_AI_GIT_AUTHOR_EMAIL,
  };
};
