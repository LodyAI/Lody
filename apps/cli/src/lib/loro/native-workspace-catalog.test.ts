import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoroRepo } from 'loro-repo';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroDocumentManager } from './doc';
import { readNativeFlockSnapshot } from './native-repo-migration';
import { getLogger } from '@/utils/logger';
import { resolveSessionMessageAuthor } from '@/session/message-author';
import { loadSessionMcpCatalog } from '@/agent/session-mcp-resolver';
import {
  loadWorkspaceAgentRoleCatalog,
  resolveAgentRoleCreateFromCatalog,
} from '@/lib/agent-role-create';
import { upsertWorkspaceMcpCatalogEntry, listWorkspaceMcpCatalog } from '../workspace-mcp-store';
import { startEngine } from '@loro-dev/loro-repo-engine';
import { connectEngine } from '@loro-dev/loro-repo-client/node';
import type { RepoClient, JsonValue } from '@loro-dev/loro-repo-client';
import {
  AGENT_ROLE_VERSION,
  ACP_CAPABILITY_CACHE_VERSION,
  createAgentRoleSchemaEvidence,
  type AgentRoleSchemaEvidence,
  type ReconcileAgentRoleSchemaCommand,
  getWorkspaceFlockDocId,
  getProjectMcpKey,
  type AgentRole,
  type AgentRoleId,
  type AgentConfigId,
  type MachineId,
  type WorkspaceId,
  type WorkspaceMcpServerMeta,
  type WorkspaceProject,
  type ProjectId,
  type ProjectMemberId,
} from '@lody/shared';
import {
  createNativeWorkspaceCatalog,
  createNativeWorkspaceCatalogOwner,
} from './native-workspace-catalog';

const binding = { workspaceId: 'catalog-workspace' as WorkspaceId, accountId: 'account' };
const room = { kind: 'flock' as const, id: getWorkspaceFlockDocId(binding.workspaceId) };
const namespace = 'catalog-test';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'lody-native-catalog-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const engine = startEngine({ dataDir });
  cleanups.push(async () => engine.stop());
  const client = await connectEngine(dataDir);
  cleanups.push(() => client.close());
  await client.createRoom(namespace, room);
  return { client, dataDir };
}
const role: AgentRole = {
  v: AGENT_ROLE_VERSION,
  id: 'role' as AgentRoleId,
  ownerUserId: 'account',
  visibility: 'private',
  name: 'Reviewer',
  machineId: 'machine' as MachineId,
  agentConfigId: 'agent' as AgentConfigId,
  runConfig: { modelId: 'model' },
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};
const mcp: WorkspaceMcpServerMeta = {
  id: 'mcp' as WorkspaceMcpServerMeta['id'],
  name: 'Files',
  transport: 'stdio',
  connection: { transport: 'stdio', command: 'mcp-files' },
  createdAt: 1,
  updatedAt: 1,
};
const project: WorkspaceProject = {
  v: 1,
  id: '41598421-d627-42de-8bb4-a7cb0736fc54' as ProjectId,
  name: 'Project',
  ownerUserId: 'account',
  createdAtMs: 1,
  revision: 1,
  members: [
    {
      id: '097c806c-5b18-4629-8892-8cffda4c02b5' as ProjectMemberId,
      source: { kind: 'github', repoFullName: 'lodyai/lody' },
      placement: { kind: 'root', dir: 'repo' },
    },
  ],
};

async function put(client: RepoClient, key: string[], value: unknown) {
  await client.flockBatch(namespace, room, [{ op: 'put', key, value: value as JsonValue }]);
}

describe('trusted native workspace catalog domain', () => {
  it('projects credential-free MCP/Role data and refuses credential writes without changing stored rows', async () => {
    const { client } = await setup();
    await put(client, ['mcpServer', mcp.id], {
      ...mcp,
      connection: {
        ...mcp.connection,
        env: { PUBLIC: '${PUBLIC}', TOKEN: 'synthetic-credential' },
      },
    });
    await put(client, ['agentRole', role.id], {
      ...role,
      runConfig: { configOptionValues: { api_key: 'synthetic-key', safe: true } },
    });
    await put(client, ['agentRole', 'foreign'], {
      ...role,
      id: 'foreign',
      ownerUserId: 'another-account',
    });
    const catalog = createNativeWorkspaceCatalog({
      client,
      namespace,
      binding,
      authorize: () => true,
    });
    const snapshot = await catalog.read(binding);
    expect(snapshot.roles.map((entry) => entry.id)).toEqual([role.id]);
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-');
    expect(snapshot.servers[0]?.connection).toMatchObject({
      authentication: 'local',
      env: { PUBLIC: '${PUBLIC}' },
    });
    const before = await client.flockScan(namespace, room);
    await expect(
      catalog.execute(binding, {
        kind: 'put-mcp',
        entry: {
          ...mcp,
          connection: {
            transport: 'stdio',
            command: 'mcp-files',
            env: { TOKEN: 'new-private-credential' },
          },
        },
      })
    ).rejects.toThrow('credentials');
    expect((await client.flockScan(namespace, room)).roomTxId).toBe(before.roomTxId);
    await expect(catalog.upload(binding)).rejects.toThrow('confirmation is unavailable');
  });

  it('preserves unknown Role/project/member fields and other families while applying conditional commands', async () => {
    const { client } = await setup();
    await put(client, ['agentRole', role.id], {
      ...role,
      future: { retained: true },
      runConfig: {
        ...role.runConfig,
        futureConfig: { opaque: 1 },
        configOptionValues: { api_key: 'synthetic-old-key' },
      },
    });
    await put(client, ['project', project.id], {
      ...project,
      future: 1,
      members: [{ ...project.members[0], futureMember: { retained: true } }],
    });
    await put(client, ['future-family', 'opaque'], { preserved: true });
    const catalog = createNativeWorkspaceCatalog({
      client,
      namespace,
      binding,
      authorize: () => true,
    });
    await catalog.execute(binding, {
      kind: 'put-role',
      role: { ...role, name: 'Renamed', revision: 2 },
      expectedRevision: 1,
    });
    const storedRole = (await client.flockGet(namespace, room, ['agentRole', role.id])).value;
    expect(storedRole).toMatchObject({
      name: 'Renamed',
      future: { retained: true },
      runConfig: { futureConfig: { opaque: 1 } },
    });
    expect(JSON.stringify(storedRole)).not.toContain('synthetic-old-key');
    await expect(
      catalog.execute(binding, {
        kind: 'put-role',
        role: { ...role, name: 'Stale', revision: 2 },
        expectedRevision: 1,
      })
    ).rejects.toThrow('edit conflict');
    await catalog.execute(binding, {
      kind: 'put-project',
      project: { ...project, name: 'Renamed project', revision: 2 },
      expectedRevision: 1,
    });
    expect((await client.flockGet(namespace, room, ['project', project.id])).value).toMatchObject({
      name: 'Renamed project',
      future: 1,
      members: [{ futureMember: { retained: true } }],
    });
    const projectKey = getProjectMcpKey({ kind: 'github', repoFullName: 'lodyai/lody' });
    if (!projectKey) throw new Error('Invalid fixture project key');
    await catalog.execute(binding, { kind: 'set-project-defaults', projectKey, ids: [] });
    expect((await catalog.read(binding)).projectMcpDefaults[projectKey]).toEqual({ ids: [] });
    expect((await client.flockGet(namespace, room, ['future-family', 'opaque'])).value).toEqual({
      preserved: true,
    });
    await put(client, ['mcpServer', mcp.id], { ...mcp, futureUnsupported: { untouched: true } });
    await expect(
      catalog.execute(binding, { kind: 'put-mcp', entry: { ...mcp, name: 'Rename' } })
    ).rejects.toThrow('Unsupported MCP configuration');
    expect((await client.flockGet(namespace, room, ['mcpServer', mcp.id])).value).toMatchObject({
      futureUnsupported: { untouched: true },
    });
  });

  it('uses owner-resolved current schema, preserves opaque v1/v2 fields, and leaves stale/foreign/cancelled maintenance untouched', async () => {
    const { client } = await setup();
    const expected = {
      ...role,
      runConfig: { configOptionValues: { retired: 'old', permission: 'keep', live: false } },
    };
    const evidence = createAgentRoleSchemaEvidence(expected, {
      cliType: 'builtin',
      agentType: 'codex',
      provenance: 'runtime',
      fetchedAt: 4,
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
      sourceVersion: 'synthetic-runtime-v1',
      modes: [],
      models: [],
      configOptions: [{ id: 'live', type: 'boolean', currentValue: true, name: 'Live' }],
    });
    const command: ReconcileAgentRoleSchemaCommand = {
      kind: 'reconcile-role-schema',
      expected,
      evidence,
      now: 9,
    };
    let trusted: AgentRoleSchemaEvidence | undefined = evidence;
    const catalog = createNativeWorkspaceCatalog({
      client,
      namespace,
      binding,
      authorize: () => true,
      resolveRoleSchemaEvidence: async () => trusted,
    });
    const key = ['agentRole', role.id];
    const raw = {
      ...expected,
      opaque: { keep: true },
      runConfig: {
        ...expected.runConfig,
        future: { keep: true },
        configOptionValues: {
          ...expected.runConfig.configOptionValues,
          api_key: 'synthetic-secret',
          unknownStructured: { keep: true },
        },
      },
    };
    await put(client, key, raw);
    const noResolver = createNativeWorkspaceCatalog({
      client,
      namespace,
      binding,
      authorize: () => true,
    });
    expect(await noResolver.execute(binding, command)).toEqual({ changed: false });
    for (const version of [ACP_CAPABILITY_CACHE_VERSION - 1, ACP_CAPABILITY_CACHE_VERSION + 1]) {
      trusted = { ...evidence, schema: { ...evidence.schema, cacheVersion: version } };
      expect(await catalog.execute(binding, { ...command, evidence: trusted })).toEqual({
        changed: false,
      });
    }
    trusted = { ...evidence, schema: { ...evidence.schema, sourceVersion: 'different-probe' } };
    expect(await catalog.execute(binding, command)).toEqual({ changed: false });
    trusted = evidence;
    const controller = new AbortController();
    controller.abort();
    expect(await catalog.execute(binding, command, { signal: controller.signal })).toEqual({
      changed: false,
    });
    await put(client, key, { ...raw, ownerUserId: 'foreign' });
    expect(await catalog.execute(binding, command)).toEqual({ changed: false });
    await put(client, key, raw);
    // Renderer-provided options cannot override the trusted schema.
    const forged = {
      ...command,
      evidence: { ...evidence, schema: { ...evidence.schema, configOptions: [] } },
    };
    expect(await catalog.execute(binding, forged)).toEqual({ changed: true });
    expect((await client.flockGet(namespace, room, key)).value).toEqual({
      ...raw,
      revision: 2,
      updatedAt: 9,
      runConfig: {
        future: { keep: true },
        configOptionValues: { permission: 'keep', live: false, unknownStructured: { keep: true } },
      },
    });
    expect(await catalog.execute(binding, command)).toEqual({ changed: false });
    const otherTarget = {
      machineId: 'other',
      agentConfigId: 'other-agent',
      futureTarget: true,
      runConfig: { modelId: 'untouched-model', futureConfig: true },
    };
    const multi = {
      ...raw,
      v: 2,
      targets: [
        {
          machineId: role.machineId,
          agentConfigId: role.agentConfigId,
          futureTarget: true,
          runConfig: raw.runConfig,
        },
        otherTarget,
      ],
    };
    delete (multi as Partial<typeof raw>).machineId;
    delete (multi as Partial<typeof raw>).agentConfigId;
    delete (multi as Partial<typeof raw>).runConfig;
    await put(client, key, multi);
    // Expected binding includes every normalized target, so an omitted target is stale.
    expect(await catalog.execute(binding, command)).toEqual({ changed: false });
    const projection = await catalog.read(binding);
    const multiExpected = projection.roles[0]!;
    expect(await catalog.execute(binding, { ...command, expected: multiExpected })).toEqual({
      changed: true,
    });
    expect((await client.flockGet(namespace, room, key)).value).toMatchObject({
      v: 2,
      revision: 2,
      opaque: { keep: true },
      targets: [
        {
          futureTarget: true,
          runConfig: {
            future: { keep: true },
            configOptionValues: {
              permission: 'keep',
              live: false,
              unknownStructured: { keep: true },
            },
          },
        },
        otherTarget,
      ],
    });
  });

  it.each(['opaque-change', 'authored-change', 'deleted', 'schema-change'] as const)(
    'rechecks Role maintenance after an actual concurrent CAS %s',
    async (scenario) => {
      const { client, dataDir } = await setup();
      const other = await connectEngine(dataDir);
      cleanups.push(() => other.close());
      const expected = { ...role, runConfig: { configOptionValues: { retired: 'old' } } };
      const evidence = createAgentRoleSchemaEvidence(expected, {
        cliType: 'builtin',
        agentType: 'codex',
        provenance: 'runtime',
        cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
        fetchedAt: 1,
        modes: [],
        models: [],
        configOptions: [],
      });
      let changedSchema = false;
      const catalog = createNativeWorkspaceCatalog({
        client,
        namespace,
        binding,
        authorize: () => true,
        resolveRoleSchemaEvidence: async () =>
          changedSchema
            ? { ...evidence, schema: { ...evidence.schema, sourceVersion: 'new-probe' } }
            : evidence,
      });
      const key = ['agentRole', role.id];
      await put(client, key, expected);
      const commit = client.flockBatch.bind(client);
      let raced = false;
      vi.spyOn(client, 'flockBatch').mockImplementation(async (...args) => {
        if (!raced) {
          raced = true;
          if (scenario === 'schema-change') {
            changedSchema = true;
            await put(other, ['concurrent', 'schema'], { refreshed: true });
          } else if (scenario === 'deleted')
            await other.flockBatch(namespace, room, [{ op: 'delete', key }]);
          else
            await put(
              other,
              key,
              scenario === 'authored-change'
                ? { ...expected, name: 'New authored name', revision: 2 }
                : { ...expected, concurrentOpaque: true }
            );
        }
        return commit(...args);
      });
      expect(
        await catalog.execute(binding, {
          kind: 'reconcile-role-schema',
          expected,
          evidence,
          now: 8,
        })
      ).toEqual({ changed: scenario === 'opaque-change' });
      const stored = await other.flockGet(namespace, room, key);
      if (scenario === 'deleted') expect(stored.found).toBe(false);
      else if (scenario === 'schema-change') expect(stored.value).toEqual(expected);
      else if (scenario === 'authored-change')
        expect(stored.value).toEqual({ ...expected, name: 'New authored name', revision: 2 });
      else
        expect(stored.value).toEqual({
          ...expected,
          revision: 2,
          updatedAt: 8,
          runConfig: { configOptionValues: {} },
          concurrentOpaque: true,
        });
    }
  );

  it('refuses to rewrite an opaque unsafe integer projection and leaves its raw native snapshot unchanged', async () => {
    const { client, dataDir } = await setup();
    const legacy = new Flock();
    (
      legacy as unknown as { inner: { put(key: string[], value: unknown, now: number): void } }
    ).inner.put(
      ['agentRole', role.id],
      { ...role, future: { nested: [{ integer: 9007199254740993n, fraction: 0.25 }] } },
      1
    );
    await client.importRoomState(namespace, room, {
      snapshot: legacy.exportFile(),
      enqueueOutbox: false,
    });
    await client.compactRoom(namespace, room);
    const before = readNativeFlockSnapshot({ dataDir, namespace, room });
    const rawInteger = (bytes: Uint8Array) => {
      try {
        return Flock.strictFromFile(bytes).get(['agentRole', role.id]);
      } catch (error) {
        return String(error);
      }
    };
    expect(rawInteger(before.bytes)).toContain("9007199254740993 can't be represented");
    const catalog = createNativeWorkspaceCatalog({
      client,
      namespace,
      binding,
      authorize: () => true,
    });
    const projected = await client.flockGet(namespace, room, ['agentRole', role.id]);
    expect(projected.value).toMatchObject({ future: { nested: [{ integer: 9007199254740993n }] } });
    await expect(
      catalog.execute(binding, {
        kind: 'put-role',
        role: { ...role, name: 'Must not corrupt extension', revision: 2 },
        expectedRevision: 1,
      })
    ).rejects.toThrow('unsafe integer projection');
    expect((await client.flockGet(namespace, room, ['agentRole', role.id])).roomTxId).toBe(
      projected.roomTxId
    );
    const after = readNativeFlockSnapshot({ dataDir, namespace, room });
    expect(after.bytes).toEqual(before.bytes);
    expect(after.sha256).toBe(before.sha256);
    expect(rawInteger(after.bytes)).toContain("9007199254740993 can't be represented");
    // The guard is specific to unsafe integers, not binary or fractional JSON.
    await put(client, ['agentRole', 'normal-extension'], {
      ...role,
      id: 'normal-extension',
      future: { bytes: Uint8Array.of(3, 4), fraction: 0.25, integer: Number.MAX_SAFE_INTEGER },
    });
    await catalog.execute(binding, {
      kind: 'put-role',
      role: { ...role, id: 'normal-extension' as AgentRoleId, name: 'Safe extension', revision: 2 },
      expectedRevision: 1,
    });
    expect(
      (await client.flockGet(namespace, room, ['agentRole', 'normal-extension'])).value
    ).toMatchObject({
      name: 'Safe extension',
      future: { bytes: Uint8Array.of(3, 4), fraction: 0.25, integer: Number.MAX_SAFE_INTEGER },
    });
  });

  it('observes full native projections, keeps remote authority separate, and closes readers independently', async () => {
    const { client } = await setup();
    let authoritative = false;
    const authorityListeners = new Set<() => void>();
    const catalog = createNativeWorkspaceCatalog({
      client,
      namespace,
      binding,
      authorize: () => true,
      authority: {
        current: () => authoritative,
        subscribe(listener) {
          authorityListeners.add(listener);
          return () => authorityListeners.delete(listener);
        },
      },
    });
    const first: Array<import('@lody/shared').WorkspaceCatalogUpdate> = [];
    const second: Array<import('@lody/shared').WorkspaceCatalogUpdate> = [];
    let updated!: () => void;
    const nextUpdate = () =>
      new Promise<void>((resolve) => {
        updated = resolve;
      });
    const a = await catalog.observe(
      binding,
      (state) => first.push(state),
      (error) => {
        throw error;
      }
    );
    cleanups.push(async () => a.close());
    const b = await catalog.observe(
      binding,
      (state) => {
        second.push(state);
        if (state.projection.servers[0]?.name === 'Updated') updated();
      },
      (error) => {
        throw error;
      }
    );
    cleanups.push(async () => b.close());
    expect(first.at(-1)?.synced).toBe(false);
    authoritative = true;
    for (const listener of authorityListeners) listener();
    expect(first.at(-1)?.synced).toBe(true);
    await a.close();
    const retained = first.at(-1);
    const observed = nextUpdate();
    await catalog.execute(binding, { kind: 'put-mcp', entry: { ...mcp, name: 'Updated' } });
    await observed;
    expect(first.at(-1)).toBe(retained);
    expect(second.at(-1)?.projection.servers).toEqual([{ ...mcp, name: 'Updated' }]);
    await b.close();
    expect(authorityListeners.size).toBe(0);
  });

  it('enforces live binding/owner grants and retains a concurrent raw extension through actual room CAS', async () => {
    const { client, dataDir } = await setup();
    const other = await connectEngine(dataDir);
    cleanups.push(() => other.close());
    await put(client, ['agentRole', role.id], role);
    let admitted = true;
    const catalog = createNativeWorkspaceCatalog({
      client,
      namespace,
      binding,
      authorize: () => admitted,
    });
    await expect(catalog.read({ ...binding, accountId: 'foreign' })).rejects.toThrow(
      'binding mismatch'
    );
    await put(client, ['agentRole', 'foreign'], { ...role, id: 'foreign', ownerUserId: 'foreign' });
    await expect(
      catalog.execute(binding, { kind: 'delete-role', id: 'foreign' as AgentRoleId })
    ).rejects.toThrow('access denied');
    admitted = false;
    await expect(catalog.execute(binding, { kind: 'delete-role', id: role.id })).rejects.toThrow(
      'access denied'
    );
    admitted = true;
    const commit = client.flockBatch.bind(client);
    let raced = false;
    vi.spyOn(client, 'flockBatch').mockImplementation(async (...args) => {
      if (!raced) {
        raced = true;
        await put(other, ['agentRole', role.id], { ...role, futureConcurrent: 'preserved' });
      }
      return commit(...args);
    });
    await catalog.execute(binding, {
      kind: 'put-role',
      role: { ...role, name: 'CAS renamed', revision: 2 },
      expectedRevision: 1,
    });
    expect((await other.flockGet(namespace, room, ['agentRole', role.id])).value).toMatchObject({
      name: 'CAS renamed',
      futureConcurrent: 'preserved',
    });
  });
});

describe('legacy CLI catalog commands through the common port', () => {
  it('keeps local durability and reports failed remote confirmation without rolling back a stored definition', async () => {
    const repo = await LoroRepo.create({});
    cleanups.push(() => repo.destroy());
    const stored = await repo.openFlockDoc(getWorkspaceFlockDocId(binding.workspaceId));
    const adapter = {
      openFlockDoc: async () => ({
        flock: stored.flock,
        syncOnce: async () => {
          throw new Error('Synthetic remote unavailable');
        },
      }),
      flush: () => repo.flush(),
    };
    expect(
      await upsertWorkspaceMcpCatalogEntry(adapter, binding.workspaceId, mcp, { sync: false })
    ).toMatchObject({ changed: true, synced: false });
    expect(await listWorkspaceMcpCatalog(repo, binding.workspaceId)).toEqual([mcp]);
    expect(await upsertWorkspaceMcpCatalogEntry(adapter, binding.workspaceId, mcp)).toEqual({
      changed: false,
      synced: true,
    });
    expect(
      await upsertWorkspaceMcpCatalogEntry(adapter, binding.workspaceId, {
        ...mcp,
        name: 'Durable rename',
      })
    ).toMatchObject({ changed: true, synced: false, syncError: 'Synthetic remote unavailable' });
    expect((await listWorkspaceMcpCatalog(repo, binding.workspaceId))[0]?.name).toBe(
      'Durable rename'
    );
  });
});

describe('manager-selected workspace catalog consumers', () => {
  it('binds the real default legacy port, preserves unknown rows, and keeps command no-op/durable semantics', async () => {
    const repo = await LoroRepo.create({});
    const manager = new LoroDocumentManager({
      repo,
      workspaceId: binding.workspaceId,
      userId: binding.accountId,
      metaSub: null,
      logger: getLogger('catalog-domain-test'),
    });
    cleanups.push(() => manager.cleanUp({ preserveSessionStatus: true }));
    const handle = await repo.openFlockDoc(room.id);
    handle.flock.set(['future-family', 'opaque'], { retain: true });
    handle.flock.commit();
    expect(
      await upsertWorkspaceMcpCatalogEntry(manager, binding.workspaceId, mcp, { sync: false })
    ).toEqual({ changed: true, synced: false, syncError: 'offline mode' });
    expect(
      await upsertWorkspaceMcpCatalogEntry(manager, binding.workspaceId, mcp, { sync: false })
    ).toEqual({ changed: false, synced: true });
    expect((await manager.readWorkspaceCatalog()).servers).toEqual([mcp]);
    expect(handle.flock.get(['future-family', 'opaque'])).toEqual({ retain: true });
    await expect(manager.readWorkspaceCatalog('wrong-workspace' as WorkspaceId)).rejects.toThrow(
      'binding mismatch'
    );
    handle.flock.set(['agentRole', 'future-version'], { v: 99, retain: true });
    handle.flock.commit();
    await expect(
      manager.workspaceCatalog.execute(binding, {
        kind: 'put-role',
        role: { ...role, id: 'future-version' as AgentRoleId },
      })
    ).rejects.toThrow('Unsupported workspace catalog row');
    expect(handle.flock.get(['agentRole', 'future-version'])).toEqual({ v: 99, retain: true });
  });

  it('uses the injected native owner for real CLI MCP, session MCP and author reads without reopening a legacy wf replica', async () => {
    const { client } = await setup();
    const catalog = createNativeWorkspaceCatalog({
      client,
      namespace,
      binding,
      authorize: () => true,
      authorizeRoleLookup: () => true,
      confirmUpload: async () => {
        throw new Error('Synthetic remote confirmation unavailable');
      },
    });
    const repo = await LoroRepo.create({});
    const open = repo.openFlockDoc.bind(repo);
    vi.spyOn(repo, 'openFlockDoc').mockImplementation((id) => {
      if (id === room.id) return Promise.reject(new Error('Unexpected raw legacy wf access'));
      return open(id);
    });
    const manager = new LoroDocumentManager({
      repo,
      workspaceId: binding.workspaceId,
      userId: binding.accountId,
      metaSub: null,
      logger: getLogger('catalog-native-domain-test'),
      workspaceCatalog: catalog,
    });
    cleanups.push(() => manager.cleanUp({ preserveSessionStatus: true }));
    expect(await upsertWorkspaceMcpCatalogEntry(manager, binding.workspaceId, mcp)).toEqual({
      changed: true,
      synced: false,
      syncError: 'Synthetic remote confirmation unavailable',
    });
    expect(await listWorkspaceMcpCatalog(manager, binding.workspaceId)).toEqual([mcp]);
    await catalog.execute(binding, { kind: 'put-role', role });
    const select = await loadSessionMcpCatalog({
      catalog: manager.workspaceCatalog,
      catalogBinding: manager.workspaceCatalogBinding,
      workspaceId: binding.workspaceId,
      sessionId: 'native-catalog-session' as never,
      selectedIds: [mcp.id],
      logger: { debug: () => {} },
    });
    expect(select(undefined).servers).toHaveLength(1);
    vi.spyOn(manager, 'getAgentConfigById').mockResolvedValue(undefined);
    const author = await resolveSessionMessageAuthor(
      manager,
      {
        id: 'native-catalog-session',
        machineId: role.machineId,
        agentConfigId: role.agentConfigId,
        cliType: 'builtin',
        agentType: 'codex',
        userId: binding.accountId,
        createdAt: 'synthetic',
      } as never,
      'turn',
      { agentRoleId: role.id, agentRoleRevision: role.revision } as never,
      undefined,
      binding.workspaceId
    );
    expect(author.role).toMatchObject({ id: role.id, revision: role.revision, name: role.name });
    await expect(manager.readWorkspaceCatalog('wrong-workspace' as WorkspaceId)).rejects.toThrow(
      'binding mismatch'
    );
  });
});

describe('stable native workspace catalog owner', () => {
  it('reacquires a new client generation after terminal closure and replaces the full projection', async () => {
    const { client, dataDir } = await setup();
    const next = await connectEngine(dataDir);
    cleanups.push(() => next.close());
    let current = client;
    const owner = createNativeWorkspaceCatalogOwner({
      getClient: async () => current,
      namespace,
      binding,
      authorize: () => true,
    });
    cleanups.push(() => owner.close());
    await put(client, ['mcpServer', mcp.id], mcp);
    const first: unknown[] = [],
      second: unknown[] = [];
    const terminal = Promise.withResolvers<unknown>();
    const a = await owner.observe(binding, (value) => first.push(value), terminal.resolve);
    await client.close();
    expect(await terminal.promise).toMatchObject({ code: 'restart_required' });
    await a.close();
    current = next;
    await next.flockBatch(namespace, room, [
      { op: 'delete', key: ['mcpServer', mcp.id] },
      {
        op: 'put',
        key: ['mcpServer', 'replacement'],
        value: { ...mcp, id: 'replacement', name: 'New generation' },
      },
    ]);
    const b = await owner.observe(
      binding,
      (value) => second.push(value),
      (error) => {
        throw error;
      }
    );
    expect(second.at(-1)).toMatchObject({
      projection: { servers: [{ id: 'replacement', name: 'New generation' }] },
    });
    expect(first.at(-1)).toMatchObject({ projection: { servers: [mcp] } });
    await b.close();
  });

  it('retains a failed observer release for retry while closing siblings and keeping the borrowed client usable', async () => {
    const { client } = await setup();
    const subscribe = client.flockSubscribe.bind(client);
    const handles: Array<Awaited<ReturnType<typeof subscribe>>> = [];
    let fail = true;
    vi.spyOn(client, 'flockSubscribe').mockImplementation(async (...args) => {
      const handle = await subscribe(...args);
      handles.push(handle);
      if (handles.length === 1) {
        const release = handle.unsubscribe.bind(handle);
        handle.unsubscribe = () => {
          if (fail) {
            fail = false;
            return Promise.reject(new Error('Synthetic release refusal'));
          }
          return release();
        };
      }
      return handle;
    });
    const owner = createNativeWorkspaceCatalogOwner({
      getClient: async () => client,
      namespace,
      binding,
      authorize: () => true,
    });
    cleanups.push(() => owner.close());
    const first: unknown[] = [],
      second: unknown[] = [];
    await owner.observe(
      binding,
      (value) => first.push(value),
      (error) => {
        throw error;
      }
    );
    await owner.observe(
      binding,
      (value) => second.push(value),
      (error) => {
        throw error;
      }
    );
    await expect(owner.close()).rejects.toThrow('cleanup failed');
    expect(handles.map((handle) => handle.isClosed)).toEqual([false, true]);
    await put(client, ['mcpServer', mcp.id], mcp);
    expect((await client.flockGet(namespace, room, ['mcpServer', mcp.id])).found).toBe(true);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    await owner.close();
    expect(handles.map((handle) => handle.isClosed)).toEqual([true, true]);
  });

  it('does not mistake the SDK closed-handle no-op for a failed unsubscribe acknowledgement', async () => {
    const { client, dataDir } = await setup();
    const other = await connectEngine(dataDir);
    cleanups.push(() => other.close());
    const subscribe = client.flockSubscribe.bind(client);
    vi.spyOn(client, 'flockSubscribe').mockImplementation(async (...args) => {
      const handle = await subscribe(...args);
      const release = handle.unsubscribe.bind(handle);
      handle.unsubscribe = async () => {
        await release();
        throw new Error('Synthetic unsubscribe acknowledgement lost');
      };
      return handle;
    });
    const owner = createNativeWorkspaceCatalogOwner({
      getClient: async () => client,
      namespace,
      binding,
      authorize: () => true,
    });
    await owner.observe(
      binding,
      () => {},
      () => {}
    );
    await expect(owner.close()).rejects.toThrow('cleanup failed');
    await expect(owner.close()).rejects.toThrow('cleanup failed');
    await put(other, ['mcpServer', mcp.id], mcp);
    expect((await client.flockGet(namespace, room, ['mcpServer', mcp.id])).found).toBe(true);
    // Terminal transport closure is proof that this forgotten subscription can
    // no longer be live; it does not close the other borrowed client's host.
    await client.close();
    await owner.close();
    expect((await other.flockGet(namespace, room, ['mcpServer', mcp.id])).found).toBe(true);
  });

  it('bounds the close waiter while retaining the actual pending observer release', async () => {
    const { client } = await setup();
    const subscribe = client.flockSubscribe.bind(client);
    const gate = Promise.withResolvers<void>();
    vi.spyOn(client, 'flockSubscribe').mockImplementation(async (...args) => {
      const handle = await subscribe(...args);
      const release = handle.unsubscribe.bind(handle);
      handle.unsubscribe = async () => {
        await gate.promise;
        await release();
      };
      return handle;
    });
    const owner = createNativeWorkspaceCatalogOwner({
      getClient: async () => client,
      namespace,
      binding,
      authorize: () => true,
    });
    await owner.observe(
      binding,
      () => {},
      () => {}
    );
    vi.useFakeTimers();
    try {
      const closing = owner.close();
      const refused = expect(closing).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
      await vi.advanceTimersByTimeAsync(5_000);
      await refused;
    } finally {
      vi.useRealTimers();
    }
    await put(client, ['mcpServer', mcp.id], mcp);
    expect((await client.flockGet(namespace, room, ['mcpServer', mcp.id])).found).toBe(true);
    gate.resolve();
    await owner.close();
  });

  it('never replays a sent mutation with a lost acknowledgement onto a newly selected client', async () => {
    const { client, dataDir } = await setup();
    const next = await connectEngine(dataDir);
    cleanups.push(() => next.close());
    let current = client;
    const commit = client.flockBatch.bind(client);
    vi.spyOn(client, 'flockBatch').mockImplementation(async (...args) => {
      await commit(...args);
      current = next;
      throw new Error('Synthetic lost acknowledgement');
    });
    const owner = createNativeWorkspaceCatalogOwner({
      getClient: async () => current,
      namespace,
      binding,
      authorize: () => true,
    });
    cleanups.push(() => owner.close());
    await expect(owner.execute(binding, { kind: 'put-mcp', entry: mcp })).rejects.toThrow(
      'lost acknowledgement'
    );
    expect((await owner.read(binding)).servers).toEqual([mcp]);
  });

  it('fences a late client acquisition during close without closing that client or leaking an observer', async () => {
    const { client } = await setup();
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<RepoClient>();
    const owner = createNativeWorkspaceCatalogOwner({
      getClient: () => {
        started.resolve();
        return gate.promise;
      },
      namespace,
      binding,
      authorize: () => true,
    });
    const observing = owner.observe(
      binding,
      () => {
        throw new Error('Late observation published');
      },
      () => {}
    );
    await started.promise;
    const closing = owner.close();
    gate.resolve(client);
    await expect(observing).rejects.toMatchObject({ code: 'restart_required' });
    await closing;
    await put(client, ['mcpServer', mcp.id], mcp);
    expect((await client.flockGet(namespace, room, ['mcpServer', mcp.id])).found).toBe(true);
  });
});

describe('trusted exact Role IDs versus ordinary native summaries', () => {
  it('matches legacy CLI lookup without granting private discovery or write access to an ordinary renderer', async () => {
    const { client } = await setup();
    const id = 'foreign-private' as AgentRoleId;
    const raw = {
      ...role,
      id,
      ownerUserId: 'other-member',
      name: 'Explicit private role',
      runConfig: { configOptionValues: { api_key: 'synthetic-secret', safe: true } },
    };
    await put(client, ['agentRole', id], raw);
    const ordinary = createNativeWorkspaceCatalog({
      client,
      namespace,
      binding,
      authorize: () => true,
    });
    expect((await ordinary.read(binding)).roles).toEqual([]);
    await expect(ordinary.readRole(binding, id)).rejects.toThrow('lookup access denied');
    let granted = true;
    const trusted = createNativeWorkspaceCatalogOwner({
      getClient: async () => client,
      namespace,
      binding,
      authorize: () => true,
      authorizeRoleLookup: () => granted,
    });
    cleanups.push(() => trusted.close());
    const repo = await LoroRepo.create({});
    const legacy = new LoroDocumentManager({
      repo,
      workspaceId: binding.workspaceId,
      userId: binding.accountId,
      metaSub: null,
      logger: getLogger('catalog-explicit-role-legacy'),
    });
    cleanups.push(() => legacy.cleanUp({ preserveSessionStatus: true }));
    const legacyRow = await repo.openFlockDoc(room.id);
    legacyRow.flock.set(['agentRole', id], raw);
    legacyRow.flock.commit();
    const lookedUp = await trusted.readRole(binding, id);
    expect(lookedUp).toEqual(await legacy.readWorkspaceRole(binding.workspaceId, id));
    expect(lookedUp).toMatchObject({
      id,
      ownerUserId: 'other-member',
      runConfig: { configOptionValues: { safe: true } },
    });
    expect(JSON.stringify(lookedUp)).not.toContain('synthetic-secret');
    const nativeRepo = await LoroRepo.create({});
    vi.spyOn(nativeRepo, 'openFlockDoc').mockRejectedValue(new Error('Unexpected raw wf read'));
    const nativeManager = new LoroDocumentManager({
      repo: nativeRepo,
      workspaceId: binding.workspaceId,
      userId: binding.accountId,
      metaSub: null,
      logger: getLogger('catalog-explicit-role-native'),
      workspaceCatalog: trusted,
    });
    cleanups.push(() => nativeManager.cleanUp({ preserveSessionStatus: true }));
    vi.spyOn(nativeManager, 'syncFlockDocOrThrow').mockResolvedValue();
    expect(
      (await loadWorkspaceAgentRoleCatalog(nativeManager, binding.workspaceId, [id])).get(id)
    ).toEqual(lookedUp);
    expect(
      (
        await resolveAgentRoleCreateFromCatalog({
          manager: nativeManager,
          workspaceId: binding.workspaceId,
          selector: id,
          prompt: 'Synthetic explicit request',
        })
      ).role
    ).toEqual(lookedUp);
    expect((await ordinary.read(binding)).roles).toEqual([]);
    await expect(trusted.execute(binding, { kind: 'delete-role', id })).rejects.toThrow(
      'access denied'
    );
    granted = false;
    await expect(trusted.readRole(binding, id)).rejects.toThrow('lookup access denied');
  });
});
