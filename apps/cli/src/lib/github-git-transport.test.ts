import { EventEmitter } from 'node:events';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureGitHubGitTransport } from './github-git-transport';

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-git-transport-'));
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function harness(
  options: {
    owner?: boolean;
    personal?: boolean;
    target?: string;
    header?: string;
    sshCommand?: string;
    unavailable?: boolean;
    env?: Record<string, string>;
  } = {}
) {
  ensureGitHubGitTransport(directory, '/workspace/broker.json', 'git');
  const source = fs
    .readFileSync(path.join(directory, 'git-remote-lody-github'), 'utf8')
    .replace(/main\(\)\.catch\([\s\S]*$/, 'globalThis.run = main;');
  let contextToken = 'original';
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const sync = vi.fn((_git: string, args: string[]) => {
    if (args.includes('core.sshCommand')) return { status: 0, stdout: options.sshCommand ?? '' };
    if (args.includes('http.extraHeader')) return { status: 0, stdout: options.header ?? '' };
    if (args[0] === 'credential')
      return { status: 0, stdout: 'username=local\npassword=local-token\n' };
    return { status: 0, stdout: '', stderr: '' };
  });
  const spawn = vi.fn(() => new EventEmitter());
  const context = vm.createContext({
    require: (name: string) =>
      name === 'child_process'
        ? { spawn, spawnSync: sync }
        : {
            readFileSync: (file: string) =>
              JSON.stringify(
                file.endsWith('context.json')
                  ? { contextToken }
                  : { url: 'http://broker', token: 'bearer' }
              ),
          },
    process: {
      argv: ['node', 'helper', 'origin', options.target ?? 'org/repo'],
      env: {
        LODY_GIT_CRED_CONTEXT_FILE: '/session/context.json',
        LODY_GIT_OPERATION: 'write',
        ...options.env,
      },
      exit: vi.fn(),
    },
    fetch: vi.fn(
      async (url: string, init: { body?: string; headers?: { Authorization: string } }) => {
        const body = JSON.parse(init.body ?? '{}');
        requests.push({ url, body });
        if (url.startsWith('https://api.github.com'))
          return {
            ok: true,
            status: 200,
            json: async () => ({ private: false, permissions: { push: true } }),
          };
        if (url.endsWith('/github-auth-context'))
          return {
            ok: true,
            json: async () => ({
              allowLocalAuth: options.owner ?? true,
              personalEnabled: options.personal ?? false,
            }),
          };
        return {
          ok: true,
          json: async () =>
            options.unavailable
              ? { available: false }
              : { tokenSource: body.source, token: body.source + '-token' },
        };
      }
    ),
    console: { error: vi.fn() },
    URL,
    AbortSignal,
    Buffer,
  });
  vm.runInContext(source, context);
  return {
    sync,
    spawn,
    requests,
    rotate: () => {
      contextToken = 'rotated';
    },
    run: () => (context.run as () => Promise<void>)(),
  };
}

describe('GitHub per-remote transport', () => {
  it.skipIf(process.platform === 'win32')(
    'routes a native recursive submodule clone through the same transport',
    async () => {
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      const fixtureEnv = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.test',
      };
      const git = (args: string[]) =>
        execFileSync(realGit, args, { env: fixtureEnv, stdio: 'ignore' });
      const dependency = path.join(directory, 'dependency');
      const project = path.join(directory, 'project');
      git(['init', dependency]);
      git(['-C', dependency, 'commit', '--allow-empty', '-m', 'dependency']);
      git(['init', project]);
      git([
        '-C',
        project,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        dependency,
        'dependency',
      ]);
      git([
        '-C',
        project,
        'config',
        '-f',
        '.gitmodules',
        'submodule.dependency.url',
        'git@github.com:org/dependency.git',
      ]);
      git(['-C', project, 'add', '.gitmodules']);
      git(['-C', project, 'commit', '-m', 'project']);
      const ssh = path.join(directory, 'ssh.cjs');
      const log = path.join(directory, 'ssh.log');
      fs.writeFileSync(
        ssh,
        `const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2).join(' ');
if (process.argv.includes('-G')) process.exit(0);
const match = args.match(/(git-upload-pack|git-receive-pack).*?org\\/(project|dependency)\\.git/);
if (!match) process.exit(1);
fs.appendFileSync(${JSON.stringify(log)}, match[2] + '\\n');
const roots = ${JSON.stringify({ project, dependency })};
const child = spawnSync(${JSON.stringify(realGit)}, [match[1].replace('git-', ''), roots[match[2]]], { stdio: 'inherit' });
process.exit(child.status ?? 1);
`
      );
      const server = createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ allowLocalAuth: true, personalEnabled: false }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing broker port');
        const state = path.join(directory, 'broker.json');
        fs.writeFileSync(
          state,
          JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token: 'fixture' })
        );
        const bin = path.join(directory, 'bin');
        fs.mkdirSync(bin);
        ensureGitHubGitTransport(bin, state, realGit);
        const checkout = path.join(directory, 'checkout');
        await promisify(execFile)(
          path.join(bin, 'git'),
          ['clone', '--recurse-submodules', 'git@github.com:org/project.git', checkout],
          {
            env: {
              ...fixtureEnv,
              PATH: `${bin}:${process.env.PATH}`,
              GIT_SSH_COMMAND: `${JSON.stringify(process.execPath)} ${JSON.stringify(ssh)}`,
              LODY_GIT_CRED_CONTEXT_TOKEN: 'requester',
              LODY_GIT_LOCAL_CONFIG: '{}',
              GIT_CONFIG_COUNT: '2',
              GIT_CONFIG_KEY_0: 'url.lody-github::.insteadOf',
              GIT_CONFIG_VALUE_0: 'git@github.com:',
              GIT_CONFIG_KEY_1: 'protocol.lody-github.allow',
              GIT_CONFIG_VALUE_1: 'always',
            },
            timeout: 20_000,
          }
        );
        expect(fs.readFileSync(log, 'utf8').split('\n')).toEqual(
          expect.arrayContaining(['project', 'dependency'])
        );
        expect(
          execFileSync(realGit, ['-C', path.join(checkout, 'dependency'), 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim()
        ).toBe(
          execFileSync(realGit, ['-C', dependency, 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim()
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );
  it('allows verified public anonymous reads but never anonymous writes', async () => {
    const h = harness({
      owner: false,
      target: 'https/public/dependency',
      unavailable: true,
      env: { LODY_GIT_OPERATION: 'read' },
    });
    await h.run();
    expect(h.spawn.mock.calls[0]).toEqual([
      'git',
      ['remote-https', 'origin', 'https://github.com/public/dependency.git'],
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_CONFIG_PARAMETERS: expect.stringContaining('.extraHeader=Authorization:'),
        }),
      }),
    ]);
    const write = harness({ owner: false, unavailable: true });
    await expect(write.run()).rejects.toThrow('No GitHub credential');
    expect(write.spawn).not.toHaveBeenCalled();
  });
  it('blocks native Git rewrite precedence from bypassing credential selection', () => {
    ensureGitHubGitTransport(directory, '/unused', 'git');
    const result = spawnSync(
      process.execPath,
      [
        path.join(directory, 'git'),
        '-c',
        'url.git@github.com:.insteadOf=https://github.com/',
        'ls-remote',
        '--get-url',
        'https://github.com/org/repo.git',
      ],
      { cwd: directory, encoding: 'utf8' }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('custom GitHub URL rewrite');
    expect(result.stdout).toBe('');
  });
  it('preserves SSH command and port 443, preflighting receive-pack without replaying a write', async () => {
    const h = harness({
      target: 'ssh443/org/submodule.git',
      sshCommand: 'ssh -i "key with spaces"',
    });
    await h.run();
    expect(h.sync).toHaveBeenCalledWith(
      'git',
      [
        'ls-remote',
        '--upload-pack=git-receive-pack',
        'ssh://git@ssh.github.com:443/org/submodule.git',
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_SSH_COMMAND: 'ssh -i "key with spaces" -oBatchMode=yes -oConnectTimeout=5',
        }),
      })
    );
    expect(h.spawn).toHaveBeenCalledOnce();
    expect(h.spawn.mock.calls[0]).toEqual([
      'git',
      ['remote-ext', 'origin', expect.stringContaining('-p% 443% git@ssh.github.com')],
      expect.anything(),
    ]);
    expect(h.requests.some((request) => request.url.endsWith('/github-token'))).toBe(false);
  });
  it('uses owner-local HTTPS authorization headers only after personal selection', async () => {
    const h = harness({
      target: 'https/org/repo',
      header: 'Authorization: Basic ' + Buffer.from('user:header-token').toString('base64'),
    });
    await h.run();
    expect(h.requests.some((request) => request.url.endsWith('/github-token'))).toBe(false);
    expect(h.spawn.mock.calls[0]).toEqual([
      'git',
      ['remote-https', 'origin', 'https://github.com/org/repo.git'],
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_CONFIG_PARAMETERS: expect.stringContaining(
            Buffer.from('x-access-token:header-token').toString('base64')
          ),
        }),
      }),
    ]);
  });
  it.each([
    { owner: false, personal: false, source: 'app' },
    { owner: true, personal: true, source: 'personal' },
  ])('does not borrow local headers for $source', async ({ owner, personal, source }) => {
    const h = harness({
      owner,
      personal,
      target: 'https/org/repo',
      header: 'Authorization: Bearer owner-secret',
      env: {
        GIT_CONFIG_PARAMETERS:
          "'http.https://github.com/.extraHeader=Authorization: Bearer owner-secret'",
      },
    });
    h.rotate();
    await h.run();
    expect(
      h.sync.mock.calls.some(
        ([, args]) =>
          args.includes('http.extraHeader') || args[0] === 'credential' || args[0] === 'ls-remote'
      )
    ).toBe(false);
    expect(
      h.requests
        .filter((request) => request.url.startsWith('http://broker'))
        .every((request) => request.body.contextToken === 'original')
    ).toBe(true);
    const invocation = h.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    const headers = execFileSync(
      'git',
      ['config', '--get-urlmatch', 'http.extraHeader', 'https://github.com/org/repo.git'],
      { cwd: directory, env: { ...process.env, ...invocation[2].env }, encoding: 'utf8' }
    );
    expect(headers.trim()).toBe(
      'Authorization: Basic ' +
        Buffer.from('x-access-token:' + source + '-token').toString('base64')
    );
  });
  it('native receive-pack advertisement does not change repository refs', () => {
    const bare = path.join(directory, 'remote.git');
    execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
    const probe = spawnSync('git', ['ls-remote', '--upload-pack=git-receive-pack', bare], {
      encoding: 'utf8',
    });
    expect(probe.status).toBe(0);
    expect(execFileSync('git', ['--git-dir', bare, 'for-each-ref'], { encoding: 'utf8' })).toBe('');
  });
});
