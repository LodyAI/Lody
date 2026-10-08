import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentConfigId,
  LocalProjectId,
  MachineId,
  SessionId,
  SessionPreparationSpec,
  WorkspaceId,
} from '@lody/shared';
import { createLocalCloudPort } from '@lody/platform';

import { Session } from './session';
import { SessionManager } from './session-manager';
import type { SessionSandbox } from './session-sandbox';
import type { SessionConfig } from './types';
import type { LoroDocumentManager } from '../lib/loro/doc';
import type { Logger } from '../utils/logger';
import type { GitHubTokenManager } from '../lib/github-token-manager';
import { GitCredentialBroker, LODY_GIT_CRED_CONTEXT_TOKEN_ENV } from '../lib/git-credential-broker';

vi.mock('../agent/setting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/setting')>()),
  resolveACPProcessLaunchAsync: vi.fn(async () => ({ command: 'synthetic-agent', args: [] })),
}));

const SESSION_ID = 'session-github-context' as SessionId;

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

const createSandbox = (): SessionSandbox => ({
  enabled: false,
  description: 'synthetic-sandbox',
  applyLimits: vi.fn(async () => {}),
  spawn: vi.fn(async () => {
    throw new Error('Agent processes are not started by this test');
  }),
  terminate: vi.fn(async () => {}),
  cleanup: vi.fn(async () => {}),
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

type PreparedRuntime = {
  session: Session;
  config: SessionConfig;
  start(): void;
  initialized: Promise<void>;
  sessionReady: Promise<void>;
  adopt(): Promise<void>;
  dispose(): Promise<void>;
};

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'lody-github-context-'));
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
  vi.stubEnv('LODY_DATA_DIR', directory);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

const createHarness = () => {
  const logger = createLogger();
  const getDocMeta = vi.fn(async (): Promise<unknown> => undefined);
  const workspaceDocument = {
    repo: {
      getDocMeta,
      upsertDocMeta: vi.fn(async () => undefined),
      openFlockDoc: vi.fn(async () => {
        throw new Error('No machine launch snapshot in this fixture');
      }),
    },
    getAgentConfigById: vi.fn(async () => ({
      id: 'agent-config',
      machineId: 'machine-1',
      cliType: 'builtin',
      agentType: 'claude',
      name: 'Claude',
      env: {},
    })),
    getOrCreateSessionDoc: vi.fn(async () => ({ setRepoFullName: vi.fn(async () => {}) })),
    cleanUp: vi.fn(async () => undefined),
  } as unknown as LoroDocumentManager;
  const manager = new SessionManager(
    logger,
    'token',
    'machine-1' as MachineId,
    'workspace-1' as WorkspaceId,
    workspaceDocument,
    {
      cloudPort: createLocalCloudPort({ identity: { userId: 'user-1' }, workspaces: [] }),
      sessionSandboxFactory: async () => createSandbox(),
    }
  );
  const broker = new GitCredentialBroker({
    tokenManager: {} as GitHubTokenManager,
    logger,
    workspaceId: 'workspace-1',
    ownerUserId: 'user-1',
  });
  Object.assign(manager, {
    githubTokenManager: {} as GitHubTokenManager,
    gitCredentialBroker: broker,
    preparationUserResolver: {
      resolve: async (id: string) => ({ id, name: 'Test User', email: 'test@example.com' }),
      clear: () => {},
    },
  });
  const internals = manager as unknown as {
    ensureGitCredentialBrokerEnv(): Promise<unknown>;
    createPreparedSessionRuntime(
      spec: SessionPreparationSpec,
      signal: AbortSignal
    ): Promise<PreparedRuntime>;
    prepareGitHubRepoSessionConfig(config: SessionConfig): Promise<unknown>;
  };
  vi.spyOn(internals, 'ensureGitCredentialBrokerEnv').mockResolvedValue({
    url: 'http://127.0.0.1:9',
    port: 9,
    token: 'synthetic-broker-token',
  });
  const spec = (project?: SessionPreparationSpec['project']): SessionPreparationSpec => ({
    preparationId: 'preparation-1' as SessionPreparationSpec['preparationId'],
    sessionId: SESSION_ID,
    requestedByUserId: 'user-1',
    agentConfigId: 'agent-config' as AgentConfigId,
    cliType: 'builtin',
    agentType: 'claude',
    ...(project ? { project } : {}),
  });
  const sessionConfig = (overrides: Partial<SessionConfig> = {}): SessionConfig => ({
    sessionId: SESSION_ID,
    workspaceId: 'workspace-1' as WorkspaceId,
    requesterUserId: 'user-1',
    machineId: 'machine-1' as MachineId,
    agentConfigId: 'agent-config' as AgentConfigId,
    agentCliType: 'builtin',
    agentType: 'claude',
    mcpServerIds: [],
    assumeDocExisting: true,
    userName: 'Test User',
    userEmail: 'test@example.com',
    env: {},
    ...overrides,
  });
  const localSession = () => {
    const config = sessionConfig({
      project: {
        kind: 'local',
        localProjectId: 'local-project' as LocalProjectId,
        githubRepoFullName: 'owner/repo',
      },
      githubRepo: 'owner/repo',
      workdir: directory,
    });
    return { config, session: new Session(config, logger, directory, createSandbox()) };
  };
  return { manager, internals, broker, getDocMeta, spec, sessionConfig, localSession, logger };
};

describe('SessionManager GitHub credential context lifecycle', () => {
  it('releases the context of a preparation abandoned while it prepared GitHub credentials', async () => {
    const h = createHarness();
    const owner = deferred<unknown>();
    h.getDocMeta.mockImplementationOnce(async () => await owner.promise);
    const controller = new AbortController();

    // The draft first targets a managed GitHub project; the user switches to a
    // local project while the owner lookup is still pending.
    const preparing = h.internals.createPreparedSessionRuntime(
      h.spec({ kind: 'github', repoFullName: 'owner/repo', branch: 'main' }),
      controller.signal
    );
    await vi.waitFor(() => expect(h.getDocMeta).toHaveBeenCalled());
    controller.abort();
    owner.resolve(undefined);
    await expect(preparing).rejects.toThrow(/aborted/i);
    expect(h.broker.hasSessionContext(SESSION_ID)).toBe(false);

    const { config, session } = h.localSession();
    await h.internals.prepareGitHubRepoSessionConfig(config);
    for (let turn = 0; turn < 2; turn++) {
      await h.manager.refreshGhTokenForSession(session, 'owner/repo', 'user-1');
    }
    expect(config.githubCredentialPolicy).toBeUndefined();
    expect(config.env?.[LODY_GIT_CRED_CONTEXT_TOKEN_ENV]).toBeUndefined();
    expect(h.broker.hasSessionContext(SESSION_ID)).toBe(false);
  });

  it('releases an unclaimed preparation context when the preparation is disposed', async () => {
    const h = createHarness();
    const runtime = await h.internals.createPreparedSessionRuntime(
      h.spec(),
      new AbortController().signal
    );
    expect(runtime.config.githubCredentialPolicy).toEqual(
      expect.objectContaining({ allowLocalAuth: true })
    );
    expect(h.broker.hasSessionContext(SESSION_ID)).toBe(true);

    await runtime.dispose();

    expect(h.broker.hasSessionContext(SESSION_ID)).toBe(false);
    const { session } = h.localSession();
    await expect(
      h.manager.refreshGhTokenForSession(session, undefined, 'user-1')
    ).resolves.toBeUndefined();
  });

  it('keeps the context of the durable session that replaced a late-disposed preparation', async () => {
    const h = createHarness();
    const abandoned = await h.internals.createPreparedSessionRuntime(
      h.spec(),
      new AbortController().signal
    );
    const durableConfig = h.sessionConfig();
    await h.internals.prepareGitHubRepoSessionConfig(durableConfig);
    const durableToken = durableConfig.env?.[LODY_GIT_CRED_CONTEXT_TOKEN_ENV];
    expect(durableToken).toBe(abandoned.config.env?.[LODY_GIT_CRED_CONTEXT_TOKEN_ENV]);
    const durable = new Session(durableConfig, h.logger, directory, createSandbox());

    await abandoned.dispose();

    expect(h.broker.hasSessionContext(SESSION_ID)).toBe(true);
    for (let turn = 0; turn < 2; turn++) {
      await h.manager.refreshGhTokenForSession(durable, undefined, 'user-1');
      expect(durableConfig.env?.[LODY_GIT_CRED_CONTEXT_TOKEN_ENV]).toBe(durableToken);
    }
  });

  it('keeps an adopted preparation context for later turns', async () => {
    const h = createHarness();
    const runtime = await h.internals.createPreparedSessionRuntime(
      h.spec(),
      new AbortController().signal
    );
    vi.spyOn(runtime.session, 'createAgent').mockRejectedValue(new Error('agent unavailable'));
    void runtime.initialized.catch(() => undefined);
    void runtime.sessionReady.catch(() => undefined);
    runtime.start();
    await runtime.adopt();

    // finishPreparedSession may still dispose an adopted runtime when it falls
    // back to a cold start; ownership has already moved to the durable session.
    await runtime.dispose();

    expect(h.broker.hasSessionContext(SESSION_ID)).toBe(true);
    for (let turn = 0; turn < 2; turn++) {
      await h.manager.refreshGhTokenForSession(runtime.session, undefined, 'user-1');
    }
    expect(runtime.config.githubCredentialPolicy?.allowLocalAuth).toBe(true);
  });

  it('keeps local project sessions on native credentials when another holder owns the same session id', async () => {
    const h = createHarness();
    const foreign = h.broker.acquireSessionContext({
      sessionId: SESSION_ID,
      requesterUserId: 'user-1',
      machineId: 'machine-1',
    });
    const { config, session } = h.localSession();
    const nativeEnv = { ...config.env };
    const terminate = vi.spyOn(session, 'terminate');

    for (let turn = 0; turn < 2; turn++) {
      await h.manager.refreshGhTokenForSession(session, 'owner/repo', 'user-2');
    }

    expect(config.githubCredentialPolicy).toBeUndefined();
    expect(config.env).toEqual(nativeEnv);
    expect(terminate).not.toHaveBeenCalled();
    expect(h.broker.getSessionOwner(SESSION_ID)).toBe('user-1');
    expect(
      h.broker.refreshSessionContext({
        sessionId: SESSION_ID,
        requesterUserId: 'user-1',
        machineId: 'machine-1',
      })
    ).toBe(foreign.contextToken);
  });

  it('still fails closed when a managed session has a context but no credential policy', async () => {
    const h = createHarness();
    h.broker.acquireSessionContext({
      sessionId: SESSION_ID,
      requesterUserId: 'user-1',
      machineId: 'machine-1',
    });
    const managed = new Session(
      h.sessionConfig({ project: { kind: 'github', repoFullName: 'owner/repo', branch: 'main' } }),
      h.logger,
      directory,
      createSandbox()
    );

    await expect(
      h.manager.refreshGhTokenForSession(managed, 'owner/repo', 'user-1')
    ).rejects.toThrow('github_context_missing');
  });
});
