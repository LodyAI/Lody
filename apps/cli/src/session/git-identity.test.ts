import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  let dir: string | undefined;

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('ignores repository-level user config (shared across Lody worktrees)', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lody-git-identity-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    process.chdir(dir);
    for (const key of [
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
    ])
      delete process.env[key];

    const identity = readHostDefaultGitIdentity();
    expect(identity.name).not.toBe('Test User');
    expect(identity.email).not.toBe('test@example.com');
  });
});
