import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeProjectPreparationProgress,
  type ACPSessionId,
  type AgentConfigId,
  type AgentConfigMeta,
  type LocalProjectId,
  type MachineId,
  type RepoId,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';

import { getDefaultSessionWorkdir, Session } from './session';
import { SessionManager, type ISession } from './session-manager';
import { createNoopSessionSandbox } from './session-sandbox';
import type { SessionConfig } from './types';
import type { LoroDocumentManager } from '../lib/loro/doc';
import type { Logger } from '../utils/logger';
import { runWorktreeSetup } from './worktree/worktree-setup-runner';
import { getLegacySpeculativeWorktreeMarkerPath } from './worktree/legacy-speculative-worktrees';
import { deriveRepoIdFromLocalProjectPath } from '@lody/shared/node/worktree-paths';
import { localProjectsLegacy } from '@lody/shared/node/local-project';
import {
  getWorktreeManager,
  type GitCredentialBrokerAuth,
  type WorktreeManagerSource,
} from './worktree/worktree-manager';
import { createLocalCloudPort } from '@lody/platform';
import * as codexProfiles from '../agent/codex-profile-store';

vi.mock('./worktree/worktree-setup-runner', () => ({
  runWorktreeSetup: vi.fn(async () => undefined),
}));

vi.mock('./worktree/worktree-setup-config-store', () => ({
  readLocalProjectWorktreeSetup: vi.fn(async () => ({
    scripts: { bash: 'echo setup' },
  })),
}));

const createLogger = (): Logger => {
  const logger: Logger = {
    debug: vi.fn(),
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(() => logger),
    close: vi.fn(async () => undefined),
  };
  return logger;
};

const createTestCloudPort = () =>
  createLocalCloudPort({ identity: { userId: 'user-1' }, workspaces: [] });

type FakeSessionDoc = {
  getMetaState: ReturnType<typeof vi.fn<() => Promise<SessionMeta | undefined>>>;
  setRepoFullName: ReturnType<typeof vi.fn<(repoFullName: string) => Promise<void>>>;
  setBaseBranch: ReturnType<typeof vi.fn<(baseBranch: string) => Promise<void>>>;
  setBranchName: ReturnType<typeof vi.fn<(branchName: string) => Promise<void>>>;
  setIsWorktree: ReturnType<typeof vi.fn<(isWorktree: boolean) => Promise<void>>>;
};

const createSessionDoc = (meta?: SessionMeta): FakeSessionDoc => ({
  getMetaState: vi.fn(async () => meta),
  setRepoFullName: vi.fn(async () => undefined),
  setBaseBranch: vi.fn(async () => undefined),
  setBranchName: vi.fn(async () => undefined),
  setIsWorktree: vi.fn(async () => undefined),
});

const createWorkspaceDocument = (docs: Map<SessionId, FakeSessionDoc>) =>
  ({
    getAgentConfigById: vi.fn(async () => null),
    getOrCreateSessionDoc: vi.fn(async (sessionId: SessionId) => {
      const existing = docs.get(sessionId);
      if (existing) {
        return existing;
      }
      const doc = createSessionDoc();
      docs.set(sessionId, doc);
      return doc;
    }),
    cleanUp: vi.fn(async () => undefined),
    // Some SessionManager paths dereference `repo` directly; keep the fake narrow.
    repo: {
      getDocMeta: vi.fn(async () => undefined),
      upsertDocMeta: vi.fn(async () => undefined),
    },
    persistPendingChanges: vi.fn(async () => undefined),
  }) as unknown as LoroDocumentManager;

const runGit = (cwd: string, args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const createLocalRepo = (rootDir: string): string => {
  const sourceDir = path.join(rootDir, 'source');
  runGit(rootDir, ['init', '-b', 'main', sourceDir]);
  writeFileSync(path.join(sourceDir, 'README.md'), '# local\n', 'utf8');
  runGit(sourceDir, ['add', '-A']);
  runGit(sourceDir, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'init',
  ]);
  return sourceDir;
};

const createSessionConfig = (
  overrides: Partial<SessionConfig> & Pick<SessionConfig, 'sessionId'>
): SessionConfig => ({
  workspaceId: 'workspace-1' as WorkspaceId,
  requesterUserId: 'user-1',
  machineId: 'machine-1' as MachineId,
  agentCliType: 'builtin',
  agentType: 'codex',
  mcpServerIds: [],
  assumeDocExisting: true,
  userName: 'Test User',
  userEmail: 'test@example.com',
  ...overrides,
});

const deferred = <T>() => {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

const createSessionInner = async (
  manager: SessionManager,
  config: SessionConfig
): Promise<ISession> =>
  await (
    manager as unknown as {
      createSessionInner(config: SessionConfig): Promise<ISession>;
    }
  ).createSessionInner(config);

describe('SessionManager repository Member credentials', () => {
  it('keeps a GitHub-source local-copy session native and never enrolls its host worktree', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'repository-member-auth-'));
    for (const key of Object.keys(process.env)) {
      if (/^(GIT_|SSH_|LODY_GIT_)/.test(key)) vi.stubEnv(key, undefined);
    }
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', os.devNull);
    try {
      const root = createLocalRepo(temp);
      runGit(root, ['remote', 'add', 'origin', 'https://github.com/example/web.git']);
      const workspaceDocument = createWorkspaceDocument(new Map());
      const manager = new SessionManager(
        createLogger(),
        'token',
        'machine-1' as MachineId,
        'workspace-1' as WorkspaceId,
        workspaceDocument,
        {
          sessionSandboxFactory: async () => createNoopSessionSandbox(),
          cloudPort: createTestCloudPort(),
        }
      );
      vi.spyOn(manager, 'resolveLocalProjectRootPath').mockImplementation(async (id) =>
        id === 'copy' ? root : temp
      );
      const phases: Array<{ phase: string; detail?: string }> = [];
      const config = createSessionConfig({
        onPresencePhase: (phase, detail) => phases.push({ phase, detail }),
        sessionId: 'repo-member' as SessionId,
        project: { kind: 'github', repoFullName: 'example/web' },
        projectRun: {
          id: '12345678-1234-4234-8234-123456789012' as never,
          name: 'Group',
          root: 'project-group-12345678-1234-4234-8234-123456789012',
          members: {
            ['docs' as keyof NonNullable<SessionConfig['projectRun']>['members']]: {
              o: 1,
              src: {
                kind: 'local',
                machineId: 'machine-1' as MachineId,
                localProjectId: 'docs' as LocalProjectId,
              },
              placement: { kind: 'root', dir: 'docs' },
              path: 'docs',
              base: 'HEAD',
            },
            ['web' as keyof NonNullable<SessionConfig['projectRun']>['members']]: {
              o: 0,
              src: { kind: 'github', repoFullName: 'example/web', preferLocal: true },
              placement: { kind: 'root', dir: 'web' },
              path: 'web',
              base: 'HEAD',
              repositoryCheckout: {
                kind: 'local',
                machineId: 'machine-1' as MachineId,
                localProjectId: 'copy' as LocalProjectId,
              },
            },
          },
        },
      });
      vi.spyOn(workspaceDocument, 'getOrCreateSessionDoc').mockResolvedValue({
        getMetaState: async () => ({ projectRun: config.projectRun }),
        setProjectRun: async (run: NonNullable<SessionConfig['projectRun']>) => {
          config.projectRun = run;
        },
      } as never);
      const internals = manager as unknown as {
        prepareGitHubRepoSessionConfig(
          config: SessionConfig
        ): Promise<import('./session-credentials').SessionCredentials>;
        ensureGitCredentialBrokerEnv(): Promise<never>;
        resolveHostGitBrokerAuth(
          source: WorktreeManagerSource,
          config: SessionConfig,
          credentials: import('./session-credentials').SessionCredentials
        ): Promise<GitCredentialBrokerAuth | undefined>;
      };
      vi.spyOn(internals, 'ensureGitCredentialBrokerEnv').mockRejectedValue(
        new Error('Unexpected broker enrollment')
      );
      const credentials = await internals.prepareGitHubRepoSessionConfig(config);
      expect(phases).toContainEqual({
        phase: 'git-clone',
        detail: encodeProjectPreparationProgress({ step: 'resolve' }),
      });
      expect(credentials.mode).toBe('native');
      expect(config.env).toBeUndefined();
      const releasedManaged = {
        mode: 'managed',
        lease: { active: false },
      } as unknown as import('./session-credentials').SessionCredentials;
      expect(
        await internals.resolveHostGitBrokerAuth(
          { kind: 'local-shared', originalRootPath: root },
          config,
          releasedManaged
        )
      ).toBeUndefined();
      await expect(
        internals.resolveHostGitBrokerAuth(
          { kind: 'github', repoUrl: 'https://github.com/example/managed.git' },
          config,
          releasedManaged
        )
      ).rejects.toMatchObject({ message: 'github_runtime_context_released' });
      await credentials.release();
    } finally {
      vi.unstubAllEnvs();
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe('SessionManager ACP project identity', () => {
  it.each([undefined, 'parent-session' as SessionId])(
    'resolves the registered root for local worktree sessions, including child %s',
    async (parentSessionId) => {
      const manager = new SessionManager(
        createLogger(),
        'test-token',
        'machine-1' as MachineId,
        'workspace-1' as WorkspaceId,
        createWorkspaceDocument(new Map()),
        {
          sessionSandboxFactory: async () => createNoopSessionSandbox(),
          cloudPort: createTestCloudPort(),
        }
      );
      const localProjectId = 'local-project' as LocalProjectId;
      vi.spyOn(manager, 'resolveLocalProjectRootPath').mockImplementation(async (id) => {
        if (id !== localProjectId) throw new Error('wrong project');
        return '/registered-project';
      });
      const config = createSessionConfig({
        sessionId: 'session-project' as SessionId,
        parentSessionId,
        project: { kind: 'local', localProjectId, useWorktree: true },
        workdir: '/execution-worktree',
      });
      const session = new Session(config, createLogger(), '/execution-worktree');
      const callbacks = (
        manager as unknown as {
          buildCreateAgentConfig(
            session: Session,
            config: SessionConfig,
            launch: { command: string; args: string[] }
          ): import('./session-manager').CreateAgentConfig;
        }
      ).buildCreateAgentConfig(session, config, { command: 'agent', args: [] });
      expect(await callbacks.resolveWorktreeProject?.()).toEqual({
        version: 1,
        originProjectPath: '/registered-project',
      });
    }
  );
});

describe('SessionManager Codex provider binding', () => {
  it('requires the live provider before restoring a ready managed profile', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lody-codex-launch-binding-'));
    const store = new codexProfiles.CodexProfileStore(root, {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined,
    });
    const storeSpy = vi.spyOn(codexProfiles, 'getCodexProfileStore').mockReturnValue(store);
    try {
      const provider: AgentConfigMeta = {
        id: 'codex-provider' as AgentConfigId,
        machineId: 'machine-1' as MachineId,
        name: 'Work Codex',
        description: undefined,
        cliType: 'builtin',
        agentType: 'codex',
        env: {},
        codexAuth: {
          mode: 'api-key',
          profileId: '989f09cf-0e9a-43b9-a44a-35fa8740a8e4',
          baseUrl: 'https://relay.example.invalid/v1',
        },
      };
      const readyProfile = await store.resolve('workspace-1', provider, true);
      if (!readyProfile) throw new Error('Expected a managed Codex profile');
      await store.withApiKeyCandidate(readyProfile, 'synthetic-key', async () => undefined);

      const workspaceDocument = createWorkspaceDocument(new Map());
      const getProvider = vi.mocked(workspaceDocument.getAgentConfigById);
      const manager = new SessionManager(
        createLogger(),
        'test-token',
        'machine-1' as MachineId,
        'workspace-1' as WorkspaceId,
        workspaceDocument,
        {
          sessionSandboxFactory: async () => createNoopSessionSandbox(),
          cloudPort: createTestCloudPort(),
        }
      );
      const freezeProfile = async (config: SessionConfig) =>
        await (
          manager as unknown as { freezeCodexProfile(config: SessionConfig): Promise<void> }
        ).freezeCodexProfile(config);
      const restoredConfig = () =>
        createSessionConfig({
          sessionId: 'codex-restore' as SessionId,
          agentConfigId: provider.id,
          codexAuth: provider.codexAuth,
        });

      getProvider.mockResolvedValue(null);
      await expect(freezeProfile(restoredConfig())).rejects.toThrow(
        'This Codex provider account is no longer available'
      );

      getProvider.mockResolvedValue({ ...provider, codexAuth: undefined });
      await expect(freezeProfile(restoredConfig())).rejects.toThrow(
        'This Codex provider account is no longer available'
      );

      getProvider.mockResolvedValue(provider);
      const validConfig = restoredConfig();
      await freezeProfile(validConfig);
      expect(validConfig.codexProfile).toMatchObject({
        configId: provider.id,
        profile: provider.codexAuth,
      });
    } finally {
      storeSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('SessionManager cleanup phases', () => {
  it('stops session producers before closing the workspace document', async () => {
    const workspaceDocument = createWorkspaceDocument(new Map());
    const manager = new SessionManager(
      createLogger(),
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      workspaceDocument,
      {
        sessionSandboxFactory: async () => createNoopSessionSandbox(),
        cloudPort: createTestCloudPort(),
      }
    );
    const cleanupSessionsSpy = vi
      .spyOn(manager as unknown as { cleanupSessions(): Promise<void> }, 'cleanupSessions')
      .mockResolvedValue();

    await manager.cleanUp({ keepWorkspaceDocumentOpen: true });

    expect(cleanupSessionsSpy).toHaveBeenCalledTimes(1);
    expect(workspaceDocument.cleanUp).not.toHaveBeenCalled();

    await manager.cleanUp();

    expect(cleanupSessionsSpy).toHaveBeenCalledTimes(2);
    expect(workspaceDocument.cleanUp).toHaveBeenCalledTimes(1);
    expect(cleanupSessionsSpy.mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(workspaceDocument.cleanUp).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
  });
});

describe('SessionManager child session workdir resolution', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'lody-session-manager-'));
    vi.stubEnv('HOME', tempHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it.each(['cold', 'parent'] as const)(
    'keeps requester auth through %s GitHub worktree creation',
    async (mode) => {
      vi.stubEnv('LODY_DATA_DIR', tempHome);
      const sourceDir = createLocalRepo(tempHome);
      const repoId = `github---fixture---${mode}` as RepoId;
      const repoUrl = pathToFileURL(sourceDir).href;
      const sessionId = `github-${mode}-startup` as SessionId;
      const parentId = 'github-parent-owner' as SessionId;
      runGit(sourceDir, ['branch', 'session/parent-restore']);
      const parentDoc = createSessionDoc({
        id: parentId,
        machineId: 'machine-1' as MachineId,
        userId: 'user-1',
        createdAt: '2026-06-20T00:00:00.000Z',
        cliType: 'builtin',
        agentType: 'codex',
        project: { kind: 'github', repoFullName: 'fixture/repo', branch: 'main' },
        isWorktree: true,
        baseBranch: 'main',
        branchName: 'session/parent-restore',
      });
      const manager = new SessionManager(
        createLogger(),
        'token',
        'machine-1' as MachineId,
        'workspace-1' as WorkspaceId,
        createWorkspaceDocument(new Map([[parentId, parentDoc]])),
        {
          sessionSandboxFactory: async () => createNoopSessionSandbox(),
          cloudPort: createTestCloudPort(),
        }
      );
      const auth: GitCredentialBrokerAuth = {
        workspaceId: 'workspace-1',
        url: 'http://fixture.invalid',
        token: 'fixture',
        contextToken: 'frozen-requester',
        transportEnv: {},
      };
      const internals = manager as unknown as {
        resolveHostGitBrokerAuth(
          source: WorktreeManagerSource,
          config: SessionConfig
        ): Promise<GitCredentialBrokerAuth>;
      };
      const authSpy = vi.spyOn(internals, 'resolveHostGitBrokerAuth').mockResolvedValue(auth);
      const worktrees = getWorktreeManager({ repoId, repoUrl, logger: createLogger() });
      const realCreate = worktrees.createWorktree.bind(worktrees);
      const createSpy = vi
        .spyOn(worktrees, 'createWorktree')
        .mockImplementation(async (...args) => {
          if (args[4] !== auth) throw new Error('requester auth was lost at the creation boundary');
          return realCreate(...args);
        });
      try {
        const session = await createSessionInner(
          manager,
          createSessionConfig({
            sessionId,
            repoId,
            githubRepo: 'fixture/repo',
            githubRepoUrl: repoUrl,
            parentSessionId: mode === 'parent' ? parentId : undefined,
            project: { kind: 'github', repoFullName: 'fixture/repo', branch: 'main' },
            worktreeSetup: { scripts: { bash: 'echo fixture' } },
          })
        );
        const workdir = session.getWorkdir();
        if (!workdir) throw new Error('missing materialized worktree');
        expect(runGit(workdir, ['rev-parse', 'HEAD'])).toBe(
          runGit(sourceDir, ['rev-parse', 'HEAD'])
        );
        expect(workdir).toBe(
          worktrees.getWorktreeHostPath(mode === 'parent' ? parentId : sessionId)
        );
        if (mode === 'parent')
          expect(runGit(workdir, ['branch', '--show-current'])).toBe('session/parent-restore');
      } finally {
        createSpy.mockRestore();
        authSpy.mockRestore();
      }
    }
  );

  it('reuses the parent default chat workdir for chat-only child sessions', async () => {
    const parentSessionId = 'parent-session' as SessionId;
    const childSessionId = 'child-session' as SessionId;
    const docs = new Map<SessionId, FakeSessionDoc>([
      [
        parentSessionId,
        createSessionDoc({
          id: parentSessionId,
          machineId: 'machine-1' as MachineId,
          userId: 'user-1',
          createdAt: '2026-06-20T00:00:00.000Z',
          cliType: 'builtin',
          agentType: 'codex',
        }),
      ],
    ]);
    const manager = new SessionManager(
      createLogger(),
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      createWorkspaceDocument(docs),
      {
        sessionSandboxFactory: async () => createNoopSessionSandbox(),
        cloudPort: createTestCloudPort(),
      }
    );

    const session = await createSessionInner(
      manager,
      createSessionConfig({
        sessionId: childSessionId,
        parentSessionId,
      })
    );

    const expectedWorkdir = getDefaultSessionWorkdir(parentSessionId);
    expect(session.getWorkdir()).toBe(expectedWorkdir);
    expect(existsSync(expectedWorkdir)).toBe(true);
  });

  it('persists a canonical parent base before recreating its local worktree', async () => {
    const sourceDir = createLocalRepo(tempHome);
    const parentSessionId = 'parent-base-persist' as SessionId;
    const childSessionId = 'child-base-persist' as SessionId;
    const localProjectId = 'local-project-parent-base' as LocalProjectId;
    const parentDoc = createSessionDoc({
      id: parentSessionId,
      machineId: 'machine-1' as MachineId,
      userId: 'user-1',
      createdAt: '2026-06-20T00:00:00.000Z',
      cliType: 'builtin',
      agentType: 'codex',
      project: {
        kind: 'local',
        localProjectId,
        branch: 'main',
        useWorktree: true,
      },
      baseBranch: 'main',
      isWorktree: true,
    });
    const docs = new Map<SessionId, FakeSessionDoc>([[parentSessionId, parentDoc]]);
    const workspaceDocument = createWorkspaceDocument(docs);
    const persistPendingChanges = vi.mocked(workspaceDocument.persistPendingChanges);
    persistPendingChanges.mockImplementation(async () => {
      expect(parentDoc.setBaseBranch).toHaveBeenCalledWith('refs/heads/main');
      expect(runGit(sourceDir, ['for-each-ref', '--format=%(refname)', 'refs/heads/lody/'])).toBe(
        ''
      );
    });
    const manager = new SessionManager(
      createLogger(),
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      workspaceDocument,
      {
        sessionSandboxFactory: async () => createNoopSessionSandbox(),
        cloudPort: createTestCloudPort(),
      }
    );

    const sharedWorkdir = await (
      manager as unknown as {
        resolveSharedWorkdir(config: SessionConfig, repoId: undefined): Promise<string | undefined>;
      }
    ).resolveSharedWorkdir(
      createSessionConfig({
        sessionId: childSessionId,
        parentSessionId,
        branch: 'main',
        workdir: sourceDir,
        project: {
          kind: 'local',
          localProjectId,
          branch: 'main',
          useWorktree: true,
        },
      }),
      undefined
    );

    expect(sharedWorkdir).toBeTruthy();
    expect(parentDoc.setBaseBranch).toHaveBeenCalledWith('refs/heads/main');
    expect(persistPendingChanges).toHaveBeenCalledWith('session-local-base-ref');
    expect(runGit(sourceDir, ['for-each-ref', '--format=%(refname)', 'refs/heads/lody/'])).toBe(
      'refs/heads/lody/parent-base-'
    );
  });

  it('bases a legacy worktree on the local branch that shadows a same-named remote', async () => {
    const sourceDir = createLocalRepo(tempHome);
    const parentSessionId = 'parent-shadowed-base' as SessionId;
    const childSessionId = 'child-shadowed-base' as SessionId;
    const localProjectId = 'local-project-shadowed-base' as LocalProjectId;
    // The shape every pre-selector project has: a `master` that exists both
    // locally and on origin. It used to fail the turn as ambiguous.
    const remoteCommit = runGit(sourceDir, ['rev-parse', 'main']);
    runGit(sourceDir, ['remote', 'add', 'origin', path.join(tempHome, 'origin.git')]);
    runGit(sourceDir, ['update-ref', 'refs/remotes/origin/master', remoteCommit]);
    runGit(sourceDir, ['branch', 'master']);

    const parentDoc = createSessionDoc({
      id: parentSessionId,
      machineId: 'machine-1' as MachineId,
      userId: 'user-1',
      createdAt: '2026-06-20T00:00:00.000Z',
      cliType: 'builtin',
      agentType: 'codex',
      project: {
        kind: 'local',
        localProjectId,
        branch: 'master',
        useWorktree: true,
      },
      baseBranch: 'master',
      isWorktree: true,
    });
    const docs = new Map<SessionId, FakeSessionDoc>([[parentSessionId, parentDoc]]);
    const workspaceDocument = createWorkspaceDocument(docs);
    const manager = new SessionManager(
      createLogger(),
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      workspaceDocument,
      {
        sessionSandboxFactory: async () => createNoopSessionSandbox(),
        cloudPort: createTestCloudPort(),
      }
    );

    const sharedWorkdir = await (
      manager as unknown as {
        resolveSharedWorkdir(config: SessionConfig, repoId: undefined): Promise<string | undefined>;
      }
    ).resolveSharedWorkdir(
      createSessionConfig({
        sessionId: childSessionId,
        parentSessionId,
        branch: 'master',
        workdir: sourceDir,
        project: {
          kind: 'local',
          localProjectId,
          branch: 'master',
          useWorktree: true,
        },
      }),
      undefined
    );

    expect(sharedWorkdir).toBeTruthy();
    expect(parentDoc.setBaseBranch).toHaveBeenCalledWith('refs/heads/master');
  });

  it('recreates a parent worktree from its recorded branch after a legacy base is deleted', async () => {
    const sourceDir = createLocalRepo(tempHome);
    const parentSessionId = 'parent-deleted-base' as SessionId;
    const childSessionId = 'child-deleted-base' as SessionId;
    const localProjectId = 'local-project-deleted-parent-base' as LocalProjectId;
    const remoteCommit = runGit(sourceDir, ['rev-parse', 'main']);
    runGit(sourceDir, ['remote', 'add', 'origin', path.join(tempHome, 'origin.git')]);
    runGit(sourceDir, ['update-ref', 'refs/remotes/origin/remote-base', remoteCommit]);
    runGit(sourceDir, ['branch', 'lody/parent-dele', 'refs/remotes/origin/remote-base']);
    runGit(sourceDir, ['update-ref', '-d', 'refs/remotes/origin/remote-base']);

    const parentDoc = createSessionDoc({
      id: parentSessionId,
      machineId: 'machine-1' as MachineId,
      userId: 'user-1',
      createdAt: '2026-06-20T00:00:00.000Z',
      cliType: 'builtin',
      agentType: 'codex',
      project: {
        kind: 'local',
        localProjectId,
        branch: 'remote-base',
        useWorktree: true,
      },
      baseBranch: 'remote-base',
      branchName: 'lody/parent-dele',
      isWorktree: true,
    });
    const docs = new Map<SessionId, FakeSessionDoc>([[parentSessionId, parentDoc]]);
    const workspaceDocument = createWorkspaceDocument(docs);
    const manager = new SessionManager(
      createLogger(),
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      workspaceDocument,
      {
        sessionSandboxFactory: async () => createNoopSessionSandbox(),
        cloudPort: createTestCloudPort(),
      }
    );

    const sharedWorkdir = await (
      manager as unknown as {
        resolveSharedWorkdir(config: SessionConfig, repoId: undefined): Promise<string | undefined>;
      }
    ).resolveSharedWorkdir(
      createSessionConfig({
        sessionId: childSessionId,
        parentSessionId,
        branch: 'remote-base',
        workdir: sourceDir,
        project: {
          kind: 'local',
          localProjectId,
          branch: 'remote-base',
          useWorktree: true,
        },
      }),
      undefined
    );

    expect(sharedWorkdir).toBeTruthy();
    expect(runGit(sharedWorkdir!, ['symbolic-ref', '--short', 'HEAD'])).toBe('lody/parent-dele');
    expect(parentDoc.setBaseBranch).not.toHaveBeenCalled();
    expect(workspaceDocument.persistPendingChanges).not.toHaveBeenCalled();
  });
});

describe('SessionManager worktree setup', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'lody-session-manager-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('LODY_LOCKS_DIR', path.join(tempHome, 'locks'));
    vi.mocked(runWorktreeSetup).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('reports the setup step only once a script starts, and names the sandbox after it', async () => {
    const sourceDir = createLocalRepo(tempHome);
    const temporary = Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' });
    const manager = new SessionManager(
      createLogger(),
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      createWorkspaceDocument(new Map<SessionId, FakeSessionDoc>()),
      {
        sessionSandboxFactory: async () => {
          throw temporary;
        },
        cloudPort: createTestCloudPort(),
      }
    );
    const start = (sessionId: string) => {
      const stages: string[] = [];
      const config = createSessionConfig({
        sessionId: sessionId as SessionId,
        branch: 'main',
        workdir: sourceDir,
        project: {
          kind: 'local',
          localProjectId: 'local-project-1' as LocalProjectId,
          branch: 'main',
          useWorktree: true,
        },
      });
      config.onStartStage = (stage) => stages.push(stage);
      return { stages, run: () => createSessionInner(manager, config) };
    };

    // No script ran, so a failure after the worktree is not blamed on setup.
    const withoutScript = start('setup-stage-none');
    await expect(withoutScript.run()).rejects.toBe(temporary);
    expect(withoutScript.stages).toEqual(['workdir', 'worktree', 'sandbox']);

    const scriptFailure = new Error('setup script failed');
    vi.mocked(runWorktreeSetup).mockImplementationOnce(async (options) => {
      // The fixture doc has no history port; only the reported step matters here.
      await Promise.resolve(
        options.events?.onStart?.({
          phase: 'setup',
          shell: 'bash',
          displayCommand: 'pnpm install',
          command: 'bash',
          args: [],
          workdir: options.workdir,
        })
      ).catch(() => undefined);
      throw scriptFailure;
    });
    const withScript = start('setup-stage-script');
    await expect(withScript.run()).rejects.toBe(scriptFailure);
    expect(withScript.stages).toEqual(['workdir', 'worktree', 'worktree-setup']);
  });

  it('does not rerun setup or switch branches when restoring an existing local worktree', async () => {
    const sourceDir = createLocalRepo(tempHome);
    const sessionId = 'setup-resume-session' as SessionId;
    const localProjectId = 'local-project-1' as LocalProjectId;
    const docs = new Map<SessionId, FakeSessionDoc>();
    const manager = new SessionManager(
      createLogger(),
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      createWorkspaceDocument(docs),
      {
        sessionSandboxFactory: async () => createNoopSessionSandbox(),
        cloudPort: createTestCloudPort(),
      }
    );

    const config = createSessionConfig({
      sessionId,
      branch: 'main',
      workdir: sourceDir,
      project: {
        kind: 'local',
        localProjectId,
        branch: 'main',
        useWorktree: true,
      },
    });

    const createdSession = await createSessionInner(manager, config);
    expect(runWorktreeSetup).toHaveBeenCalledTimes(1);
    const workdir = createdSession.getWorkdir();
    runGit(workdir, ['switch', '-c', 'user/switched-worktree']);
    writeFileSync(path.join(workdir, 'dirty.txt'), 'keep me\n', 'utf8');

    const resumedSession = await createSessionInner(manager, {
      ...config,
      resume: true,
    });

    expect(runWorktreeSetup).toHaveBeenCalledTimes(1);
    expect(resumedSession.getWorkdir()).toBe(workdir);
    expect(runGit(workdir, ['symbolic-ref', '--short', 'HEAD'])).toBe('user/switched-worktree');
    expect(runGit(workdir, ['status', '--porcelain'])).toContain('?? dirty.txt');
  });

  const writeLegacyPreparationMarker = (input: {
    sessionId: SessionId;
    sourceDir: string;
    baseBranch: string;
    phase: 'speculative' | 'durable-pending-setup';
  }): string => {
    const originalRootPath = localProjectsLegacy.normalizeLocalProjectRootPath(input.sourceDir);
    const markerPath = getLegacySpeculativeWorktreeMarkerPath(input.sessionId);
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify({
        version: 1,
        preparationId: `prepare-${input.sessionId}`,
        sessionId: input.sessionId,
        workspaceId: 'workspace-1',
        machineId: 'machine-1',
        repoId: deriveRepoIdFromLocalProjectPath(originalRootPath),
        source: { kind: 'local-shared', originalRootPath },
        baseBranch: input.baseBranch,
        ownsWorktree: true,
        phase: input.phase,
        createdAtMs: 0,
      })
    );
    return markerPath;
  };

  const createLocalWorktreeManager = (docs: Map<SessionId, FakeSessionDoc>) =>
    new SessionManager(
      createLogger(),
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      createWorkspaceDocument(docs),
      {
        sessionSandboxFactory: async () => createNoopSessionSandbox(),
        cloudPort: createTestCloudPort(),
      }
    );

  /** `restoreBranchName` set means the shape of a real resume, which restores by name. */
  const localWorktreeConfig = (
    sessionId: SessionId,
    sourceDir: string,
    restoreBranchName?: string
  ) =>
    createSessionConfig({
      sessionId,
      branch: 'main',
      workdir: sourceDir,
      resume: restoreBranchName !== undefined,
      ...(restoreBranchName ? { restoreBranchName } : {}),
      project: {
        kind: 'local',
        localProjectId: 'local-project-legacy' as LocalProjectId,
        branch: 'main',
        useWorktree: true,
      },
    });

  const currentBranch = (workdir: string) => runGit(workdir, ['symbolic-ref', '--short', 'HEAD']);

  it('reruns setup on resume when an older daemon left it pending', async () => {
    const sourceDir = createLocalRepo(tempHome);
    const sessionId = 'setup-legacy-pending' as SessionId;
    const manager = createLocalWorktreeManager(new Map());

    const created = await createSessionInner(manager, localWorktreeConfig(sessionId, sourceDir));
    expect(runWorktreeSetup).toHaveBeenCalledTimes(1);
    const branchName = currentBranch(created.getWorkdir());
    writeFileSync(path.join(created.getWorkdir(), 'keep.txt'), 'reused\n', 'utf8');
    const markerPath = writeLegacyPreparationMarker({
      sessionId,
      sourceDir,
      baseBranch: 'main',
      phase: 'durable-pending-setup',
    });

    const resumed = await createSessionInner(
      manager,
      localWorktreeConfig(sessionId, sourceDir, branchName)
    );

    expect(resumed.getWorkdir()).toBe(created.getWorkdir());
    expect(existsSync(path.join(created.getWorkdir(), 'keep.txt'))).toBe(true);
    expect(runWorktreeSetup).toHaveBeenCalledTimes(2);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('resumes an adopted worktree whose recorded base branch is spelled differently', async () => {
    const sourceDir = createLocalRepo(tempHome);
    const sessionId = 'setup-legacy-drift' as SessionId;
    const manager = createLocalWorktreeManager(new Map());

    const created = await createSessionInner(manager, localWorktreeConfig(sessionId, sourceDir));
    const branchName = currentBranch(created.getWorkdir());
    writeFileSync(path.join(created.getWorkdir(), 'keep.txt'), 'reused\n', 'utf8');
    // A first create records the resolved ref; resume passes the project selector.
    const markerPath = writeLegacyPreparationMarker({
      sessionId,
      sourceDir,
      baseBranch: 'refs/heads/main',
      phase: 'durable-pending-setup',
    });

    const resumed = await createSessionInner(
      manager,
      localWorktreeConfig(sessionId, sourceDir, branchName)
    );

    expect(resumed.getWorkdir()).toBe(created.getWorkdir());
    expect(currentBranch(resumed.getWorkdir())).toBe(branchName);
    expect(existsSync(path.join(created.getWorkdir(), 'keep.txt'))).toBe(true);
    expect(runWorktreeSetup).toHaveBeenCalledTimes(2);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('rebuilds an unadopted worktree an older daemon prepared for another base branch', async () => {
    const sourceDir = createLocalRepo(tempHome);
    const sessionId = 'setup-legacy-mismatch' as SessionId;
    const manager = createLocalWorktreeManager(new Map());

    // Stands in for the directory a preparation materialized for the draft.
    const prepared = await createSessionInner(manager, localWorktreeConfig(sessionId, sourceDir));
    const workdir = prepared.getWorkdir();
    writeFileSync(path.join(workdir, 'stale.txt'), 'from the old base\n', 'utf8');
    const markerPath = writeLegacyPreparationMarker({
      sessionId,
      sourceDir,
      baseBranch: 'dev',
      phase: 'speculative',
    });

    const created = await createSessionInner(manager, localWorktreeConfig(sessionId, sourceDir));

    expect(created.getWorkdir()).toBe(workdir);
    expect(existsSync(path.join(workdir, 'stale.txt'))).toBe(false);
    expect(runWorktreeSetup).toHaveBeenCalledTimes(2);
    expect(existsSync(markerPath)).toBe(false);
  });
});

describe('SessionManager.requestSessionTerminate', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'lody-session-manager-'));
    vi.stubEnv('HOME', tempHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempHome, { recursive: true, force: true });
  });

  const buildManager = () =>
    new SessionManager(
      createLogger(),
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      createWorkspaceDocument(new Map()),
      {
        sessionSandboxFactory: async () => createNoopSessionSandbox(),
        cloudPort: createTestCloudPort(),
      }
    );

  it('terminates a resident session', async () => {
    const manager = buildManager();
    const sessionId = 'resident-session' as SessionId;
    const session = await createSessionInner(manager, createSessionConfig({ sessionId }));
    const terminate = vi.spyOn(session, 'terminate').mockResolvedValue(undefined);

    await expect(manager.requestSessionTerminate(sessionId)).resolves.toBe('terminated');
    expect(terminate).toHaveBeenCalledWith(true);
  });

  it('reports not-found for a session that is neither resident nor pending', async () => {
    const manager = buildManager();
    await expect(manager.requestSessionTerminate('ghost-session' as SessionId)).resolves.toBe(
      'not-found'
    );
  });

  it('waits for a still-starting session to terminate', async () => {
    const manager = buildManager();
    const sessionId = 'pending-session' as SessionId;
    let resolvePending: ((session: ISession) => void) | undefined;
    const pending = new Promise<ISession>((resolve) => {
      resolvePending = resolve;
    });
    const terminate = vi.fn(async () => undefined);
    (
      manager as unknown as {
        pendingSessionCreates: Map<SessionId, Promise<ISession>>;
      }
    ).pendingSessionCreates.set(sessionId, pending);

    const result = manager.requestSessionTerminate(sessionId);
    let settled = false;
    void result.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolvePending?.({ terminate } as unknown as ISession);
    await expect(result).resolves.toBe('terminated');
    expect(terminate).toHaveBeenCalledWith(true);
  });

  it('rejects when a still-starting session cannot be terminated', async () => {
    const manager = buildManager();
    const sessionId = 'pending-session' as SessionId;
    const terminate = vi.fn(async () => {
      throw new Error('terminate failed');
    });
    (
      manager as unknown as {
        pendingSessionCreates: Map<SessionId, Promise<ISession>>;
      }
    ).pendingSessionCreates.set(sessionId, Promise.resolve({ terminate } as unknown as ISession));

    await expect(manager.requestSessionTerminate(sessionId)).rejects.toThrow('terminate failed');
  });
});

describe('SessionManager durable create ownership', () => {
  it('registers the pending session before startup work begins', async () => {
    const manager = new SessionManager(
      createLogger(),
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      createWorkspaceDocument(new Map()),
      {
        sessionSandboxFactory: async () => createNoopSessionSandbox(),
        cloudPort: createTestCloudPort(),
      }
    );
    const sessionId = 'ownership-session' as SessionId;
    const created = deferred<ISession>();
    (
      manager as unknown as {
        createSessionInnerWithAgent: () => Promise<ISession>;
      }
    ).createSessionInnerWithAgent = async () => await created.promise;

    const result = manager.createSession(createSessionConfig({ sessionId }));

    expect(manager.getPendingSession(sessionId)).not.toBeNull();

    const session = { sessionId } as ISession;
    created.resolve(session);
    await expect(result).resolves.toBe(session);
    expect(manager.getPendingSession(sessionId)).toBeNull();
  });

  const buildOwnershipManager = () =>
    new SessionManager(
      createLogger(),
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      createWorkspaceDocument(new Map()),
      {
        sessionSandboxFactory: async () => createNoopSessionSandbox(),
        cloudPort: createTestCloudPort(),
      }
    );

  it('hands a retry a fresh create after a wedged one is abandoned', async () => {
    const manager = buildOwnershipManager();
    const sessionId = 'wedged-create-session' as SessionId;
    const attempts: Array<ReturnType<typeof deferred<ISession>>> = [];
    // A create wedged inside a managed-runtime install or ACP startup: the
    // first attempt's promise is never resolved by this test.
    const createInnerWithAgent = vi.fn(async () => {
      const pending = deferred<ISession>();
      attempts.push(pending);
      return await pending.promise;
    });
    (
      manager as unknown as {
        createSessionInnerWithAgent: typeof createInnerWithAgent;
      }
    ).createSessionInnerWithAgent = createInnerWithAgent;
    const config = createSessionConfig({ sessionId });

    void manager.createSession(config).catch(() => undefined);
    await Promise.resolve();
    const wedged = manager.getPendingSession(sessionId);
    expect(wedged).not.toBeNull();

    // Deduplication hands a naive retry the very same wedged promise, so it
    // would stall exactly like the first attempt.
    void manager.createSession(config).catch(() => undefined);
    await Promise.resolve();
    expect(manager.getPendingSession(sessionId)).toBe(wedged);

    expect(manager.abandonPendingSessionCreate(sessionId, 'initialization-stalled')).toBe(true);
    expect(manager.getPendingSession(sessionId)).toBeNull();

    // The retry now reaches a genuinely new create and completes, which is the
    // self-healing the stall watchdog promises.
    const retry = manager.createSession(config);
    await Promise.resolve();
    expect(manager.getPendingSession(sessionId)).not.toBe(wedged);
    const retrySession = {
      sessionId,
      terminate: vi.fn(async () => undefined),
    } as unknown as ISession;
    attempts[1]?.resolve(retrySession);
    await expect(retry).resolves.toBe(retrySession);
  });

  it('terminates a session that materializes from an abandoned create', async () => {
    const manager = buildOwnershipManager();
    const sessionId = 'late-create-session' as SessionId;
    const created = deferred<ISession>();
    const createInnerWithAgent = vi.fn(async () => await created.promise);
    (
      manager as unknown as {
        createSessionInnerWithAgent: typeof createInnerWithAgent;
      }
    ).createSessionInnerWithAgent = createInnerWithAgent;

    void manager.createSession(createSessionConfig({ sessionId })).catch(() => undefined);
    await Promise.resolve();
    expect(manager.abandonPendingSessionCreate(sessionId, 'initialization-stalled')).toBe(true);

    // The abandoned create wins the race after nobody is waiting for it. Its
    // Session was never handed to a caller, so it must not survive as an orphan.
    const terminate = vi.fn(async () => undefined);
    created.resolve({ sessionId, terminate } as unknown as ISession);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(terminate).toHaveBeenCalledWith(true);
  });

  it('reaps a late orphan without unregistering or finalizing the retry that replaced it', async () => {
    const manager = buildOwnershipManager();
    const sessionId = 'orphan-after-replacement-session' as SessionId;
    const config = createSessionConfig({ sessionId });
    const managerTerminated: SessionId[] = [];
    manager.on('terminated', (event: { sessionId: SessionId }) => {
      managerTerminated.push(event.sessionId);
    });

    const orphanCreate = deferred<ISession>();
    const replacementCreate = deferred<ISession>();
    let attempt = 0;
    (
      manager as unknown as {
        createSessionInnerWithAgent: () => Promise<ISession>;
      }
    ).createSessionInnerWithAgent = async () =>
      await (++attempt === 1 ? orphanCreate.promise : replacementCreate.promise);

    // Attempt 1 registers its Session (manager listeners attached) and then
    // wedges in managed-runtime resolution or ACP startup — both of which run
    // AFTER `createSessionInner` has published it.
    void manager.createSession(config).catch(() => undefined);
    await Promise.resolve();
    const orphan = (await createSessionInner(manager, config)) as Session;
    expect(manager.abandonPendingSessionCreate(sessionId, 'initialization-stalled')).toBe(true);

    // The retry publishes a healthy replacement under the same id and completes.
    const retry = manager.createSession(config);
    await Promise.resolve();
    const replacement = await createSessionInner(manager, config);
    replacementCreate.resolve(replacement);
    await expect(retry).resolves.toBe(replacement);
    expect(manager.getSession(sessionId)).toBe(replacement);

    // Only now does the orphan's wedged startup return.
    const orphanTerminated = new Promise<void>((resolve) => {
      orphan.once('terminated', () => resolve());
    });
    orphanCreate.resolve(orphan);
    await orphanTerminated;
    await Promise.resolve();

    // The orphan is gone, but its death is invisible to the manager: the
    // replacement stays registered, and MessageHandler never hears a
    // `terminated` for this id that would finalize the replacement's live turn.
    expect(manager.getSession(sessionId)).toBe(replacement);
    expect(managerTerminated).toEqual([]);
  });

  it('does not forward an old runtime exit as the replacement runtime death', async () => {
    const manager = buildOwnershipManager();
    const sessionId = 'runtime-generation-events' as SessionId;
    const config = createSessionConfig({ sessionId });
    const exits: string[] = [];
    manager.on('exit', () => exits.push('exit'));
    manager.on('terminated', () => exits.push('terminated'));
    const previous = (await createSessionInner(manager, config)) as Session;
    const replacement = await createSessionInner(manager, config);
    previous.emit('exit', { sessionId, exitCode: 0 });
    await previous.terminate(true);
    expect(manager.getSession(sessionId)).toBe(replacement);
    expect(exits).toEqual([]);
    await replacement.terminate(true);
    expect(manager.getSession(sessionId)).toBeNull();
    expect(exits).toEqual(['terminated']);
  });

  it('keeps a failed Session registered until independent cleanup succeeds', async () => {
    const manager = buildOwnershipManager();
    const sessionId = 'retained-cleanup' as SessionId;
    const session = await createSessionInner(manager, createSessionConfig({ sessionId }));
    const original = session.terminate.bind(session);
    const failure = new Error('synthetic retained-resource failure');
    session.terminate = async () => {
      throw failure;
    };
    await expect(manager.cleanUp({ keepWorkspaceDocumentOpen: true })).rejects.toBeInstanceOf(
      AggregateError
    );
    expect(manager.getSession(sessionId)).toBe(session);
    session.terminate = original;
    await manager.cleanUp({ keepWorkspaceDocumentOpen: true });
    expect(manager.getSession(sessionId)).toBeNull();
  });

  it('reports no entry to abandon when the create already settled', async () => {
    const manager = buildOwnershipManager();
    const sessionId = 'settled-create-session' as SessionId;
    expect(manager.abandonPendingSessionCreate(sessionId, 'initialization-stalled')).toBe(false);
  });

  it('stops waiting on a wedged create instead of hanging teardown', async () => {
    vi.useFakeTimers();
    try {
      const manager = buildOwnershipManager();
      const sessionId = 'wedged-terminate-session' as SessionId;
      (
        manager as unknown as {
          pendingSessionCreates: Map<SessionId, Promise<ISession>>;
        }
      ).pendingSessionCreates.set(sessionId, new Promise<ISession>(() => {}));

      const result = manager.requestSessionTerminate(sessionId);
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      // Teardown gives the create its deadline and then detaches, rather than
      // waiting on a promise that will never settle.
      await vi.advanceTimersByTimeAsync(300_000);
      await expect(result).resolves.toBe('terminated');
      expect(manager.getPendingSession(sessionId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SessionManager failed agent creation', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'lody-session-manager-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('LODY_LOCKS_DIR', path.join(tempHome, 'locks'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('rejects a replacement native conversation before changing the durable resume pointer', async () => {
    const sourceDir = createLocalRepo(tempHome);
    const sessionId = 'strict-native-resume' as SessionId;
    let persisted = 'native-original';
    const doc = {
      ...createSessionDoc(),
      setACPSessionId: async (id: ACPSessionId) => {
        persisted = id;
      },
    };
    const manager = new SessionManager(
      createLogger(),
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      createWorkspaceDocument(new Map([[sessionId, doc]])),
      {
        sessionSandboxFactory: async () => createNoopSessionSandbox(),
        cloudPort: createTestCloudPort(),
      }
    );
    vi.spyOn(Session.prototype, 'createAgent').mockResolvedValue('native-replacement');
    await expect(
      manager.createSession(
        createSessionConfig({
          sessionId,
          agentCliType: 'custom',
          agentType: 'synthetic',
          customAcp: { command: 'never-started', args: [] },
          workdir: sourceDir,
        }),
        { resumeSessionId: 'native-original' as ACPSessionId, requireExactResume: true }
      )
    ).rejects.toThrow('AUTOMATION_NATIVE_RESUME_UNCONFIRMED');
    expect(persisted).toBe('native-original');
    expect(manager.getSession(sessionId)).toBeNull();
    expect(manager.getPendingSession(sessionId)).toBeNull();
  });

  it('publishes no lifecycle events for an instance whose agent never started', async () => {
    const sourceDir = createLocalRepo(tempHome);
    const sessionId = 'agent-start-failed' as SessionId;
    const docs = new Map<SessionId, FakeSessionDoc>();
    const manager = new SessionManager(
      createLogger(),
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      createWorkspaceDocument(docs),
      {
        sessionSandboxFactory: async () => createNoopSessionSandbox(),
        cloudPort: createTestCloudPort(),
      }
    );
    const terminated = vi.fn();
    const exit = vi.fn();
    manager.on('terminated', terminated);
    manager.on('exit', exit);
    const config = createSessionConfig({
      sessionId,
      agentCliType: 'custom',
      agentType: 'custom-agent',
      customAcp: { command: 'agent', args: [] },
      workdir: sourceDir,
    });
    const createAgent = vi
      .spyOn(Session.prototype, 'createAgent')
      .mockRejectedValueOnce(
        new Error('[ACP_RESUME_UNSUPPORTED] agent_did_not_advertise_resume_or_loadSession')
      );

    // The resume attempt fails after the instance was registered. A consumer
    // that treats `terminated` as "the session running this turn died" would
    // finalize the live turn here and lose the replacement agent's output.
    await expect(
      manager.createSession(config, { resumeSessionId: 'acp-old' as ACPSessionId })
    ).rejects.toThrow('ACP_RESUME_UNSUPPORTED');
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(manager.getSession(sessionId)).toBeNull();
    expect(terminated).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    // The replacement under the same id is a normal live session: it is the
    // one in the map and its termination still reaches consumers.
    createAgent.mockResolvedValueOnce('acp-replacement');
    const sessionDoc = docs.get(sessionId) as FakeSessionDoc & {
      setACPSessionId?: (id: ACPSessionId) => Promise<void>;
    };
    sessionDoc.setACPSessionId = vi.fn(async () => undefined);
    const replacement = await manager.createSession(config);
    expect(manager.getSession(sessionId)).toBe(replacement);
    expect(terminated).not.toHaveBeenCalled();

    await manager.retireSessionForReconfiguration(replacement);
    expect(manager.getSession(sessionId)).toBeNull();
    expect(terminated).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    createAgent.mockResolvedValueOnce('acp-memory');
    const memory = { providerId: 'nowledge-mem', memoryId: 'reviewer' };
    const reconfigured = await manager.createSession({ ...config, memory });
    expect(reconfigured.getMemoryBinding?.()).toEqual(memory);
    expect(manager.getSession(sessionId)).toBe(reconfigured);
    await manager.terminateSession(sessionId, true);
    expect(terminated).toHaveBeenCalledTimes(1);
    expect(terminated).toHaveBeenCalledWith(expect.objectContaining({ sessionId }));
    expect(manager.getSession(sessionId)).toBeNull();
  });
});
