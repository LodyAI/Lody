import os from 'os';

import { describe, expect, it, vi, afterEach } from 'vitest';
import type { LocalProjectId, SessionId, WorkspaceId } from '@lody/shared';

import { SessionManager, type ISession } from '../src/session/session-manager';
import type { SessionConfig } from '../src/session/types';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { Logger } from '../src/utils/logger';
import type { SessionSandbox, SessionSandboxLimits } from '../src/session/session-sandbox';
import type { GitHubTokenManager } from '../src/lib/github-token-manager';
import {
  GitCredentialBroker,
  LODY_GIT_CRED_CONTEXT_TOKEN_ENV,
} from '../src/lib/git-credential-broker';
import { createTestCloudPort } from './test-cloud-port';

const GIB = 1024 * 1024 * 1024;

// Mock getEffectiveMemoryLimitBytes to return the same value as the mocked os.totalmem()
// so the test controls the memory budget deterministically.
vi.mock('../src/utils/memory', () => ({
  getEffectiveMemoryLimitBytes: vi.fn(() => 16 * GIB),
  getAvailableMemoryBytes: vi.fn(() => 8 * GIB),
}));

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

const createWorkspaceDocument = (): LoroDocumentManager =>
  ({
    repo: { getDocMeta: vi.fn(async () => ({ meta: { userId: 'user-1' } })) },
    getOrCreateSessionDoc: vi.fn(async () => ({
      setRepoFullName: vi.fn(async () => {}),
    })),
    cleanUp: vi.fn(async () => {}),
  }) as unknown as LoroDocumentManager;

const createSandbox = (): SessionSandbox & {
  applyLimits: ReturnType<typeof vi.fn>;
} => ({
  enabled: true,
  description: 'test-sandbox',
  applyLimits: vi.fn(async (_limits: SessionSandboxLimits) => {}),
  spawn: vi.fn(async () => {
    throw new Error('Not implemented in this test');
  }),
  terminate: vi.fn(async () => {}),
  cleanup: vi.fn(async () => {}),
});

const createConfig = (sessionId: string): SessionConfig => ({
  workspaceId: 'workspace-1' as WorkspaceId,
  requesterUserId: 'user-1',
  machineId: 'machine-1',
  agentCliType: 'builtin',
  agentType: 'codex',
  mcpServerIds: [],
  sessionId: sessionId as SessionId,
  userName: 'test-user',
  userEmail: 'test@example.com',
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SessionManager sandbox rebalance', () => {
  it('rebalances execution-plane limits when sessions are added and removed', async () => {
    vi.spyOn(os, 'totalmem').mockReturnValue(16 * GIB);
    vi.spyOn(os, 'cpus').mockReturnValue(
      Array.from({ length: 8 }, () => ({ model: 'test', speed: 1, times: {} })) as os.CpuInfo[]
    );

    const sandboxes = new Map<string, ReturnType<typeof createSandbox>>();
    const manager = new SessionManager(
      createSilentLogger(),
      'token',
      'machine-1',
      'workspace-1',
      createWorkspaceDocument(),
      {
        cloudPort: createTestCloudPort(),
        sessionSandboxFactory: async (sessionId) => {
          const sandbox = createSandbox();
          sandboxes.set(sessionId, sandbox);
          return sandbox;
        },
      }
    );

    const managerInternals = manager as unknown as {
      createSessionInner(config: SessionConfig): Promise<ISession>;
    };

    const sessionOne = await managerInternals.createSessionInner(createConfig('session-1'));
    const sandboxOne = sandboxes.get('session-1');
    expect(sandboxOne?.applyLimits).toHaveBeenCalledWith({
      memoryMaxBytes: Math.floor(16 * GIB * 0.75),
      cpuMax: '600000 100000',
      pidsMax: 1024,
    });

    const sessionTwo = await managerInternals.createSessionInner(createConfig('session-2'));
    const sandboxTwo = sandboxes.get('session-2');
    const sharedLimits = {
      memoryMaxBytes: Math.floor((16 * GIB * 0.75) / 2),
      cpuMax: '300000 100000',
      pidsMax: 1024,
    };
    expect(sandboxOne?.applyLimits).toHaveBeenLastCalledWith(sharedLimits);
    expect(sandboxTwo?.applyLimits).toHaveBeenCalledWith(sharedLimits);

    (
      sessionOne as unknown as {
        emit(event: 'terminated', payload: { sessionId: SessionId; exitCode: number }): void;
      }
    ).emit('terminated', {
      sessionId: 'session-1' as SessionId,
      exitCode: 0,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(sandboxTwo?.applyLimits).toHaveBeenLastCalledWith({
      memoryMaxBytes: Math.floor(16 * GIB * 0.75),
      cpuMax: '600000 100000',
      pidsMax: 1024,
    });
    expect(manager.getSession('session-1' as SessionId)).toBeNull();
    expect(manager.getSession('session-2' as SessionId)).toBe(sessionTwo);
  });

  it('keeps the conversation owner when another participant starts a turn', async () => {
    const manager = new SessionManager(
      createSilentLogger(),
      'token',
      'machine-1',
      'workspace-1',
      createWorkspaceDocument(),
      { cloudPort: createTestCloudPort() }
    );
    const tokenManager = {
      invalidate: vi.fn(),
      getWriteTokenForRepo: vi.fn(async () => {
        throw new Error('requester denied');
      }),
    } as unknown as GitHubTokenManager;
    const broker = new GitCredentialBroker({ tokenManager, logger: createSilentLogger() });
    const originalToken = broker.activateSessionContext({
      sessionId: 'session-1',
      requesterUserId: 'user-1',
      machineId: 'machine-1',
    });
    Object.assign(manager as unknown as Record<string, unknown>, {
      githubTokenManager: tokenManager,
      gitCredentialBroker: broker,
    });

    const env: Record<string, string | undefined> = {};
    const updateEnv = (next: Record<string, string | undefined>) => Object.assign(env, next);
    const session = {
      sessionId: 'session-1' as SessionId,
      updateEnv,
    } as unknown as ISession;

    await manager.refreshGhTokenForSession(session, 'owner/repo', 'user-2');

    const rotatedToken = env[LODY_GIT_CRED_CONTEXT_TOKEN_ENV];
    expect(rotatedToken).toEqual(expect.any(String));
    expect(rotatedToken).toBe(originalToken);
    expect(env).toEqual({ [LODY_GIT_CRED_CONTEXT_TOKEN_ENV]: rotatedToken });
    expect(
      broker.refreshSessionContext({
        sessionId: 'session-1',
        requesterUserId: 'user-1',
        machineId: 'machine-1',
      })
    ).toBe(rotatedToken);
  });

  it.each([false, true])(
    'keeps local project native credentials (worktree=%s)',
    async (useWorktree) => {
      const manager = new SessionManager(
        createSilentLogger(),
        'token',
        'machine-1',
        'workspace-1',
        createWorkspaceDocument(),
        { cloudPort: createTestCloudPort() }
      );
      const tokenManager = {
        retainRepoOwner: () => {
          throw new Error('Local projects must not use managed tokens');
        },
      } as unknown as GitHubTokenManager;
      const broker = new GitCredentialBroker({ tokenManager, logger: createSilentLogger() });
      // Another managed session already exists in this workspace.
      broker.activateSessionContext({
        sessionId: 'github-session',
        requesterUserId: 'user-1',
        machineId: 'machine-1',
      });
      Object.assign(manager, { githubTokenManager: tokenManager, gitCredentialBroker: broker });
      const nativeEnv = {
        GH_TOKEN: 'synthetic-local-gh-token',
        GITHUB_TOKEN: 'synthetic-local-github-token',
        PATH: '/native/bin',
        BASH_ENV: '/native/bashenv',
        ZDOTDIR: '/native/zsh',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: 'native-helper',
        GIT_SSH_COMMAND: 'ssh -i /native/key',
      };
      const config: SessionConfig = {
        ...createConfig('local-session'),
        project: {
          kind: 'local',
          localProjectId: 'local-project' as LocalProjectId,
          useWorktree,
          githubRepoFullName: 'owner/repo',
        },
        githubRepo: 'owner/repo',
        githubRepoUrl: 'git@github.com:owner/repo.git',
        env: { ...nativeEnv },
      };
      const prepare = manager as unknown as {
        prepareGitHubRepoSessionConfig(config: SessionConfig): Promise<void>;
      };
      await prepare.prepareGitHubRepoSessionConfig(config);
      expect(config.env).toEqual(nativeEnv);
      expect(config.githubCredentialPolicy).toBeUndefined();
      expect(config.githubRepoUrl).toBe('git@github.com:owner/repo.git');
      const session = {
        sessionId: config.sessionId,
        updateEnv: (env: Record<string, string | undefined>) =>
          Object.assign(config.env ?? {}, env),
      } as ISession;
      await manager.refreshGhTokenForSession(session, 'owner/repo', 'user-2');
      expect(config.env).toEqual(nativeEnv);
      expect(
        broker.refreshSessionContext({
          sessionId: 'local-session',
          requesterUserId: 'user-2',
          machineId: 'machine-1',
        })
      ).toBeUndefined();
    }
  );
});
