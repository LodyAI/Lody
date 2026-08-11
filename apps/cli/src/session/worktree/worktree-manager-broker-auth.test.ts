import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
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
function makeChild(stdout: string) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
  };
  child.stdout = Readable.from([stdout]);
  child.stderr = Readable.from([]);
  // Emit close after the streams have been consumed by the caller's listeners.
  queueMicrotask(() => queueMicrotask(() => child.emit('close', 0)));
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

/** Env of the git invocation whose argv contains `verb`. */
function envOfGitCall(verb: string): NodeJS.ProcessEnv {
  const call = spawnMock.mock.calls.find(([, args]) => (args as string[]).includes(verb));
  if (!call) {
    throw new Error(
      `no git invocation with "${verb}"; saw: ${spawnMock.mock.calls
        .map(([, args]) => (args as string[]).join(' '))
        .join(' | ')}`
    );
  }
  return (call[2] as { env: NodeJS.ProcessEnv }).env;
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
