import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoId } from '@lody/shared';
import type { Logger } from '@/utils/logger';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('cross-spawn', () => ({ default: spawnMock }));
vi.mock('@/utils/file-lock', () => ({
  withFileLock: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

/**
 * Minimal stand-in for a git child process that exits successfully.
 * `stdout` is scripted per invocation so callers that parse output (fetchspec
 * probing, rev-parse) take their normal branches without a real repository.
 */
function makeChild(stdout: string, options?: { stderr?: string; exitCode?: number }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
  };
  child.stdout = Readable.from([stdout]);
  child.stderr = Readable.from([options?.stderr ?? '']);
  // The credential-helper probe writes its request to stdin before waiting.
  child.stdin = new Writable({ write: (_chunk, _encoding, done) => done() });
  // Emit close only once both streams have been fully delivered, or callers that
  // classify a failure from stderr would see an empty message.
  let pending = 2;
  const settle = () => {
    if (--pending === 0) child.emit('close', options?.exitCode ?? 0);
  };
  child.stdout.once('end', settle);
  child.stderr.once('end', settle);
  return child;
}

function createLogger(): Logger {
  return {
    debug: vi.fn(),
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

/** The spawn call whose argv contains `verb`. */
function gitCall(verb: string): [string, string[], { env: NodeJS.ProcessEnv }] {
  const call = spawnMock.mock.calls.find(([, args]) => (args as string[]).includes(verb));
  if (!call) {
    throw new Error(
      `no git invocation with "${verb}"; saw: ${spawnMock.mock.calls
        .map(([, args]) => (args as string[]).join(' '))
        .join(' | ')}`
    );
  }
  return call as [string, string[], { env: NodeJS.ProcessEnv }];
}

/** Env of the git invocation whose argv contains `verb`. */
function envOfGitCall(verb: string): NodeJS.ProcessEnv {
  return gitCall(verb)[2].env;
}

describe('WorktreeManager host git credential broker routing', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      // `remote.origin.fetch` already configured -> no `config --add` detour.
      if (args.includes('--get-all')) {
        return makeChild('+refs/heads/*:refs/remotes/origin/*\n');
      }
      if (args.includes('rev-parse')) return makeChild('deadbeef\n');
      return makeChild('');
    });

    previousDataDir = process.env.LODY_DATA_DIR;
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'lody-broker-auth-'));
    process.env.LODY_DATA_DIR = dataDir;
    // Existing bare clone -> ensureRepo takes the fetch path, which is the
    // operation that failed in the reported bug.
    mkdirSync(path.join(dataDir, 'repos', REPO_ID, 'bare.git'), { recursive: true });
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
    else process.env.LODY_DATA_DIR = previousDataDir;
    delete process.env.LODY_GIT_CRED_BROKER_URL;
    delete process.env.LODY_GIT_CRED_BROKER_TOKEN;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function newManager() {
    const { WorktreeManager } = await import('./worktree-manager');
    return new WorktreeManager({
      repoId: REPO_ID,
      source: { kind: 'github', repoUrl: REPO_URL },
      logger: createLogger(),
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
      },
    });

    const env = envOfGitCall('fetch');
    expect(env.LODY_GIT_CRED_BROKER_URL).toBe('http://127.0.0.1:33215');
    expect(env.LODY_GIT_CRED_BROKER_TOKEN).toBe('session-workspace-token');
  });

  it('leaves the ambient pointer in place when no broker auth is supplied', async () => {
    // Local platform has no token manager and therefore no broker; host git must
    // keep working off whatever the environment already provides.
    process.env.LODY_GIT_CRED_BROKER_URL = 'http://127.0.0.1:44102';
    process.env.LODY_GIT_CRED_BROKER_TOKEN = 'ambient-token';

    const manager = await newManager();
    await manager.ensureRepo();

    const env = envOfGitCall('fetch');
    expect(env.LODY_GIT_CRED_BROKER_URL).toBe('http://127.0.0.1:44102');
    expect(env.LODY_GIT_CRED_BROKER_TOKEN).toBe('ambient-token');
  });
});

describe('WorktreeManager host git credential helper runtime', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let previousRunAsNode: string | undefined;

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--get-all')) {
        return makeChild('+refs/heads/*:refs/remotes/origin/*\n');
      }
      if (args.includes('rev-parse')) return makeChild('deadbeef\n');
      return makeChild('');
    });

    previousDataDir = process.env.LODY_DATA_DIR;
    previousRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.ELECTRON_RUN_AS_NODE;
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'lody-helper-runtime-'));
    process.env.LODY_DATA_DIR = dataDir;
    mkdirSync(path.join(dataDir, 'repos', REPO_ID, 'bare.git'), { recursive: true });
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
    else process.env.LODY_DATA_DIR = previousDataDir;
    if (previousRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previousRunAsNode;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function newManager() {
    const { WorktreeManager } = await import('./worktree-manager');
    return new WorktreeManager({
      repoId: REPO_ID,
      source: { kind: 'github', repoUrl: REPO_URL },
      logger: createLogger(),
    });
  }

  // A desktop launched from the Dock has no `node` on its GUI PATH, so a `!node`
  // helper never starts and git aborts with "terminal prompts disabled".
  it('points credential.helper at the CLI runtime instead of a PATH lookup', async () => {
    const manager = await newManager();
    await manager.ensureRepo();

    const helperArg = gitCall('fetch')[1].find(
      (arg) => arg.startsWith('credential.helper=') && arg.length > 'credential.helper='.length
    );
    const helperPath = path.join(
      dataDir,
      'repos',
      REPO_ID,
      'lody-git-credential-helper.cjs'
    );
    const toShellPath = (value: string) =>
      process.platform === 'win32' ? value.replace(/\\/g, '/') : value;
    expect(helperArg).toBe(
      `credential.helper=!"${toShellPath(process.execPath)}" "${toShellPath(helperPath)}"`
    );
    expect(helperArg).not.toContain('!node ');
  });

  // The packaged desktop CLI *is* the Electron binary: without the flag, git
  // running `process.execPath` would launch a second GUI app.
  it('forces ELECTRON_RUN_AS_NODE on git children when running under Electron', async () => {
    process.env.ELECTRON_RUN_AS_NODE = '1';

    const manager = await newManager();
    await manager.ensureRepo();

    expect(envOfGitCall('fetch').ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('leaves ELECTRON_RUN_AS_NODE unset under a plain Node CLI', async () => {
    const manager = await newManager();
    await manager.ensureRepo();

    expect(envOfGitCall('fetch').ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('probes the failing helper with the same runtime git uses', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--get-all')) {
        return makeChild('+refs/heads/*:refs/remotes/origin/*\n');
      }
      if (args.includes('fetch')) {
        return makeChild('', {
          stderr:
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
          exitCode: 128,
        });
      }
      if (args.includes('rev-parse')) return makeChild('deadbeef\n');
      return makeChild('');
    });

    const manager = await newManager();
    await manager.ensureRepo();

    const probeCall = spawnMock.mock.calls.find(([, args]) => (args as string[]).includes('get'));
    expect(probeCall).toBeDefined();
    expect(probeCall?.[0]).toBe(process.execPath);
    expect(probeCall?.[1]).toEqual([
      path.join(dataDir, 'repos', REPO_ID, 'lody-git-credential-helper.cjs'),
      'get',
    ]);
  });
});
