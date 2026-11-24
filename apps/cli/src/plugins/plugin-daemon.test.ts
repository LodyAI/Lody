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
