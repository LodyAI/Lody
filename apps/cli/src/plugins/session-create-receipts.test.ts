import type { MessageHandler as MessageHandlerInstance } from '../lib/message-handler';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { SessionCreateReceipts } from './session-create-receipts';

it('arbitrates concurrent connections and retains archived requests across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-receipts-'));
  const file = join(dir, 'db');
  const scope = {
    workspaceId: 'workspace',
    callerUserId: 'owner',
    canonicalTargetKey: 'project',
    pluginId: 'plugin',
  };
  try {
    const reserve = () =>
      new Promise<string>((resolve, reject) => {
        const worker = new Worker(
          `const {parentPort,workerData}=require('node:worker_threads'); (async()=>{const {SessionCreateReceipts}=await import(workerData.module);const store=new SessionCreateReceipts(workerData.file);try{parentPort.postMessage(store.reserve(workerData.scope,'request','key',{a:1,b:2}))}finally{store.close()}})();`,
          {
            eval: true,
            workerData: {
              module: new URL('./session-create-receipts.ts', import.meta.url).href,
              file,
              scope,
            },
          }
        );
        worker.once('error', reject);
        worker.once('message', resolve);
      });
    const [id, duplicate] = await Promise.all([reserve(), reserve()]);
    expect(duplicate).toBe(id);
    const db = new SessionCreateReceipts(file);
    try {
      expect(() => db.reserve(scope, 'request', 'key', { a: 2 })).toThrow('idempotency_conflict');
      expect(() => db.reserve(scope, 'next', 'key', {})).toThrow('business_key_conflict');
      expect(
        db.reserve({ ...scope, canonicalTargetKey: 'another' }, 'request', 'key', {})
      ).not.toBe(id);
      db.releaseArchived(scope.workspaceId, id);
      expect(db.reserve(scope, 'next', 'key', {})).not.toBe(id);
      expect(db.reserve(scope, 'request', 'key', { b: 2, a: 1 })).toBe(id);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('preserves the real session metadata on replay after archive and manager restart', async () => {
  const { LoroDocumentManager } = await import('../lib/loro/doc');
  const { LoroRepo } = await import('loro-repo');
  const { FileSystemStorageAdaptor } = await import('loro-repo/storage/filesystem');
  const { getSessionRoomId } = await import('@lody/shared');
  const { getLogger } = await import('../utils/logger');
  const { mkdirSync } = await import('node:fs');
  const { vi } = await import('vitest');
  const { getLoroRepoStorageBaseDir } = await import('../lib/loro/sqlite-repo-store');
  const dir = mkdtempSync(join(tmpdir(), 'plugin-session-create-'));
  vi.stubEnv('LODY_DATA_DIR', dir);
  const workspaceId = 'workspace' as import('@lody/shared').WorkspaceId;
  mkdirSync(getLoroRepoStorageBaseDir(workspaceId), { recursive: true });
  const open = async () =>
    new LoroDocumentManager({
      repo: await LoroRepo.create({
        storageAdapter: new FileSystemStorageAdaptor({ baseDir: join(dir, 'repo') }),
      }),
      workspaceId,
      userId: 'owner',
      metaSub: null,
      logger: getLogger('plugin-test'),
    });
  let manager = await open();
  const { PluginDaemon } = await import('./plugin-host-legacy');
  const { MessageHandler } = await import('../lib/message-handler');
  const { writeFileSync } = await import('node:fs');
  const daemon = new PluginDaemon(dir, workspaceId, 'm', () => {});
  const digest = '1'.repeat(64);
  writeFileSync(
    join(dir, 'catalog.json'),
    JSON.stringify([
      {
        source: 'unused',
        dev: false,
        enabled: true,
        current: {
          directory: dir,
          clientDigest: digest,
          manifest: {
            sdk: '^1.0.0',
            id: 'plugin',
            title: 'Plugin',
            version: '1.0.0',
            client: 'client.js',
          },
        },
      },
    ])
  );
  const machineId = 'm' as import('@lody/shared').MachineId;
  const handler = Object.assign(
    Object.create(MessageHandler.prototype) as Pick<
      MessageHandlerInstance,
      'handlePluginMachineRpc'
    >,
    {
      workspaceId,
      machineId,
      get workspaceDocument() {
        return manager;
      },
      pluginRpc: daemon.dispatchMachineRpc.bind(daemon),
    }
  );
  type Input = Extract<
    import('@lody/shared/plugins/machine-rpc').PluginMachineRequest,
    { method: 'plugin/session-create' }
  >['params']['input'];
  const create = async (
    request: string,
    owner = true,
    extra: Partial<Input> = {},
    isCurrent?: () => boolean,
    projectId?: string
  ) => {
    Object.assign(handler, { workspaceDocument: manager });
    const reply = await handler.handlePluginMachineRpc(
      {
        method: 'plugin/session-create',
        workspaceId,
        machineId,
        params: {
          pluginId: 'plugin',
          clientDigest: digest,
          scope: projectId ? 'project' : 'machine',
          target: { workspaceId, machineId, projectId },
          input: { prompt: 'hi', requestId: request, businessKey: 'task', ...extra },
        },
      },
      'owner',
      owner,
      undefined,
      projectId ? { projectId } : undefined,
      isCurrent
    );
    if (!reply.ok || !('type' in reply.result) || reply.result.type !== 'plugin/session-create')
      throw Error('create denied');
    return reply.result.sessionId as import('@lody/shared').SessionId;
  };
  try {
    const agentConfigId = await manager.createAgentConfig('builtin', 'codex', machineId);
    await daemon.start();
    await expect(create('denied', false)).rejects.toThrow('denied');
    const [first, again] = await Promise.all([create('1'), create('1')]);
    expect(first).toBe(again);
    const sdk = await import('@lody/shared');
    const roleId = 'reviewer' as import('@lody/shared').AgentRoleId;
    const catalog = await manager.repo.openFlockDoc(sdk.getWorkspaceFlockDocId(workspaceId));
    const role = {
      v: 1 as const,
      id: roleId,
      ownerUserId: 'other',
      visibility: 'private' as const,
      name: 'Reviewer',
      machineId,
      agentConfigId,
      runConfig: { modeId: 'plan' },
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    sdk.writeWorkspaceAgentRoleToFlock(catalog.flock, role);
    const ref = { workspaceId, machineId, sessionId: first };
    const options = {
      businessKey: 'child',
      roleId,
      parentSession: ref,
      pullRequestUrl: 'https://github.com/example/example/pull/4',
    };
    await expect(create('child', true, options)).rejects.toThrow(/role unavailable/);
    sdk.writeWorkspaceAgentRoleToFlock(catalog.flock, { ...role, visibility: 'workspace' });
    await expect(
      create('child', true, { ...options, originTurn: { session: ref, userTurnId: 'forged' } })
    ).rejects.toThrow(/origin unavailable/);
    await expect(
      create('child', true, { ...options, parentSession: { ...ref, machineId: 'elsewhere' } })
    ).rejects.toThrow(/reference forbidden/);
    await expect(
      create('child', true, { ...options, pullRequestUrl: 'file:///bad' })
    ).rejects.toThrow(/pull request/);
    const { Effect } = await import('effect');
    Object.assign(handler, {
      encryptedExecution: {
        resolveDerivationOrigin: () =>
          Effect.succeed({
            principal: 'member',
            origin: { sessionId: first, userTurnId: 'human' },
          }),
      },
      localProjectControlService: {
        listGlobalSkills: async () => ({ groups: [{ skills: [{ id: 'review' }] }] }),
      },
    });
    const withOrigin = {
      ...options,
      originTurn: { session: ref, userTurnId: 'human' },
      businessKey: 'rooted',
    };
    await expect(create('rooted', true, withOrigin)).rejects.toThrow(/origin forbidden/);
    await expect(create('rooted', true, withOrigin, () => false)).rejects.toThrow(
      /authority withdrawn/
    );
    const projectId = 'scope';
    await manager.repo.upsertDocMeta(getSessionRoomId(first), {
      project: { kind: 'local', localProjectId: projectId },
    });
    let active = false;
    Object.assign(handler, {
      resolveSessionExecutionScope: async () => [projectId],
      executionService: {
        getActiveInvocationContext: () => (active ? { sourceTurnId: 'human' } : undefined),
      },
    });
    const memberRef = { ...ref, projectId };
    const memberOptions = {
      ...withOrigin,
      parentSession: memberRef,
      originTurn: { session: memberRef, userTurnId: 'human' },
    };
    await expect(create('member', false, memberOptions, () => true, projectId)).rejects.toThrow(
      /origin forbidden/
    );
    active = true;
    const memberSession = await create('member', false, memberOptions, () => true, projectId);
    expect((await manager.repo.getDocMeta(getSessionRoomId(memberSession)))?.meta).toMatchObject({
      openedBySessionId: first,
    });
    const rooted = await create('rooted', true, withOrigin, () => true);
    expect((await manager.repo.getDocMeta(getSessionRoomId(rooted)))?.meta).toMatchObject({
      pluginOriginTurn: { sessionId: first, userTurnId: 'human' },
    });
    await expect(create('unknown-skill', true, { skillIds: ['missing'] })).rejects.toThrow(
      /skill unavailable/
    );
    const child = await create('child', true, options);
    const childMeta = (await manager.repo.getDocMeta(getSessionRoomId(child)))?.meta;
    expect(childMeta).toMatchObject({
      openedBySessionId: first,
      agentRoleId: roleId,
      agentRoleRevision: 1,
    });
    expect(sdk.isPullRequestExplicitlyLinked(childMeta, options.pullRequestUrl)).toBe(true);
    await manager.repo.upsertDocMeta(getSessionRoomId(first), {
      isArchived: true,
      title: 'edited',
    });
    // Simulate an archive received while the daemon watcher is offline.
    await manager.repo.flush();
    await manager.cleanUp({ fast: true });
    manager = await open();
    expect(await create('1')).toBe(first);
    expect((await manager.repo.getDocMeta(getSessionRoomId(first)))?.meta).toMatchObject({
      title: 'edited',
      createdByPluginId: 'plugin',
      businessKey: 'task',
      isArchived: true,
    });
    expect(await create('2')).not.toBe(first);
  } finally {
    await manager.cleanUp({ fast: true });
    await daemon.dispose();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
