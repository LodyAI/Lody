import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureGhShimScript,
  getGhShimHostBinDir,
  getGhShimHostPath,
} from '../src/lib/gh-shim-script';

let directory: string;
let statePath: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-gh-policy-'));
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
  vi.stubEnv('LODY_DATA_DIR', directory);
  statePath = path.join(directory, 'workspace-broker.json');
  ensureGhShimScript(statePath);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function harness(
  options: {
    owner?: boolean;
    personal?: boolean;
    env?: Record<string, string>;
    localToken?: string;
    remote?: string;
    status?: number;
    permissions?: { push?: boolean; admin?: boolean };
  } = {}
) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const actual: Array<string[]> = [];
  const spawn = vi.fn((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      let status = 0;
      if (args[0] === 'remote')
        child.stdout.emit('data', options.remote ?? 'git@github.com:cwd/project.git');
      else if (args[0] === 'auth' && args[1] === 'token') {
        if (options.localToken) child.stdout.emit('data', options.localToken);
        else status = 1;
      } else actual.push(args);
      child.emit('close', status);
    });
    return child;
  });
  const fetch = vi.fn(async (url: string, init: { body?: string }) => {
    if (url.startsWith('https://api.github.com/'))
      return {
        ok: (options.status ?? 200) === 200,
        status: options.status ?? 200,
        json: async () => ({ permissions: options.permissions ?? { push: false } }),
      };
    const endpoint = new URL(url).pathname;
    const body = JSON.parse(init.body ?? '{}');
    calls.push({ path: endpoint, body });
    if (endpoint === '/github-auth-context')
      return {
        ok: true,
        json: async () => ({
          allowLocalAuth: options.owner ?? true,
          personalEnabled: options.personal ?? false,
        }),
      };
    return {
      ok: true,
      json: async () => ({
        token: body.source + ':' + body.repoFullName,
        tokenSource: body.source,
        available: true,
      }),
    };
  });
  const source = fs
    .readFileSync(getGhShimHostPath(statePath), 'utf8')
    .replace(/main\(\)\.catch\([\s\S]*$/, 'globalThis.build = buildGhEnv;');
  const context = vm.createContext({
    require: (name: string) => {
      if (name === 'child_process') return { spawn };
      if (name === 'fs')
        return {
          ...fs,
          accessSync: () => {},
          statSync: () => ({ isFile: () => true }),
          realpathSync: { native: (p: string) => p },
          readFileSync: (p: string) => {
            if (p !== statePath) throw new Error('Wrong workspace broker');
            return JSON.stringify({ url: 'http://broker.test', token: 'bearer' });
          },
        };
      return { path, crypto, os }[name as 'path' | 'crypto' | 'os'];
    },
    __filename: getGhShimHostPath(statePath),
    process: {
      env: {
        PATH: '/native/bin',
        LODY_GIT_CRED_CONTEXT_TOKEN: 'requester',
        LODY_GITHUB_REPO_FULL_NAME: 'startup/repo',
        ...options.env,
      },
      platform: 'linux',
      on: vi.fn(),
    },
    console: { error: vi.fn() },
    fetch,
    URL,
    AbortSignal,
    AbortController,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context);
  return {
    calls,
    actual,
    spawn,
    build: (args: string[]) =>
      (
        context.build as (
          command: string,
          args: string[]
        ) => Promise<{ env: Record<string, string> }>
      )('/native/bin/gh', args),
  };
}

describe('generated gh command boundary', () => {
  it('generates syntactically valid standalone gh and Git transports', () => {
    for (const command of ['gh', 'git', 'git-remote-lody-github'])
      expect(
        () =>
          new vm.Script(fs.readFileSync(path.join(getGhShimHostBinDir(statePath), command), 'utf8'))
      ).not.toThrow();
  });
  it.each([
    { args: ['pr', 'view', '1', '-R', 'other/repo'], repo: 'other/repo' },
    { args: ['pr', 'view', 'https://github.com/url/repo/pull/1'], repo: 'url/repo' },
    { args: ['pr', 'view', '1'], repo: 'cwd/project' },
    { args: ['api', 'repos/api/repo/pulls'], repo: 'api/repo' },
    { args: ['repo', 'clone', 'clone/repo'], repo: 'clone/repo' },
  ])('uses actual target $repo rather than startup repo', async ({ args, repo }) => {
    const h = harness({ owner: false });
    expect((await h.build(args)).env.GH_TOKEN).toBe('app:' + repo);
    expect(
      h.calls.filter((c) => c.path === '/github-token').map((c) => c.body.repoFullName)
    ).toEqual([repo]);
  });
  it('honors GH_REPO ahead of current directory', async () => {
    const h = harness({ owner: false, env: { GH_REPO: 'env/repo' } });
    expect((await h.build(['pr', 'list'])).env.GH_TOKEN).toBe('app:env/repo');
  });
  it('owner uses local before App', async () => {
    const h = harness({ localToken: 'local' });
    expect((await h.build(['pr', 'list'])).env.GH_TOKEN).toBe('local');
    expect(h.calls.map((c) => c.path)).toEqual(['/github-auth-context']);
  });
  it.each([
    ['pr', 'merge', '1'],
    ['release', 'create', 'v1'],
    ['workflow', 'run', 'build.yml'],
    ['run', 'rerun', '123'],
  ])('preflights required push permission for %s %s without executing a write', async (...args) => {
    const h = harness({ localToken: 'read-only' });
    expect((await h.build(args)).env.GH_TOKEN).toBe('app:cwd/project');
    expect(h.actual).toEqual([]);
  });
  it('keeps owner credentials when a write preflight confirms push access', async () => {
    const h = harness({ localToken: 'writer', permissions: { push: true } });
    expect((await h.build(['-R', 'other/repo', 'pr', 'merge', '1'])).env.GH_TOKEN).toBe('writer');
  });
  it('uses admin rather than push capability for repository administration', async () => {
    const h = harness({ localToken: 'writer', permissions: { push: true, admin: false } });
    expect((await h.build(['repo', 'archive', 'other/repo'])).env.GH_TOKEN).toBe('app:other/repo');
  });
  it.each([
    { flags: ['--disable-auto'], token: 'local' },
    { flags: ['--disable-auto=true'], token: 'local' },
    { flags: ['--disable-auto=false'], token: 'app:cwd/project' },
    { flags: ['--disable-auto', '--disable-auto=false'], token: 'app:cwd/project' },
    { flags: ['--body', '--disable-auto'], token: 'app:cwd/project' },
  ])('uses parsed disable-auto semantics: $flags', async ({ flags, token }) => {
    const h = harness({ localToken: 'local' });
    expect((await h.build(['pr', 'merge', '1', ...flags])).env.GH_TOKEN).toBe(token);
  });
  it.each([
    ['pr', 'update-branch', '1'],
    ['repo', 'edit', '--description', 'test'],
  ])('does not demand base push or admin for %s %s', async (...args) => {
    const h = harness({ localToken: 'local', permissions: { push: false, admin: false } });
    expect((await h.build(args)).env.GH_TOKEN).toBe('local');
  });
  it('does not reinterpret a comment body as a write command', async () => {
    const h = harness({ localToken: 'reader' });
    expect(
      (await h.build(['pr', '--repo', 'other/repo', 'comment', '1', '--body', 'merge'])).env
        .GH_TOKEN
    ).toBe('reader');
  });
  it('personal overrides ambient tokens and local login even without push permission', async () => {
    const h = harness({ personal: true, localToken: 'local', env: { GH_TOKEN: 'ambient' } });
    expect((await h.build(['pr', 'comment', '1'])).env.GH_TOKEN).toBe('personal:cwd/project');
    expect(h.spawn.mock.calls.some((call) => call[1][0] === 'auth')).toBe(false);
  });
  it('nonowner never reads local credentials', async () => {
    const h = harness({ owner: false, localToken: 'local', env: { GH_TOKEN: 'owner-secret' } });
    expect((await h.build(['pr', 'list'])).env.GH_TOKEN).toBe('app:cwd/project');
    expect(h.spawn.mock.calls.some((call) => call[1][0] === 'auth')).toBe(false);
  });
  it('does not switch identity or execute the operation on a 403', async () => {
    const h = harness({ personal: true, status: 403 });
    await expect(h.build(['pr', 'comment', '1'])).rejects.toThrow('identity was not changed');
    expect(h.calls.filter((c) => c.path === '/github-token').map((c) => c.body.source)).toEqual([
      'personal',
    ]);
    expect(h.actual).toEqual([]);
  });
  it('does not send App credentials to an enterprise host', async () => {
    const h = harness({ owner: false });
    await expect(
      h.build(['pr', 'view', 'https://github.example.com/o/r/pull/1'])
    ).rejects.toThrow();
    expect(h.calls.filter((c) => c.path === '/github-token')).toEqual([]);
  });
  it('unknown targets cannot bypass personal priority', async () => {
    const h = harness({ personal: true, localToken: 'local' });
    await expect(h.build(['some-extension', 'write'])).rejects.toThrow(
      'separately authenticated terminal'
    );
  });
});
