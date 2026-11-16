import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toShared } from '@/platform/process-options';
import { isMissingEmail } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

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

/** Identity the machine owner's own Git setup provides for a session workdir. */
export type MachineGitIdentity = {
  /** What a plain `git commit` in the workdir would use: process env, then every config scope. */
  effective: PartialGitIdentity;
  /**
   * The effective name or email comes from repository/worktree config of a Lody-managed
   * shared clone. Agents can write that config, so it is not the owner's choice.
   */
  untrustedRepositoryIdentity: boolean;
  /**
   * The effective name or email comes from repository/worktree config the owner set (not a
   * Lody-managed shared clone). It is the most specific choice and wins over "Act as you".
   */
  repositoryIdentity: boolean;
  /** Process env and user-level config only, read lazily when the effective value is untrusted. */
  userLevel: () => PartialGitIdentity;
};

export type GitIdentityResolutionOptions = {
  /** Only machine-owner turns may use the machine's Git identity. */
  preferMachineIdentity: boolean;
  /**
   * The requester approved committing as themselves ("Act as you" for GitHub).
   * Their Lody identity then wins over local Git configuration.
   */
  personalIdentityEnabled?: boolean;
  /** Session workdir whose effective Git configuration the owner keeps. */
  workdir?: string;
  /** Injected machine identity; the default probes Git in `workdir`. */
  machine?: MachineGitIdentity;
};

/**
 * `inject: true` exports the identity as `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, which beats
 * every Git config scope. `inject: false` leaves resolution to Git, so repository,
 * conditional and user-level config keep working; `name`/`email` are then informational.
 */
export type SessionGitIdentity = GitIdentity & { inject: boolean };

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

// Git's config quoting differs from JSON (for example, it does not accept \r).
const quoteConfigPath = (value: string): string =>
  `"${value.replace(/[\\"\n\t\b]/g, (char) => {
    if (char === '\n') return '\\n';
    if (char === '\t') return '\\t';
    if (char === '\b') return '\\b';
    return `\\${char}`;
  })}"`;

// Only global identity is a host default; shared bare-repo config belongs to agents.
const readGitConfig = (key: 'user.name' | 'user.email', cwd?: string): string | undefined => {
  try {
    let configDir: string | undefined;
    try {
      let source = ['--global'];
      const home = process.env.HOME;
      if (process.env.GIT_CONFIG_GLOBAL === undefined && home) {
        // --global selects one file, but ordinary Git reads XDG before ~/.gitconfig.
        // Let Git resolve includes and precedence without querying repository config.
        // A real file, rather than stdin, lets hasconfig conditions rescan the input.
        const paths = [
          path.resolve(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'git/config'),
          path.resolve(home, '.gitconfig'),
        ];
        configDir = mkdtempSync(path.join(tmpdir(), 'lody-git-identity-'));
        const configFile = path.join(configDir, 'config');
        writeFileSync(
          configFile,
          paths.map((file) => `[include]\npath = ${quoteConfigPath(file)}\n`).join('')
        );
        source = ['--file', configFile];
      }
      const { stdout } = runCommandTextSyncLegacy(
        {
          command: 'git',
          args: ['config', ...source, '--includes', '--get', key],
          cwd,
          timeout: GIT_CONFIG_TIMEOUT_MS,
          check: 'exit-0',
        },
        toShared()
      );
      return trimNonEmpty(stdout);
    } finally {
      if (configDir) rmSync(configDir, { recursive: true, force: true });
    }
  } catch {
    return undefined;
  }
};

const envIdentity = (): PartialGitIdentity => ({
  name: trimNonEmpty(process.env.GIT_AUTHOR_NAME) ?? trimNonEmpty(process.env.GIT_COMMITTER_NAME),
  email:
    trimNonEmpty(process.env.GIT_AUTHOR_EMAIL) ?? trimNonEmpty(process.env.GIT_COMMITTER_EMAIL),
});

/** Process env and user-level (global/XDG) config, never repository config. */
export const readHostDefaultGitIdentity = (cwd?: string): PartialGitIdentity => {
  const env = envIdentity();
  return {
    name: env.name ?? readGitConfig('user.name', cwd),
    email: env.email ?? readGitConfig('user.email', cwd),
  };
};

const REPOSITORY_SCOPES = new Set(['local', 'worktree']);

type ScopedValue = { value: string; scope: string };

/** `git config --show-scope --get-regexp`: the last value of each key wins, as in Git. */
const readEffectiveGitConfigIdentity = (
  workdir: string
): { name?: ScopedValue; email?: ScopedValue } => {
  const result: { name?: ScopedValue; email?: ScopedValue } = {};
  let stdout: string;
  try {
    stdout = runCommandTextSyncLegacy(
      {
        command: 'git',
        args: ['config', '--includes', '--show-scope', '--get-regexp', '^user\\.(name|email)$'],
        cwd: workdir,
        timeout: GIT_CONFIG_TIMEOUT_MS,
        check: 'exit-0',
      },
      toShared()
    ).stdout;
  } catch {
    return result;
  }
  for (const line of stdout.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const scope = line.slice(0, tab);
    const entry = line.slice(tab + 1);
    const space = entry.indexOf(' ');
    const key = (space < 0 ? entry : entry.slice(0, space)).toLowerCase();
    const value = trimNonEmpty(space < 0 ? '' : entry.slice(space + 1));
    const field = key === 'user.name' ? 'name' : key === 'user.email' ? 'email' : undefined;
    if (!field) continue;
    if (value === undefined) delete result[field];
    else result[field] = { value, scope };
  }
  return result;
};

const realpathOrResolve = (target: string): string => {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};

/** GitHub projects share `<data dir>/repos/<repoId>/bare.git`, written by every agent on it. */
const isLodyManagedSharedClone = (workdir: string): boolean => {
  try {
    const { stdout } = runCommandTextSyncLegacy(
      {
        command: 'git',
        args: ['rev-parse', '--git-common-dir'],
        cwd: workdir,
        timeout: GIT_CONFIG_TIMEOUT_MS,
        check: 'exit-0',
      },
      toShared()
    );
    const commonDir = trimNonEmpty(stdout);
    if (!commonDir) return false;
    const resolved = realpathOrResolve(path.resolve(workdir, commonDir));
    return (
      path.basename(resolved) === 'bare.git' &&
      path.dirname(path.dirname(resolved)) ===
        realpathOrResolve(path.join(getLodyDataDir(), 'repos'))
    );
  } catch {
    return false;
  }
};

/**
 * Probe what Git would use in `workdir`. Repository config is the owner's choice for
 * local projects and their worktrees, but not for Lody's shared GitHub clones.
 */
export const probeMachineGitIdentity = (workdir: string): MachineGitIdentity => {
  const env = envIdentity();
  const configured = env.name && env.email ? undefined : readEffectiveGitConfigIdentity(workdir);
  const name = env.name ? undefined : configured?.name;
  const email = env.email ? undefined : configured?.email;
  const repositoryScoped =
    (name !== undefined && REPOSITORY_SCOPES.has(name.scope)) ||
    (email !== undefined && REPOSITORY_SCOPES.has(email.scope));
  const untrusted = repositoryScoped && isLodyManagedSharedClone(workdir);
  return {
    effective: { name: env.name ?? name?.value, email: env.email ?? email?.value },
    untrustedRepositoryIdentity: untrusted,
    repositoryIdentity: repositoryScoped && !untrusted,
    userLevel: () => readHostDefaultGitIdentity(workdir),
  };
};

const NEUTRAL_IDENTITY: SessionGitIdentity = {
  name: DEFAULT_AI_GIT_AUTHOR_NAME,
  email: DEFAULT_AI_GIT_AUTHOR_EMAIL,
  inject: true,
};

const usableIdentity = (identity: PartialGitIdentity): GitIdentity | undefined => {
  const email = trimNonEmpty(identity.email);
  if (!isUsableEmail(email)) return undefined;
  return { name: normalizeName(trimNonEmpty(identity.name), email), email };
};

const resolveMachineIdentity = (machine: MachineGitIdentity): SessionGitIdentity | undefined => {
  if (!machine.untrustedRepositoryIdentity) {
    const effective = usableIdentity(machine.effective);
    if (!effective) return undefined;
    // Without a configured name Git would guess one from the OS account; keep the
    // previous email-as-name rule instead, which needs the environment.
    const nameConfigured = trimNonEmpty(machine.effective.name) === effective.name;
    return { ...effective, inject: !nameConfigured };
  }
  const userLevel = usableIdentity(machine.userLevel());
  return userLevel ? { ...userLevel, inject: true } : undefined;
};

/**
 * Commit identity precedence:
 * 1. for the machine owner, an identity configured in the workdir's own repository;
 * 2. the requester's own identity, only when they approved it ("Act as you");
 * 3. for the machine owner, whatever else Git resolves in the workdir (left to Git itself);
 * 4. the neutral LodyAI identity.
 * A non-owner never reaches the machine's identity, and an unapproved requester's account
 * email never enters a commit.
 */
export const resolveSessionGitIdentity = (
  requested: PartialGitIdentity,
  options: GitIdentityResolutionOptions
): SessionGitIdentity => {
  const machine = options.preferMachineIdentity
    ? (options.machine ??
      (options.workdir !== undefined
        ? probeMachineGitIdentity(options.workdir)
        : {
            effective: readHostDefaultGitIdentity(),
            untrustedRepositoryIdentity: false,
            repositoryIdentity: false,
            userLevel: () => readHostDefaultGitIdentity(),
          }))
    : undefined;
  const machineIdentity = machine ? resolveMachineIdentity(machine) : undefined;
  if (machine?.repositoryIdentity && machineIdentity) return machineIdentity;

  // Missing-email addresses are auth placeholders, not commit identities.
  const requestedIdentity = usableIdentity(requested);
  if (options.personalIdentityEnabled && requestedIdentity) {
    return { ...requestedIdentity, inject: true };
  }

  return machineIdentity ?? NEUTRAL_IDENTITY;
};
