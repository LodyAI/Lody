import { Effect, Layer, Deferred, Fiber } from 'effect';
import { packClientBundle, PLUGIN_BUNDLE_CHUNK_BYTES } from '@lody/shared/plugins/digest';
import { createHash, randomUUID } from 'node:crypto';
import { platformLayer } from '@/platform/process-options';
import { pluginHostLayer } from './workflow/plugin-host';
import { DevPluginCompiler } from './workflow/dev-plugin-compiler';
import { Registry, registryLayer } from './workflow/plugin-registry';
import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PluginDaemon } from './plugin-host-legacy';
it('restores an enabled generation without its source checkout and preserves disable across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-registry-'));
  const create = () => new PluginDaemon(root, 'workspace', 'machine', () => {});
  let daemon = create();
  try {
    const generation = {
      directory: join(root, 'release'),
      manifest: {
        id: 'test-plugin',
        sdk: '^1.0.0',
        version: '1.0.0',
        title: 'Test',
        client: 'client.js',
      },
      clientDigest: 'test',
    };
    const file = join(root, 'catalog.json');
    await writeFile(
      file,
      JSON.stringify([
        { current: generation, enabled: true, dev: false, source: join(root, 'missing') },
      ])
    );
    const generations = join(root, 'generations');
    await Promise.all(
      [randomUUID(), '.stage-ab12CD', 'unmanaged'].map((name) =>
        mkdir(join(generations, name), { recursive: true })
      )
    );
    await daemon.start();
    expect(await readdir(generations)).toEqual(['unmanaged']);
    expect(await daemon.dispatch({ action: 'list' })).toMatchObject({
      plugins: [{ pluginId: 'test-plugin', enabled: true }],
    });
    const request = {
      workspaceId: 'workspace',
      machineId: 'machine',
      method: 'plugin/catalog' as const,
      params: {},
    };
    const owner = { userId: 'owner', machineOwner: true };
    const member = { userId: 'member', machineOwner: false };
    expect(await daemon.dispatchMachineRpc(request, owner)).toMatchObject({
      installations: [{ inspection: { lifecycle: 'Running' } }],
    });
    const catalog = await daemon.dispatchMachineRpc(request, member);
    if (catalog.type !== 'plugin/catalog') throw Error('Unexpected catalog response');
    expect(catalog.installations[0]?.inspection).toBeUndefined();
    const control = {
      ...request,
      method: 'plugin/control' as const,
      params: { pluginId: 'test-plugin', action: 'disable' as const, clientDigest: 'test' },
    };
    await expect(daemon.dispatchMachineRpc(control, member)).rejects.toThrow('Owner required');
    await expect(
      daemon.dispatchMachineRpc(
        { ...control, params: { ...control.params, clientDigest: 'stale' } },
        owner
      )
    ).rejects.toThrow('generation changed');
    await writeFile(join(root, 'data', 'test-plugin', 'journal'), 'checkpoint');
    expect(await daemon.dispatchMachineRpc(control, owner)).toMatchObject({
      inspection: { lifecycle: 'Disabled' },
    });
    await daemon.dispose();
    daemon = create();
    await daemon.start();
    expect(await daemon.dispatch({ action: 'list' })).toMatchObject({
      plugins: [{ enabled: false }],
    });
    expect(await readFile(join(root, 'data', 'test-plugin', 'journal'), 'utf8')).toBe('checkpoint');
  } finally {
    await daemon.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
it('serves digest-bound staged pages and rejects unverified invocation scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-pages-'));
  const daemon = new PluginDaemon(root, 'w', 'm', () => {});
  try {
    const manifest = {
      id: 'pages',
      title: 'Pages',
      version: '1.0.0',
      sdk: '^1.0.0',
      client: 'client.js',
    };
    const file = Buffer.alloc(PLUGIN_BUNDLE_CHUNK_BYTES, 65);
    const packed = (await packClientBundle(manifest, async () => file))!;
    const clientDigest = createHash('sha256').update(packed).digest('hex');
    const current = { directory: root, manifest, clientDigest };
    await writeFile(join(root, 'client.js'), file);
    await writeFile(
      join(root, 'catalog.json'),
      JSON.stringify([{ current, enabled: true, dev: false, source: '/unused' }])
    );
    await daemon.start();
    const base = { workspaceId: 'w', machineId: 'm' };
    const actor = { userId: 'owner', machineOwner: true };
    const page = (offset: number) =>
      daemon.dispatchMachineRpc(
        {
          ...base,
          method: 'plugin/bundle-chunk',
          params: { pluginId: 'pages', clientDigest, offset },
        },
        actor
      );
    const pages = await Promise.all([page(0), page(PLUGIN_BUNDLE_CHUNK_BYTES)]);
    expect(
      Buffer.concat(
        pages.map((p) => {
          if (p.type !== 'plugin/bundle-chunk') throw Error('Unexpected page');
          return Buffer.from(p.base64, 'base64');
        })
      )
    ).toEqual(Buffer.from(packed));
    await writeFile(join(root, 'client.js'), 'changed');
    await expect(page(0)).rejects.toThrow('Stale bundle');
    const query = {
      ...base,
      method: 'plugin/query' as const,
      params: {
        pluginId: 'pages',
        descriptorId: 'test',
        scope: 'session' as const,
        target: { ...base, sessionId: 's' },
        input: null,
      },
    };
    await expect(daemon.dispatchMachineRpc(query, actor)).rejects.toThrow('scope forbidden');
    await expect(
      daemon.dispatchMachineRpc(query, { ...actor, sessionId: 'other' })
    ).rejects.toThrow('scope forbidden');
    await expect(daemon.dispatchMachineRpc(query, { ...actor, sessionId: 's' })).rejects.toThrow(
      'handler unavailable'
    );
  } finally {
    await daemon.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('resumes a pending installation from its saved generation once all required settings exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-pending-'));
  const daemon = new PluginDaemon(root, 'workspace', 'machine', () => {});
  const id = 'pending-plugin';
  try {
    await writeFile(
      join(root, 'catalog.json'),
      JSON.stringify([
        {
          enabled: true,
          dev: false,
          source: join(root, 'missing'),
          current: {
            directory: root,
            manifest: {
              id,
              title: 'Pending',
              sdk: '^1.0.0',
              version: '1.0.0',
              client: 'client.js',
              config: {
                channel: { type: 'string', label: 'Channel', required: true },
                topic: { type: 'string', label: 'Topic', required: true },
                format: { type: 'string', label: 'Format', scope: 'project' },
              },
            },
          },
        },
      ])
    );
    await daemon.start();
    const list = () => daemon.dispatch({ action: 'list' });
    const configure = (key: string) =>
      daemon.dispatch({ action: 'configure', pluginId: id, key, value: 'test' });
    await configure('topic');
    expect(await list()).toMatchObject({ plugins: [{ pendingConfiguration: true }] });
    expect(await daemon.dispatch({ action: 'inspect', pluginId: id })).toMatchObject({
      lifecycle: 'PendingConfiguration',
      configured: ['topic'],
    });
    await daemon.dispatch({ action: 'disable', pluginId: id });
    await daemon.dispatch({ action: 'enable', pluginId: id, changes: { channel: 'test' } });
    expect(await daemon.dispatch({ action: 'inspect', pluginId: id })).toMatchObject({
      lifecycle: 'Running',
      preferences: { channel: 'test', topic: 'test' },
    });
    expect(await list()).toMatchObject({
      plugins: [{ enabled: true, pendingConfiguration: false }],
    });
    for (const projectId of ['a', 'b'])
      await daemon.dispatch({
        action: 'configure-many',
        pluginId: id,
        projectId,
        changes: { format: projectId },
      });
    await expect(
      daemon.dispatch({ action: 'configure', pluginId: id, key: 'format', value: 'shared' })
    ).rejects.toThrow('target mismatch');
    expect(
      JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'))[0].projectPreferences
    ).toEqual({ a: { format: 'a' }, b: { format: 'b' } });
    expect(JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'))[0].preferences).toEqual({
      channel: 'test',
      topic: 'test',
    });
  } finally {
    await daemon.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
it('reports an uncommitted disable without advertising it when catalog replacement fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-catalog-')),
    catalog = join(root, 'catalog.json'),
    daemon = new PluginDaemon(root, 'workspace', 'machine', () => {});
  try {
    await writeFile(
      catalog,
      JSON.stringify([
        {
          current: {
            directory: root,
            manifest: {
              id: 'demo',
              sdk: '^1.0.0',
              version: '1.0.0',
              title: 'Demo',
              client: 'client.js',
            },
          },
          enabled: true,
          dev: false,
          source: root,
        },
      ])
    );
    await daemon.start();
    await rm(catalog);
    await mkdir(catalog);
    await expect(daemon.dispatch({ action: 'disable', pluginId: 'demo' })).rejects.toThrow();
    expect(await daemon.dispatch({ action: 'list' })).toMatchObject({
      plugins: [{ enabled: true }],
    });
    expect(await daemon.dispatch({ action: 'logs', pluginId: 'demo' })).toMatchObject({
      logs: ['Catalog persistence failed'],
    });
    await rm(catalog, { recursive: true });
    await daemon.dispatch({ action: 'disable', pluginId: 'demo' });
    expect(JSON.parse(await readFile(catalog, 'utf8'))[0].enabled).toBe(false);
  } finally {
    await daemon.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('coalesces trailing dev builds, preserves the rollback directory and orders disable last', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-turns-')),
    source = join(root, 'src');
  await mkdir(source);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>(),
          resume = yield* Deferred.make<void>();
        let serial = 0;
        const compiler = Layer.succeed(DevPluginCompiler, {
          build: (_, dest) =>
            Effect.gen(function* () {
              const n = ++serial;
              if (n === 2) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(resume);
              }
              const directory = join(dest, randomUUID());
              yield* Effect.promise(() => mkdir(directory, { recursive: true }));
              return {
                directory,
                clientDigest: String(n),
                manifest: {
                  id: 'demo',
                  title: 'Demo',
                  version: '1.0.0',
                  sdk: '^1.0.0',
                  client: 'client.js',
                },
              };
            }),
        });
        yield* Effect.gen(function* () {
          const registry = yield* Registry;
          yield* registry.dispatch({ action: 'link', path: source, dev: true });
          const reload = registry.dispatch({ action: 'reload', pluginId: 'demo' });
          const running = yield* Effect.forkChild(reload);
          yield* Deferred.await(entered);
          const trailing = yield* Effect.forkChild(reload, { startImmediately: true });
          const duplicate = yield* Effect.forkChild(reload, { startImmediately: true });
          const disable = yield* Effect.forkChild(
            registry.dispatch({ action: 'disable', pluginId: 'demo' }),
            { startImmediately: true }
          );
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(running);
          expect((yield* Fiber.join(trailing)).clientDigest).toBe('3');
          expect((yield* Fiber.join(duplicate)).clientDigest).toBe('3');
          yield* Fiber.join(disable);
          expect(yield* registry.dispatch({ action: 'list' })).toMatchObject({
            plugins: [{ enabled: false, clientDigest: '3' }],
          });
        }).pipe(
          Effect.provide(
            registryLayer(root, 'w', 'm', () => {}).pipe(
              Layer.provide(Layer.merge(compiler, pluginHostLayer)),
              Layer.provide(platformLayer({}))
            )
          )
        );
      })
    );
    const [item] = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'));
    expect((await readdir(join(root, 'generations'))).sort()).toEqual(
      [basename(item.current.directory), basename(item.previous.directory)].sort()
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['buffered event', 'missed event'] as const)(
  'restores the staged Sorbet worker and replays the journal after a %s without an activation',
  async (window) => {
    const { fileURLToPath } = await import('node:url');
    const { compilePlugin } = await import('./plugin-build');
    const { dispatchMachineHostCall } = await import('./workflow/daemon-command-executor');
    const { build } = await import('esbuild');
    const root = await mkdtemp(join(tmpdir(), 'sorbet-daemon-'));
    const generation = join(root, 'generations', randomUUID());
    const worker = join(root, 'worker.mjs');
    const pluginId = 'sorbet-workflow';
    const target = { workspaceId: 'w', machineId: 'm' };
    const project = { ...target, projectId: 'p' };
    const session = { ...project, sessionId: 'architect' };
    const architect = `plugin:${pluginId}:sorbet-architect`;
    const journal = join(root, 'data', pluginId, 'workflow-journal.json');
    const signal = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { resolve, promise };
    };
    const scanning = signal(),
      release = signal();
    const attempts: import('./machine-host-port').MachineHostCall[] = [];
    let restarted = false;
    const dispatch: import('./machine-host-port').DispatchMachineHostCall = async (
      call,
      signal
    ) => {
      if (call.op === 'lody.read' && call.payload.descriptorId === 'sessions') {
        if (!restarted) {
          scanning.resolve();
          await release.promise;
          if (window === 'buffered event') return { items: [] };
        }
        return { items: [{ session, project, agentRoleId: architect, updatedAt: 1 }] };
      }
      if (call.op === 'lody.read' && call.payload.descriptorId === 'sessionTurns')
        return {
          items: [
            {
              role: 'assistant',
              turnId: 'assistant',
              userTurnId: 'human',
              stopReason: 'end_turn',
              finished: true,
              createdAt: 1,
            },
          ],
        };
      if (call.op === 'lody.unstable.readSnapshot') return { doc: { agentRoleId: architect } };
      if (call.op === 'lody.execute' && call.payload.descriptorId === 'sessionCreate') {
        attempts.push(call);
        return dispatchMachineHostCall(call, signal);
      }
      throw Error(`Unexpected host call: ${call.op}`);
    };
    const open = () => new PluginDaemon(root, 'w', 'm', () => {}, undefined, dispatch, worker);
    let daemon = open();
    try {
      await mkdir(generation, { recursive: true });
      const [compiled] = await Promise.all([
        compilePlugin({
          sourceDir: fileURLToPath(
            new URL(
              '../../../../scripts/fixtures/plugin-sdk/examples/sorbet-workflow',
              import.meta.url
            )
          ),
          stage: generation,
        }),
        build({
          entryPoints: [fileURLToPath(new URL('./plugin-worker-entry.ts', import.meta.url))],
          outfile: worker,
          bundle: true,
          platform: 'node',
          format: 'esm',
        }),
      ]);
      await writeFile(
        join(root, 'catalog.json'),
        JSON.stringify([
          {
            enabled: true,
            dev: false,
            source: 'unavailable',
            current: {
              ...compiled,
              directory: generation,
              machineEntry: join(generation, 'machine.js'),
            },
          },
        ])
      );
      const start = daemon.start();
      await Promise.race([
        scanning.promise,
        start.then(async () => {
          throw Error(
            `Worker stopped before scan: ${JSON.stringify(await daemon.dispatch({ action: 'logs', pluginId }))}`
          );
        }),
      ]);
      if (window === 'buffered event')
        await daemon.event({
          type: 'event',
          eventId: 'complete',
          eventType: 'session.turn.completed',
          payload: {
            workspace: { workspaceId: 'w' },
            machine: target,
            project,
            session,
            turnId: 'assistant',
            userTurnId: 'human',
            stopReason: 'end_turn',
          },
        });
      await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' });
      release.resolve();
      await start;
      const first = JSON.parse(await readFile(journal, 'utf8'));
      expect(first.entries['architect:assistant']).toMatchObject({
        userTurnId: 'human',
        verifierSessionId: null,
      });
      await daemon.dispose();
      restarted = true;
      daemon = open();
      await daemon.start();
      expect(attempts.map((c) => c.origin.type)).toEqual([
        window === 'buffered event' ? 'event' : 'start',
        'start',
      ]);
      expect(attempts[1]?.payload).toEqual(attempts[0]?.payload);
      expect(attempts[1]?.payload).toMatchObject({
        target: project,
        input: {
          parentSession: session,
          originTurn: { session, userTurnId: 'human' },
          roleId: `plugin:${pluginId}:sorbet-verifier`,
        },
      });
      expect(JSON.parse(await readFile(journal, 'utf8'))).toEqual(first);
    } finally {
      release.resolve();
      await daemon.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
);

it('reopens the signed owner workflow receipt for the exact staged Sorbet project and operation', async () => {
  const { ownerApprovalFixture } = await import('../../tests/fixtures/plugin-workflow-approval');
  const { compilePlugin } = await import('./plugin-build');
  const { build } = await import('esbuild');
  const { fileURLToPath } = await import('node:url');
  const owner = await ownerApprovalFixture(),
    { f } = owner;
  const installationId = randomUUID(),
    directory = join(f.directory, 'generations', installationId),
    worker = join(f.directory, 'worker.mjs');
  const projectId = 'project';
  const projectExists = async (id: string) => id === projectId;
  const open = () =>
    new PluginDaemon(
      f.directory,
      f.workspaceId,
      f.machineId,
      () => {},
      undefined,
      undefined,
      worker
    );
  let daemon = open();
  try {
    await mkdir(directory, { recursive: true });
    const [compiled] = await Promise.all([
      compilePlugin({
        sourceDir: fileURLToPath(
          new URL(
            '../../../../scripts/fixtures/plugin-sdk/examples/sorbet-workflow',
            import.meta.url
          )
        ),
        stage: directory,
      }),
      build({
        entryPoints: [fileURLToPath(new URL('./plugin-worker-entry.ts', import.meta.url))],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: worker,
      }),
    ]);
    const pluginId = compiled.manifest.id;
    await writeFile(
      join(f.directory, 'catalog.json'),
      JSON.stringify([
        {
          enabled: true,
          dev: false,
          source: 'missing',
          preferences: { autoVerify: false },
          current: { ...compiled, directory, machineEntry: join(directory, 'machine.js') },
        },
      ])
    );
    await daemon.start();
    if (!compiled.machineDigest) throw Error('No staged machine digest');
    const approval = {
      action: 'grant' as const,
      installationId,
      plugin_id: pluginId,
      machineDigest: compiled.machineDigest,
      targetDevice: owner.identity.signingPublicKey,
      grant_id: randomUUID(),
      machine_id: f.machineId,
      workspace_id: f.workspaceId,
      issued_by_user_id: Buffer.from(f.ledger.owner.raw).toString('hex'),
      issued_at_ms: Date.now(),
      allowed_project_ids: [projectId],
      allowed_role_ids: '*' as const,
      allowed_ops: ['sessions.create'] as 'sessions.create'[],
    };
    expect(await owner.issue(daemon, approval, projectExists)).toEqual({
      type: 'plugin/declared-workflow-grant',
      active: true,
    });
    await daemon.dispose();
    daemon = open();
    await daemon.start();
    const restored = JSON.parse(await readFile(join(f.directory, 'catalog.json'), 'utf8'))[0]
      .declaredGrant.signature;
    expect(
      (await owner.identity.verifyDeclaredWorkflowGrant(restored, f.machineId)).approval
    ).toEqual(approval);
    await expect(
      owner.identity.verifyDeclaredWorkflowGrant(restored.slice(0, -2), f.machineId)
    ).rejects.toThrow();
    const inspection = await daemon.dispatch({ action: 'inspect', pluginId });
    const instance = inspection.instanceId;
    if (typeof instance !== 'number') throw Error('No running Sorbet worker');
    const lease = await daemon.workflowLease(pluginId, instance);
    expect(lease?.isCurrent()).toBe(true);
    expect(await daemon.workflowLease(pluginId, instance + 1)).toBeUndefined();
    const revoke = (id: string) =>
      owner.issue(
        daemon,
        {
          ...approval,
          action: 'revoke',
          grant_id: id === projectId ? approval.grant_id : randomUUID(),
        },
        projectExists
      );
    await revoke('other-project');
    expect(lease?.isCurrent()).toBe(true);
    await revoke(projectId);
    expect(lease?.isCurrent()).toBe(false);
    expect(await daemon.workflowLease(pluginId, instance)).toBeUndefined();
    await expect(owner.issue(daemon, approval, projectExists)).rejects.toThrow();
    await owner.issue(daemon, { ...approval, grant_id: randomUUID() }, projectExists);
    const renewed = await daemon.workflowLease(pluginId, instance);
    expect(renewed?.isCurrent()).toBe(true);
    await daemon.dispatch({ action: 'disable', pluginId });
    expect(renewed?.isCurrent()).toBe(false);
    expect(await daemon.workflowLease(pluginId, instance)).toBeUndefined();
  } finally {
    await daemon.dispose();
    await owner.close();
  }
});

it('workflow contribution processes belong to the enabled generation and receive only declared config', async () => {
  const { once } = await import('node:events');
  const root = await mkdtemp(join(tmpdir(), 'workflow-generation-'));
  const directory = join(root, 'generations', randomUUID());
  const daemon = new PluginDaemon(root, 'workspace', 'machine', () => {});
  try {
    await mkdir(join(directory, 'skills', 'plan'), { recursive: true });
    await writeFile(join(directory, 'skills', 'plan', 'SKILL.md'), 'Plan instructions');
    await writeFile(join(directory, 'role.md'), 'Role instructions');
    await writeFile(
      join(directory, 'entry.mjs'),
      `process.stdin.once('data',()=>process.stdout.write(JSON.stringify({allowed:process.env.ALLOWED,unselected:process.env.UNSELECTED,unrelated:process.env.LODY_WORKFLOW_TEST_PRIVATE}))); process.stdin.resume();`
    );
    await writeFile(
      join(directory, 'http.mjs'),
      `import {createServer} from 'node:http';createServer((req,res)=>res.end(JSON.stringify({path:req.url,auth:req.headers.authorization}))).listen(process.env.LODY_MCP_SOCKET,()=>process.send('lody:mcp-ready'));`
    );
    const manifest = {
      id: 'demo',
      version: '1.0.0',
      sdk: '^1.0.0',
      title: 'Demo',
      skills: ['plan'],
      agentRoles: [
        {
          id: 'planner',
          name: 'Planner',
          promptPath: 'role.md',
          skills: ['plan'],
          mcpServers: ['lookup'],
          defaultProvider: 'plugin:demo:acp',
        },
      ],
      acpProviders: [{ id: 'acp', title: 'ACP', entry: 'entry.mjs' }],
      mcpServers: [
        { id: 'web', title: 'Web', entry: 'http.mjs', transport: 'http' },
        {
          id: 'lookup',
          title: 'Lookup',
          entry: 'entry.mjs',
          transport: 'stdio',
          envKeys: ['ALLOWED'],
        },
      ],
      config: {
        ALLOWED: { label: 'Allowed', type: 'string', scope: 'both', default: 'public-input' },
        UNSELECTED: { label: 'Unselected', type: 'string', scope: 'both', default: 'not-exposed' },
      },
    };
    await writeFile(
      join(root, 'catalog.json'),
      JSON.stringify([
        { enabled: true, source: root, dev: false, current: { directory, manifest } },
      ])
    );
    await daemon.start();
    const rows = (await daemon.workflowCatalog())[0]!;
    expect(rows.roles.get('plugin:demo:planner')).toMatchObject({
      prompt: 'Role instructions',
      skills: ['plugin:demo:plan'],
      mcpServers: ['plugin:demo:lookup'],
    });
    const handle = await daemon.spawnWorkflow('mcpServers', 'plugin:demo:lookup');
    const reply = once(handle.child.stdout!, 'data');
    handle.child.stdin!.write('read');
    expect(JSON.parse(String((await reply)[0]))).toEqual({ allowed: 'public-input' });
    const http = await daemon.spawnWorkflow('mcpServers', 'plugin:demo:web');
    const { bindWorkflowHttp } = await import('./workflow/plugin-mcp-session');
    const binding = await bindWorkflowHttp('web', http, http.socketPath!);
    expect((await fetch(binding.entry.url)).status).toBe(403);
    expect(
      await (
        await fetch(binding.entry.url, {
          headers: { Authorization: binding.entry.headers[0]!.value },
        })
      ).json()
    ).toEqual({ path: '/mcp' });
    const acp = await daemon.spawnWorkflow('acpProviders', 'plugin:demo:acp');
    const ended = Promise.all([once(handle.child, 'close'), once(acp.child, 'close')]);
    await daemon.dispatch({ action: 'disable', pluginId: 'demo' });
    await ended;
    expect(await daemon.workflowCatalog()).toEqual([]);
    await expect(daemon.spawnWorkflow('acpProviders', 'plugin:demo:acp')).rejects.toThrow(
      'unavailable'
    );
  } finally {
    await daemon.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('admits verifier lineage only for the approved project, signed parent turn and installed role skills', async () => {
  const { ownerApprovalFixture } = await import('../../tests/fixtures/plugin-workflow-approval');
  const { resolveDeclaredWorkflow } = await import('./workflow/declared-workflow');
  const { makeVerifiedExecutionIntent } = await import('../lib/e2ee/execution-intent-verification');
  const { LoroDoc, LoroMap } = await import('loro-crdt');
  const fixture = await ownerApprovalFixture(),
    { f } = fixture;
  try {
    const { machineId, workspaceId } = f,
      projectId = 'p',
      pluginId = 'sorbet-workflow',
      installationId = randomUUID(),
      machineDigest = 'aa'.repeat(32),
      receipt = {
        signer: Buffer.from(f.ledger.owner.raw).toString('hex'),
        requestId: 'de'.repeat(16),
      },
      roleId = `plugin:${pluginId}:verifier`,
      providerId = `plugin:${pluginId}:provider`,
      skill = `plugin:${pluginId}:verify`,
      target = { workspaceId, machineId, projectId };
    const original = await Effect.runPromise(
      f.sender.prepareFeature({
        requestId: receipt.requestId,
        request: {
          workspaceId,
          machineId,
          method: 'plugin/declared-workflow-grant',
          params: {
            plugin_id: pluginId,
            installationId,
            machineDigest,
            grant_id: randomUUID(),
            workspace_id: workspaceId,
            machine_id: machineId,
            issued_by_user_id: receipt.signer,
            issued_at_ms: Date.now(),
            allowed_project_ids: [projectId],
            allowed_role_ids: [roleId],
            targetDevice: fixture.identity.signingPublicKey,
            action: 'grant',
            allowed_ops: ['sessions.create'],
          },
        },
      })
    );
    const frame = await Effect.runPromise(f.receiver.openFeature(machineId, original.frameHex));
    if (!frame) throw Error('Missing approval');
    await Effect.runPromise(f.receiver.retainFeatureRequest(machineId, frame));
    const dispatch = await Effect.runPromise(f.sender.prepareDispatch(machineId, f.input)),
      signed = await Effect.runPromise(f.receiver.openDispatch(machineId, dispatch.frameHex));
    const doc = new LoroDoc(),
      row = doc.getList('history').pushContainer(new LoroMap());
    row.set('id', f.input.userTurnId);
    row.set('role', 'user');
    row.set('e2eeIntent', signed.e2eeIntent);
    row.set('inputConfig', f.input.inputConfig);
    const parentSession = { ...target, sessionId: f.input.sessionId },
      originTurn = { session: parentSession, userTurnId: f.input.userTurnId };
    let footprint = [projectId];
    const reserved: unknown[] = [];
    const manager = {
      isEncryptedWorkspace: () => true,
      pluginWorkflows: async () => [
        {
          root: `/fixture/${installationId}`,
          pluginId,
          roles: new Map([[roleId, { defaultProvider: providerId, skills: [skill] }]]),
          acpProviders: new Map([[providerId, {}]]),
          skills: new Map([[skill, {}]]),
        },
      ],
      repo: {
        getDocMeta: async () => ({
          meta: {
            id: f.input.sessionId,
            machineId,
            project: { kind: 'local', localProjectId: projectId },
          },
        }),
      },
      getOrCreateSessionDoc: async () => ({ handle: { doc } }),
      createClientPluginSession: async (p: unknown, userId: string) => {
        reserved.push(p);
        return { archived: true, sessionId: 'verifier', userId };
      },
    };
    const resolve = resolveDeclaredWorkflow({
      workspaceId,
      machineId: machineId as import('@lody/shared').MachineId,
      manager: manager as unknown as import('../lib/loro/doc').LoroDocumentManager,
      identity: {
        ...fixture.identity,
        resolveVerifiedExecutionOriginal: makeVerifiedExecutionIntent({
          workspaceId,
          genesis: f.ledger.context.genesis,
          selfDevice: fixture.identity.signingPublicKey,
          isClosed: () => false,
          ledger: f.ledger.ledger,
          refreshLedger: Effect.void,
          readIncoming: () => Effect.succeed(null),
          openDispatch: (id, frame) => f.receiver.openDispatch(id, frame),
        }),
      },
      lease: async () => ({
        signature: Buffer.from(frame.frame).toString('hex'),
        installationId,
        machineDigest,
        isCurrent: () => true,
      }),
      projectExists: async () => true,
      sessionScope: async () => footprint,
    });
    const create = async (extra: Record<string, string | string[]> = {}) => {
      const signal = new AbortController().signal;
      const fn = await resolve(
        {
          workspaceId,
          machineId,
          pluginId,
          instanceId: 1,
          origin: { type: 'start' },
          op: 'lody.execute',
          payload: {
            descriptorId: 'sessionCreate',
            target,
            input: {
              prompt: 'Verify',
              requestId: 'request',
              parentSession,
              originTurn,
              roleId,
              providerId,
              skillIds: ['verify'],
              ...extra,
            },
          },
        },
        signal
      );
      if (!fn) throw Error('Denied');
      return fn(signal);
    };
    expect(await create()).toEqual({ ...target, sessionId: 'verifier' });
    expect(reserved[0]).toMatchObject({
      target,
      input: { parentSession, originTurn, skillIds: [skill] },
    });
    await expect(create({ skillIds: ['foreign'] })).rejects.toThrow('skill');
    await expect(create({ roleId: 'external' })).rejects.toThrow('Denied');
    footprint = ['other'];
    await expect(create()).rejects.toThrow('parent');
    footprint = [projectId];
    row.set('inputConfig', { prompt: 'tampered' });
    await expect(create()).rejects.toThrow('origin');
    expect(reserved).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

it('restores Issue Context pins from host storage without sharing pins across projects', async () => {
  const { compilePlugin } = await import('./plugin-build');
  const { fileURLToPath } = await import('node:url');
  const { build } = await import('esbuild');
  const root = await mkdtemp(join(tmpdir(), 'issue-pins-'));
  const stage = join(root, 'generations', randomUUID());
  const worker = join(root, 'worker.mjs');
  const open = () =>
    new PluginDaemon(
      root,
      'w',
      'm',
      () => {},
      { read: async () => JSON.stringify('test-tracker'), write: async () => {} },
      undefined,
      worker
    );
  let daemon = open();
  const call = (
    projectId: string,
    method: 'plugin/query' | 'plugin/mutate',
    descriptorId: string,
    input: Record<string, string | boolean>
  ) => {
    const machine = { workspaceId: 'w', machineId: 'm' };
    return daemon.dispatchMachineRpc(
      {
        ...machine,
        method,
        params: {
          pluginId: 'issue-context',
          descriptorId,
          scope: 'project',
          target: { ...machine, projectId },
          input,
        },
      },
      { userId: 'viewer', machineOwner: false, projectId }
    );
  };
  try {
    await mkdir(stage, { recursive: true });
    const [compiled] = await Promise.all([
      compilePlugin({
        stage,
        sourceDir: fileURLToPath(
          new URL('../../../../scripts/fixtures/plugin-sdk/examples/issue-context', import.meta.url)
        ),
      }),
      build({
        entryPoints: [fileURLToPath(new URL('./plugin-worker-entry.ts', import.meta.url))],
        outfile: worker,
        bundle: true,
        platform: 'node',
        format: 'esm',
      }),
    ]);
    await writeFile(
      join(root, 'catalog.json'),
      JSON.stringify([
        {
          enabled: true,
          dev: false,
          source: 'unavailable',
          current: { ...compiled, directory: stage, machineEntry: join(stage, 'machine.js') },
        },
      ])
    );
    await daemon.start();
    await call('p', 'plugin/mutate', 'issues.togglePin', { issueId: 'iss_101', pinned: true });
    await daemon.dispose();
    daemon = open();
    await daemon.start();
    for (const project of ['p', 'q'])
      expect(await call(project, 'plugin/query', 'issues.list', {})).toMatchObject({
        data: [{ id: 'iss_101', pinned: project === 'p' }],
      });
  } finally {
    await daemon.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
