import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_AI_GIT_AUTHOR_EMAIL,
  readHostDefaultGitIdentity,
  resolveSessionGitIdentity,
} from './git-identity';

const requester = { name: 'Requester', email: 'requester@example.com' };
const machine = { name: 'Owner Machine', email: 'owner@example.com' };

describe('resolveSessionGitIdentity', () => {
  it('lets a requester with personal identity enabled commit as themselves on their own machine', () => {
    expect(
      resolveSessionGitIdentity(requester, {
        preferMachineIdentity: true,
        personalIdentityEnabled: true,
        machineIdentity: machine,
      })
    ).toEqual(requester);
  });

  it('keeps the machine identity for the owner when personal identity is off', () => {
    expect(
      resolveSessionGitIdentity(requester, {
        preferMachineIdentity: true,
        personalIdentityEnabled: false,
        machineIdentity: machine,
      })
    ).toEqual(machine);
  });

  it('falls back to the machine identity when the personal account has no usable email', () => {
    expect(
      resolveSessionGitIdentity(
        { name: 'Requester', email: '' },
        { preferMachineIdentity: true, personalIdentityEnabled: true, machineIdentity: machine }
      )
    ).toEqual(machine);
  });

  it('never gives a non-owner the machine identity, even with personal identity off', () => {
    expect(
      resolveSessionGitIdentity(requester, {
        preferMachineIdentity: false,
        personalIdentityEnabled: false,
        machineIdentity: machine,
      })
    ).toEqual(requester);
    expect(
      resolveSessionGitIdentity(
        { name: 'x', email: '' },
        { preferMachineIdentity: false, machineIdentity: machine }
      ).email
    ).toBe(DEFAULT_AI_GIT_AUTHOR_EMAIL);
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
    process.env = { ...originalEnv, HOME: home, XDG_CONFIG_HOME: xdg };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_')) delete process.env[key];
    }
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.chdir(dir);
    execFileSync('git', ['init', '-q']);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
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
});
