import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Effect } from 'effect';
import { LoroRepo } from 'loro-repo';
import { makePromiseRepoNetwork } from '@/lib/loro/promise-repo-network.test-support';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSessionRoomId,
  getMachineFlockDocId,
  getMachineRoomId,
  getMachineFlockAgentConfigs,
  writeAgentConfigToFlock,
  getWorkspaceFlockDocId,
  getProjectMcpKey,
  workspaceFlockKeys,
  listWorkspaceAgentRoles,
  readWorkspaceFlockRowsFromFlock,
  readMachineFlockRowsFromFlock,
  SessionStatusFactory,
  writeWorkspaceAgentRoleToFlock,
  writeWorkspaceMcpServerToFlock,
  type AgentConfigId,
  type AgentRoleId,
  type MachineId,
  type McpServerId,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { bindTestPresenceApplication } from '../../tests/presence-application-fixture';
import { resolveWorkspaceOrThrow, withWorkspaceManager } from '@/lib/command-runtime';
import * as workspaceApi from '@/lib/workspace';
import * as commandRuntime from '@/lib/command-runtime';
import * as sessionCommands from '@/commands/session';
import { createResourceDiscovery } from '@/lib/resource-discovery-runtime';
import { waitForMcpCatalogBaseline } from '@/lib/workspace-mcp-store';
import { loadSessionMcpCatalog } from '@/agent/session-mcp-resolver';
import { LodyOperationStore, getLodyOperationStorePath } from '@/orchestration/operation-store';
import { createSessionBackend } from '@/session/session-backend';
import { LocalControlHandler } from '@/lib/local-control-handler';
import { LoroDocumentManager } from '@/lib/loro/doc';
import {
  createLocalSessionCommandEnvironment,
  runWithDaemonWorkspace,
  runWithSessionCommandEnvironment,
  type DaemonWorkspace,
  type DaemonWorkspaceAccess,
} from '@/lib/session-command-environment';
import type { Logger } from '@/utils/logger';
import { executeDaemonSessionTool } from './daemon-session-tools';
import { buildLodyMcpServer, runWithMcpSessionContext } from './lody-mcp-server';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

function testSignal() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const workspaceId = 'synthetic-cloud-workspace' as WorkspaceId;
const machineId = 'synthetic-daemon-machine' as MachineId;
const ownerUserId = 'synthetic-owner';

describe('daemon-hosted Session tools in the cloud composition', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let presenceApplication: ReturnType<typeof bindTestPresenceApplication>;
  let manager: LoroDocumentManager;
  let sessionId: SessionId;
  let daemon: DaemonWorkspace;

  beforeEach(async () => {
    presenceApplication = bindTestPresenceApplication(createSilentLogger());
    originalEnv = { ...process.env };
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-daemon-tools-'));
    process.env.LODY_DATA_DIR = path.join(tempDir, '.lody');
    delete process.env.LODY_PLATFORM;
    manager = await LoroDocumentManager.create(workspaceId, ownerUserId, createSilentLogger(), {
      keepWorkspaceCatalogJoined: true,
    });
    await manager.registerMachine(machineId, {
      id: machineId,
      name: 'Daemon',
      ownerUserId,
    });
    sessionId = await manager.createSession(machineId, 'custom', 'claude');
    await manager.repo.flush();
    daemon = {
      workspaceId,
      userId: ownerUserId,
      machineId,
      manager,
      // A collaborator drives this Session on the owner's shared machine.
      readInvocation: (id) => ({
        type: 'session/active-invocation-context',
        active: true,
        sessionId: id,
        requesterUserId: 'synthetic-collaborator',
        sourceTurnId: 'synthetic-turn',
        inputConfig: { cliType: 'custom', agentType: 'claude' },
      }),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await manager.cleanUp({ fast: true });
    await presenceApplication.closeLegacy();
    process.env = originalEnv;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const context = () => ({
    machineId,
    workspaceId,
    sessionId,
    localControlSocketPath: undefined,
    workdir: tempDir,
  });

  const createAuth = () => ({
    token: 'synthetic-token',
    userId: ownerUserId,
    userName: 'Owner',
    userEmail: 'owner@example.test',
    machineId,
    machineName: 'Daemon',
  });

  function createEnvironment() {
    return createLocalSessionCommandEnvironment({
      manager,
      workspaceId,
      machineId,
      machineName: 'Daemon',
      userId: ownerUserId,
      host: {
        readInvocation: (invocationSessionId) => ({
          type: 'session/active-invocation-context',
          active: true,
          sessionId: invocationSessionId,
          requesterUserId: ownerUserId,
          sourceTurnId: 'synthetic-turn',
          inputConfig: { cliType: 'custom', agentType: 'claude' },
        }),
        readLiveStatus: async () => {
          throw new Error('No live-status query');
        },
        readActiveTurnId: () => undefined,
        steerSession: async () => {
          throw new Error('No steer');
        },
        cancelSession: async () => {
          throw new Error('No cancellation');
        },
        dispatchSession: async () => {},
      },
    });
  }

  async function settleCatalogWait<T>(
    run: () => Promise<T>,
    duringWait?: () => Promise<void>
  ): Promise<T> {
    const started = testSignal();
    const ready = manager.catalogBaselineReady.bind(manager);
    const observer = vi.spyOn(manager, 'catalogBaselineReady').mockImplementation((id, timeout) => {
      const result = ready(id, timeout);
      if (timeout > 0) started.resolve();
      return result;
    });
    const outcome = run().then(
      (value) => () => value,
      (error: unknown) => () => {
        throw error;
      }
    );
    try {
      const waiting = await Promise.race([
        started.promise.then(() => true),
        outcome.then(() => false),
      ]);
      // A batch validates its items sequentially; each owns a one-second waiter.
      if (waiting) {
        await duringWait?.();
        await vi.advanceTimersByTimeAsync(duringWait ? 0 : 3_000);
      }
      return (await outcome)();
    } finally {
      observer.mockRestore();
    }
  }

  async function persistRemoteCatalogReceipt() {
    const docId = getWorkspaceFlockDocId(workspaceId);
    const { flock } = await manager.repo.openFlockDoc(docId);
    await manager.repo.persistFlockDocNow(docId, flock);
    // Inject at the real SDK cursor persistence boundary; the real Streams
    // composition test separately verifies only remote receipt creates this.
    await manager.repo.getReplicaCheckpointStore({ kind: 'flock', flockDocId: docId, flock }).save({
      streamUrl: 'https://streams.synthetic.invalid/catalog',
      nextOffset: '42',
      serverLowerBoundVersion: {},
      updatedAtMs: 1,
    });
  }

  async function seedRoles() {
    const agentConfigId = await manager.createAgentConfig('custom', 'claude', machineId, 'Agent');
    const handle = await manager.repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
    for (const userId of [ownerUserId, 'synthetic-collaborator']) {
      writeWorkspaceAgentRoleToFlock(handle.flock, {
        v: 1,
        id: userId as AgentRoleId,
        ownerUserId: userId,
        visibility: 'private',
        name: userId,
        promptPrefix: 'Review carefully.',
        machineId,
        agentConfigId,
        runConfig: {},
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      });
    }
    await manager.repo.flush();
    return agentConfigId;
  }

  it('authors concurrent creates and loads startup MCP from the live daemon catalog during sync failure', async () => {
    const agentConfigId = await seedRoles();
    const agentConfig = await manager.getAgentConfigById(agentConfigId);
    if (!agentConfig) throw new Error('Missing seeded Agent config');
    const id = 'synthetic-mcp' as McpServerId;
    const handle = await manager.repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
    const entry = {
      id,
      name: 'Synthetic MCP',
      transport: 'stdio' as const,
      connection: { transport: 'stdio' as const, command: 'synthetic-command' },
      enabledByDefault: true,
      createdAt: 1,
      updatedAt: 1,
    };
    writeWorkspaceMcpServerToFlock(handle.flock, entry);
    await manager.repo.flush();
    await waitForMcpCatalogBaseline(manager, workspaceId);
    vi.spyOn(manager, 'syncFlockDocOrThrow').mockRejectedValue(new Error('ECONNRESET'));
    const resolve = (dispatchConfig = {}) =>
      runWithDaemonWorkspace(daemon, () =>
        sessionCommands.resolveEffectiveSessionCreateDispatchConfig({
          manager,
          workspaceId,
          agentConfig,
          dispatchConfig,
        })
      );
    const configs = await Promise.all(Array.from({ length: 4 }, () => resolve()));
    expect(configs.map((config) => config.mcpServerIds)).toEqual([[id], [id], [id], [id]]);
    const select = await loadSessionMcpCatalog({
      repo: manager.repo,
      waitForCatalogBaseline: () => waitForMcpCatalogBaseline(manager, workspaceId),
      workspaceId,
      sessionId,
      selectedIds: [id],
      logger: createSilentLogger(),
    });
    expect(select(undefined)).toMatchObject({
      servers: [{ name: 'Synthetic MCP', command: 'synthetic-command' }],
      problems: [],
    });
    writeWorkspaceMcpServerToFlock(handle.flock, {
      ...entry,
      enabledByDefault: false,
      updatedAt: 2,
    });
    expect((await resolve()).mcpServerIds).toEqual([]);
    expect((await resolve(configs[0])).mcpServerIds).toEqual([id]);
  });

  it.each([
    ['lody_session_create', false],
    ['lody_session_create_many', false],
    ['lody_session_create', true],
    ['lody_session_create_many', true],
  ] as const)(
    'accepts %s from persisted defaults before any Streams baseline (configured=%s)',
    async (tool, configured) => {
      const agentConfigId = await seedRoles();
      const id = 'persisted-default-mcp' as McpServerId;
      if (configured) {
        const handle = await manager.repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
        writeWorkspaceMcpServerToFlock(handle.flock, {
          id,
          name: 'Persisted default MCP',
          transport: 'stdio',
          connection: { transport: 'stdio', command: 'synthetic-command' },
          enabledByDefault: true,
          createdAt: 1,
          updatedAt: 1,
        });
      }
      await persistRemoteCatalogReceipt();
      await manager.repo.flush();
      await manager.cleanUp({ fast: true });
      manager = await LoroDocumentManager.create(workspaceId, ownerUserId, createSilentLogger(), {
        keepWorkspaceCatalogJoined: true,
        streamsTokens: {} as never,
      });
      daemon.manager = manager;
      vi.useFakeTimers();
      expect(manager.hasPersistedWorkspaceCatalog()).toBe(true);
      expect(await manager.catalogBaselineReady(getWorkspaceFlockDocId(workspaceId), 0)).toBe(
        false
      );
      const agentConfig = await manager.getAgentConfigById(agentConfigId);
      if (!agentConfig) throw new Error('Missing persisted Agent config');
      const selected = await settleCatalogWait(() =>
        runWithDaemonWorkspace(daemon, () =>
          sessionCommands.resolveEffectiveSessionCreateDispatchConfig({
            manager,
            workspaceId,
            agentConfig,
            dispatchConfig: {},
          })
        )
      );
      expect(selected.mcpServerIds).toEqual(configured ? [id] : []);
      const project = { kind: 'github' as const, repoFullName: 'synthetic/repo', branch: 'main' };
      const projectKey = getProjectMcpKey(project);
      if (!projectKey) throw new Error('Expected a project key');
      const defaults = await manager.repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
      defaults.flock.set(workspaceFlockKeys.projectMcpDefault(projectKey), { ids: [] });
      defaults.flock.commit();
      const projectDefault = await settleCatalogWait(() =>
        runWithDaemonWorkspace(daemon, () =>
          sessionCommands.resolveEffectiveSessionCreateDispatchConfig({
            manager,
            workspaceId,
            agentConfig,
            project,
            dispatchConfig: {},
          })
        )
      );
      expect(projectDefault.mcpServerIds).toEqual([]);
      const frozen = await runWithDaemonWorkspace(daemon, () =>
        sessionCommands.resolveEffectiveSessionCreateDispatchConfig({
          manager,
          workspaceId,
          agentConfig,
          project,
          dispatchConfig: selected,
        })
      );
      expect(frozen.mcpServerIds).toEqual(configured ? [id] : []);

      const explicit = await runWithDaemonWorkspace(daemon, () =>
        sessionCommands.resolveEffectiveSessionCreateDispatchConfig({
          manager,
          workspaceId,
          agentConfig,
          dispatchConfig: { mcpServerIds: [] },
        })
      );
      expect(explicit.mcpServerIds).toEqual([]);
      const environment = createEnvironment();
      vi.spyOn(manager, 'syncMetaOrThrow').mockResolvedValue();
      const item = { prompt: 'Review synthetic code.', machineId, agentConfigId };
      const create = () =>
        runWithSessionCommandEnvironment(environment, () =>
          executeDaemonSessionTool(
            context(),
            tool,
            tool === 'lody_session_create'
              ? { operationId: 'cold-defaults', ...item }
              : { operationId: 'cold-defaults', items: [item, item] }
          )
        );
      const recovered = await settleCatalogWait(create);
      expect(JSON.parse(recovered.content[0]?.text ?? '{}')).toMatchObject({
        id: 'cold-defaults',
        state: 'active',
        items: Array.from({ length: tool === 'lody_session_create' ? 1 : 2 }, () => ({
          status: 'active',
          inputDurable: true,
        })),
      });
      expect(await manager.catalogBaselineReady(getWorkspaceFlockDocId(workspaceId), 0)).toBe(
        false
      );
    }
  );

  it.each(['lody_session_create', 'lody_session_create_many'] as const)(
    'rejects %s with no remote history before acceptance and recovers the same request after catch-up',
    async (tool) => {
      const agentConfigId = await manager.createAgentConfig('custom', 'claude', machineId, 'Agent');
      await manager.repo.flush();
      await manager.cleanUp({ fast: true });
      manager = await LoroDocumentManager.create(workspaceId, ownerUserId, createSilentLogger(), {
        keepWorkspaceCatalogJoined: true,
        streamsTokens: {} as never,
      });
      daemon.manager = manager;
      const environment = createEnvironment();
      vi.spyOn(manager, 'syncMetaOrThrow').mockResolvedValue();
      vi.useFakeTimers();
      const item = { prompt: 'Review synthetic code.', machineId, agentConfigId };
      const create = (explicit = false) =>
        runWithSessionCommandEnvironment(environment, () =>
          executeDaemonSessionTool(
            context(),
            tool,
            tool === 'lody_session_create'
              ? {
                  operationId: explicit ? 'explicit-none' : 'fresh-defaults',
                  ...item,
                  ...(explicit ? { mcpServerIds: [] } : {}),
                }
              : {
                  operationId: explicit ? 'explicit-none' : 'fresh-defaults',
                  items: [item, item].map((entry) => ({
                    ...entry,
                    ...(explicit ? { mcpServerIds: [] } : {}),
                  })),
                }
          )
        );
      expect(manager.hasPersistedWorkspaceCatalog()).toBe(false);
      const failed = await settleCatalogWait(create);
      expect(JSON.parse(failed.content[0]?.text ?? '{}')).toMatchObject({
        ok: false,
        error: { code: 'SYNC_UNAVAILABLE', retryable: true },
      });
      const operations = await runWithSessionCommandEnvironment(environment, () =>
        executeDaemonSessionTool(context(), 'lody_operation_list', {})
      );
      expect(JSON.parse(operations.content[0]?.text ?? '{}')).toMatchObject({ items: [] });
      const localAgent = await manager.getAgentConfigById(agentConfigId);
      if (!localAgent) throw new Error('Missing Agent');
      // Schedule's daemon IPC entry has a reader owner but no Session ALS.
      await expect(
        settleCatalogWait(() =>
          sessionCommands.resolveEffectiveSessionCreateDispatchConfig({
            manager,
            workspaceId,
            agentConfig: localAgent,
            dispatchConfig: {},
          })
        )
      ).rejects.toMatchObject({ _tag: 'WorkspaceSyncUnavailableError' });
      // Schedule create/edit use this same validation before repository.save.
      await expect(
        settleCatalogWait(() =>
          runWithSessionCommandEnvironment(environment, () =>
            sessionCommands.validateSessionCreateOptions({
              manager,
              auth: environment.auth,
              workspace: { id: workspaceId, name: 'Synthetic' },
              options: {
                machine: machineId,
                agentConfig: agentConfigId,
                currentSessionId: sessionId,
              },
              skipMachineAvailabilityCheck: true,
            })
          )
        )
      ).rejects.toMatchObject({ _tag: 'WorkspaceSyncUnavailableError' });

      // Locally authored rows cannot turn unknown remote defaults into known absence.
      await seedRoles();
      expect(manager.hasPersistedWorkspaceCatalog()).toBe(false);
      const stillUnknown = await settleCatalogWait(create);
      expect(JSON.parse(stillUnknown.content[0]?.text ?? '{}')).toMatchObject({
        error: { code: 'SYNC_UNAVAILABLE', retryable: true },
      });
      expect(JSON.parse((await create(true)).content[0]?.text ?? '{}')).toMatchObject({
        id: 'explicit-none',
        state: 'active',
      });
      const host = await LoroRepo.create({});
      try {
        const docId = getWorkspaceFlockDocId(workspaceId);
        const remote = await host.openFlockDoc(docId);
        const id = 'remote-default-mcp' as McpServerId;
        writeWorkspaceMcpServerToFlock(remote.flock, {
          id,
          name: 'Remote default',
          transport: 'stdio',
          connection: { transport: 'stdio', command: 'synthetic-command' },
          enabledByDefault: true,
          createdAt: 1,
          updatedAt: 1,
        });
        const network = makePromiseRepoNetwork();
        await host.addTransport('streams', network.transport());
        const room = await host.joinFlockDocRoom(docId);
        const recovered = await settleCatalogWait(create, async () => {
          await vi.advanceTimersByTimeAsync(200);
          await manager.repo.addTransport('streams', network.transport());
        });
        expect(await manager.catalogBaselineReady(docId, 0)).toBe(true);
        expect(JSON.parse(recovered.content[0]?.text ?? '{}')).toMatchObject({
          id: 'fresh-defaults',
          state: 'active',
          items: Array.from({ length: tool === 'lody_session_create' ? 1 : 2 }, () => ({
            inputDurable: true,
          })),
        });
        const agentConfig = await manager.getAgentConfigById(agentConfigId);
        if (!agentConfig) throw new Error('Missing Agent');
        const selected = await runWithDaemonWorkspace(daemon, () =>
          sessionCommands.resolveEffectiveSessionCreateDispatchConfig({
            manager,
            workspaceId,
            agentConfig,
            dispatchConfig: {},
          })
        );
        expect(selected.mcpServerIds).toEqual([id]);
        const operationStore = new LodyOperationStore(
          getLodyOperationStorePath(machineId),
          undefined,
          { maintenance: false }
        );
        try {
          expect(
            operationStore.get(sessionId, 'fresh-defaults').frozenContinuationConfig
              .targetDispatchConfigs
          ).toEqual(
            Array.from({ length: tool === 'lody_session_create' ? 1 : 2 }, () =>
              expect.objectContaining({ mcpServerIds: [id] })
            )
          );
        } finally {
          operationStore.close();
        }

        room.unsubscribe();
      } finally {
        await host.destroy();
      }
    }
  );

  it.each(['metadata', 'flock'] as const)(
    'reads daemon catalogs for the active user when %s synchronization fails',
    async (failure) => {
      const agentConfigId = await seedRoles();
      vi.spyOn(commandRuntime, 'getAuthContextOrThrow').mockImplementation(createAuth);
      vi.spyOn(commandRuntime, 'resolveWorkspaceOrThrow').mockResolvedValue({
        id: workspaceId,
        name: 'Synthetic',
        slug: 'synthetic',
        role: 'owner',
      });
      vi.spyOn(sessionCommands, 'readSessionMachineAccess').mockImplementation(async (args) => ({
        ...(args.delegatedRequester?.userId === 'synthetic-collaborator'
          ? { allowed: true as const }
          : { allowed: false as const, reason: 'not_visible' as const }),
      }));
      vi.spyOn(manager, 'syncMetaOrThrow').mockImplementation(async () => {
        if (failure === 'metadata')
          throw new Error(
            'Workspace metadata sync failed (resource.discovery): Repository adapter operation failed'
          );
      });
      vi.spyOn(manager, 'syncFlockDocOrThrow').mockRejectedValue(
        new Error('Flock sync unavailable')
      );
      for (const [name, args, expected] of [
        ['lody_agent_role_list', {}, { items: [{ id: 'synthetic-collaborator', machineId }] }],
        [
          'lody_agent_role_get',
          { id: 'synthetic-collaborator' },
          { item: { promptPrefix: 'Review carefully.' } },
        ],
        ['lody_agent_config_list', {}, { items: [{ id: agentConfigId }] }],
      ] as const) {
        const result = await runWithDaemonWorkspace(daemon, () =>
          executeDaemonSessionTool(context(), name, args)
        );
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject(expected);
      }
    }
  );

  it('keeps standalone discovery sync failures explicit and offline reads available', async () => {
    await seedRoles();
    vi.spyOn(manager, 'syncMetaOrThrow').mockRejectedValue(new Error('Metadata unavailable'));
    const args = { manager, auth: createAuth(), workspaceId };
    await expect(createResourceDiscovery(args)).rejects.toThrow('Use --offline');
    vi.spyOn(manager, 'syncMetaOrThrow').mockResolvedValue();
    vi.spyOn(manager, 'syncFlockDocOrThrow').mockRejectedValue(new Error('Flock unavailable'));
    await expect((await createResourceDiscovery(args)).list('agent_role')).rejects.toThrow(
      'Flock unavailable'
    );
    // With no machine access, the readable Role still remains listed as unavailable.
    vi.spyOn(sessionCommands, 'readSessionMachineAccess').mockResolvedValue({
      allowed: false,
      reason: 'not_visible',
    });
    const offline = await createResourceDiscovery({ ...args, offline: true });
    expect((await offline.list('agent_role')).items).toMatchObject([{ id: ownerUserId }]);
  });

  it('reads the local daemon catalog without forcing synchronization', async () => {
    await seedRoles();
    vi.spyOn(manager, 'syncMetaOrThrow').mockRejectedValue(new Error('Metadata unavailable'));
    vi.spyOn(manager, 'syncFlockDocOrThrow').mockRejectedValue(new Error('Flock unavailable'));
    const environment = createLocalSessionCommandEnvironment({
      manager,
      workspaceId,
      machineId,
      machineName: 'Daemon',
      userId: ownerUserId,
      host: {
        readInvocation: daemon.readInvocation,
        readLiveStatus: async () => {
          throw new Error('Unexpected live status');
        },
        readActiveTurnId: () => undefined,
        steerSession: async () => {
          throw new Error('Unexpected steer');
        },
        cancelSession: async () => {
          throw new Error('Unexpected cancellation');
        },
        dispatchSession: async () => {
          throw new Error('Unexpected dispatch');
        },
      },
    });
    await runWithSessionCommandEnvironment(environment, async () => {
      const discovery = await createResourceDiscovery({
        manager,
        workspaceId,
        auth: environment.auth,
      });
      expect((await discovery.list('agent_role')).items).toMatchObject([
        { id: ownerUserId, machineId },
      ]);
    });
  });

  it.each(['local', 'cloud'] as const)(
    'archives only contained Tabs through the %s daemon MCP entrypoint',
    async (composition) => {
      const root = {
        ...(await manager.repo.getDocMeta(getSessionRoomId(sessionId)))?.meta,
        id: sessionId,
        isArchived: false,
        status: SessionStatusFactory.running(),
      } as SessionMeta;
      const tab = { ...root, id: 'archive-tab' as SessionId, parentSessionId: sessionId };
      const opened = {
        ...root,
        id: 'archive-opened' as SessionId,
        openedBySessionId: sessionId,
      };
      const openedByTab = {
        ...opened,
        id: 'archive-opened-by-tab' as SessionId,
        openedBySessionId: tab.id,
        openedByRootSessionId: sessionId,
      };
      const independentTab = {
        ...root,
        id: 'archive-independent-tab' as SessionId,
        parentSessionId: openedByTab.id,
      };
      const independentSessions = [opened, openedByTab, independentTab];
      const sessions = [root, tab, ...independentSessions];
      for (const session of sessions)
        await manager.repo.upsertDocMeta(getSessionRoomId(session.id), session);

      const environment = createLocalSessionCommandEnvironment({
        manager,
        workspaceId,
        machineId,
        machineName: 'Daemon',
        userId: ownerUserId,
        host: {
          readInvocation: (id) => ({
            type: 'session/active-invocation-context',
            active: true,
            sessionId: id,
            requesterUserId: ownerUserId,
            sourceTurnId: 'synthetic-turn',
            inputConfig: { cliType: 'custom', agentType: 'claude' },
          }),
          readLiveStatus: async () => {
            throw new Error('Archive must not request live status');
          },
          readActiveTurnId: () => undefined,
          steerSession: async () => {
            throw new Error('Archive must not steer a Session');
          },
          cancelSession: async () => {
            throw new Error('Archive is observed, not a cancellation request');
          },
          dispatchSession: async () => {
            throw new Error('Archive must not dispatch a Session');
          },
        },
      });
      if (composition === 'cloud') {
        vi.spyOn(commandRuntime, 'getAuthContextOrThrow').mockImplementation(createAuth);
        vi.spyOn(commandRuntime, 'resolveWorkspaceOrThrow').mockResolvedValue({
          id: workspaceId,
          name: 'Synthetic',
          slug: 'synthetic',
          role: 'owner',
        });
      }
      const sync = vi.spyOn(manager, 'syncMetaOrThrow');
      sync.mockRejectedValueOnce(new Error('Synthetic metadata unavailable'));
      vi.spyOn(manager, 'waitUntilMetaSynced').mockResolvedValue(true);
      const archive = () => {
        const execute = () =>
          executeDaemonSessionTool(context(), 'lody_session_archive', { sessionId });
        return composition === 'local'
          ? runWithSessionCommandEnvironment(environment, execute)
          : runWithDaemonWorkspace(daemon, execute);
      };

      expect((await archive()).isError).toBe(true);
      for (const session of sessions)
        expect((await manager.repo.getDocMeta(getSessionRoomId(session.id)))?.meta).toEqual(
          session
        );

      sync.mockResolvedValue();
      // Repeated archive is idempotent and must not reach independently opened work.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await archive();
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
          ok: true,
          sessionId,
          archivedChildSessionIds: [tab.id],
        });
      }
      for (const session of [root, tab])
        expect((await manager.repo.getDocMeta(getSessionRoomId(session.id)))?.meta).toMatchObject({
          isArchived: true,
          status: SessionStatusFactory.idle(),
        });
      for (const session of independentSessions)
        expect((await manager.repo.getDocMeta(getSessionRoomId(session.id)))?.meta).toEqual(
          session
        );
    }
  );

  it('serves bound Session tools from the daemon access verdict while workspace discovery is down', async () => {
    const list = vi
      .spyOn(workspaceApi, 'listWorkspacesForToken')
      .mockRejectedValue(new Error('Synthetic workspace discovery outage'));
    vi.spyOn(commandRuntime, 'getAuthContextOrThrow').mockImplementation(createAuth);
    vi.spyOn(sessionCommands, 'readSessionMachineAccess').mockResolvedValue({ allowed: true });
    vi.spyOn(manager, 'syncMetaOrThrow').mockResolvedValue();
    vi.spyOn(manager, 'waitUntilMetaSynced').mockResolvedValue(true);
    const authorized: DaemonWorkspaceAccess = {
      status: 'authorized',
      workspace: { id: workspaceId, name: 'Synthetic', slug: 'synthetic', role: 'member' },
    };
    let access: DaemonWorkspaceAccess = authorized;
    const call = (name: string, args: Record<string, unknown>) =>
      runWithDaemonWorkspace({ ...daemon, readAccess: () => access }, () =>
        executeDaemonSessionTool(context(), name, args)
      );
    const text = (result: Awaited<ReturnType<typeof call>>) => result.content[0]?.text ?? '';

    const listed = await call('lody_session_list', {});
    expect(listed.isError, text(listed)).not.toBe(true);
    expect(JSON.parse(text(listed))).toMatchObject({
      items: [expect.objectContaining({ id: sessionId })],
    });

    // A confirmed revocation denies; it never falls back to cache or discovery.
    access = { status: 'revoked' };
    const denied = await call('lody_session_archive', { sessionId });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain('Workspace access was revoked');
    expect((await manager.repo.getDocMeta(getSessionRoomId(sessionId)))?.meta).toMatchObject({
      isArchived: false,
    });

    // Restored access is used by the next call without restarting the daemon.
    access = authorized;
    const archived = await call('lody_session_archive', { sessionId });
    expect(archived.isError, text(archived)).not.toBe(true);
    expect(list).not.toHaveBeenCalled();

    // Without a verdict the command still discovers, and keeps that failure visible.
    access = { status: 'unknown' };
    const undiscovered = await call('lody_session_list', {});
    expect(undiscovered.isError).toBe(true);
    expect(text(undiscovered)).toContain('Synthetic workspace discovery outage');
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('binds daemon workspace resolution to the daemon identity and workspace', async () => {
    const list = vi.spyOn(workspaceApi, 'listWorkspacesForToken');
    const workspace = { id: workspaceId, name: 'Synthetic', slug: 'synthetic', role: 'member' };
    let access: DaemonWorkspaceAccess = { status: 'authorized', workspace };
    const auth = createAuth();
    await runWithDaemonWorkspace({ ...daemon, readAccess: () => access }, async () => {
      await expect(resolveWorkspaceOrThrow(auth)).resolves.toEqual(workspace);
      await expect(resolveWorkspaceOrThrow(auth, 'synthetic')).resolves.toEqual(workspace);
      // An explicit other workspace is refused, never replaced by the current one.
      await expect(resolveWorkspaceOrThrow(auth, 'other-workspace')).rejects.toThrow(
        'Daemon command workspace mismatch'
      );
      for (const other of [{ userId: 'other-user' }, { machineId: 'other-machine' as MachineId }])
        await expect(resolveWorkspaceOrThrow({ ...auth, ...other }, workspaceId)).rejects.toThrow(
          'restart the daemon'
        );
      access = { status: 'authorized', workspace: { ...workspace, id: 'other-workspace' } };
      await expect(resolveWorkspaceOrThrow(auth, workspaceId)).rejects.toThrow(
        'Daemon command workspace mismatch'
      );
      access = { status: 'unauthorized' };
      await expect(resolveWorkspaceOrThrow(auth, workspaceId)).rejects.toThrow(
        'CLI token is invalid or expired'
      );
    });
    expect(list).not.toHaveBeenCalled();
  });

  it('executes a Session tool for another requester against the daemon replica', async () => {
    const result = await runWithDaemonWorkspace(daemon, () =>
      executeDaemonSessionTool(context(), 'lody_operation_list', {})
    );
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({ items: [] });
  });

  it('returns syncing uncertainty for a detached cold catalog and reads normally after its baseline', async () => {
    await manager.cleanUp({ fast: true });
    manager = await LoroDocumentManager.create(workspaceId, ownerUserId, createSilentLogger(), {
      keepWorkspaceCatalogJoined: true,
      streamsTokens: {
        createTokenProvider: () => Effect.die(new Error('No real cloud token in this fixture')),
        createTokenProviderLegacy: () => {
          throw new Error('No real cloud token in this fixture');
        },
      },
    });
    daemon = { ...daemon, manager };
    const remoteMachineId = 'cold-machine' as MachineId;
    const id = getMachineFlockDocId(workspaceId, remoteMachineId);
    await manager.repo.upsertDocMeta(getMachineRoomId(remoteMachineId), {
      id: remoteMachineId,
      name: 'Remote',
      ownerUserId,
    });
    const roleDoc = await manager.repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
    writeWorkspaceAgentRoleToFlock(roleDoc.flock, {
      v: 1,
      id: 'cold-role' as AgentRoleId,
      name: 'Cold',
      ownerUserId: 'synthetic-collaborator',
      visibility: 'private',
      machineId: remoteMachineId,
      agentConfigId: 'cold-config' as AgentConfigId,
      runConfig: { modelId: 'remote-model' },
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    const host = await LoroRepo.create({});
    const network = makePromiseRepoNetwork();
    let unsubscribe: (() => void) | undefined;
    try {
      const remote = await host.openFlockDoc(id);
      writeAgentConfigToFlock(remote.flock, {
        id: 'cold-config' as AgentConfigId,
        machineId: remoteMachineId,
        name: 'Remote',
        description: '',
        cliType: 'custom',
        agentType: 'claude',
        env: {},
      });
      await host.addTransport('streams', network.transport());
      await host.joinMetaRoom();
      await host.joinFlockDocRoom(id);
      vi.spyOn(sessionCommands, 'readSessionMachineAccess').mockResolvedValue({ allowed: true });
      const args = {
        manager,
        auth: createAuth(),
        workspaceId,
        delegatedRequester: { userId: 'synthetic-collaborator' },
        initialCatalogWaitMs: 0,
      };
      const discovery = await runWithDaemonWorkspace(daemon, () => createResourceDiscovery(args));
      expect(await discovery.list('agent_role')).toMatchObject({
        sync: { state: 'syncing', retryable: true },
        items: [{ availability: { state: 'unknown', reason: 'catalog_syncing' } }],
      });
      await expect(discovery.get('agent_config', 'cold-config')).rejects.toThrow('CATALOG_SYNCING');
      const local = await manager.repo.openFlockDoc(id);
      const received = testSignal();
      unsubscribe = local.flock.subscribe(() => {
        if (
          getMachineFlockAgentConfigs(readMachineFlockRowsFromFlock(local.flock))[
            'cold-config' as AgentConfigId
          ]
        )
          received.resolve();
      });
      await manager.repo.addTransport('streams', network.transport());
      await received.promise;
      // A new request reads the same Promise replica; no forced catch-up is needed.
      vi.spyOn(manager, 'syncMetaOrThrow').mockRejectedValue(new Error('No request sync'));
      vi.spyOn(manager, 'syncFlockDocOrThrow').mockRejectedValue(new Error('No request sync'));
      const ready = await runWithDaemonWorkspace(daemon, () => createResourceDiscovery(args));
      expect(await ready.get('agent_config', 'cold-config')).toMatchObject({
        item: { id: 'cold-config', name: 'Remote' },
      });
    } finally {
      unsubscribe?.();
      await host.destroy();
    }
  });

  it('validates Role creation against a cold remote config before publishing the review card', async () => {
    const network = makePromiseRepoNetwork();
    const host = await LoroRepo.create({});
    try {
      const remoteMachineId = 'remote-role-target' as MachineId;
      const id = getMachineFlockDocId(workspaceId, remoteMachineId);
      const room = await host.openFlockDoc(id);
      writeAgentConfigToFlock(room.flock, {
        id: 'remote-role-config' as AgentConfigId,
        machineId: remoteMachineId,
        name: 'Remote',
        description: '',
        cliType: 'custom',
        agentType: 'claude',
        env: {},
      });
      await host.addTransport('memory', network.transport());
      await host.joinMetaRoom();
      await host.joinFlockDocRoom(id);
      await manager.repo.addTransport('memory', network.transport());
      await manager.repo.upsertDocMeta(getMachineRoomId(remoteMachineId), {
        id: remoteMachineId,
        name: 'Remote',
        ownerUserId,
      });
      const session = await manager.getOrCreateSessionDoc(sessionId, { historyBackend: 'loro' });
      vi.spyOn(session, 'waitUntilSynced').mockResolvedValue(true);
      vi.spyOn(commandRuntime, 'getAuthContextOrThrow').mockImplementation(createAuth);
      vi.spyOn(commandRuntime, 'resolveWorkspaceOrThrow').mockResolvedValue({
        id: workspaceId,
        name: 'Synthetic',
        slug: 'synthetic',
        role: 'owner',
      });
      vi.spyOn(sessionCommands, 'readSessionMachineAccess').mockResolvedValue({ allowed: true });
      const result = await runWithDaemonWorkspace(daemon, () =>
        executeDaemonSessionTool(context(), 'lody_agent_role_create', {
          requestId: 'cold-target',
          name: 'Remote Role',
          machineId: remoteMachineId,
          agentConfigId: 'remote-role-config',
        })
      );
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({ pending: true });
      const originalSync = manager.syncFlockDocOrThrow.bind(manager);
      const originalFailure = new Error('Synthetic remote catalog outage');
      vi.spyOn(manager, 'syncFlockDocOrThrow').mockImplementation((docId, options) =>
        docId === id ? Promise.reject(originalFailure) : originalSync(docId, options)
      );
      const retry = await runWithDaemonWorkspace(daemon, () =>
        executeDaemonSessionTool(context(), 'lody_agent_role_create', {
          requestId: 'cold-retry',
          name: 'Retry Role',
          machineId: remoteMachineId,
          agentConfigId: 'remote-role-config',
        })
      );
      expect(retry.isError).toBe(true);
      expect(JSON.parse(retry.content[0]?.text ?? '{}')).toMatchObject({
        ok: false,
        error: { code: 'SYNC_UNAVAILABLE', retryable: true },
      });
    } finally {
      await host.destroy();
    }
  });

  it.each([
    ['create', 'metadata'],
    ['create', 'workspace'],
    ['create', 'target'],
    ['update', 'metadata'],
    ['update', 'workspace'],
  ] as const)(
    'keeps failed %s %s validation retryable without publishing a proposal',
    async (action, failure) => {
      const configId = await seedRoles();
      const session = await manager.getOrCreateSessionDoc(sessionId, { historyBackend: 'loro' });
      const backend = await createSessionBackend(session);
      vi.spyOn(session, 'waitUntilSynced').mockResolvedValue(true);
      vi.spyOn(manager, 'syncDocOrThrow').mockResolvedValue();
      vi.spyOn(commandRuntime, 'getAuthContextOrThrow').mockImplementation(createAuth);
      vi.spyOn(commandRuntime, 'resolveWorkspaceOrThrow').mockResolvedValue({
        id: workspaceId,
        name: 'Synthetic',
        slug: 'synthetic',
        role: 'owner',
      });
      vi.spyOn(sessionCommands, 'readSessionMachineAccess').mockResolvedValue({ allowed: true });
      let unavailable = true;
      const original = new Error('Synthetic synchronization outage');
      vi.spyOn(manager, 'syncMetaOrThrow').mockImplementation(async () => {
        if (unavailable && failure === 'metadata') throw original;
      });
      vi.spyOn(manager, 'syncFlockDocOrThrow').mockImplementation(async (id) => {
        if (
          unavailable &&
          id ===
            (failure === 'target'
              ? getMachineFlockDocId(workspaceId, machineId)
              : getWorkspaceFlockDocId(workspaceId))
        )
          throw original;
      });
      const requestId = `${action}-${failure}`;
      const args =
        action === 'create'
          ? { requestId, name: 'New role', machineId, agentConfigId: configId }
          : { requestId, roleId: 'synthetic-collaborator', patch: { description: 'Updated' } };
      const propose = () =>
        runWithDaemonWorkspace(daemon, () =>
          executeDaemonSessionTool(context(), `lody_agent_role_${action}`, args)
        );
      const failed = await propose();
      expect(failed.isError).toBe(true);
      expect(JSON.parse(failed.content[0]?.text ?? '{}')).toMatchObject({
        error: { code: 'SYNC_UNAVAILABLE', retryable: true },
      });
      expect(await backend.readTurn(`agent-role-proposal-${requestId}`)).toMatchObject({
        state: 'missing',
      });
      unavailable = false;
      expect(JSON.parse((await propose()).content[0]?.text ?? '{}')).toMatchObject({
        pending: true,
      });
      expect(await backend.readTurn(`agent-role-proposal-${requestId}`)).toMatchObject({
        state: 'ready',
      });
    }
  );

  it('hydrates a cold headless daemon and receives later Role changes without a discovery sync', async () => {
    const docId = getWorkspaceFlockDocId(workspaceId);
    const network = makePromiseRepoNetwork();
    const host = await LoroRepo.create({});
    const remote = await host.openFlockDoc(docId);
    const remoteFlock = remote.flock;
    const local = await manager.repo.openFlockDoc(docId);
    const received = testSignal();
    const updated = testSignal();
    const reattached = testSignal();
    const detach = local.flock.subscribe(() => {
      const role = listWorkspaceAgentRoles(readWorkspaceFlockRowsFromFlock(local.flock)).find(
        (row) => row.id === 'remote-role'
      );
      if (role?.revision === 1) received.resolve();
      if (role?.revision === 2) updated.resolve();
      if (role?.revision === 3) reattached.resolve();
    });
    const detachCallbacks = [detach];
    try {
      writeWorkspaceAgentRoleToFlock(remoteFlock, {
        v: 1,
        id: 'remote-role' as AgentRoleId,
        ownerUserId: 'synthetic-collaborator',
        visibility: 'private',
        name: 'Remote Role',
        machineId,
        agentConfigId: 'remote-config' as AgentConfigId,
        runConfig: {},
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      await host.addTransport('memory', network.transport());
      await host.joinMetaRoom();
      await host.joinFlockDocRoom(docId);
      await manager.repo.addTransport('memory', network.transport());
      await received.promise;
      const remoteMachineId = 'remote-machine' as MachineId;
      const machineDocId = getMachineFlockDocId(workspaceId, remoteMachineId);
      const machineRoom = await host.openFlockDoc(machineDocId);
      const remoteConfig = {
        id: 'remote-agent' as AgentConfigId,
        machineId: remoteMachineId,
        name: 'Remote Agent',
        description: '',
        cliType: 'custom' as const,
        agentType: 'claude' as const,
        env: {},
      };
      writeAgentConfigToFlock(machineRoom.flock, remoteConfig);
      await host.joinFlockDocRoom(machineDocId);
      await manager.repo.upsertDocMeta(getMachineRoomId(remoteMachineId), {
        id: remoteMachineId,
        name: 'Remote Machine',
        ownerUserId,
      });
      const localMachine = await manager.repo.openFlockDoc(machineDocId);
      const configReceived = testSignal();
      const configUpdated = testSignal();
      const detachMachine = localMachine.flock.subscribe(() => {
        const config = getMachineFlockAgentConfigs(
          readMachineFlockRowsFromFlock(localMachine.flock)
        )[remoteConfig.id];
        if (config?.name === 'Remote Agent') configReceived.resolve();
        if (config?.name === 'Updated Agent') configUpdated.resolve();
      });
      detachCallbacks.push(detachMachine);
      vi.spyOn(manager, 'syncMetaOrThrow').mockRejectedValue(new Error('No request sync'));
      vi.spyOn(manager, 'syncFlockDocOrThrow').mockRejectedValue(new Error('No request sync'));
      vi.spyOn(commandRuntime, 'getAuthContextOrThrow').mockImplementation(createAuth);
      vi.spyOn(commandRuntime, 'resolveWorkspaceOrThrow').mockResolvedValue({
        id: workspaceId,
        name: 'Synthetic',
        slug: 'synthetic',
        role: 'owner',
      });
      vi.spyOn(sessionCommands, 'readSessionMachineAccess').mockResolvedValue({ allowed: true });
      const list = () =>
        runWithDaemonWorkspace(daemon, () =>
          executeDaemonSessionTool(context(), 'lody_agent_role_list', {})
        );
      expect(JSON.parse((await list()).content[0]?.text ?? '{}').items).toMatchObject([
        { id: 'remote-role', revision: 1 },
      ]);
      const configs = () =>
        runWithDaemonWorkspace(daemon, () =>
          executeDaemonSessionTool(context(), 'lody_agent_config_list', {
            machineId: remoteMachineId,
          })
        );
      // A first read admits background reader interest; it never waits for catch-up.
      await configs();
      await configReceived.promise;
      expect(JSON.parse((await configs()).content[0]?.text ?? '{}').items).toMatchObject([
        { id: remoteConfig.id, name: 'Remote Agent' },
      ]);
      writeAgentConfigToFlock(machineRoom.flock, {
        ...remoteConfig,
        name: 'Updated Agent',
      });
      await configUpdated.promise;
      expect(JSON.parse((await configs()).content[0]?.text ?? '{}').items).toMatchObject([
        { id: remoteConfig.id, name: 'Updated Agent' },
      ]);
      const role = listWorkspaceAgentRoles(readWorkspaceFlockRowsFromFlock(remoteFlock))[0];
      if (!role) throw new Error('Missing Role');
      writeWorkspaceAgentRoleToFlock(remoteFlock, {
        ...role,
        revision: 2,
        name: 'Updated Role',
        updatedAt: 2,
      });
      await updated.promise;
      expect(JSON.parse((await list()).content[0]?.text ?? '{}').items).toMatchObject([
        { id: 'remote-role', name: 'Updated Role', revision: 2 },
      ]);
      await manager.repo.removeTransport('memory');
      writeWorkspaceAgentRoleToFlock(remoteFlock, {
        ...role,
        revision: 3,
        name: 'Reattached Role',
        updatedAt: 3,
      });
      // Cached results stay useful while detached; reattachment refreshes the same replica.
      expect(JSON.parse((await list()).content[0]?.text ?? '{}').items).toMatchObject([
        { id: 'remote-role', revision: 2 },
      ]);
      await manager.repo.addTransport('memory', network.transport());
      await reattached.promise;
      expect(JSON.parse((await list()).content[0]?.text ?? '{}').items).toMatchObject([
        { id: 'remote-role', name: 'Reattached Role', revision: 3 },
      ]);
    } finally {
      for (const unsubscribe of detachCallbacks) unsubscribe();
      await host.destroy();
    }
  });

  it('routes an MCP process Session tool to the daemon instead of executing it locally', async () => {
    const handled: string[] = [];
    const control = new LocalControlHandler({
      machineId,
      logger: createSilentLogger(),
      dispatchSession: async () => {
        throw new Error('Unexpected session control');
      },
      dispatchProject: async () => {
        throw new Error('Unexpected project control');
      },
      dispatchMachineRpc: async (request) => {
        if (request.method !== 'session/call-tool') throw new Error('Unexpected RPC');
        handled.push(request.params.name);
        return {
          ok: true,
          result: await runWithDaemonWorkspace(daemon, () =>
            executeDaemonSessionTool(
              { ...context(), sessionId: request.params.sessionId },
              request.params.name,
              request.params.arguments
            )
          ),
        };
      },
    });
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\lody-daemon-tools-${process.pid}`
        : path.join(tempDir, 'control.sock');
    const socketServer = http.createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await control.handle({
          path: request.url ?? '',
          rawBody: Buffer.concat(chunks).toString('utf8'),
          requestId: 1,
        });
        response
          .writeHead(result.status, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(result.payload));
      })();
    });
    await new Promise<void>((resolve, reject) => {
      socketServer.once('error', reject);
      socketServer.listen(socketPath, resolve);
    });
    const mcpServer = buildLodyMcpServer();
    const client = new Client({ name: 'daemon-tools-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await runWithMcpSessionContext(
        { ...context(), localControlSocketPath: socketPath },
        () => client.callTool({ name: 'lody_operation_list', arguments: {} })
      );
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(handled).toEqual(['lody_operation_list']);
    } finally {
      await client.close();
      await mcpServer.close();
      await new Promise<void>((resolve, reject) =>
        socketServer.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('lends the daemon replica to nested commands and refuses another workspace', async () => {
    const auth = {
      token: 'synthetic-token',
      userId: ownerUserId,
      userName: 'Owner',
      userEmail: 'owner@example.test',
      machineId,
      machineName: 'Daemon',
    };
    const workspace = { id: workspaceId, name: 'Synthetic', slug: 'synthetic', role: 'owner' };
    await runWithDaemonWorkspace(daemon, async () => {
      expect(await withWorkspaceManager(auth, workspace, 'test', async (owner) => owner)).toBe(
        manager
      );
      await expect(
        withWorkspaceManager(auth, { ...workspace, id: 'other-workspace' }, 'test', async () => 1)
      ).rejects.toThrow('Daemon command workspace mismatch');
      await expect(
        withWorkspaceManager({ ...auth, userId: 'other-user' }, workspace, 'test', async () => 1)
      ).rejects.toThrow('restart the daemon');
      await expect(
        withWorkspaceManager(auth, workspace, 'test', async () => {
          throw new Error('Synthetic command failure');
        })
      ).rejects.toThrow('Synthetic command failure');
    });
    // The borrowing command never cleans up the daemon's replica.
    expect((await manager.repo.getDocMeta(getSessionRoomId(sessionId)))?.meta).toMatchObject({
      machineId,
    });
  });

  it('rejects calls outside the daemon workspace scope', async () => {
    await expect(executeDaemonSessionTool(context(), 'lody_operation_list', {})).rejects.toThrow(
      'Session tool scope mismatch'
    );
    await expect(
      runWithDaemonWorkspace(daemon, () =>
        executeDaemonSessionTool(
          { ...context(), workspaceId: 'other-workspace' },
          'lody_operation_list',
          {}
        )
      )
    ).rejects.toThrow('Session tool scope mismatch');
    await expect(
      runWithDaemonWorkspace(daemon, () =>
        executeDaemonSessionTool(
          { ...context(), sessionId: 'missing-session' as SessionId },
          'lody_operation_list',
          {}
        )
      )
    ).rejects.toThrow('Requester Session does not belong to this machine');
    // A process outliving its Turn cannot keep using the Session's tools.
    await expect(
      runWithDaemonWorkspace(
        {
          ...daemon,
          readInvocation: (id) => ({
            type: 'session/active-invocation-context',
            sessionId: id,
            active: false,
          }),
        },
        () => executeDaemonSessionTool(context(), 'lody_operation_list', {})
      )
    ).rejects.toThrow('Session tool requires an active Turn');
  });
});
