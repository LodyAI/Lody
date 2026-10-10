import { Effect } from 'effect';
import type { SessionCredentials } from '../session-credentials';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId, RepoId, SessionId, WorkspaceId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import type { NodeProcessApi } from '@lody/shared/node/process';
import { SessionManager } from '../session-manager';
import type { SessionConfig } from '../types';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { createTestCloudPort } from '../../../tests/test-cloud-port';
import { materializeSpeculativeWorktree } from './speculative-worktree';
import { ensureGitHubGitTransport } from '@/lib/github-git-transport';
import type { GitCredentialBrokerAuth } from './worktree-manager';
import { isGitExecutableNotFoundError } from './git-process-error';

vi.mock('@/utils/file-lock', () => ({
  fileLocksLegacy: { withLock: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn() },
}));

type SpawnCall = { command: string; args: readonly string[]; options: SpawnOptions };
type SpawnImpl = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Pids no OS hands out, so scripted children never collide with real ones. */
const FAKE_PID_BASE = 2 ** 30;
let nextFakePid = FAKE_PID_BASE;
let spawnImpl: SpawnImpl;
const spawnCalls: SpawnCall[] = [];

/**
 * The process layer's OS seam. Scripted git children have fake pids that
 * no signal can reach; children the native fixture really spawns get real
 * signals, so their process groups are proven gone like in production.
 */
const nodeProcess: NodeProcessApi = {
  platform: process.platform,
  spawn: (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return spawnImpl(command, args, options);
  },
  spawnSync: () => {
    throw new Error('host git never runs synchronously');
  },
  kill: (pid, signal) => {
    if (Math.abs(pid) >= FAKE_PID_BASE) {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    }
    process.kill(pid, signal);
  },
};

/**
 * Minimal stand-in for a git child process that exits successfully.
 * `stdout` is scripted per invocation so callers that parse output (fetchspec
 * probing, rev-parse) take their normal branches without a real repository.
 */
function makeChild(stdout: string, stderr = '', code = 0): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: Readable;
    stderr: Readable;
  };
  child.pid = nextFakePid++;
  child.stdout = Readable.from([Buffer.from(stdout)]);
  child.stderr = Readable.from([Buffer.from(stderr)]);
  // Match child_process: close follows both output streams, including errors.
  let remainingStreams = 2;
  const ended = () => {
    if (--remainingStreams === 0) {
      child.emit('exit', code, null);
      child.emit('close', code, null);
    }
  };
  child.stdout.once('end', ended);
  child.stderr.once('end', ended);
  return child as unknown as ChildProcess;
}

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(),
    close: vi.fn(async () => undefined),
  } as unknown as Logger;
}

const REPO_ID = 'github---owner---repo' as RepoId;
const REPO_URL = 'https://github.com/owner/repo.git';

/** Env of the git invocation whose argv contains `verb`. */
function envOfGitCall(verb: string): NodeJS.ProcessEnv {
  const call = spawnCalls.find(({ args }) => args.includes(verb));
  if (!call) {
    throw new Error(
      `no git invocation with "${verb}"; saw: ${spawnCalls
        .map(({ args }) => args.join(' '))
        .join(' | ')}`
    );
  }
  return call.options.env ?? {};
}

describe('WorktreeManager host git credential broker routing', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    spawnCalls.length = 0;
    spawnImpl = (_cmd, args) => {
      // `remote.origin.fetch` already configured -> no `config --add` detour.
      if (args.includes('--get-all')) {
        return makeChild('+refs/heads/*:refs/remotes/origin/*\n');
      }
      if (args.includes('rev-parse')) return makeChild('deadbeef\n');
      return makeChild('');
    };

    previousDataDir = process.env.LODY_DATA_DIR;
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'lody-broker-auth-'));
    process.env.LODY_DATA_DIR = dataDir;
    // Existing bare clone -> ensureRepo takes the fetch path, which is the
    // operation that failed in the reported bug.
    mkdirSync(path.join(dataDir, 'repos', REPO_ID, 'bare.git'), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
    else process.env.LODY_DATA_DIR = previousDataDir;
    delete process.env.LODY_GIT_CRED_BROKER_URL;
    delete process.env.LODY_GIT_CRED_BROKER_TOKEN;
    rmSync(dataDir, { recursive: true, force: true });
  });

  // Exercise native worktree creation and the generated credential helper. Only
  // remote Git transport and broker HTTP are replaced with deterministic local
  // fixtures: no real credentials, GitHub requests or network timing involved.
  function nativeFixture(checkoutCredentials = false, retryCheckout = false) {
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const coreGit = path.join(execPath, process.platform === 'win32' ? 'git.exe' : 'git');
    const git = existsSync(coreGit) ? coreGit : 'git';
    const bin = path.join(dataDir, 'bin');
    mkdirSync(bin);
    ensureGitHubGitTransport(bin, '/unused', git);
    const wrapper = path.join(bin, 'git');
    for (const key of Object.keys(process.env)) {
      if (/^(GIT_CONFIG_|LODY_GIT_|GIT_DIR$|GIT_WORK_TREE$)/.test(key)) vi.stubEnv(key, undefined);
    }
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(dataDir, 'empty-config'));
    vi.stubEnv('GIT_CONFIG_COUNT', '0');
    vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
    const upstream = path.join(dataDir, 'upstream');
    const nativeGit = (args: string[], cwd = dataDir) =>
      execFileSync(git, args, {
        cwd,
        env: process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    nativeGit(['init', '-b', 'fixture-base', upstream]);
    writeFileSync(path.join(upstream, 'README.md'), 'fixture content');
    if (checkoutCredentials)
      writeFileSync(path.join(upstream, '.gitattributes'), 'README.md filter=credential-fixture\n');
    nativeGit(['add', '.'], upstream);
    nativeGit(
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'fixture',
      ],
      upstream
    );
    writeFileSync(
      path.join(dataDir, 'empty-config'),
      '[credential]\n\thelper = "!f() { echo username=machine; echo password=machine-owner-secret; }; f"\n'
    );
    const head = nativeGit(['rev-parse', 'HEAD'], upstream);
    const bare = path.join(dataDir, 'repos', REPO_ID, 'bare.git');
    rmSync(bare, { recursive: true, force: true });
    const log = path.join(dataDir, 'broker-calls.jsonl');
    const preload = path.join(dataDir, 'broker-fixture.cjs');
    writeFileSync(
      preload,
      `
const fs = require('node:fs');
globalThis.fetch = async (url, init) => {
  if (url.startsWith('https://api.github.com/')) {
    return { ok: true, status: 200, json: async () => ({ permissions: { push: false } }) };
  }
  const request = JSON.parse(init.body);
  const context = request.contextToken;
  const host = new URL(url).hostname;
  if (!['requester-a', 'requester-b'].includes(context) || host !== context + '.test' || init.headers.Authorization !== 'Bearer ' + context) {
    return { ok: false, status: 403, json: async () => ({ error: 'invalid_context' }) };
  }
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url, context }) + '\\n');
  return { ok: true, status: 200, json: async () => url.endsWith('/github-auth-context')
    ? { allowLocalAuth: false, personalEnabled: ${checkoutCredentials} }
    : ${checkoutCredentials} && request.source !== 'personal'
      ? { available: false }
      : { tokenSource: request.source, token: 'synthetic-fixture-token' } };
};
`
    );
    const smudge = path.join(dataDir, 'smudge.cjs');
    writeFileSync(
      smudge,
      `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) throw new Error('host credential leaked');
const input = fs.readFileSync(0);
const result = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(wrapper)}, 'credential', 'fill'], {
  input: 'protocol=https\\nhost=github.com\\npath=owner/repo.git/info/lfs\\n\\n', encoding: 'utf8', env: process.env,
});
if (result.status !== 0 || !result.stdout.includes('password=synthetic-fixture-token')) {
  process.stderr.write(result.stderr); process.exit(1);
}
process.stdout.write(input);
`
    );
    let networkCalls = 0;
    let checkoutFailed = false;
    spawnImpl = (_command, args, options) => {
      if (retryCheckout && !checkoutFailed && args[0] === 'worktree' && args[1] === 'add') {
        checkoutFailed = true;
        return makeChild('', 'fatal: missing stale worktree registration', 1);
      }
      const verb = args.find((arg) => arg === 'fetch' || arg === 'clone');
      if (!verb)
        return spawn(
          checkoutCredentials ? process.execPath : git,
          checkoutCredentials ? [wrapper, ...args] : args,
          {
            ...options,
            env: { ...options.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
      networkCalls++;
      // Ask actual Git to run the generated helper with EXACTLY the supplied
      // auth env before serving pack data from the local fixture repository.
      const script = `
const { spawnSync } = require('node:child_process');
const args = ${JSON.stringify(args)};
const index = args.indexOf(${JSON.stringify(verb)});
const credential = spawnSync(${JSON.stringify(git)}, [...args.slice(0, index), 'credential', 'fill'], {
  input: 'protocol=https\\nhost=github.com\\npath=owner/repo.git\\n\\n', encoding: 'utf8', env: process.env,
});
if (credential.status !== 0) { process.stderr.write(credential.stderr); process.exit(1); }
if (!credential.stdout.includes('password=synthetic-fixture-token')) process.exit(2);
const operation = ${JSON.stringify(verb)} === 'clone'
  ? ['clone', '--bare', ${JSON.stringify(upstream)}, args[args.length - 1]]
  : ['fetch', ${JSON.stringify(upstream)}, '+refs/heads/*:refs/remotes/origin/*', '--prune'];
const result = spawnSync(${JSON.stringify(git)}, operation, { env: process.env, stdio: 'inherit' });
process.exit(result.status ?? 1);
`;
      return spawn(process.execPath, ['-e', script], {
        ...options,
        env: { ...options.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    };
    const auth = async (context: string): Promise<GitCredentialBrokerAuth> => {
      const stateFilePath = path.join(dataDir, context + '-broker.json');
      mkdirSync(stateFilePath + '.contexts', { recursive: true });
      writeFileSync(
        stateFilePath,
        JSON.stringify({ url: `http://${context}.test`, token: context })
      );
      writeFileSync(
        stateFilePath + '.contexts/' + context + '.json',
        JSON.stringify({ version: 1, contextToken: context, allowLocalAuth: false })
      );
      const sessionManager = new SessionManager(
        createLogger(),
        'cli',
        'machine',
        'workspace',
        {
          repo: { getDocMeta: async () => ({ meta: { userId: context } }) },
        } as unknown as LoroDocumentManager,
        { cloudPort: createTestCloudPort() }
      );
      Object.assign(sessionManager, {
        githubTokenManager: {},
        gitCredentialBroker: {
          ensureStarted: async () => ({ url: `http://${context}.test`, token: context, port: 0 }),
          acquireContext: () =>
            Effect.acquireRelease(
              Effect.sync(() => ({
                context: { sessionId: context, requesterUserId: context, machineId: 'machine' },
                contextToken: context,
                stateFilePath,
                contextFilePath: stateFilePath + '.contexts/' + context + '.json',
                allowLocalAuth: false,
                active: true,
                revoke: () => {},
              })),
              () => Effect.void
            ),
          getStateFilePath: () => stateFilePath,
        },
      });
      const production = sessionManager as unknown as {
        prepareGitHubRepoSessionConfig(config: SessionConfig): Promise<SessionCredentials>;
        resolveHostGitBrokerAuth(
          source: { kind: 'github'; repoUrl: string },
          config: SessionConfig,
          credentials: SessionCredentials
        ): Promise<GitCredentialBrokerAuth>;
      };
      const config = {
        sessionId: context,
        requesterUserId: context,
        repoId: REPO_ID,
        githubRepo: 'owner/repo',
        env: {},
      } as SessionConfig;
      const credentials = await production.prepareGitHubRepoSessionConfig(config);
      const prepared = await production.resolveHostGitBrokerAuth(
        { kind: 'github', repoUrl: REPO_URL },
        config,
        credentials
      );
      // Only repository filter configuration is fixture-specific. Credentials,
      // routing and pinned authority come from the actual production preparation.
      if (checkoutCredentials) {
        let count = Number(prepared.transportEnv.GIT_CONFIG_COUNT);
        for (const [key, value] of [
          [
            'filter.credential-fixture.smudge',
            `${JSON.stringify(process.execPath)} ${JSON.stringify(smudge)}`,
          ],
          ['filter.credential-fixture.required', 'true'],
        ]) {
          prepared.transportEnv[`GIT_CONFIG_KEY_${count}`] = key;
          prepared.transportEnv[`GIT_CONFIG_VALUE_${count++}`] = value;
        }
        prepared.transportEnv.GIT_CONFIG_COUNT = String(count);
      }
      return prepared;
    };
    return {
      head,
      auth,
      nativeGit,
      seed: () => nativeGit(['clone', '--bare', upstream, bare]),
      calls: () => networkCalls,
      contexts: () =>
        existsSync(log)
          ? readFileSync(log, 'utf8')
              .trim()
              .split('\n')
              .map((line) => (JSON.parse(line) as { context: string }).context)
          : [],
    };
  }

  it.each(['clone', 'fetch', 'speculative', 'restore-cache'] as const)(
    'creates a real worktree through authenticated %s',
    async (mode) => {
      const fixture = nativeFixture();
      const needsClone = mode === 'clone' || mode === 'restore-cache';
      if (!needsClone) fixture.seed();
      const manager = await newManager();
      const sessionId = `startup-${mode}` as SessionId;
      const brokerAuth = await fixture.auth('requester-a');
      const info =
        mode === 'speculative'
          ? (
              await materializeSpeculativeWorktree({
                preparationId: 'prepare',
                sessionId,
                workspaceId: 'workspace-a' as WorkspaceId,
                machineId: 'machine-a' as MachineId,
                manager,
                managerConfig: { repoId: REPO_ID, source: { kind: 'github', repoUrl: REPO_URL } },
                resolveBrokerAuth: async () => brokerAuth,
                logger: createLogger(),
              })
            ).info
          : await manager.createWorktree(
              sessionId,
              undefined,
              mode === 'restore-cache' ? 'fixture-base' : undefined,
              undefined,
              brokerAuth
            );
      expect(readFileSync(path.join(info.hostPath, 'README.md'), 'utf8')).toBe('fixture content');
      expect(info.headSha).toBe(fixture.head);
      expect(fixture.calls()).toBe(needsClone ? 2 : 1);
      expect(fixture.contexts()).toEqual(
        Array.from({ length: needsClone ? 2 : 1 }, () => 'requester-a')
      );
      if (mode === 'restore-cache') expect(info.branch).toBe('fixture-base');
      // Existing checkout restores offline, without authenticating or fetching.
      expect((await manager.createWorktree(sessionId)).headSha).toBe(fixture.head);
      expect(fixture.calls()).toBe(needsClone ? 2 : 1);
    }
  );

  it.each(['fresh', 'retry', 'restore'])(
    'passes frozen credentials to checkout-time smudge filters during %s',
    async (mode) => {
      const fixture = nativeFixture(true, mode === 'retry');
      vi.stubEnv('GH_TOKEN', 'machine-owner-env-secret');
      vi.stubEnv('GITHUB_TOKEN', 'machine-owner-secondary-secret');
      fixture.seed();
      const manager = await newManager();
      const info = await manager.createWorktree(
        'checkout-auth' as SessionId,
        undefined,
        mode === 'restore' ? 'fixture-base' : undefined,
        undefined,
        await fixture.auth('requester-a')
      );
      expect(readFileSync(path.join(info.hostPath, 'README.md'), 'utf8')).toBe('fixture content');
      expect(fixture.contexts()).toEqual(['requester-a', 'requester-a']);
    }
  );

  it('creates a broker-less GitHub worktree with native credentials', async () => {
    const fixture = nativeFixture();
    fixture.seed();
    fixture.nativeGit([
      'config',
      '--file',
      path.join(dataDir, 'empty-config'),
      'credential.helper',
      '!f() { printf "username=native\\npassword=synthetic-fixture-token\\n"; }; f',
    ]);
    const manager = await newManager();
    const info = await manager.createWorktree('native-auth' as SessionId);
    expect(readFileSync(path.join(info.hostPath, 'README.md'), 'utf8')).toBe('fixture content');
    expect(fixture.contexts()).toEqual([]);
  });

  it('keeps two callers on the same manager isolated from ambient and mutable contexts', async () => {
    const fixture = nativeFixture();
    fixture.seed();
    const manager = await newManager();
    const ambientFile = path.join(dataDir, 'other-context.json');
    writeFileSync(ambientFile, JSON.stringify({ contextToken: 'wrong-context' }));
    vi.stubEnv('LODY_GIT_CRED_CONTEXT_FILE', ambientFile);
    vi.stubEnv('LODY_GIT_CRED_CONTEXT_TOKEN', 'wrong-context');
    vi.stubEnv('LODY_GIT_CRED_BROKER_TOKEN', 'wrong-broker');
    for (const requester of ['requester-a', 'requester-b']) {
      const info = await manager.createWorktree(
        requester as SessionId,
        undefined,
        undefined,
        undefined,
        await fixture.auth(requester)
      );
      expect(info.headSha).toBe(fixture.head);
    }
    expect(fixture.contexts()).toEqual(['requester-a', 'requester-b']);
  });

  it('fails a fresh worktree before materialization when the requester context is invalid', async () => {
    const fixture = nativeFixture();
    fixture.seed();
    const manager = await newManager();
    const sessionId = 'denied-startup' as SessionId;
    await expect(
      manager.createWorktree(
        sessionId,
        undefined,
        undefined,
        undefined,
        await fixture.auth('revoked')
      )
    ).rejects.toThrow('invalid_context');
    expect(manager.hasWorktree(sessionId)).toBe(false);
    expect(fixture.contexts()).toEqual([]);
  });

  async function newManager() {
    const { WorktreeManager } = await import('./worktree-manager');
    return new WorktreeManager({
      repoId: REPO_ID,
      source: { kind: 'github', repoUrl: REPO_URL },
      logger: createLogger(),
      nodeProcess,
    });
  }

  it('fetches with the caller-supplied broker, not the process-global pointer', async () => {
    // Another workspace in the same fleet process started its broker last and
    // therefore owns the global pointer.
    process.env.LODY_GIT_CRED_BROKER_URL = 'http://127.0.0.1:44102';
    process.env.LODY_GIT_CRED_BROKER_TOKEN = 'other-workspace-token';

    const manager = await newManager();
    await manager.ensureRepo({
      brokerAuth: {
        workspaceId: 'workspace-owning-the-session',
        url: 'http://127.0.0.1:33215',
        token: 'session-workspace-token',
        contextToken: 'session-context',
        transportEnv: {},
      },
    });

    const env = envOfGitCall('fetch');
    expect(env.LODY_GIT_CRED_BROKER_URL).toBe('http://127.0.0.1:33215');
    expect(env.LODY_GIT_CRED_BROKER_TOKEN).toBe('session-workspace-token');
  });

  it.each(['clone', 'fetch'])(
    'routes host %s through the prepared requester transport, not ambient authentication',
    async (verb) => {
      if (verb === 'clone')
        rmSync(path.join(dataDir, 'repos', REPO_ID, 'bare.git'), { recursive: true });
      const manager = await newManager();
      const transportEnv = {
        PATH: '/workspace/scoped-shims:/native/bin',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'url.lody-github::https/.insteadOf',
        GIT_CONFIG_VALUE_0: 'https://github.com/',
        LODY_GIT_LOCAL_CONFIG: '{}',
      };
      await manager.ensureRepo({
        brokerAuth: {
          workspaceId: 'workspace',
          url: 'http://broker',
          token: 'bearer',
          contextToken: 'frozen-requester',
          stateFilePath: '/workspace/broker.json',
          transportEnv,
        },
      });
      expect(envOfGitCall(verb)).toMatchObject({
        ...transportEnv,
        LODY_GIT_CRED_CONTEXT_TOKEN: 'frozen-requester',
        LODY_GIT_CRED_CONTEXT_FILE: undefined,
      });
      const args = spawnCalls.find((call) => call.args.includes(verb))?.args ?? [];
      expect(args.some((arg) => arg.includes('credential.https://github.com.helper'))).toBe(false);
    }
  );

  it('reports a missing git executable through the process layer', async () => {
    rmSync(path.join(dataDir, 'repos', REPO_ID, 'bare.git'), { recursive: true });
    spawnImpl = () => {
      // What Node does for a missing executable: no pid, then an async ENOENT.
      const child = new EventEmitter();
      queueMicrotask(() =>
        child.emit('error', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))
      );
      return child as unknown as ChildProcess;
    };
    const manager = await newManager();

    const failure = await manager.ensureRepo().then(
      () => undefined,
      (error: unknown) => error
    );

    expect(isGitExecutableNotFoundError(failure)).toBe(true);
  });

  it('uses native Git without installing managed credentials or borrowing an ambient broker', async () => {
    // Local platform has no token manager and therefore no broker; host git must
    // keep working off whatever the environment already provides.
    process.env.LODY_GIT_CRED_BROKER_URL = 'http://127.0.0.1:44102';
    process.env.LODY_GIT_CRED_BROKER_TOKEN = 'ambient-token';

    const manager = await newManager();
    await manager.ensureRepo();

    const env = envOfGitCall('fetch');
    expect(env.LODY_GIT_CRED_BROKER_URL).toBeUndefined();
    expect(env.LODY_GIT_CRED_BROKER_TOKEN).toBeUndefined();
    expect(spawnCalls.find(({ args }) => args.includes('fetch'))?.args).toEqual([
      'fetch',
      'origin',
      '--prune',
    ]);
  });
});
