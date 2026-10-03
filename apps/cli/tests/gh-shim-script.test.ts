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
    policyFailures?: number;
    executions?: Array<{ code: number; stderr?: string; stdout?: string }>;
  } = {}
) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let policyFailures = options.policyFailures ?? 0;
  const actual: Array<string[]> = [];
  const identities: string[] = [];
  const spawn = vi.fn((_command: string, args: string[], init: { env: Record<string, string> }) => {
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
      } else {
        const result = options.executions?.[actual.length];
        actual.push(args);
        identities.push(init.env.GH_TOKEN);
        if (result) {
          status = result.code;
          if (result.stderr) child.stderr.emit('data', result.stderr);
          if (result.stdout) child.stdout.emit('data', result.stdout);
        }
      }
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
    if (endpoint === '/github-auth-context' && policyFailures-- > 0)
      return { ok: false, status: 503, json: async () => ({ error: 'policy_unavailable' }) };
    if (endpoint === '/github-auth-context')
      return {
        ok: true,
        json: async () => ({
          allowLocalAuth: options.owner ?? true,
          personalEnabled: options.personal ?? false,
        }),
      };
    if (body.source === 'personal' && !options.personal)
      return { ok: true, json: async () => ({ available: false }) };
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
    .replace(
      /main\(\)\.catch\([\s\S]*$/,
      'globalThis.build = async (...args) => (await ghEnvironments(...args).next()).value; globalThis.execute = main;'
    );
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
            if (p === statePath + '.contexts/context.json')
              return JSON.stringify({
                version: 1,
                contextToken: 'context',
                allowLocalAuth: options.owner ?? true,
              });
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
        LODY_GIT_CRED_CONTEXT_TOKEN: 'context',
        LODY_GITHUB_REPO_FULL_NAME: 'startup/repo',
        ...options.env,
      },
      argv: ['node', '/shim/gh'],
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
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
    identities,
    execute: async (args: string[]) => {
      context.process.argv = ['node', '/shim/gh', ...args];
      await (context.execute as () => Promise<void>)();
      return context.process.exitCode ?? 0;
    },
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
  it('advances a definitively rejected single REST write to local without retrying personal', async () => {
    const h = harness({
      personal: true,
      localToken: 'native-token',
      executions: [
        { code: 1, stderr: 'HTTP 403: Forbidden' },
        { code: 0, stdout: 'created' },
      ],
    });
    expect(await h.execute(['api', 'repos/owner/repo/issues', '-X', 'POST'])).toBe(0);
    expect(h.identities).toEqual(['personal:owner/repo', 'native-token']);
  });
  it('advances a failed read-only repository command without replaying a source', async () => {
    const h = harness({
      personal: true,
      localToken: 'native-token',
      executions: [
        { code: 1, stderr: 'HTTP 403: Forbidden' },
        { code: 0, stdout: 'pull request' },
      ],
    });
    expect(await h.execute(['pr', 'view', '1', '-R', 'owner/repo'])).toBe(0);
    expect(h.identities).toEqual(['personal:owner/repo', 'native-token']);
  });
  it.each(['HTTP 403: Forbidden', 'connection reset'])(
    'never replays a compound write after %s',
    async (stderr) => {
      const h = harness({
        personal: true,
        localToken: 'native-token',
        executions: [{ code: 1, stderr }],
      });
      expect(await h.execute(['pr', 'merge', '1', '-R', 'owner/repo'])).toBe(1);
      expect(h.identities).toEqual(['personal:owner/repo']);
    }
  );
  it('does not replay a REST request after partial output', async () => {
    const h = harness({
      personal: true,
      executions: [{ code: 1, stdout: 'partial', stderr: 'HTTP 403: Forbidden' }],
    });
    expect(await h.execute(['api', 'repos/owner/repo'])).toBe(1);
    expect(h.identities).toEqual(['personal:owner/repo']);
  });
  it('selects personal without querying cloud policy or executing the write', async () => {
    const h = harness({ personal: true, localToken: 'owner-token' });
    expect((await h.build(['pr', 'merge', '1', '-R', 'other/repo'])).env.GH_TOKEN).toBe(
      'personal:other/repo'
    );
    expect(h.actual).toEqual([]);
    expect(h.calls.map((call) => call.path)).toEqual(['/github-token']);
  });
  it('generates syntactically valid standalone gh and Git transports', () => {
    for (const command of ['gh', 'git', 'git-remote-https'])
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
    ).toEqual([repo, repo]);
  });
  it('honors GH_REPO ahead of current directory', async () => {
    const h = harness({ owner: false, env: { GH_REPO: 'env/repo' } });
    expect((await h.build(['pr', 'list'])).env.GH_TOKEN).toBe('app:env/repo');
  });
  it('owner uses local before App', async () => {
    const h = harness({ localToken: 'local' });
    expect((await h.build(['pr', 'list'])).env.GH_TOKEN).toBe('local');
    expect(h.calls.map((c) => c.path)).toEqual(['/github-token']);
  });
  it('does not preflight permissions before a write', async () => {
    const h = harness({ localToken: 'read-only', permissions: { push: false } });
    expect((await h.build(['pr', 'merge', '1'])).env.GH_TOKEN).toBe('read-only');
    expect(h.actual).toEqual([]);
    expect(h.calls.map((call) => call.path)).toEqual(['/github-token']);
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
  it('does not send App credentials to an enterprise host', async () => {
    const h = harness({ owner: false });
    await expect(
      h.build(['pr', 'view', 'https://github.example.com/o/r/pull/1'])
    ).rejects.toThrow();
    expect(h.calls.filter((c) => c.path === '/github-token')).toEqual([]);
  });
  it('lets the eligible machine handle unsupported targets without borrowing an App token', async () => {
    const h = harness({ personal: true, localToken: 'local' });
    expect((await h.build(['some-extension', 'write'])).env.GH_TOKEN).toBeUndefined();
    expect(h.calls).toEqual([]);
  });
});
