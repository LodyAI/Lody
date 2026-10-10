import { Effect } from 'effect';
import type { SessionPreparationSpec } from '@lody/shared';
import type { GitCredentialLease } from '../src/lib/git-credential-broker';
import {
  acquireSessionCredentialsLegacy,
  type SessionCredentials,
} from '../src/session/session-credentials';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import os from 'os';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Session } from '../src/session/session';

import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ACPSessionId, LocalProjectId, SessionId, WorkspaceId } from '@lody/shared';

import { SessionManager, type ISession } from '../src/session/session-manager';
import type { SessionConfig } from '../src/session/types';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { Logger } from '../src/utils/logger';
import type { SessionSandbox, SessionSandboxLimits } from '../src/session/session-sandbox';
import type { GitHubTokenManager } from '../src/lib/github-token-manager';
import { GitCredentialBroker } from '../src/lib/git-credential-broker';
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
    const credentials = acquireSessionCredentialsLegacy(broker, {
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
      getGitHubCredentials: () => credentials,
    } as unknown as ISession;

    try {
      await manager.validateSessionCredentials(session, 'user-2');
      expect(credentials.mode).toBe('managed');
      if (credentials.mode === 'managed') {
        expect(credentials.lease.active).toBe(true);
        expect(credentials.lease.context.requesterUserId).toBe('user-1');
      }
      expect(env).toEqual({});
    } finally {
      await credentials.release();
    }
  });

  it('scrubs the new owner environment and retires the old runtime on ownership transfer', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'lody-owner-transfer-'));
    vi.stubEnv('LODY_DATA_DIR', directory);
    vi.stubEnv('GH_TOKEN', 'machine-owner-secret');
    vi.stubEnv('GITHUB_TOKEN', 'machine-owner-secondary');
    const document = createWorkspaceDocument();
    vi.mocked(document.repo.getDocMeta).mockResolvedValue({ meta: { userId: 'user-2' } } as never);
    const manager = new SessionManager(
      createSilentLogger(),
      'token',
      'machine-1',
      'workspace-1',
      document,
      { cloudPort: createTestCloudPort() }
    );
    const tokenManager = {} as GitHubTokenManager;
    const broker = new GitCredentialBroker({
      tokenManager,
      logger: createSilentLogger(),
      workspaceId: 'workspace-1',
      ownerUserId: 'user-1',
    });
    const credentials = acquireSessionCredentialsLegacy(broker, {
      sessionId: 'session-1',
      requesterUserId: 'user-1',
      machineId: 'machine-1',
    });
    Object.assign(manager, { githubTokenManager: tokenManager, gitCredentialBroker: broker });
    const config = createConfig('session-1');
    const sandbox = createSandbox();
    const child = Object.assign(new EventEmitter(), {
      pid: 1234,
      exitCode: null as number | null,
    }) as ChildProcess;
    let terminalEnv: NodeJS.ProcessEnv | undefined;
    vi.spyOn(sandbox, 'spawn').mockImplementation(async (_command, _args, options) => {
      terminalEnv = options.env;
      return {
        child,
        inspectExit: async () => null,
        onStdout: () => () => {},
        onStderr: () => () => {},
        onExit: (listener) => {
          child.on('exit', listener);
          return () => child.off('exit', listener);
        },
        onClose: (listener) => {
          child.on('close', listener);
          return () => child.off('close', listener);
        },
        onError: (listener) => {
          child.on('error', listener);
          return () => child.off('error', listener);
        },
        terminate: async () => {
          child.exitCode = 0;
          child.emit('exit', 0, null);
          child.emit('close', 0, null);
        },
      };
    });
    const session = new Session(config, createSilentLogger(), directory, sandbox, credentials);
    session.acpSessionId = 'old-owner-acp' as ACPSessionId;
    await session.terminalManager.createTerminal(
      session.acpSessionId,
      'fixture',
      ['keep-open'],
      directory
    );
    expect(terminalEnv?.GH_TOKEN).toBe('machine-owner-secret');
    const shell = session as unknown as { buildShellEnv(): NodeJS.ProcessEnv };
    expect(shell.buildShellEnv().GH_TOKEN).toBe('machine-owner-secret');
    let terminated = false;
    session.on('terminated', () => {
      terminated = true;
    });
    try {
      await expect(manager.validateSessionCredentials(session, 'user-2')).rejects.toThrow(
        'github_owner_changed'
      );
      expect(credentials.mode === 'managed' && credentials.lease.active).toBe(false);
      expect(shell.buildShellEnv().GH_TOKEN).toBeUndefined();
      expect(shell.buildShellEnv().GITHUB_TOKEN).toBeUndefined();
      expect(terminated).toBe(true);
      expect(child.exitCode).toBe(0);
      expect(session.acpSessionId).toBeNull();
      await expect(session.exec('git', ['status'], directory, false)).rejects.toThrow(
        'not running'
      );
    } finally {
      await broker.shutdown();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['sandbox-failure', 'discard-before-start', 'adopt'] as const)(
    'owns speculative credentials through %s',
    async (stage) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'lody-prepared-credentials-'));
      vi.stubEnv('LODY_DATA_DIR', directory);
      const document = createWorkspaceDocument();
      Object.assign(document, {
        getAgentConfigById: async () => ({
          machineId: 'machine-1',
          cliType: 'custom',
          agentType: 'fixture',
          customAcp: { command: 'fixture', args: [] },
        }),
      });
      const manager = new SessionManager(
        createSilentLogger(),
        'token',
        'machine-1',
        'workspace-1',
        document,
        {
          cloudPort: createTestCloudPort(),
          sessionSandboxFactory: async () => {
            if (stage === 'sandbox-failure') throw new Error('fixture sandbox failure');
            return createSandbox();
          },
        }
      );
      const broker = new GitCredentialBroker({
        tokenManager: {} as GitHubTokenManager,
        logger: createSilentLogger(),
        workspaceId: 'workspace-1',
        ownerUserId: 'user-1',
      });
      vi.spyOn(broker, 'ensureStarted').mockResolvedValue({ url: '', token: '', port: 0 });
      let acquired: GitCredentialLease | undefined;
      const acquire = broker.acquireContext.bind(broker);
      vi.spyOn(broker, 'acquireContext').mockImplementation((context) =>
        acquire(context).pipe(
          Effect.tap((lease) =>
            Effect.sync(() => {
              acquired = lease;
            })
          )
        )
      );
      Object.assign(manager, {
        githubTokenManager: {},
        gitCredentialBroker: broker,
        preparationUserResolver: {
          resolve: async () => ({ name: 'Fixture', email: 'fixture@example.test' }),
        },
      });
      const spec = {
        sessionId: 'prepared-credentials' as SessionId,
        preparationId: 'prepare-1',
        agentConfigId: 'fixture-agent',
        requestedByUserId: 'user-1',
        cliType: 'custom',
        agentType: 'fixture',
      } as SessionPreparationSpec;
      const internals = manager as unknown as {
        createPreparedSessionRuntime(
          spec: SessionPreparationSpec,
          signal: AbortSignal
        ): Promise<{
          session: Session;
          start(): void;
          agentResult: Promise<string>;
          adopt(): Promise<void>;
          dispose(): Promise<void>;
        }>;
      };
      vi.spyOn(Session.prototype, 'createAgent').mockResolvedValue('fixture-acp');
      try {
        if (stage === 'sandbox-failure') {
          await expect(
            internals.createPreparedSessionRuntime(spec, new AbortController().signal)
          ).rejects.toThrow('fixture sandbox failure');
        } else {
          const prepared = await internals.createPreparedSessionRuntime(
            spec,
            new AbortController().signal
          );
          expect(acquired?.active).toBe(true);
          if (stage === 'adopt') {
            prepared.start();
            await prepared.agentResult;
            await prepared.adopt();
            expect(acquired?.active).toBe(true);
            expect(prepared.session.getGitHubCredentials().mode).toBe('managed');
            await prepared.session.terminate(true);
          }
          await prepared.dispose();
          await prepared.dispose();
        }
        expect(acquired).toBeDefined();
        expect(acquired?.active).toBe(false);
        expect(acquired?.contextFilePath && existsSync(acquired.contextFilePath)).toBe(false);
      } finally {
        await broker.shutdown();
        vi.unstubAllEnvs();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(['before-session', 'agent-start', 'after-agent-start', 'success'] as const)(
    'owns managed credentials across cold startup: %s',
    async (stage) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'lody-credential-lifetime-'));
      vi.stubEnv('LODY_DATA_DIR', directory);
      const doc = createWorkspaceDocument();
      const persisted = {
        setRepoFullName: async () => {},
        setACPSessionId: async () => {
          if (stage === 'after-agent-start') throw new Error('fixture persistence failed');
        },
      };
      vi.mocked(doc.getOrCreateSessionDoc).mockImplementation(async () => {
        if (stage === 'before-session') throw new Error('fixture document unavailable');
        return persisted as never;
      });
      const manager = new SessionManager(
        createSilentLogger(),
        'token',
        'machine-1',
        'workspace-1',
        doc,
        {
          cloudPort: createTestCloudPort(),
          sessionSandboxFactory: async () => createSandbox(),
        }
      );
      const broker = new GitCredentialBroker({
        tokenManager: {} as GitHubTokenManager,
        logger: createSilentLogger(),
        workspaceId: 'workspace-1',
        ownerUserId: 'user-1',
      });
      vi.spyOn(broker, 'ensureStarted').mockResolvedValue({ url: '', token: '', port: 0 });
      Object.assign(manager, { githubTokenManager: {}, gitCredentialBroker: broker });
      const config: SessionConfig = {
        ...createConfig('runtime-lifetime'),
        assumeDocExisting: true,
        agentCliType: 'custom',
        agentType: 'custom-fixture',
        customAcp: { command: 'fixture', args: [] },
        workdir: directory,
      };
      const create = vi.spyOn(Session.prototype, 'createAgent').mockImplementation(async () => {
        if (stage === 'agent-start') throw new Error('fixture spawn failed');
        return 'fixture-acp';
      });
      try {
        if (stage === 'success') {
          const session = await manager.createSession(config);
          const credentials = session.getGitHubCredentials();
          expect(credentials.mode).toBe('managed');
          if (credentials.mode !== 'managed') throw new Error('expected managed runtime');
          const file = credentials.lease.contextFilePath;
          expect(file && existsSync(file)).toBe(true);
          await manager.validateSessionCredentials(session, 'user-1');
          await manager.validateSessionCredentials(session, 'another-participant');
          await session.terminate(true);
          expect(credentials.lease.active).toBe(false);
          expect(file && existsSync(file)).toBe(false);
          await expect(manager.validateSessionCredentials(session, 'user-1')).rejects.toThrow(
            'github_runtime_context_invalid'
          );
        } else {
          await expect(manager.createSession(config)).rejects.toThrow('fixture');
          expect(manager.getSession(config.sessionId!)).toBeNull();
          const file = config.env?.LODY_GIT_CRED_CONTEXT_FILE;
          expect(typeof file).toBe('string');
          expect(file && existsSync(file)).toBe(false);
        }
      } finally {
        create.mockRestore();
        await broker.shutdown();
        vi.unstubAllEnvs();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

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
      // An obsolete managed preparation has the SAME logical Session ID.
      const stale = acquireSessionCredentialsLegacy(broker, {
        sessionId: 'local-session',
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
        prepareGitHubRepoSessionConfig(config: SessionConfig): Promise<SessionCredentials>;
      };
      const credentials = await prepare.prepareGitHubRepoSessionConfig(config);
      expect(config.env).toEqual(nativeEnv);
      expect(credentials.mode).toBe('native');
      expect(config.githubRepoUrl).toBe('git@github.com:owner/repo.git');
      const session = {
        sessionId: config.sessionId,
        getGitHubCredentials: () => credentials,
        updateEnv: (env: Record<string, string | undefined>) =>
          Object.assign(config.env ?? {}, env),
      } as ISession;
      await manager.validateSessionCredentials(session, 'user-2');
      expect(config.env).toEqual(nativeEnv);
      await manager.validateSessionCredentials(session, 'user-2');
      await stale.release();
      expect(config.env).toEqual(nativeEnv);
    }
  );
});
