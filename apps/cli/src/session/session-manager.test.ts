import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSessionPreparationClaimKey,
  buildSessionPreparationRequestKey,
  buildSessionLaunchConfig,
  type AgentConfigId,
  type LocalProjectId,
  type MachineId,
  type SessionId,
  type SessionLaunchConfig,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { deriveRepoIdFromLocalProjectPath } from '@lody/shared/node/worktree-paths';
import { normalizeLocalProjectRootPath } from '@lody/shared/node/local-project';

import { getDefaultSessionWorkdir } from './session';
import { SessionManager, type ISession } from './session-manager';
import { createNoopSessionSandbox } from './session-sandbox';
import type { SessionConfig } from './types';
import type { LoroDocumentManager } from '../lib/loro/doc';
import type { Logger } from '../utils/logger';
import { runWorktreeSetup } from './worktree/worktree-setup-runner';
import { getWorktreeManager, type WorktreeInfo } from './worktree/worktree-manager';
import { materializeSpeculativeWorktree } from './worktree/speculative-worktree';
import {
  SessionPreparationService,
  type SessionPreparationResource,
} from './session-preparation-service';
import { createLocalCloudPort } from '@lody/platform';

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
  config: SessionConfig,
  preparedWorktree?: WorktreeInfo
): Promise<ISession> =>
  await (
    manager as unknown as {
      createSessionInner(
        config: SessionConfig,
        preparedSession?: undefined,
        preparedWorktree?: WorktreeInfo
      ): Promise<ISession>;
    }
  ).createSessionInner(config, undefined, preparedWorktree);

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

  it('runs setup only after a speculative worktree is adopted by durable creation', async () => {
    const sourceDir = createLocalRepo(tempHome);
    const originalRootPath = normalizeLocalProjectRootPath(sourceDir);
    const sessionId = 'setup-prepared-session' as SessionId;
    const localProjectId = 'local-project-prepared' as LocalProjectId;
    const repoId = deriveRepoIdFromLocalProjectPath(originalRootPath);
    const logger = createLogger();
    const docs = new Map<SessionId, FakeSessionDoc>();
    const manager = new SessionManager(
      logger,
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      createWorkspaceDocument(docs),
      {
        sessionSandboxFactory: async () => createNoopSessionSandbox(),
      }
    );
    const worktreeManager = getWorktreeManager({
      repoId,
      source: {
        kind: 'local-shared',
        originalRootPath,
      },
      logger,
    });
    const preparedWorktree = await materializeSpeculativeWorktree({
      preparationId: 'prepare-setup-session',
      sessionId,
      workspaceId: 'workspace-1' as WorkspaceId,
      machineId: 'machine-1' as MachineId,
      manager: worktreeManager,
      managerConfig: {
        repoId,
        source: {
          kind: 'local-shared',
          originalRootPath,
        },
      },
      baseBranch: 'main',
      logger,
    });

    expect(runWorktreeSetup).not.toHaveBeenCalled();
    await preparedWorktree.claim();

    const session = await createSessionInner(
      manager,
      createSessionConfig({
        sessionId,
        branch: 'main',
        workdir: sourceDir,
        project: {
          kind: 'local',
          localProjectId,
          branch: 'main',
          useWorktree: true,
        },
      }),
      preparedWorktree.info
    );

    expect(session.getWorkdir()).toBe(preparedWorktree.info.hostPath);
    expect(runWorktreeSetup).toHaveBeenCalledTimes(1);
    await preparedWorktree.dispose();
    expect(existsSync(preparedWorktree.info.hostPath)).toBe(true);
  });

  it('retries setup after a durable create fails with a prepared worktree', async () => {
    const sourceDir = createLocalRepo(tempHome);
    const originalRootPath = normalizeLocalProjectRootPath(sourceDir);
    const sessionId = 'setup-prepared-retry' as SessionId;
    const localProjectId = 'local-project-prepared-retry' as LocalProjectId;
    const repoId = deriveRepoIdFromLocalProjectPath(originalRootPath);
    const logger = createLogger();
    const manager = new SessionManager(
      logger,
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      createWorkspaceDocument(new Map()),
      {
        sessionSandboxFactory: async () => createNoopSessionSandbox(),
      }
    );
    const worktreeManager = getWorktreeManager({
      repoId,
      source: {
        kind: 'local-shared',
        originalRootPath,
      },
      logger,
    });
    const preparedWorktree = await materializeSpeculativeWorktree({
      preparationId: 'prepare-setup-retry',
      sessionId,
      workspaceId: 'workspace-1' as WorkspaceId,
      machineId: 'machine-1' as MachineId,
      manager: worktreeManager,
      managerConfig: {
        repoId,
        source: {
          kind: 'local-shared',
          originalRootPath,
        },
      },
      baseBranch: 'main',
      logger,
    });
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
    vi.mocked(runWorktreeSetup).mockRejectedValueOnce(new Error('setup failed'));
    await preparedWorktree.claim();

    await expect(createSessionInner(manager, config, preparedWorktree.info)).rejects.toThrow(
      'setup failed'
    );
    expect(runWorktreeSetup).toHaveBeenCalledTimes(1);
    expect(existsSync(preparedWorktree.info.hostPath)).toBe(true);
    expect(worktreeManager.hasWorktree(sessionId)).toBe(true);

    vi.mocked(runWorktreeSetup).mockResolvedValue(undefined);
    await expect(createSessionInner(manager, { ...config, resume: true })).resolves.toBeDefined();
    expect(runWorktreeSetup).toHaveBeenCalledTimes(2);

    await preparedWorktree.dispose();
    expect(existsSync(preparedWorktree.info.hostPath)).toBe(true);
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
  it('registers the pending session before preparation claim or cold-start work begins', async () => {
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
    const createFromPreparationOrCold = vi.fn(async () => await created.promise);
    (
      manager as unknown as {
        createSessionFromPreparationOrCold: typeof createFromPreparationOrCold;
      }
    ).createSessionFromPreparationOrCold = createFromPreparationOrCold;

    const result = manager.createSession(createSessionConfig({ sessionId }));

    expect(manager.getPendingSession(sessionId)).not.toBeNull();
    expect(createFromPreparationOrCold).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(createFromPreparationOrCold).toHaveBeenCalledTimes(1);

    const session = { sessionId } as ISession;
    created.resolve(session);
    await expect(result).resolves.toBe(session);
    expect(manager.getPendingSession(sessionId)).toBeNull();
  });
});

describe('SessionManager preparation compatibility', () => {
  it('waits for a published preparation to release its worktree when durable launch config is absent', async () => {
    const manager = new SessionManager(
      createLogger(),
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      createWorkspaceDocument(new Map()),
      {
        sessionSandboxFactory: async () => createNoopSessionSandbox(),
      }
    );
    const sessionId = 'missing-agent-config-cold-fallback' as SessionId;
    const cleanup = deferred<void>();
    type PreparedTestResource = SessionPreparationResource & {
      compatibility: SessionLaunchConfig | undefined;
    };
    const prepared = {
      compatibility: buildSessionLaunchConfig({}),
      initialized: Promise.resolve(),
      sessionReady: Promise.resolve(),
      dispose: vi.fn(async () => await cleanup.promise),
    } satisfies PreparedTestResource;
    const internals = manager as unknown as {
      preparationService: SessionPreparationService<PreparedTestResource>;
      createSessionFromPreparationOrCold(config: SessionConfig): Promise<ISession>;
      createSessionInnerWithAgent(config: SessionConfig): Promise<ISession>;
    };
    internals.preparationService.start({
      preparationId: 'prepare-missing-agent-config',
      sessionId,
      requesterUserId: 'user-1',
      requestKey: 'no-agent-config',
      create: async () => prepared,
    });
    await vi.waitFor(() =>
      expect(internals.preparationService.getState(sessionId)).toBe('session-ready')
    );
    const coldSession = { sessionId } as ISession;
    const coldCreate = vi
      .spyOn(internals, 'createSessionInnerWithAgent')
      .mockResolvedValue(coldSession);
    const config = createSessionConfig({ sessionId });

    const result = internals.createSessionFromPreparationOrCold(config);
    await vi.waitFor(() => expect(prepared.dispose).toHaveBeenCalledTimes(1));
    expect(coldCreate).not.toHaveBeenCalled();

    cleanup.resolve(undefined);
    await expect(result).resolves.toBe(coldSession);
    expect(coldCreate).toHaveBeenCalledWith(config, undefined);
  });

  it('waits for an incompatible published preparation to release its worktree before cold start', async () => {
    const manager = new SessionManager(
      createLogger(),
      'token',
      'machine-1' as MachineId,
      'workspace-1' as WorkspaceId,
      createWorkspaceDocument(new Map()),
      {
        sessionSandboxFactory: async () => createNoopSessionSandbox(),
      }
    );
    const sessionId = 'changed-project-cold-fallback' as SessionId;
    const agentConfigId = 'agent-1' as AgentConfigId;
    const cleanup = deferred<void>();
    type PreparedTestResource = SessionPreparationResource & {
      compatibility: SessionLaunchConfig | undefined;
    };
    const prepared = {
      compatibility: buildSessionLaunchConfig({}),
      initialized: Promise.resolve(),
      sessionReady: Promise.resolve(),
      dispose: vi.fn(async () => await cleanup.promise),
    } satisfies PreparedTestResource;
    const preparedIdentity = {
      requestedByUserId: 'user-1',
      agentConfigId,
      cliType: 'builtin' as const,
      agentType: 'codex',
      project: {
        kind: 'github' as const,
        repoFullName: 'loro-dev/old-project',
        branch: 'main',
      },
    };
    const internals = manager as unknown as {
      preparationService: SessionPreparationService<PreparedTestResource>;
      createSessionFromPreparationOrCold(config: SessionConfig): Promise<ISession>;
      createSessionInnerWithAgent(config: SessionConfig): Promise<ISession>;
    };
    internals.preparationService.start({
      preparationId: 'prepare-old-project',
      sessionId,
      requesterUserId: 'user-1',
      requestKey: buildSessionPreparationRequestKey(preparedIdentity),
      claimKey: buildSessionPreparationClaimKey(preparedIdentity),
      create: async () => prepared,
    });
    await vi.waitFor(() =>
      expect(internals.preparationService.getState(sessionId)).toBe('session-ready')
    );
    const coldSession = { sessionId } as ISession;
    const coldCreate = vi
      .spyOn(internals, 'createSessionInnerWithAgent')
      .mockResolvedValue(coldSession);
    const durableConfig = createSessionConfig({
      sessionId,
      agentConfigId,
      project: {
        kind: 'github',
        repoFullName: 'loro-dev/new-project',
        branch: 'main',
      },
    });

    const result = internals.createSessionFromPreparationOrCold(durableConfig);
    await vi.waitFor(() => expect(prepared.dispose).toHaveBeenCalledTimes(1));
    expect(coldCreate).not.toHaveBeenCalled();

    cleanup.resolve(undefined);
    await expect(result).resolves.toBe(coldSession);
    expect(coldCreate).toHaveBeenCalledWith(durableConfig, undefined);
  });

  it('claims a preparation when empty launch settings are omitted by durable dispatch', async () => {
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
    const sessionId = 'empty-launch-config' as SessionId;
    const agentConfigId = 'agent-1' as AgentConfigId;
    type PreparedTestResource = SessionPreparationResource & {
      compatibility: SessionLaunchConfig | undefined;
    };
    const prepared = {
      compatibility: buildSessionLaunchConfig({ env: {} }),
      initialized: Promise.resolve(),
      sessionReady: Promise.resolve(),
      dispose: vi.fn(async () => undefined),
    } satisfies PreparedTestResource;
    const internals = manager as unknown as {
      preparationService: SessionPreparationService<PreparedTestResource>;
      createSessionFromPreparationOrCold(config: SessionConfig): Promise<ISession>;
      createSessionInnerWithAgent(config: SessionConfig): Promise<ISession>;
      finishPreparedSession(
        config: SessionConfig,
        resource: PreparedTestResource
      ): Promise<ISession>;
    };
    internals.preparationService.start({
      preparationId: 'prepare-empty-launch-config',
      sessionId,
      requesterUserId: 'user-1',
      requestKey: JSON.stringify(['user-1', agentConfigId, 'builtin', 'codex', null]),
      create: async () => prepared,
    });
    await vi.waitFor(() =>
      expect(internals.preparationService.getState(sessionId)).toBe('session-ready')
    );

    const adoptedSession = { sessionId } as ISession;
    const finishPreparedSession = vi
      .spyOn(internals, 'finishPreparedSession')
      .mockResolvedValue(adoptedSession);
    const coldCreate = vi
      .spyOn(internals, 'createSessionInnerWithAgent')
      .mockResolvedValue({ sessionId } as ISession);
    const durableConfig = createSessionConfig({
      sessionId,
      agentConfigId,
      env: undefined,
    });

    await expect(internals.createSessionFromPreparationOrCold(durableConfig)).resolves.toBe(
      adoptedSession
    );
    expect(finishPreparedSession).toHaveBeenCalledWith(durableConfig, prepared);
    expect(coldCreate).not.toHaveBeenCalled();
  });

  it('exposes a current prepared launch config and rejects a changed config', async () => {
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
    const sessionId = 'prepared-launch-config' as SessionId;
    const agentConfigId = 'agent-1' as AgentConfigId;
    const preparedConfig = buildSessionLaunchConfig({ env: { PREPARED: '1' } });
    let currentConfig = preparedConfig;
    type PreparedTestResource = SessionPreparationResource & {
      compatibility: SessionLaunchConfig | undefined;
      readCurrentLaunchConfig: () => {
        config: SessionLaunchConfig | undefined;
        source: 'agent-config';
      };
    };
    const prepared = {
      compatibility: preparedConfig,
      readCurrentLaunchConfig: () => ({ config: currentConfig, source: 'agent-config' }),
      initialized: Promise.resolve(),
      sessionReady: Promise.resolve(),
      dispose: vi.fn(async () => undefined),
    } satisfies PreparedTestResource;
    const internals = manager as unknown as {
      preparationService: SessionPreparationService<PreparedTestResource>;
    };
    internals.preparationService.start({
      preparationId: 'prepare-launch-config',
      sessionId,
      requesterUserId: 'user-1',
      requestKey: JSON.stringify(['user-1', agentConfigId, 'builtin', 'codex', null]),
      create: async () => prepared,
    });
    await vi.waitFor(() =>
      expect(internals.preparationService.getState(sessionId)).toBe('session-ready')
    );
    const sessionMeta = {
      id: sessionId,
      machineId: 'machine-1' as MachineId,
      userId: 'user-1',
      createdAt: '2026-07-19T00:00:00.000Z',
      agentConfigId,
      cliType: 'builtin',
      agentType: 'codex',
    } satisfies SessionMeta;

    expect(
      manager.getPreparedSessionLaunchConfig({ sessionMeta, requesterUserId: 'user-1' })
    ).toEqual({ config: preparedConfig });

    currentConfig = buildSessionLaunchConfig({ env: { PREPARED: 'changed' } });
    expect(
      manager.getPreparedSessionLaunchConfig({ sessionMeta, requesterUserId: 'user-1' })
    ).toBeNull();
    expect(internals.preparationService.getState(sessionId)).toBe('session-ready');
  });
});

describe('SessionManager preparation resource accounting', () => {
  it('counts a retiring preparation and cold fallback with the same session id separately', async () => {
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
    const sessionId = 'overlapping-session' as SessionId;
    const durableApplyLimits = vi.fn(async () => undefined);
    const preparationApplyLimits = vi.fn(async () => undefined);
    const internals = manager as unknown as {
      sessions: Map<SessionId, ISession>;
      preparationSessions: Map<SessionId, ISession>;
      rebalanceSessionSandboxes(): Promise<void>;
    };
    internals.sessions.set(sessionId, {
      sessionId,
      applyExecutionPlaneLimits: durableApplyLimits,
    } as unknown as ISession);
    internals.preparationSessions.set(sessionId, {
      sessionId,
      applyExecutionPlaneLimits: preparationApplyLimits,
    } as unknown as ISession);

    await internals.rebalanceSessionSandboxes();

    expect(durableApplyLimits).toHaveBeenCalledTimes(1);
    expect(preparationApplyLimits).toHaveBeenCalledTimes(1);
  });
});
