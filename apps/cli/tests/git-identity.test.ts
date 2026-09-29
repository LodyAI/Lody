import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMissingEmail } from '@lody/shared';

import { runCommandText } from '../src/platform/promise-facade';
import {
  buildGitHubNoreplyEmail,
  DEFAULT_AI_GIT_AUTHOR_EMAIL,
  DEFAULT_AI_GIT_AUTHOR_NAME,
  readHostDefaultGitIdentity,
  resolveSessionGitIdentity,
} from '../src/session/git-identity';

describe('readHostDefaultGitIdentity', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reads the repository Git configuration when no Git identity is in the environment', async () => {
    for (const name of [
      'GIT_AUTHOR_NAME',
      'GIT_COMMITTER_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_EMAIL',
    ]) {
      vi.stubEnv(name, '');
    }
    const repo = mkdtempSync(path.join(os.tmpdir(), 'lody-git-identity-'));
    tempDirs.push(repo);
    const git = (...args: string[]) =>
      runCommandText({ command: 'git', args, cwd: repo, check: 'exit-0' });
    await git('init', '--quiet');
    await git('config', 'user.name', 'Repo User');
    await git('config', 'user.email', 'repo@example.com');

    expect(readHostDefaultGitIdentity(repo)).toEqual({
      name: 'Repo User',
      email: 'repo@example.com',
    });
  });
});

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
