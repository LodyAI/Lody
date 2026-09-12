import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMissingEmail } from '@lody/shared';

import {
  buildGitHubNoreplyEmail,
  DEFAULT_AI_GIT_AUTHOR_EMAIL,
  DEFAULT_AI_GIT_AUTHOR_NAME,
  parseGitRemoteHost,
  parseGitRemoteList,
  resolveSessionGitIdentity,
} from '../src/session/git-identity';

const NOREPLY = '4324+ada@users.noreply.github.com';
const GITHUB_HTTPS = [{ name: 'origin', url: 'https://github.com/LodyAI/Lody.git' }];
const GITHUB_SSH = [{ name: 'origin', url: 'git@github.com:LodyAI/Lody.git' }];
const GITLAB_HTTPS = [{ name: 'origin', url: 'https://gitlab.com/lody/lody.git' }];

describe('resolveSessionGitIdentity', () => {
  it('uses the machine identity first for the machine owner', () => {
    expect(
      resolveSessionGitIdentity(
        { name: 'Ada', email: 'ada@example.com' },
        {
          preferMachineIdentity: true,
          machineIdentity: { name: 'Local User', email: 'local@example.com' },
        }
      )
    ).toEqual({
      name: 'Local User',
      email: 'local@example.com',
    });
  });

  it('uses the Lody identity when the machine owner has no Git identity', () => {
    expect(
      resolveSessionGitIdentity(
        { name: 'Ada', email: 'ada@example.com' },
        { preferMachineIdentity: true, machineIdentity: {} }
      )
    ).toEqual({
      name: 'Ada',
      email: 'ada@example.com',
    });
  });

  it('uses the LodyAI identity when the machine owner has no usable identity', () => {
    expect(
      resolveSessionGitIdentity(
        { name: 'github-user', email: buildMissingEmail('github', '123') },
        { preferMachineIdentity: true, machineIdentity: {} }
      )
    ).toEqual({
      name: DEFAULT_AI_GIT_AUTHOR_NAME,
      email: DEFAULT_AI_GIT_AUTHOR_EMAIL,
    });
  });

  it('never uses the machine identity for a non-owner', () => {
    expect(
      resolveSessionGitIdentity(
        { name: 'Teammate', email: 'teammate@example.com' },
        {
          preferMachineIdentity: false,
          machineIdentity: { name: 'Machine Owner', email: 'owner@example.com' },
        }
      )
    ).toEqual({
      name: 'Teammate',
      email: 'teammate@example.com',
    });
  });

  it('falls back to the LodyAI identity for a non-owner without a usable identity', () => {
    expect(
      resolveSessionGitIdentity(
        { name: 'github-user', email: buildMissingEmail('github', '123') },
        {
          preferMachineIdentity: false,
          machineIdentity: { name: 'Machine Owner', email: 'owner@example.com' },
        }
      )
    ).toEqual({
      name: DEFAULT_AI_GIT_AUTHOR_NAME,
      email: DEFAULT_AI_GIT_AUTHOR_EMAIL,
    });
  });

  it('keeps a GitHub no-reply commit email over the host identity', () => {
    const noreply = buildGitHubNoreplyEmail('4324', 'ada');
    expect(
      resolveSessionGitIdentity(
        { name: 'Ada', email: noreply },
        {
          preferMachineIdentity: false,
          machineIdentity: { email: 'local@example.com' },
        }
      )
    ).toEqual({
      name: 'Ada',
      email: '4324+ada@users.noreply.github.com',
    });
  });
});

describe('resolveSessionGitIdentity with a GitHub no-reply address', () => {
  const requested = { name: 'Ada', email: 'ada@example.com' };

  it('commits as the no-reply address on an https github.com origin', () => {
    // Beats both the account email and the host Git identity: only this address
    // survives private-email push protection (GH007).
    expect(
      resolveSessionGitIdentity(requested, {
        preferMachineIdentity: true,
        machineIdentity: { name: 'Local User', email: 'local@example.com' },
        githubNoreplyEmail: NOREPLY,
        remotes: GITHUB_HTTPS,
      })
    ).toEqual({ name: 'Ada', email: NOREPLY });
  });

  it('commits as the no-reply address on an ssh github.com origin', () => {
    expect(
      resolveSessionGitIdentity(requested, {
        preferMachineIdentity: true,
        machineIdentity: { name: 'Local User', email: 'local@example.com' },
        githubNoreplyEmail: NOREPLY,
        remotes: GITHUB_SSH,
      })
    ).toEqual({ name: 'Ada', email: NOREPLY });
  });

  it('keeps the host Git identity on a gitlab.com origin', () => {
    expect(
      resolveSessionGitIdentity(requested, {
        preferMachineIdentity: true,
        machineIdentity: { name: 'Local User', email: 'local@example.com' },
        githubNoreplyEmail: NOREPLY,
        remotes: GITLAB_HTTPS,
      })
    ).toEqual({ name: 'Local User', email: 'local@example.com' });
  });

  it('keeps the host Git identity when the workdir has no remote', () => {
    expect(
      resolveSessionGitIdentity(requested, {
        preferMachineIdentity: true,
        machineIdentity: { name: 'Local User', email: 'local@example.com' },
        githubNoreplyEmail: NOREPLY,
        remotes: [],
      })
    ).toEqual({ name: 'Local User', email: 'local@example.com' });
  });

  it('never substitutes the no-reply address for the requester email off GitHub', () => {
    // A non-owner still cannot read machine config, so the account email is the
    // only remaining identity; the GitHub address would not attribute here.
    expect(
      resolveSessionGitIdentity(requested, {
        preferMachineIdentity: false,
        machineIdentity: { name: 'Machine Owner', email: 'owner@example.com' },
        githubNoreplyEmail: NOREPLY,
        remotes: GITLAB_HTTPS,
      })
    ).toEqual({ name: 'Ada', email: 'ada@example.com' });
  });

  it('falls back to the LodyAI identity off GitHub without a usable requester email', () => {
    expect(
      resolveSessionGitIdentity(
        { name: 'github-user', email: buildMissingEmail('github', '123') },
        {
          preferMachineIdentity: false,
          githubNoreplyEmail: NOREPLY,
          remotes: GITLAB_HTTPS,
        }
      )
    ).toEqual({ name: DEFAULT_AI_GIT_AUTHOR_NAME, email: DEFAULT_AI_GIT_AUTHOR_EMAIL });
  });

  it('ignores a GitHub mirror when origin points at another forge', () => {
    expect(
      resolveSessionGitIdentity(requested, {
        preferMachineIdentity: true,
        machineIdentity: { email: 'local@example.com' },
        githubNoreplyEmail: NOREPLY,
        remotes: [...GITLAB_HTTPS, { name: 'mirror', url: 'https://github.com/lody/lody.git' }],
      })
    ).toEqual({ name: 'local@example.com', email: 'local@example.com' });
  });

  it('uses a non-origin remote when the repository has no origin', () => {
    expect(
      resolveSessionGitIdentity(requested, {
        preferMachineIdentity: true,
        machineIdentity: { email: 'local@example.com' },
        githubNoreplyEmail: NOREPLY,
        remotes: [{ name: 'upstream', url: 'https://github.com/LodyAI/Lody.git' }],
      })
    ).toEqual({ name: 'Ada', email: NOREPLY });
  });

  it('does not treat a GitHub Enterprise host as github.com', () => {
    expect(
      resolveSessionGitIdentity(requested, {
        preferMachineIdentity: true,
        machineIdentity: { email: 'local@example.com' },
        githubNoreplyEmail: NOREPLY,
        remotes: [{ name: 'origin', url: 'https://github.acme.example/lody/lody.git' }],
      })
    ).toEqual({ name: 'local@example.com', email: 'local@example.com' });
  });

  it('keeps the existing fallback when the account has no usable GitHub identity', () => {
    expect(
      resolveSessionGitIdentity(requested, {
        preferMachineIdentity: false,
        githubNoreplyEmail: buildGitHubNoreplyEmail('4324', undefined),
        remotes: GITHUB_HTTPS,
      })
    ).toEqual({ name: 'Ada', email: 'ada@example.com' });
  });
});

describe('parseGitRemoteHost', () => {
  it.each([
    ['https://github.com/LodyAI/Lody.git', 'github.com'],
    ['https://x-access-token:ghs_secret@github.com/LodyAI/Lody.git', 'github.com'],
    ['git@github.com:LodyAI/Lody.git', 'github.com'],
    ['ssh://git@github.com/LodyAI/Lody.git', 'github.com'],
    ['ssh://git@github.com:22/LodyAI/Lody.git', 'github.com'],
    ['git://github.com/LodyAI/Lody.git', 'github.com'],
    ['https://GitHub.com/LodyAI/Lody.git', 'github.com'],
    ['git@gist.github.com:abc123.git', 'gist.github.com'],
    ['https://gitlab.com/lody/lody.git', 'gitlab.com'],
    ['git@ssh.github.com:LodyAI/Lody.git', 'ssh.github.com'],
  ])('reads the host of %s', (url, host) => {
    expect(parseGitRemoteHost(url)).toBe(host);
  });

  it('has no host for a local path or an empty value', () => {
    expect(parseGitRemoteHost('/srv/git/lody.git')).toBeUndefined();
    expect(parseGitRemoteHost('../sibling-repo')).toBeUndefined();
    expect(parseGitRemoteHost('   ')).toBeUndefined();
  });
});

describe('parseGitRemoteList', () => {
  it('prefers the push URL, which is the one GitHub can reject', () => {
    expect(
      parseGitRemoteList(
        [
          'origin\thttps://gitlab.com/lody/lody.git (fetch)',
          'origin\tgit@github.com:LodyAI/Lody.git (push)',
        ].join('\n')
      )
    ).toEqual([{ name: 'origin', url: 'git@github.com:LodyAI/Lody.git' }]);
  });

  it('keeps every remote and ignores blank lines', () => {
    expect(
      parseGitRemoteList(
        [
          'origin\thttps://github.com/LodyAI/Lody.git (fetch)',
          'origin\thttps://github.com/LodyAI/Lody.git (push)',
          '',
          'upstream\thttps://gitlab.com/lody/lody.git (fetch)',
          'upstream\thttps://gitlab.com/lody/lody.git (push)',
        ].join('\n')
      )
    ).toEqual([
      { name: 'origin', url: 'https://github.com/LodyAI/Lody.git' },
      { name: 'upstream', url: 'https://gitlab.com/lody/lody.git' },
    ]);
  });
});

describe('resolveSessionGitIdentity reading a real repository', () => {
  const repositories: string[] = [];

  const createRepository = (originUrl?: string, localEmail?: string): string => {
    const path = mkdtempSync(join(tmpdir(), 'lody-git-identity-'));
    repositories.push(path);
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: path, stdio: 'ignore', windowsHide: true });
    };
    git('init', '-q');
    if (originUrl) {
      git('remote', 'add', 'origin', originUrl);
    }
    if (localEmail) {
      git('config', 'user.email', localEmail);
      git('config', 'user.name', 'Local User');
    }
    return path;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    while (repositories.length > 0) {
      rmSync(repositories.pop() as string, { recursive: true, force: true });
    }
  });

  const withoutInheritedGitEnv = (): void => {
    // readHostDefaultGitIdentity prefers these over the repository config.
    for (const key of [
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
    ]) {
      vi.stubEnv(key, '');
    }
  };

  it('commits as the no-reply address in a repository cloned from GitHub over ssh', () => {
    withoutInheritedGitEnv();
    const cwd = createRepository('git@github.com:LodyAI/Lody.git', 'local@example.com');
    expect(
      resolveSessionGitIdentity(
        { name: 'Ada', email: 'ada@example.com' },
        { preferMachineIdentity: true, cwd, githubNoreplyEmail: NOREPLY }
      )
    ).toEqual({ name: 'Ada', email: NOREPLY });
  });

  it('commits with the repository Git config in a GitLab repository', () => {
    withoutInheritedGitEnv();
    const cwd = createRepository('https://gitlab.com/lody/lody.git', 'local@example.com');
    expect(
      resolveSessionGitIdentity(
        { name: 'Ada', email: 'ada@example.com' },
        { preferMachineIdentity: true, cwd, githubNoreplyEmail: NOREPLY }
      )
    ).toEqual({ name: 'Local User', email: 'local@example.com' });
  });

  it('commits with the repository Git config when there is no remote at all', () => {
    withoutInheritedGitEnv();
    const cwd = createRepository(undefined, 'local@example.com');
    expect(
      resolveSessionGitIdentity(
        { name: 'Ada', email: 'ada@example.com' },
        { preferMachineIdentity: true, cwd, githubNoreplyEmail: NOREPLY }
      )
    ).toEqual({ name: 'Local User', email: 'local@example.com' });
  });
});

describe('buildGitHubNoreplyEmail', () => {
  it('builds the canonical id+login attribution address', () => {
    expect(buildGitHubNoreplyEmail('1234567', 'ada')).toBe('1234567+ada@users.noreply.github.com');
  });

  it('trims surrounding whitespace', () => {
    expect(buildGitHubNoreplyEmail(' 1234567 ', ' ada ')).toBe(
      '1234567+ada@users.noreply.github.com'
    );
  });

  it('returns undefined without both a numeric account id and a login', () => {
    expect(buildGitHubNoreplyEmail('1234567', undefined)).toBeUndefined();
    expect(buildGitHubNoreplyEmail(undefined, 'ada')).toBeUndefined();
    expect(buildGitHubNoreplyEmail('', 'ada')).toBeUndefined();
    // A non-numeric id is not a GitHub account id; the address would not attribute.
    expect(buildGitHubNoreplyEmail('not-an-id', 'ada')).toBeUndefined();
  });
});
