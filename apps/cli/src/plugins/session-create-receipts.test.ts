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
  const { Registry, registryLayer } = await import('./workflow/plugin-registry');
  const { makePluginHostLayer } = await import('./workflow/plugin-host');
  const { DevPluginCompiler } = await import('./workflow/dev-plugin-compiler');
  const { platformLayer } = await import('../platform/process-options');
  const { dispatchMachineHostCall } = await import('./workflow/daemon-command-executor');
  const { Effect, Layer, ManagedRuntime } = await import('effect');
  const { MessageHandler } = await import('../lib/message-handler');
  const { writeFileSync } = await import('node:fs');
  const worker = join(dir, 'worker.mjs'),
    machineEntry = join(dir, 'plugin.mjs');
  const { fileURLToPath } = await import('node:url');
  await (
    await import('esbuild')
  ).build({
    bundle: true,
    platform: 'node',
    format: 'esm',
    entryPoints: [fileURLToPath(new URL('./plugin-worker-entry.ts', import.meta.url))],
    outfile: worker,
  });
  writeFileSync(
    machineEntry,
    `export default {kind:'machine-plugin',register(m){const schema={safeParse:data=>({success:true,data})};for (const scope of ['session','project']) m.query({id:'inspect-'+scope,scope,input:schema,output:schema},async(ctx,p)=>p.snapshot?ctx.lody.unstable.readSnapshot(p.snapshot):ctx.lody.read(p.target,{id:p.id},p.input));m.mutation({id:'create',scope:'machine',input:schema,output:schema},(ctx,input)=>ctx.lody.sessions.create(ctx.machine,input));m.mutation({id:'rename',scope:'session',input:schema,output:schema},async(ctx,input)=>{await ctx.lody.execute(ctx.target,{id:'sessionUpdateTitle'},{title:input});await ctx.lody.execute(ctx.target,{id:'sessionSetAnnotation'},{value:{label:'reviewed'}});const title=(await ctx.lody.unstable.readSnapshot({kind:'session-meta',session:ctx.target})).doc.title;await ctx.lody.sessions.send(ctx.target,{prompt:'ready for review'});const detail=await ctx.lody.read(ctx.target,{id:'sessionDetail'});return {title,queued:detail.queuedCount,first:detail.recentTurns[0].previewText}})}}`
  );
  let dropAcceptedReply = false;
  let unacknowledged: unknown;
  const hostCall: typeof dispatchMachineHostCall = async (call, signal) => {
    const result = await dispatchMachineHostCall(call, signal);
    if (
      dropAcceptedReply &&
      call.op === 'lody.execute' &&
      call.payload.descriptorId === 'sessionCreate'
    ) {
      dropAcceptedReply = false;
      unacknowledged = result;
      throw Object.assign(Error('synthetic lost acceptance reply'), { code: 'outcome_unknown' });
    }
    return result;
  };
  const runtime = ManagedRuntime.make(
    registryLayer(dir, workspaceId, 'm', () => {}).pipe(
      Layer.provide(Layer.merge(makePluginHostLayer(worker, hostCall), DevPluginCompiler.layer)),
      Layer.provide(platformLayer({}))
    )
  );
  const digest = '1'.repeat(64);
  writeFileSync(
    join(dir, 'catalog.json'),
    JSON.stringify([
      {
        source: 'unused',
        dev: false,
        enabled: true,
        current: {
          provenance: { kind: 'local', origin: 'dir' },
          directory: dir,
          machineEntry,
          clientDigest: digest,
          manifest: {
            sdk: '^1.0.0',
            permissions: ['unstable.rawState', 'sessions.write'],
            id: 'plugin',
            title: 'Plugin',
            version: '1.0.0',
            client: 'client.js',
            machine: 'plugin.mjs',
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
      pluginRpc: ((request, actor, signal) =>
        runtime.runPromise(
          Effect.flatMap(Registry, (r) => r.machineRpc(request, actor)),
          { signal }
        )) satisfies NonNullable<
        import('../lib/message-handler').MessageHandlerConfig['pluginRpc']
      >,
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
    await runtime.runPromise(Effect.flatMap(Registry, (r) => r.start));
    const invokeCreate = (requestId = 'machine-write') =>
      handler.handlePluginMachineRpc(
        {
          method: 'plugin/mutate',
          workspaceId,
          machineId,
          params: {
            scope: 'machine',
            pluginId: 'plugin',
            descriptorId: 'create',
            target: { workspaceId, machineId },
            input: { prompt: 'machine plugin', requestId },
          },
        },
        'owner',
        true
      );
    const [reply, concurrent] = await Promise.all([invokeCreate(), invokeCreate()]);
    expect(concurrent).toEqual(reply);
    expect(reply).toMatchObject({
      ok: true,
      result: {
        type: 'plugin/mutate',
        data: { workspaceId, machineId, sessionId: expect.any(String) },
      },
    });
    expect(await invokeCreate()).toEqual(reply);
    if (!reply.ok || reply.result.type !== 'plugin/mutate') throw Error('Missing plugin session');
    const created = (reply.result.data as { sessionId: string }).sessionId;
    const backend = await (
      await import('../session/session-backend')
    ).createSessionBackend(
      await manager.getOrCreateSessionDoc(created as import('@lody/shared').SessionId)
    );
    expect(await backend.history.count()).toBe(1);
    expect(await backend.readTurn(`plugin-create:${created}`)).toMatchObject({
      state: 'ready',
      turn: { userId: 'owner' },
    });
    const rename = (user: string) =>
      handler.handlePluginMachineRpc(
        {
          method: 'plugin/mutate',
          workspaceId,
          machineId,
          params: {
            scope: 'session',
            pluginId: 'plugin',
            descriptorId: 'rename',
            target: { workspaceId, machineId, sessionId: created },
            input: 'Receipt session',
          },
        },
        user,
        false,
        undefined,
        { sessionId: created }
      );
    await expect(rename('other')).rejects.toBeDefined();
    expect(await rename('owner')).toMatchObject({
      ok: true,
      result: { data: { title: 'Receipt session', queued: 1, first: 'machine plugin' } },
    });
    expect((await manager.repo.getDocMeta(getSessionRoomId(created)))?.meta).toMatchObject({
      annotations: { plugin: { label: 'reviewed' } },
    });
    expect(await backend.getMessageQueue()).toMatchObject([
      { userId: 'owner', task: 'ready for review' },
    ]);

    const selected = 'chosen' as import('@lody/shared').LocalProjectId;
    await (
      await import('../lib/local-project-meta')
    ).upsertMachineLocalProject(manager.repo, workspaceId, machineId, {
      id: selected,
      name: 'Chosen',
      rootPath: dir,
      createdAtMs: 1,
    });
    const sid = created as import('@lody/shared').SessionId;
    await manager.repo.upsertDocMeta(getSessionRoomId(sid), {
      project: { kind: 'local', localProjectId: selected },
      agentRoleId: 'architect',
    });
    const other = await create('foreign-session', true, { businessKey: 'other' });
    await manager.repo.upsertDocMeta(getSessionRoomId(other), {
      project: { kind: 'local', localProjectId: 'foreign' },
      agentRoleId: 'architect',
    });
    const { SessionExecutionService } = await import('../session/session-execution-service');
    Object.assign(handler, {
      executionService: Object.assign(Object.create(SessionExecutionService.prototype), {
        deps: {
          workspaceId,
          machineId,
          workspaceDocument: manager,
          sessionManager: { getSession: () => undefined },
        },
      }),
    });
    const project = { workspaceId, machineId, projectId: selected },
      session = { ...project, sessionId: sid };
    const probe = (scope: 'project' | 'session', input: import('zod').core.util.JSONType) =>
      handler.handlePluginMachineRpc(
        {
          method: 'plugin/query',
          workspaceId,
          machineId,
          params: {
            pluginId: 'plugin',
            scope,
            target: scope === 'project' ? project : session,
            descriptorId: `inspect-${scope}`,
            input,
          },
        },
        'member',
        false,
        undefined,
        scope === 'session' ? { projectId: selected, sessionId: sid } : { projectId: selected }
      );
    const full = vi.spyOn(backend.history, 'readAll').mockImplementation(() => {
      throw Error('Unexpected full transcript scan');
    });
    const ranges = vi.spyOn(backend.history, 'readRange');
    try {
      const result = await probe('project', {
        target: project,
        id: 'sessions',
        input: { agentRoleId: 'architect' },
      });
      expect(result).toMatchObject({ ok: true, result: { data: { items: [{ session }] } } });
      expect(ranges).not.toHaveBeenCalled();
      expect(
        await probe('project', { snapshot: { kind: 'project-state', project, path: ['name'] } })
      ).toMatchObject({ ok: true, result: { data: { doc: 'Chosen' } } });
      for (const input of [
        { target: session, id: 'sessionTurns' },
        { snapshot: { kind: 'workspace-state', workspace: { workspaceId } } },
        { snapshot: { kind: 'schedule-doc', workspace: { workspaceId }, scheduleId: 'foreign' } },
      ])
        await expect(probe('project', input)).rejects.toBeDefined();
      await backend.appendHistoryTurn({
        id: 'review-turn',
        role: 'assistant',
        userTurnId: `plugin-create:${sid}`,
        timestamp: '2026-10-01T00:00:00Z',
        finished: true,
        items: [{ type: 'text', text: 'Reviewed' }],
        fileDiff: [],
      });
      expect(
        await probe('session', { target: session, id: 'sessionTurns', input: { limit: 1 } })
      ).toMatchObject({
        result: {
          data: {
            nextCursor: '1',
            items: [
              {
                turnId: 'review-turn',
                userTurnId: `plugin-create:${sid}`,
                stopReason: 'end_turn',
                proseMarkdown: 'Reviewed',
              },
            ],
          },
        },
      });
      expect(ranges.mock.calls).toEqual([[1, 2]]);
      expect(
        await probe('session', {
          snapshot: { kind: 'session-transcript', session, turnIds: ['review-turn'] },
        })
      ).toMatchObject({ result: { data: { doc: { turns: [{ id: 'review-turn' }] } } } });
      expect(ranges.mock.calls).toEqual([[1, 2]]);
    } finally {
      ranges.mockRestore();
      full.mockRestore();
    }
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
    dropAcceptedReply = true;
    await expect(invokeCreate('lost-reply')).rejects.toBeDefined();
    expect(unacknowledged).toMatchObject({ sessionId: expect.any(String) });
    // Simulate an archive received while the daemon watcher is offline.
    await manager.repo.flush();
    await manager.cleanUp({ fast: true });
    manager = await open();
    expect(await create('1')).toBe(first);
    const recovered = await invokeCreate('lost-reply');
    expect(recovered).toMatchObject({ ok: true, result: { data: unacknowledged } });
    const recoveredId = (unacknowledged as { sessionId: import('@lody/shared').SessionId })
      .sessionId;
    const recoveredBackend = await (
      await import('../session/session-backend')
    ).createSessionBackend(await manager.getOrCreateSessionDoc(recoveredId));
    expect(await recoveredBackend.history.count()).toBe(1);
    expect(await recoveredBackend.readTurn(`plugin-create:${recoveredId}`)).toMatchObject({
      state: 'ready',
      turn: { role: 'user' },
    });

    expect((await manager.repo.getDocMeta(getSessionRoomId(first)))?.meta).toMatchObject({
      title: 'edited',
      createdByPluginId: 'plugin',
      businessKey: 'task',
      isArchived: true,
    });
    expect(await create('2')).not.toBe(first);
  } finally {
    await manager.cleanUp({ fast: true });
    await runtime.dispose();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
