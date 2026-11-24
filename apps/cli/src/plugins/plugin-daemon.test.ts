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
      if (call.op === 'lody.readSnapshot') return { doc: { agentRoleId: architect } };
      if (call.op === 'sessions.create') {
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
      pluginId,
      machineDigest: compiled.machineDigest,
      targetDevice: owner.identity.signingPublicKey,
      operation: 'sessions.create' as const,
      readOperations: [
        'sessions',
        'sessionTurns',
        'session-meta',
      ] as import('@lody/shared/plugins/machine-rpc').WorkflowReadOperation[],
      projectId,
      expiresAt: Date.now() + 3600000,
    };
    expect(await owner.issue(daemon, approval, projectExists)).toEqual({
      type: 'plugin/workflow-create-approval',
      active: true,
    });
    await daemon.dispose();
    daemon = open();
    await daemon.start();
    const restored = JSON.parse(await readFile(join(f.directory, 'catalog.json'), 'utf8'))[0]
      .workflowReceipt;
    expect((await owner.identity.verifyWorkflowApproval(restored, f.machineId)).approval).toEqual(
      approval
    );
    await expect(
      owner.identity.verifyWorkflowApproval(
        { ...restored, signer: owner.identity.signingPublicKey },
        f.machineId
      )
    ).rejects.toThrow();
    const inspection = await daemon.dispatch({ action: 'inspect', pluginId });
    const instance = inspection.instanceId;
    if (typeof instance !== 'number') throw Error('No running Sorbet worker');
    const lease = await daemon.workflowLease(pluginId, instance);
    expect(lease?.isCurrent()).toBe(true);
    expect(await daemon.workflowLease(pluginId, instance + 1)).toBeUndefined();
    await daemon.dispatch({ action: 'disable', pluginId });
    expect(lease?.isCurrent()).toBe(false);
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
