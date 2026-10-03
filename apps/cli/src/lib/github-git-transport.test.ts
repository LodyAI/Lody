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
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-native-git-'));
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});
function harness(
  options: {
    owner?: boolean;
    personal?: boolean;
    offline?: boolean;
    operation?: string;
    denyPersonal?: boolean;
  } = {}
) {
  ensureGitHubGitTransport(directory, '/workspace/broker', 'git');
  const source = fs
    .readFileSync(path.join(directory, 'git-remote-https'), 'utf8')
    .replace(/main\(\)\.catch[\s\S]*$/, 'globalThis.run = main;');
  const delegates: Array<{ args: string[]; env: Record<string, string> }> = [];
  const attempts: string[] = [];
  const sync = vi.fn(
    (_git: string, args: string[], init: { env: Record<string, string>; input?: string }) => {
      if (args[0] === 'credential')
        return { status: 0, stdout: 'username=owner\npassword=local-token\n' };
      if (args[0] === 'remote-https') {
        const headers = init.env.GIT_CONFIG_PARAMETERS || '';
        attempts.push(headers);
        if (
          options.denyPersonal &&
          headers.includes(Buffer.from('x-access-token:personal-token').toString('base64'))
        )
          return { status: 128, stderr: 'HTTP 403' };
      }
      return { status: 0, stdout: '' };
    }
  );
  const context = vm.createContext({
    require: (name: string) =>
      name === 'path'
        ? path
        : name === 'child_process'
          ? {
              spawnSync: sync,
              spawn: (
                _git: string,
                args: string[],
                init: { env: Record<string, string>; input?: string }
              ) => {
                delegates.push({ args, env: init.env });
                return new EventEmitter();
              },
            }
          : {
              readFileSync: (file: string) =>
                JSON.stringify(
                  file.includes('.contexts/')
                    ? { version: 1, contextToken: 'frozen', allowLocalAuth: options.owner ?? true }
                    : { url: 'http://broker', token: 'fixture' }
                ),
            },
    process: {
      argv: ['node', 'adapter', 'origin', 'https://github.com/org/repo.git'],
      env: {
        LODY_GIT_CRED_CONTEXT_TOKEN: 'frozen',
        LODY_GIT_OPERATION: options.operation ?? 'read',
      },
    },
    fetch: async (_url: string, init: { body: string }) => {
      if (options.offline) throw Object.assign(new Error('SECRET'), { code: 'ECONNREFUSED' });
      const { source: identity } = JSON.parse(init.body);
      return Response.json(
        identity === 'personal' && !options.personal
          ? { available: false }
          : { token: identity + '-token', tokenSource: identity }
      );
    },
    console: { error: () => {} },
    URL,
    AbortSignal,
    Buffer,
  });
  vm.runInContext(source, context);
  return { run: () => (context.run as () => Promise<void>)(), delegates, attempts, sync };
}
describe('native Git credential adapter', () => {
  it('delegates once using personal credentials and keeps standard remote URLs', async () => {
    const h = harness({ personal: true });
    await h.run();
    expect(h.delegates).toHaveLength(1);
    expect(h.delegates[0].args).toEqual([
      'remote-https',
      'origin',
      'https://github.com/org/repo.git',
    ]);
    expect(h.delegates[0].env.GIT_CONFIG_PARAMETERS).toContain(
      Buffer.from('x-access-token:personal-token').toString('base64')
    );
    expect(h.sync.mock.calls.some(([, args]) => args[0] === 'credential')).toBe(false);
  });
  it('falls through a denied native advertisement to machine identity before executing a write', async () => {
    const h = harness({ personal: true, denyPersonal: true, operation: 'write' });
    await h.run();
    expect(h.attempts).toHaveLength(2);
    expect(h.delegates).toHaveLength(1);
    expect(h.delegates[0].env.GIT_CONFIG_PARAMETERS).toContain(
      Buffer.from('x-access-token:local-token').toString('base64')
    );
    expect(
      h.sync.mock.calls
        .filter(([, args]) => args[0] === 'remote-https')
        .every(([, , init]) => init.input === 'list for-push\n\n')
    ).toBe(true);
  });
  it('uses isolated anonymous reads after a cloud outage without borrowing nonowner credentials', async () => {
    const h = harness({ owner: false, offline: true });
    await h.run();
    expect(h.delegates[0].env.GIT_CONFIG_PARAMETERS).toContain('.extraHeader=Authorization:');
    expect(h.delegates[0].env.GIT_CONFIG_PARAMETERS).toContain('http.cookieFile=');
    expect(h.sync.mock.calls.some(([, args]) => args[0] === 'credential')).toBe(false);
  });
  it('does not execute an anonymous write when providers fail', async () => {
    const h = harness({ owner: false, offline: true, operation: 'write' });
    await expect(h.run()).rejects.toMatchObject({ code: 'credentials_exhausted' });
    expect(h.delegates).toEqual([]);
  });
  it('native receive-pack advertisement leaves refs unchanged', () => {
    const bare = path.join(directory, 'remote.git');
    execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
    expect(spawnSync('git', ['ls-remote', '--upload-pack=git-receive-pack', bare]).status).toBe(0);
    expect(execFileSync('git', ['--git-dir', bare, 'for-each-ref'], { encoding: 'utf8' })).toBe('');
  });
  it('clones recursive native SSH submodules while cloud credentials fail', async () => {
    const realGit = path.join(
      execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(),
      'git'
    );
    const fixtureEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(GIT_CONFIG_|GIT_EXEC_PATH|LODY_GIT_)/.test(key)
        )
      ),
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
    const state = path.join(directory, 'broker.json');
    const server = createServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream_unavailable' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing broker port');
      fs.writeFileSync(
        state,
        JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token: 'fixture' })
      );
      fs.mkdirSync(state + '.contexts');
      fs.writeFileSync(
        state + '.contexts/requester.json',
        JSON.stringify({ version: 1, contextToken: 'requester', allowLocalAuth: true })
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
            GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
            GIT_CONFIG_VALUE_0: 'git@github.com:',
            GIT_CONFIG_KEY_1: 'protocol.ext.allow',
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
  });
});
