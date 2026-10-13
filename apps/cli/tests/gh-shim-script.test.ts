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
    prFailure?: 'rejected' | 'lost-response' | 'invalid-response' | 'metadata';
    bodyFiles?: Record<string, string>;
    publishedTip?: string;
    mergeBase?: string;
  } = {}
) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let policyFailures = options.policyFailures ?? 0;
  const actual: Array<string[]> = [];
  const identities: string[] = [];
  const pullRequests: Array<{
    payload: Record<string, unknown>;
    token: string;
    metadata: string[];
  }> = [];
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
      else if (args[0] === 'symbolic-ref') child.stdout.emit('data', 'feature');
      else if (args[0] === 'rev-parse') child.stdout.emit('data', 'abc123');
      else if (args[0] === 'config') {
        if (options.mergeBase) child.stdout.emit('data', options.mergeBase);
        else status = 1;
      } else if (args[0] === 'auth' && args[1] === 'token') {
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
        } else if (args[0] === 'api' && args.some((arg) => /^repos\/.+\/pulls$/.test(arg))) {
          if (options.prFailure === 'rejected') {
            status = 1;
            child.stderr.emit('data', 'HTTP 403: Forbidden');
          } else {
            const payload: Record<string, unknown> = {};
            for (let i = 0; i < args.length; i++) {
              if (args[i] !== '-f' && args[i] !== '-F') continue;
              const typed = args[i] === '-F';
              const field = args[++i] ?? '';
              const equals = field.indexOf('=');
              payload[field.slice(0, equals)] = typed
                ? JSON.parse(field.slice(equals + 1))
                : field.slice(equals + 1);
            }
            pullRequests.push({ payload, token: init.env.GH_TOKEN ?? '', metadata: [] });
            const repo = args.find((arg) => /^repos\/.+\/pulls$/.test(arg))?.slice(6, -6);
            if (options.prFailure === 'lost-response') {
              status = 1;
              child.stderr.emit('data', 'connection reset');
            } else {
              child.stdout.emit(
                'data',
                options.prFailure === 'invalid-response'
                  ? '{}'
                  : JSON.stringify({ number: 42, html_url: `https://github.com/${repo}/pull/42` })
              );
            }
          }
        } else if (args[0] === 'api' && args.includes('.object.sha')) {
          child.stdout.emit('data', options.publishedTip ?? 'abc123');
        } else if (args[0] === 'api' && args.includes('.default_branch')) {
          child.stdout.emit('data', 'main');
        } else if (args[0] === 'pr' && args[1] === 'edit' && pullRequests[0]) {
          if (options.prFailure === 'metadata') {
            status = 1;
            child.stderr.emit('data', 'HTTP 403: Forbidden');
          } else pullRequests[0].metadata = args.slice(5);
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
          readFileSync: (p: string | number) => {
            if (options.bodyFiles && String(p) in options.bodyFiles)
              return options.bodyFiles[String(p)];
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
    pullRequests,
    stdout: context.process.stdout.write,
    stderr: context.console.error,
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
  const createArgs = [
    'pr',
    'create',
    '-R',
    'owner/repo',
    '--title',
    'A title',
    '--body',
    '',
    '--base',
    'main',
    '--head',
    'feature',
  ];
  it('creates a user-attributed REST PR and applies metadata with the same credential', async () => {
    const h = harness({ personal: true, localToken: 'native-token' });
    expect(
      await h.execute([
        ...createArgs,
        '--body',
        '@literal\n{owner}/{repo}',
        '--draft',
        '--no-maintainer-edit',
        '-lbug,cli',
        '--label=security',
        '-r',
        'reviewer',
      ])
    ).toBe(0);
    expect(h.pullRequests).toEqual([
      {
        payload: {
          title: 'A title',
          body: '@literal\n{owner}/{repo}',
          base: 'main',
          head: 'feature',
          draft: true,
          maintainer_can_modify: false,
        },
        token: 'personal:owner/repo',
        metadata: [
          '--add-label',
          'bug,cli',
          '--add-label',
          'security',
          '--add-reviewer',
          'reviewer',
        ],
      },
    ]);
    expect(h.identities).toEqual(['personal:owner/repo', 'personal:owner/repo']);
    expect(h.stdout).toHaveBeenCalledWith('https://github.com/owner/repo/pull/42\n');
  });
  it.each(['body.md', '-'])(
    'reads --body-file %s before writing and supports inherited repo flags and new alias',
    async (file) => {
      const h = harness({
        personal: true,
        bodyFiles: { [file === '-' ? '0' : file]: 'Multiline\nbody' },
      });
      expect(
        await h.execute([
          '--repo=owner/repo',
          'pr',
          'new',
          '-tTitle',
          '-F',
          file,
          '-Bmain',
          '-Hfeature',
          '--draft=false',
        ])
      ).toBe(0);
      expect(h.pullRequests[0]?.payload).toEqual({
        title: 'Title',
        body: 'Multiline\nbody',
        base: 'main',
        head: 'feature',
        draft: false,
        maintainer_can_modify: true,
      });
    }
  );
  it('supports App credentials without changing native machine-authenticated creation', async () => {
    const app = harness({ owner: false });
    expect(await app.execute(createArgs)).toBe(0);
    expect(app.pullRequests[0]?.token).toBe('app:owner/repo');
    const local = harness({ localToken: 'native-token' });
    expect(await local.execute(createArgs)).toBe(0);
    expect(local.pullRequests).toEqual([]);
    expect(local.actual).toEqual([createArgs]);
  });
  it.each(['rejected', 'lost-response', 'invalid-response', 'metadata'] as const)(
    'does not recreate or change identity after %s',
    async (prFailure) => {
      const h = harness({ personal: true, localToken: 'native-token', prFailure });
      expect(await h.execute([...createArgs, '--label', 'bug'])).toBe(1);
      expect(h.pullRequests).toHaveLength(prFailure === 'rejected' ? 0 : 1);
      expect(h.identities.every((token) => token === 'personal:owner/repo')).toBe(true);
      expect(h.actual.filter((args) => args[0] === 'api')).toHaveLength(1);
      if (prFailure === 'metadata') {
        expect(h.stdout).toHaveBeenCalledWith('https://github.com/owner/repo/pull/42\n');
        expect(h.stderr).toHaveBeenCalledWith(
          expect.stringContaining('PR was created, but metadata update failed')
        );
      }
    }
  );
  it.each([
    ['pr', 'create', '--fill'],
    [...createArgs, '--web'],
    [...createArgs, '--attach', 'image.png'],
    [...createArgs, '--body-file', 'body.md'],
  ])('preserves native behavior with an attribution warning for %j', async (...args) => {
    const h = harness({ personal: true });
    expect(await h.execute(args)).toBe(0);
    expect(h.actual).toEqual([args]);
    expect(h.pullRequests).toEqual([]);
    expect(h.stderr).toHaveBeenCalledWith(
      expect.stringContaining('GitHub may omit App attribution')
    );
  });
  it('does not write when an explicit body file is unreadable', async () => {
    const h = harness({ personal: true });
    expect(
      await h.execute([
        'pr',
        'create',
        '-t',
        'Title',
        '-F',
        'missing.md',
        '-B',
        'main',
        '-H',
        'feature',
      ])
    ).toBe(1);
    expect(h.actual).toEqual([]);
  });
  it.each([undefined, 'release'])(
    'infers a published current branch and base (%s)',
    async (mergeBase) => {
      const h = harness({ personal: true, mergeBase });
      expect(
        await h.execute(['pr', 'create', '-R', 'owner/repo', '-t', 'Title', '-b', 'Body'])
      ).toBe(0);
      expect(h.pullRequests[0]?.payload).toMatchObject({
        head: 'feature',
        base: mergeBase ?? 'main',
      });
    }
  );
  it('leaves native gh to push or select a fork when the inferred head is not published in the target', async () => {
    const h = harness({ personal: true, publishedTip: 'older-sha' });
    const args = ['pr', 'create', '-R', 'owner/repo', '-t', 'Title', '-b', 'Body'];
    expect(await h.execute(args)).toBe(0);
    expect(h.pullRequests).toEqual([]);
    expect(h.actual.at(-1)).toEqual(args);
  });
  it('prints a dry-run plan without writes and preserves credential-free help', async () => {
    const h = harness({ personal: true });
    expect(await h.execute([...createArgs, '--dry-run'])).toBe(0);
    expect(h.actual).toEqual([]);
    expect(h.stdout).toHaveBeenCalledWith(expect.stringContaining('"repository":"owner/repo"'));
    const help = harness();
    expect(await help.execute(['pr', 'create', '--help'])).toBe(0);
    expect(help.calls).toEqual([]);
    expect(help.pullRequests).toEqual([]);
  });
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
