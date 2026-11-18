import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_AI_GIT_AUTHOR_EMAIL,
  probeMachineGitIdentity,
  readHostDefaultGitIdentity,
  resolveSessionGitIdentity,
} from './git-identity';

const requester = { name: 'Requester', email: 'requester@example.com' };
const machine = { name: 'Owner Machine', email: 'owner@example.com' };

const machineSource = (
  effective: { name?: string; email?: string },
  options: {
    untrusted?: boolean;
    repository?: boolean;
    userLevel?: { name?: string; email?: string };
  } = {}
) => ({
  effective,
  untrustedRepositoryIdentity: options.untrusted ?? false,
  repositoryIdentity: options.repository ?? false,
  userLevel: () => options.userLevel ?? {},
});
const neutral = { name: 'LodyAI', email: DEFAULT_AI_GIT_AUTHOR_EMAIL, inject: true };

describe('resolveSessionGitIdentity', () => {
  it('exports an approved requester identity over the owner machine configuration', () => {
    expect(
      resolveSessionGitIdentity(requester, {
        preferMachineIdentity: true,
        personalIdentityEnabled: true,
        machine: machineSource(machine),
      })
    ).toEqual({ ...requester, inject: true });
  });

  it('lets the owner repository identity win over an approved account identity', () => {
    const repository = machineSource(machine, { repository: true });
    expect(
      resolveSessionGitIdentity(requester, {
        preferMachineIdentity: true,
        personalIdentityEnabled: true,
        machine: repository,
      })
    ).toEqual({ ...machine, inject: false });
    // The owner's repository config never applies to someone else's turn.
    expect(
      resolveSessionGitIdentity(requester, {
        preferMachineIdentity: false,
        personalIdentityEnabled: true,
        machine: repository,
      })
    ).toEqual({ ...requester, inject: true });
  });

  it('leaves the owner identity to Git instead of overriding repository config', () => {
    expect(
      resolveSessionGitIdentity(requester, {
        preferMachineIdentity: true,
        personalIdentityEnabled: false,
        machine: machineSource(machine),
      })
    ).toEqual({ ...machine, inject: false });
  });

  it('exports the email as name when the owner configured only an email', () => {
    expect(
      resolveSessionGitIdentity(requester, {
        preferMachineIdentity: true,
        machine: machineSource({ email: machine.email }),
      })
    ).toEqual({ name: machine.email, email: machine.email, inject: true });
  });

  it('replaces agent-writable shared-clone identity with the user-level identity', () => {
    const polluted = machineSource(
      { name: 'Fixture', email: 'fixture@example.com' },
      { untrusted: true, userLevel: machine }
    );
    expect(
      resolveSessionGitIdentity(requester, { preferMachineIdentity: true, machine: polluted })
    ).toEqual({ ...machine, inject: true });
    expect(
      resolveSessionGitIdentity(requester, {
        preferMachineIdentity: true,
        machine: machineSource(
          { email: 'fixture@example.com' },
          { untrusted: true, userLevel: {} }
        ),
      })
    ).toEqual(neutral);
  });

  it('falls back to the owner machine when the approved account has no usable email', () => {
    expect(
      resolveSessionGitIdentity(
        { name: 'Requester', email: '' },
        {
          preferMachineIdentity: true,
          personalIdentityEnabled: true,
          machine: machineSource(machine),
        }
      )
    ).toEqual({ ...machine, inject: false });
  });

  it('exports LodyAI when the owner has no Git identity', () => {
    expect(
      resolveSessionGitIdentity(requester, {
        preferMachineIdentity: true,
        machine: machineSource({}),
      })
    ).toEqual(neutral);
  });

  it('never gives a non-owner the machine identity or an unapproved account email', () => {
    expect(
      resolveSessionGitIdentity(requester, {
        preferMachineIdentity: false,
        personalIdentityEnabled: false,
        machine: machineSource(machine),
      })
    ).toEqual(neutral);
    expect(
      resolveSessionGitIdentity(requester, {
        preferMachineIdentity: false,
        personalIdentityEnabled: true,
        machine: machineSource(machine),
      })
    ).toEqual({ ...requester, inject: true });
    expect(
      resolveSessionGitIdentity(
        { name: 'x', email: '' },
        {
          preferMachineIdentity: false,
          personalIdentityEnabled: true,
          machine: machineSource(machine),
        }
      )
    ).toEqual(neutral);
  });
});

describe('readHostDefaultGitIdentity', () => {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  let dir: string;
  let home: string;
  let xdg: string;

  const writeConfig = (file: string, contents: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  };
  const identityConfig = (name: string, email: string) =>
    `[user]\nname = ${name}\nemail = ${email}\n`;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lody-git-identity-'));
    home = path.join(dir, process.platform === 'win32' ? 'home with space' : 'home "quoted"');
    xdg = path.join(home, '.config');
    mkdirSync(xdg, { recursive: true });
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = xdg;
    for (const key of Object.keys(process.env)) {
      if (/^(GIT_|LODY_GIT_|SSH_)/.test(key)) delete process.env[key];
    }
    // These fixtures exercise native host config, independently of a surrounding
    // Lody session's credential wrapper and its frozen identity context.
    process.env.LODY_GIT_NATIVE = '1';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.chdir(dir);
    execFileSync('git', ['init', '-q']);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads XDG identity beside an unrelated .gitconfig and keeps per-key precedence', () => {
    writeConfig(path.join(xdg, 'git/config'), identityConfig(machine.name, machine.email));
    writeConfig(path.join(home, '.gitconfig'), '[credential]\nhelper = store\n');
    expect(readHostDefaultGitIdentity()).toEqual(machine);

    writeConfig(path.join(home, '.gitconfig'), '[user]\nname = Home Owner\n');
    expect(readHostDefaultGitIdentity()).toEqual({ name: 'Home Owner', email: machine.email });
    writeConfig(path.join(home, '.gitconfig'), '[user]\nemail = ""\n');
    expect(readHostDefaultGitIdentity().email).toBeUndefined();
  });

  it('uses the default XDG location and evaluates relative and conditional includes', () => {
    delete process.env.XDG_CONFIG_HOME;
    writeConfig(path.join(xdg, 'git/config'), '[include]\npath = identity\n');
    writeConfig(path.join(xdg, 'git/identity'), identityConfig(machine.name, machine.email));
    writeConfig(path.join(home, 'branch-identity'), '[user]\nname = Branch Owner\n');
    writeConfig(path.join(home, 'remote-identity'), '[user]\nemail = remote@example.com\n');
    writeConfig(
      path.join(home, '.gitconfig'),
      '[includeIf "onbranch:identity-test"]\npath = branch-identity\n' +
        '[includeIf "hasconfig:remote.*.url:https://example.invalid/owner/**"]\n' +
        'path = remote-identity\n[remote "owner"]\nurl = https://example.invalid/owner/repo\n'
    );
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/identity-test']);
    expect(readHostDefaultGitIdentity()).toEqual({
      name: 'Branch Owner',
      email: 'remote@example.com',
    });
  });

  it('honors an explicit relative global override without falling back to the home files', () => {
    writeConfig(path.join(xdg, 'git/config'), identityConfig(machine.name, machine.email));
    writeConfig(path.join(home, '.gitconfig'), identityConfig(machine.name, machine.email));
    process.env.GIT_CONFIG_GLOBAL = 'chosen config';
    writeConfig(path.join(dir, 'chosen config'), identityConfig(requester.name, requester.email));
    expect(
      execFileSync('git', ['config', '--global', '--get', 'user.name'], { encoding: 'utf8' }).trim()
    ).toBe(requester.name);
    expect(readHostDefaultGitIdentity()).toEqual(requester);

    process.env.GIT_CONFIG_GLOBAL = '';
    expect(readHostDefaultGitIdentity()).toEqual({ name: undefined, email: undefined });
  });

  it('does not reinterpret an empty HOME as the repository directory', () => {
    process.env.HOME = '';
    delete process.env.XDG_CONFIG_HOME;
    writeConfig(path.join(dir, '.gitconfig'), identityConfig(requester.name, requester.email));
    const identity = readHostDefaultGitIdentity();
    expect(identity.name).not.toBe(requester.name);
    expect(identity.email).not.toBe(requester.email);
  });

  it('preserves author then committer environment precedence', () => {
    writeConfig(path.join(xdg, 'git/config'), identityConfig(machine.name, machine.email));
    process.env.GIT_COMMITTER_NAME = 'Committer';
    process.env.GIT_COMMITTER_EMAIL = 'committer@example.com';
    process.env.GIT_AUTHOR_NAME = 'Author';
    process.env.GIT_AUTHOR_EMAIL = 'author@example.com';
    expect(readHostDefaultGitIdentity()).toEqual({ name: 'Author', email: 'author@example.com' });
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    expect(readHostDefaultGitIdentity()).toEqual({
      name: 'Committer',
      email: 'committer@example.com',
    });
  });

  it('ignores repository and injected command config, and fails closed on malformed host config', () => {
    execFileSync('git', ['config', 'user.name', 'Repo User']);
    execFileSync('git', ['config', 'user.email', 'repo@example.com']);
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'user.email';
    process.env.GIT_CONFIG_VALUE_0 = 'command@example.com';
    expect(readHostDefaultGitIdentity()).toEqual({ name: undefined, email: undefined });

    writeConfig(path.join(xdg, 'git/config'), identityConfig(machine.name, machine.email));
    writeConfig(path.join(home, '.gitconfig'), '[invalid');
    expect(readHostDefaultGitIdentity()).toEqual({ name: undefined, email: undefined });
  });

  it('keeps repository and conditional identity of an owner project native to Git', () => {
    writeConfig(path.join(xdg, 'git/config'), identityConfig(machine.name, machine.email));
    execFileSync('git', ['config', 'user.email', 'repo@example.com']);
    const probed = probeMachineGitIdentity(dir);
    expect(probed.effective).toEqual({ name: machine.name, email: 'repo@example.com' });
    expect(probed.untrustedRepositoryIdentity).toBe(false);
    expect(probed.repositoryIdentity).toBe(true);
    expect(
      resolveSessionGitIdentity(requester, {
        preferMachineIdentity: true,
        personalIdentityEnabled: true,
        workdir: dir,
      })
    ).toEqual({ name: machine.name, email: 'repo@example.com', inject: false });
    expect(
      resolveSessionGitIdentity(requester, { preferMachineIdentity: true, workdir: dir })
    ).toEqual({ name: machine.name, email: 'repo@example.com', inject: false });

    execFileSync('git', ['config', '--unset', 'user.email']);
    writeConfig(path.join(home, 'work-identity'), '[user]\nemail = work@example.com\n');
    // Git can discover the repository through the real path (macOS /var is a symlink).
    const gitdir = realpathSync(dir).split(path.sep).join('/').replaceAll('"', '\\"');
    writeConfig(
      path.join(home, '.gitconfig'),
      `[includeIf "gitdir:${gitdir}/"]\npath = work-identity\n`
    );
    expect(probeMachineGitIdentity(dir).effective.email).toBe('work@example.com');
  });

  it('distrusts repository identity only in a Lody-managed shared clone', () => {
    writeConfig(path.join(xdg, 'git/config'), identityConfig(machine.name, machine.email));
    process.env.LODY_DATA_DIR = path.join(dir, 'data');
    const bare = path.join(dir, 'data/repos/owner-repo/bare.git');
    const worktree = path.join(dir, 'data/repos/owner-repo/worktrees/session');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['-C', bare, 'config', 'user.email', 'fixture@example.com']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'base'], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
    execFileSync('git', ['-C', dir, 'push', '-q', bare, 'HEAD:refs/heads/main']);
    execFileSync('git', ['-C', bare, 'worktree', 'add', '-q', worktree, 'main']);

    expect(probeMachineGitIdentity(worktree)).toMatchObject({
      untrustedRepositoryIdentity: true,
      repositoryIdentity: false,
    });
    expect(
      resolveSessionGitIdentity(requester, { preferMachineIdentity: true, workdir: worktree })
    ).toEqual({ ...machine, inject: true });

    execFileSync('git', ['-C', bare, 'config', '--unset', 'user.email']);
    expect(
      resolveSessionGitIdentity(requester, { preferMachineIdentity: true, workdir: worktree })
    ).toEqual({ ...machine, inject: false });
  });
});
