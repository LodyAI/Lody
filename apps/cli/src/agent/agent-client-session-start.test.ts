import { Effect } from 'effect';
import { AcpConfiguration } from './acp-configuration';
import { reconcileProjectMemberLink } from '@/session/worktree/project-member-access';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestError } from '@agentclientprotocol/sdk';
import {
  getWorkspaceFlockDocId,
  writeWorkspaceMcpServerToFlock,
  type McpServerId,
  type MachineId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { LoroRepo, type TransportAdapter } from 'loro-repo';
import { LoroDocumentManager } from '@/lib/loro/doc';
import { bindTestPresenceApplication } from '../../tests/presence-application-fixture';
import type { Logger } from '@/utils/logger';
import { WorkspaceCatalogSyncLegacy } from '@/lib/loro/workspace-catalog-sync-legacy';
import { waitForMcpCatalogBaseline } from '@/lib/workspace-mcp-store';
import { WorkspaceSyncUnavailableError } from '@/lib/command-runtime';
import { loadSessionMcpCatalog } from './session-mcp-resolver';

const connectionMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  newSession: vi.fn(),
  loadSession: vi.fn(),
  resumeSession: vi.fn(),
  setSessionConfigOption: vi.fn(),
  unstable_forkSession: vi.fn(),
  closeSession: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('@agentclientprotocol/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentclientprotocol/sdk')>()),
  PROTOCOL_VERSION: 1,
  ClientSideConnection: class {
    readonly signal = new AbortController().signal;
    readonly initialize = connectionMocks.initialize;
    readonly newSession = connectionMocks.newSession;
    readonly loadSession = connectionMocks.loadSession;
    readonly resumeSession = connectionMocks.resumeSession;
    readonly setSessionConfigOption = connectionMocks.setSessionConfigOption;
    readonly unstable_forkSession = connectionMocks.unstable_forkSession;
    readonly closeSession = connectionMocks.closeSession;
    readonly cancel = connectionMocks.cancel;
  },
}));

import { AgentClient } from './agent-client';
import { applyAcpSessionRunConfig } from '@/session/acp-session-config-applier';

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createLogger(): Logger {
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
}

describe('AgentClient session startup', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks();
    connectionMocks.initialize.mockResolvedValue({ agentCapabilities: {} });
    connectionMocks.newSession.mockResolvedValue({ sessionId: 'acp-session-1' });
  });

  it('does not turn a lost config response into successful application', async () => {
    vi.useFakeTimers();
    const client = new AgentClient({
      sessionId: 'config-failure' as SessionId,
      logger: createLogger(),
      terminalManager: {} as never,
      onUpdateMessage: () => {},
      onRequestPermission: vi.fn(),
    });
    await client.startSession({} as never, '/workdir');
    connectionMocks.setSessionConfigOption.mockRejectedValue(
      new Error('ProcessTransport is not ready for writing')
    );
    const failure = expect(
      client.setSessionConfigOption('acp-session-1' as never, 'plan_mode', false)
    ).rejects.toThrow('ProcessTransport is not ready for writing');
    await vi.runAllTimersAsync();
    await failure;
    expect(client.getConfigOptions()).toEqual([]);
  });

  it('keeps the model from the agent response instead of substituting the requested model', async () => {
    const options = [
      {
        id: 'model',
        category: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'old',
        options: [
          { value: 'old', name: 'Old' },
          { value: 'new', name: 'New' },
        ],
      },
    ];
    connectionMocks.newSession.mockResolvedValueOnce({
      sessionId: 'acp-session-1',
      configOptions: options,
    });
    connectionMocks.setSessionConfigOption.mockResolvedValueOnce({ configOptions: options });
    const client = new AgentClient({
      sessionId: 'config-model' as SessionId,
      logger: createLogger(),
      terminalManager: {} as never,
      onUpdateMessage: () => {},
      onRequestPermission: vi.fn(),
    });
    await client.startSession({} as never, '/workdir');
    await client.unstable_setSessionModel('acp-session-1' as never, 'new');
    expect(client.currentModel?.modelId).toBe('old');
  });

  it.each([true, false])(
    'retains selected MCPs through a cold baseline and recovers initialization (ready during handshake=%s)',
    async (readyDuringHandshake) => {
      vi.useFakeTimers();
      const workspaceId = 'synthetic-cold-start' as WorkspaceId;
      const selectedId = 'selected-mcp' as McpServerId;
      const docId = getWorkspaceFlockDocId(workspaceId);
      const first = deferred<void>();
      const initialize = deferred<{ agentCapabilities: object }>();
      const repo = await LoroRepo.create({});
      const handle = await repo.openFlockDoc(docId);
      const seedSelected = () =>
        writeWorkspaceMcpServerToFlock(handle.flock, {
          id: selectedId,
          name: 'Selected MCP',
          transport: 'stdio',
          connection: { transport: 'stdio', command: 'synthetic-command' },
          createdAt: 1,
          updatedAt: 1,
        });
      await repo.flush();
      const logger = createLogger();
      const catalog = new WorkspaceCatalogSyncLegacy(repo, workspaceId, logger, true);
      const subscription = (ready: Promise<void>) => ({
        status: 'joined' as const,
        firstSyncedWithRemote: ready,
        waitUntilSynced: () => ready,
        onStatusChange: () => () => {},
        unsubscribe() {},
      });
      const transport: TransportAdapter = {
        async connect() {},
        async close() {},
        isConnected: () => true,
        getStatus: () => 'connected',
        onStatusChange: () => () => {},
        syncMeta: async () => ({ ok: true }),
        syncDoc: async () => ({ ok: true }),
        joinMetaRoom: () => subscription(Promise.resolve()),
        joinFlockDocRoom: () => subscription(first.promise),
        joinDocRoom: () => subscription(Promise.resolve()),
      };
      await repo.addTransport('streams', transport);
      connectionMocks.initialize.mockImplementation(() => initialize.promise);
      const requests: { mcpServers: { name: string; command?: string }[] }[] = [];
      connectionMocks.newSession.mockImplementation(async (request) => {
        requests.push(request);
        return { sessionId: 'acp-session-1' };
      });
      const options = {
        logger,
        sessionId: 'cold-session' as SessionId,
        terminalManager: {} as never,
        onUpdateMessage: vi.fn(),
        onRequestPermission: vi.fn(),
        loadExternalMcpServers: () =>
          loadSessionMcpCatalog({
            repo,
            workspaceId,
            sessionId: 'cold-session' as SessionId,
            selectedIds: [selectedId],
            logger,
            waitForCatalogBaseline: () =>
              waitForMcpCatalogBaseline(
                {
                  catalogBaselineReady: (id, timeout) => catalog.ready(id, timeout),
                },
                workspaceId
              ),
          }),
      };
      const client = new AgentClient(options);
      try {
        const starting = client.startSession({} as never, '/synthetic-workdir');
        const outcome = starting.then(
          () => undefined,
          (error: unknown) => error
        );
        await vi.advanceTimersByTimeAsync(1_000);
        if (readyDuringHandshake) {
          await vi.advanceTimersByTimeAsync(200);
          seedSelected();
          first.resolve();
          await vi.advanceTimersByTimeAsync(0);
          expect(await catalog.ready(docId, 0)).toBe(true);
        }
        initialize.resolve({ agentCapabilities: {} });
        await vi.advanceTimersByTimeAsync(1_000);
        if (readyDuringHandshake) {
          expect(await outcome).toBeUndefined();
          expect(client.isCreated()).toBe(true);
        } else {
          expect(await outcome).toBeInstanceOf(WorkspaceSyncUnavailableError);
          expect(requests).toEqual([]);
          seedSelected();
          first.resolve();
          await vi.advanceTimersByTimeAsync(0);
          expect(await catalog.ready(docId, 0)).toBe(true);
          const nextClient = new AgentClient(options);
          await nextClient.startSession({} as never, '/synthetic-workdir');
          expect(nextClient.isCreated()).toBe(true);
        }
        expect(requests).toEqual([
          expect.objectContaining({
            mcpServers: [
              expect.objectContaining({ name: 'Selected MCP', command: 'synthetic-command' }),
            ],
          }),
        ]);
      } finally {
        await catalog.close();
        await repo.destroy();
      }
    }
  );

  it.each([false, true])(
    'starts from persisted selected MCPs or preserves missing-row uncertainty before any Streams sync (missing=%s)',
    async (missing) => {
      const logger = createLogger();
      const presence = bindTestPresenceApplication(logger);
      const directory = await mkdtemp(join(tmpdir(), 'lody-cold-mcp-start-'));
      const originalDataDir = process.env.LODY_DATA_DIR;
      process.env.LODY_DATA_DIR = directory;
      const workspaceId = 'persisted-cold-workspace' as WorkspaceId;
      const docId = getWorkspaceFlockDocId(workspaceId);
      const selectedId = 'persisted-selected-mcp' as McpServerId;
      const missingId = 'not-yet-received-mcp' as McpServerId;
      let manager: LoroDocumentManager | undefined;
      try {
        manager = await LoroDocumentManager.create(workspaceId, 'synthetic-owner', logger);
        const handle = await manager.repo.openFlockDoc(docId);
        const entry = {
          id: selectedId,
          name: 'Persisted MCP',
          transport: 'stdio' as const,
          connection: { transport: 'stdio' as const, command: 'synthetic-command' },
          createdAt: 1,
          updatedAt: 1,
        };
        writeWorkspaceMcpServerToFlock(handle.flock, entry);
        await manager.repo.flush();
        await manager.cleanUp({ fast: true });
        manager = await LoroDocumentManager.create(workspaceId, 'synthetic-owner', logger, {
          keepWorkspaceCatalogJoined: true,
          // Remote authority is required, but no transport is attached at startup.
          streamsTokens: {} as never,
        });
        const activeManager = manager;
        expect(await activeManager.catalogBaselineReady(docId, 0)).toBe(false);
        const requests: { mcpServers: { name: string; command?: string }[] }[] = [];
        const warnings: { message: string; source?: string }[] = [];
        const errors: unknown[] = [];
        const prepared = new Set<string>();
        connectionMocks.newSession.mockImplementation(async (request) => {
          requests.push(request);
          return { sessionId: 'acp-session-1' };
        });
        const load = () =>
          loadSessionMcpCatalog({
            repo: activeManager.repo,
            workspaceId,
            sessionId: 'persisted-session' as SessionId,
            selectedIds: missing ? [selectedId, missingId] : [selectedId],
            logger,
            waitForCatalogBaseline: async () => {
              try {
                await waitForMcpCatalogBaseline(activeManager, workspaceId);
              } catch (error) {
                errors.push(error);
                throw error;
              }
            },
            prepare: async (row, resolved) => {
              if (prepared.has(row.id)) throw new Error('Duplicate credential preparation');
              prepared.add(row.id);
              return { ...resolved, name: `Prepared ${row.name}` };
            },
          });
        const client = new AgentClient({
          logger,
          sessionId: 'persisted-session' as SessionId,
          terminalManager: {} as never,
          onUpdateMessage: vi.fn(),
          onRequestPermission: vi.fn(),
          onAgentWarning: (warning) => warnings.push(warning),
          loadExternalMcpServers: load,
        });
        vi.useFakeTimers();
        const outcome = client.startSession({} as never, '/synthetic-workdir').then(
          (response) => response,
          (error: unknown) => error
        );
        await vi.advanceTimersByTimeAsync(2_000);
        if (missing) {
          expect(await outcome).toBe(errors.at(-1));
          expect(await outcome).toBeInstanceOf(WorkspaceSyncUnavailableError);
          expect(requests).toEqual([]);
          expect([...prepared]).toEqual([]);
        } else {
          expect(await outcome).toMatchObject({ sessionId: 'acp-session-1' });
          expect(requests).toEqual([
            expect.objectContaining({
              mcpServers: [
                expect.objectContaining({
                  name: 'Prepared Persisted MCP',
                  command: 'synthetic-command',
                }),
              ],
            }),
          ]);
          expect(warnings).toEqual([
            {
              source: 'configWarning',
              message: expect.stringContaining('not been confirmed with the remote'),
            },
          ]);
        }
        expect(await activeManager.catalogBaselineReady(docId, 0)).toBe(false);
        // The waiter did not cancel the shared reader. It can still catch up.
        const subscription = () => ({
          status: 'joined' as const,
          firstSyncedWithRemote: Promise.resolve(),
          waitUntilSynced: async () => {},
          onStatusChange: () => () => {},
          unsubscribe() {},
        });
        const transport: TransportAdapter = {
          async connect() {},
          async close() {},
          isConnected: () => true,
          getStatus: () => 'connected',
          onStatusChange: () => () => {},
          syncMeta: async () => ({ ok: true }),
          syncDoc: async () => ({ ok: true }),
          joinMetaRoom: subscription,
          joinFlockDocRoom: subscription,
          joinDocRoom: subscription,
        };
        const recovered = await activeManager.repo.openFlockDoc(docId);
        if (missing)
          writeWorkspaceMcpServerToFlock(recovered.flock, {
            ...entry,
            id: missingId,
            name: 'Recovered MCP',
          });
        await activeManager.repo.addTransport('streams', transport);
        await vi.advanceTimersByTimeAsync(0);
        expect(await activeManager.catalogBaselineReady(docId, 0)).toBe(true);
        prepared.clear();
        const select = await load();
        expect(select(undefined)).toMatchObject({
          servers: missing
            ? [
                expect.objectContaining({ name: 'Prepared Persisted MCP' }),
                expect.objectContaining({ name: 'Prepared Recovered MCP' }),
              ]
            : [expect.objectContaining({ name: 'Prepared Persisted MCP' })],
          problems: [],
        });
        expect(select(undefined).warnings).toBeUndefined();
      } finally {
        vi.useRealTimers();
        await manager?.cleanUp({ fast: true });
        await presence.closeLegacy();
        if (originalDataDir === undefined) delete process.env.LODY_DATA_DIR;
        else process.env.LODY_DATA_DIR = originalDataDir;
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('keeps unrelated MCP loader failures best effort without a readiness retry', async () => {
    const warnings: string[] = [];
    const failure = new Error('Synthetic configuration failure');
    let attempts = 0;
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'mcp-invalid-config' as SessionId,
      terminalManager: {} as never,
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
      onAgentWarning: (warning) => warnings.push(warning.message),
      loadExternalMcpServers: async () => {
        attempts++;
        throw failure;
      },
    });
    await expect(client.startSession({} as never, '/workdir')).resolves.toMatchObject({
      sessionId: 'acp-session-1',
    });
    expect(connectionMocks.newSession).toHaveBeenCalledWith({ cwd: '/workdir', mcpServers: [] });
    expect(warnings).toEqual([expect.stringContaining(failure.message)]);
    expect(attempts).toBe(1);
  });

  it('returns ACP resource-not-found for missing files while preserving reads and other failures', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'lody-acp-files-'));
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'file-read-session' as SessionId,
      terminalManager: {} as never,
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });
    try {
      await client.startSession({} as never, workdir);
      const missing = join(workdir, 'missing-plan.md');
      await expect(
        client.readTextFile({ sessionId: 'acp-session-1', path: missing })
      ).rejects.toMatchObject({
        code: -32002,
        data: { uri: missing },
      });
      await expect(
        client.readTextFile({ sessionId: 'acp-session-1', path: missing })
      ).rejects.toBeInstanceOf(RequestError);
      const path = join(workdir, 'plan.md');
      await writeFile(path, 'first\nsecond\nthird\n');
      await expect(
        client.readTextFile({ sessionId: 'acp-session-1', path, line: 2, limit: 1 })
      ).resolves.toEqual({ content: 'second' });
      const notDirectory = join(path, 'child');
      await expect(readFile(notDirectory)).rejects.toMatchObject({ code: 'ENOTDIR' });
      await expect(
        client.readTextFile({ sessionId: 'acp-session-1', path: notDirectory })
      ).rejects.toMatchObject({ code: 'ENOTDIR' });
      await expect(
        client.readTextFile({ sessionId: 'other-session', path: missing })
      ).rejects.toThrow('Mismatched ACP session');
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it.each([true, false])(
    'negotiates directory access before starting the Provider (additional=%s)',
    async (supported) => {
      const base = await mkdtemp(join(tmpdir(), 'acp-extra-roots-'));
      const main = join(base, 'main');
      const docs = join(base, 'docs');
      await mkdir(main);
      await mkdir(docs);
      connectionMocks.initialize.mockResolvedValue({
        agentCapabilities: { sessionCapabilities: supported ? { additionalDirectories: {} } : {} },
      });
      connectionMocks.newSession.mockImplementation(async (request) => {
        const directory = request.additionalDirectories?.[0] ?? join(request.cwd, 'docs');
        await writeFile(join(directory, 'provider.txt'), 'updated');
        return { sessionId: 'provider-session' };
      });
      const client = new AgentClient({
        logger: createLogger(),
        sessionId: 'extra-roots' as SessionId,
        terminalManager: {} as never,
        onUpdateMessage: vi.fn(),
        onRequestPermission: vi.fn(),
        resolveAdditionalDirectories: async (capability) => {
          await reconcileProjectMemberLink(main, 'docs', docs, capability);
          return capability ? [docs] : [];
        },
      });
      try {
        await client.startSession({} as never, main);
        expect(await readFile(join(docs, 'provider.txt'), 'utf8')).toBe('updated');
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    }
  );

  it.each(['new', 'load', 'resume', 'fork'] as const)(
    'carries negotiated local project identity on %s while preserving the claimed worktree',
    async (operation) => {
      const project = { version: 1 as const, originProjectPath: '/original-project' };
      connectionMocks.initialize.mockResolvedValue({
        agentCapabilities: {
          loadSession: operation === 'load',
          sessionCapabilities: { resume: {}, fork: {} },
          _meta: { lody: { worktreeProject: { version: 1 } } },
        },
      });
      connectionMocks.loadSession.mockResolvedValue({});
      connectionMocks.resumeSession.mockResolvedValue({});
      connectionMocks.unstable_forkSession.mockResolvedValue({ sessionId: 'forked' });
      const client = new AgentClient({
        logger: createLogger(),
        sessionId: 'session-1' as SessionId,
        terminalManager: {} as never,
        resolveWorktreeProject: async () => project,
        modelId: 'selected-model',
        configOptionValues: { reasoning_effort: 'high' },
        onUpdateMessage: vi.fn(),
        onRequestPermission: vi.fn(),
      });
      await client.startSession(
        {} as never,
        '/worktree',
        operation === 'load' || operation === 'resume' ? ('existing' as never) : undefined,
        {},
        undefined,
        operation === 'fork' ? ('source' as never) : undefined
      );
      const request =
        operation === 'new'
          ? connectionMocks.newSession
          : operation === 'load'
            ? connectionMocks.loadSession
            : operation === 'resume'
              ? connectionMocks.resumeSession
              : connectionMocks.unstable_forkSession;
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/worktree',
          _meta: {
            lody: {
              worktreeProject: project,
              sessionConfig: {
                version: 1,
                modelId: 'selected-model',
                configOptionValues: { reasoning_effort: 'high' },
              },
            },
          },
        })
      );
    }
  );

  it('keeps project lookup disabled when the agent does not advertise support', async () => {
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-1' as SessionId,
      terminalManager: {} as never,
      resolveWorktreeProject: async () => {
        throw new Error('unexpected project lookup');
      },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });
    await client.startSession({} as never, '/worktree');
    expect(connectionMocks.newSession).toHaveBeenCalledWith({ cwd: '/worktree', mcpServers: [] });
  });

  it('starts initial and replacement sessions with selected config option values', async () => {
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-grok' as SessionId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'grok' },
      configOptionValues: { permission_mode: 'always-approve' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    await client.startSession({} as never, '/workdir');

    expect(connectionMocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: { clientIdentifier: 'lody:session-grok' },
      })
    );
    expect(connectionMocks.newSession).toHaveBeenCalledWith({
      cwd: '/workdir',
      mcpServers: [],
      _meta: {
        clientIdentifier: 'lody:session-grok',
        lody: {
          sessionConfig: {
            version: 1,
            configOptionValues: { permission_mode: 'always-approve' },
          },
        },
      },
    });

    connectionMocks.newSession.mockResolvedValueOnce({ sessionId: 'acp-session-2' });
    await client.prepareReplacementSession();

    expect(connectionMocks.newSession).toHaveBeenLastCalledWith({
      cwd: '/workdir',
      mcpServers: [],
      _meta: {
        clientIdentifier: 'lody:session-grok',
        lody: {
          sessionConfig: {
            version: 1,
            configOptionValues: { permission_mode: 'always-approve' },
          },
        },
      },
    });
  });

  it('sends initial config without provider-specific startup fields', async () => {
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-neutral-config' as SessionId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'codex' },
      configOptionValues: { approval_policy: 'never' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    await client.startSession({} as never, '/workdir');

    expect(connectionMocks.newSession).toHaveBeenCalledWith({
      cwd: '/workdir',
      mcpServers: [],
      _meta: {
        lody: {
          sessionConfig: {
            version: 1,
            configOptionValues: { approval_policy: 'never' },
          },
        },
      },
    });
  });

  it('carries successful live config changes into replacement session startup', async () => {
    connectionMocks.setSessionConfigOption.mockResolvedValue({});
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-grok-switch' as SessionId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'grok' },
      configOptionValues: { permission_mode: 'ask' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    await client.startSession({} as never, '/workdir');
    await client.setSessionConfigOption(
      'acp-session-1' as never,
      'permission_mode',
      'always-approve'
    );

    connectionMocks.newSession.mockResolvedValueOnce({ sessionId: 'acp-session-2' });
    await client.prepareReplacementSession();
    expect(connectionMocks.newSession).toHaveBeenLastCalledWith({
      cwd: '/workdir',
      mcpServers: [],
      _meta: {
        clientIdentifier: 'lody:session-grok-switch',
        lody: {
          sessionConfig: {
            version: 1,
            configOptionValues: { permission_mode: 'always-approve' },
          },
        },
      },
    });

    await client.setSessionConfigOption('acp-session-1' as never, 'permission_mode', 'ask');
    connectionMocks.newSession.mockResolvedValueOnce({ sessionId: 'acp-session-3' });
    await client.prepareReplacementSession();
    expect(connectionMocks.newSession).toHaveBeenLastCalledWith({
      cwd: '/workdir',
      mcpServers: [],
      _meta: {
        clientIdentifier: 'lody:session-grok-switch',
        lody: {
          sessionConfig: {
            version: 1,
            configOptionValues: { permission_mode: 'ask' },
          },
        },
      },
    });
  });

  it('projects a legacy acknowledged value and carries the same value into replacement startup', async () => {
    connectionMocks.newSession.mockResolvedValueOnce({
      sessionId: 'acp-session-1',
      configOptions: [
        {
          id: 'effort',
          category: 'thought_level',
          type: 'select',
          name: 'Effort',
          currentValue: 'low',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
    });
    connectionMocks.setSessionConfigOption.mockResolvedValue({});
    const logger = createLogger();
    const client = new AgentClient({
      logger,
      sessionId: 'session-legacy-projection' as SessionId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'codex' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    await client.startSession({} as never, '/workdir');
    const result = await Effect.runPromise(
      applyAcpSessionRunConfig({ configOptionValues: { effort: 'high' } }).pipe(
        Effect.provideService(AcpConfiguration, client.getConfiguration())
      )
    );
    expect(result).toMatchObject({
      acpSessionId: 'acp-session-1',
      configOptionValues: { effort: 'high' },
      state: 'ready',
    });

    connectionMocks.newSession.mockResolvedValueOnce({ sessionId: 'acp-session-2' });
    await client.prepareReplacementSession();
    expect(connectionMocks.newSession).toHaveBeenLastCalledWith({
      cwd: '/workdir',
      mcpServers: [],
      _meta: {
        lody: {
          sessionConfig: {
            version: 1,
            configOptionValues: { effort: 'high' },
          },
        },
      },
    });
  });

  it('treats an empty set-config response as an authoritative full snapshot', async () => {
    connectionMocks.setSessionConfigOption.mockResolvedValue({ configOptions: [] });
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-empty-config-snapshot' as SessionId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'codex' },
      configOptionValues: { collaboration_mode: 'plan', reasoning_effort: 'high' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    await client.startSession({} as never, '/workdir');
    await client.setSessionConfigOption('acp-session-1' as never, 'collaboration_mode', 'default');

    connectionMocks.newSession.mockResolvedValueOnce({ sessionId: 'acp-session-2' });
    await client.prepareReplacementSession();
    expect(connectionMocks.newSession).toHaveBeenLastCalledWith({
      cwd: '/workdir',
      mcpServers: [],
    });
  });

  it('uses accepted Grok config for permission decisions and notifies pending requests', async () => {
    const permissions = (currentValue: string) => [
      {
        id: 'permission_mode',
        category: '_permission',
        type: 'select' as const,
        name: 'Permissions',
        currentValue,
        options: [],
      },
    ];
    connectionMocks.newSession.mockResolvedValueOnce({
      sessionId: 'acp-session-1',
      configOptions: permissions('ask'),
    });
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'grok-config' as SessionId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'grok' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });
    await client.startSession({} as never, '/workdir');
    const request = {
      sessionId: 'acp-session-1',
      toolCall: { toolCallId: 'tool' },
      options: [{ kind: 'allow_once' as const, optionId: 'once', name: 'Once' }],
    };
    const outcomes: unknown[] = [];
    const unsubscribe = client.subscribeConfigOptions(() => {
      outcomes.push(client.getAutomaticToolPermissionOutcome(request, true));
    });
    const response = deferred<{ configOptions: ReturnType<typeof permissions> }>();
    connectionMocks.setSessionConfigOption.mockReturnValueOnce(response.promise);
    const setting = client.setSessionConfigOption(
      'acp-session-1' as never,
      'permission_mode',
      'always-approve'
    );
    expect(client.getAutomaticToolPermissionOutcome(request, false)).toBeUndefined();
    response.resolve({ configOptions: permissions('always-approve') });
    await setting;
    expect(outcomes).toEqual([{ outcome: 'selected', optionId: 'once' }]);
    expect(
      client.getAutomaticToolPermissionOutcome({ ...request, sessionId: 'other' }, true)
    ).toBeUndefined();

    // Runtime rejection preserves the accepted state and cannot spuriously drain requests.
    connectionMocks.setSessionConfigOption.mockRejectedValueOnce(new Error('unsupported value'));
    await expect(
      client.setSessionConfigOption('acp-session-1' as never, 'permission_mode', 'ask')
    ).rejects.toThrow('unsupported value');
    expect(outcomes).toHaveLength(1);

    connectionMocks.setSessionConfigOption.mockResolvedValueOnce({});
    await client.setSessionConfigOption('acp-session-1' as never, 'permission_mode', 'ask');
    expect(outcomes).toEqual([{ outcome: 'selected', optionId: 'once' }, undefined]);
    await client.sessionUpdate({
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: permissions('always-approve'),
      },
    } as never);
    expect(outcomes.at(-1)).toEqual({ outcome: 'selected', optionId: 'once' });
    unsubscribe();
    connectionMocks.setSessionConfigOption.mockResolvedValueOnce({ configOptions: [] });
    await client.setSessionConfigOption('acp-session-1' as never, 'permission_mode', 'ask');
    expect(client.getAutomaticToolPermissionOutcome(request, false)).toBeUndefined();
    expect(outcomes).toHaveLength(3);
  });

  it('carries agent-originated config updates into replacement session startup', async () => {
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-agent-config-update' as SessionId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'codex' },
      modelId: 'original-model',
      configOptionValues: { collaboration_mode: 'plan', reasoning_effort: 'high' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    await client.startSession({} as never, '/workdir');
    await client.sessionUpdate({
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'model',
            category: 'model',
            type: 'select',
            name: 'Model',
            currentValue: 'updated-model',
            options: [],
          },
          {
            id: 'collaboration_mode',
            category: 'collaboration_mode',
            type: 'select',
            name: 'Collaboration mode',
            currentValue: 'default',
            options: [],
          },
          {
            id: 'reasoning_effort',
            category: 'thought_level',
            type: 'select',
            name: 'Reasoning effort',
            currentValue: 'low',
            options: [],
          },
        ],
      },
    } as never);

    expect(client.currentModel?.modelId).toBe('updated-model');
    connectionMocks.newSession.mockResolvedValueOnce({ sessionId: 'acp-session-2' });
    await client.prepareReplacementSession();

    expect(connectionMocks.newSession).toHaveBeenLastCalledWith({
      cwd: '/workdir',
      mcpServers: [],
      _meta: {
        lody: {
          sessionConfig: {
            version: 1,
            modelId: 'updated-model',
            configOptionValues: {
              model: 'updated-model',
              collaboration_mode: 'default',
              reasoning_effort: 'low',
            },
          },
        },
      },
    });
  });

  it('loads sessions with selected config option values', async () => {
    connectionMocks.initialize.mockResolvedValue({
      agentCapabilities: { loadSession: true },
    });
    connectionMocks.loadSession.mockResolvedValue({});
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-grok-load' as SessionId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'grok' },
      configOptionValues: { permission_mode: 'always-approve' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    await client.startSession({} as never, '/workdir', 'stored-grok-session' as never);

    expect(connectionMocks.loadSession).toHaveBeenCalledWith({
      sessionId: 'stored-grok-session',
      cwd: '/workdir',
      mcpServers: [],
      _meta: {
        clientIdentifier: 'lody:session-grok-load',
        lody: {
          sessionConfig: {
            version: 1,
            configOptionValues: { permission_mode: 'always-approve' },
          },
        },
      },
    });
  });

  it('resumes builtin Pi sessions without replaying them through loadSession', async () => {
    connectionMocks.initialize.mockResolvedValue({
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
    });
    connectionMocks.resumeSession.mockResolvedValue({});
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-pi-resume' as SessionId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'pi' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    await client.startSession({} as never, '/workdir', '/pi/session.jsonl' as never);

    expect(connectionMocks.resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: '/pi/session.jsonl', cwd: '/workdir' })
    );
    expect(connectionMocks.loadSession).not.toHaveBeenCalled();
  });

  it('injects Lody MCP into DeepSeek Harness sessions', async () => {
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-deepseek' as SessionId,
      workspaceId: 'workspace-1' as WorkspaceId,
      machineId: 'machine-1' as MachineId,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'deepseek' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    await client.startSession({} as never, '/workdir');

    expect(connectionMocks.newSession).toHaveBeenCalledWith({
      cwd: '/workdir',
      mcpServers: [
        expect.objectContaining({
          name: 'lody',
          command: process.execPath,
          args: expect.arrayContaining(['__internal', 'lody-mcp-server']),
          env: expect.arrayContaining([
            { name: 'LODY_MCP_SESSION_ID', value: 'session-deepseek' },
            { name: 'LODY_MCP_WORKSPACE_ID', value: 'workspace-1' },
            { name: 'LODY_MCP_MACHINE_ID', value: 'machine-1' },
            { name: 'LODY_MCP_WORKDIR', value: '/workdir' },
          ]),
        }),
      ],
    });
  });

  it('prepares a turn-addressed fork before adopting it', async () => {
    connectionMocks.initialize.mockResolvedValue({
      agentCapabilities: {
        sessionCapabilities: { fork: {}, close: {} },
        _meta: { lody: { forkAtTurn: { version: 1 } } },
      },
    });
    connectionMocks.unstable_forkSession.mockResolvedValue({ sessionId: 'acp-session-2' });
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-fork' as SessionId,
      terminalManager: {} as never,
      configOptionValues: { interaction_mode: 'plan' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });
    await client.startSession({} as never, '/workdir');

    const prepared = await client.prepareReplacementSession('provider-turn-1');

    expect(prepared).toEqual({ sessionId: 'acp-session-2' });
    expect(connectionMocks.unstable_forkSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'acp-session-1',
        cwd: '/workdir',
        _meta: {
          lody: {
            forkAtTurn: { version: 1, turnId: 'provider-turn-1' },
            sessionConfig: {
              version: 1,
              configOptionValues: { interaction_mode: 'plan' },
            },
          },
        },
      })
    );
    await client.cancel('acp-session-1' as never);
    expect(connectionMocks.cancel).toHaveBeenCalledWith({ sessionId: 'acp-session-1' });

    client.adoptPreparedSession(prepared);
    await client.closeDetachedSession('acp-session-1' as never);
    expect(connectionMocks.closeSession).toHaveBeenCalledWith({ sessionId: 'acp-session-1' });
  });

  it('prepares a fresh provider session for editing the first user message', async () => {
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'session-first' as SessionId,
      terminalManager: {} as never,
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
    });
    await client.startSession({} as never, '/workdir');
    connectionMocks.newSession.mockResolvedValueOnce({ sessionId: 'acp-session-2' });

    await expect(client.prepareReplacementSession()).resolves.toEqual({
      sessionId: 'acp-session-2',
    });
    expect(connectionMocks.newSession).toHaveBeenLastCalledWith({
      cwd: '/workdir',
      mcpServers: [],
    });
  });
});

describe('AgentClient advisory prompt suggestions', () => {
  it('delivers only negotiated native-session predictions under a stable Lody owner', async () => {
    const delivered: unknown[] = [];
    connectionMocks.initialize.mockResolvedValue({
      agentCapabilities: { _meta: { lody: { promptSuggestions: { version: 1 } } } },
    });
    connectionMocks.newSession.mockResolvedValue({ sessionId: 'native-suggestion-session' });
    const client = new AgentClient({
      logger: createLogger(),
      sessionId: 'lody-session' as SessionId,
      terminalManager: {} as never,
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(),
      onPromptSuggestion: (event) => delivered.push(event),
    });
    const suggestion = {
      sessionId: 'native-suggestion-session',
      suggestionId: 'native-message',
      result: { type: 'completed', text: 'Run tests' },
    };
    await client.extNotification?.('_lody/session/prompt_suggestion', suggestion);
    expect(delivered).toEqual([]);
    await client.startSession({} as never, '/tmp');
    await client.extNotification?.('_lody/session/prompt_suggestion', {
      ...suggestion,
      sessionId: 'foreign',
    });
    await client.extNotification?.('_lody/session/prompt_suggestion', {
      ...suggestion,
      result: { type: 'completed', text: 42 },
    });
    expect(delivered).toEqual([]);
    await client.extNotification?.('_lody/session/prompt_suggestion', suggestion);
    expect(delivered).toEqual([suggestion]);
  });
});
