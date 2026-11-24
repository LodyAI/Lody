import { Effect, Layer, ManagedRuntime } from 'effect';
import { PluginHost } from './workflow/plugin-host';
import { Registry } from './workflow/plugin-registry';
import { gzipSync, gunzipSync } from 'node:zlib';
import { test, expect, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectPinnedNpmPackage,
  installWorkspacePin,
  packPlugin,
  inspectProposalPackage,
  installPackage,
} from './plugin-package';

test('deterministic releases include only declared files; integrity and approval failures publish no generation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'package-release-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    generations = join(root, 'generations');
  await mkdir(source);
  await writeFile(
    join(source, 'lody.plugin.json'),
    JSON.stringify({
      id: 'demo',
      version: '1.0.0',
      sdk: '^1.0.0',
      title: 'Demo',
      client: 'main.ts',
      permissions: ['sessions.approve', 'unstable.rawState'],
    })
  );
  await writeFile(join(source, 'main.ts'), 'export default 123');
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({ name: '@example/demo', scripts: { install: 'MUST_NOT_SHIP' } })
  );
  const a = await packPlugin(source, join(root, 'a'));
  await writeFile(join(source, '.env'), 'MUST_NOT_SHIP');
  const b = await packPlugin(source, join(root, 'b'));
  expect(b.sha256).toBe(a.sha256);
  const bytes = await readFile(a.path);
  expect(a.workspaceEntry.source).toEqual({
    kind: 'npm',
    package_name: '@example/demo',
    exact_version: '1.0.0',
    integrity:
      'sha512-' + (await import('node:crypto')).createHash('sha512').update(bytes).digest('base64'),
  });
  expect(await inspectPinnedNpmPackage(a.path, a.workspaceEntry.source)).toEqual({
    sha256: a.sha256,
    entry: a.workspaceEntry,
  });
  await expect(
    inspectPinnedNpmPackage(a.path, { ...a.workspaceEntry.source, package_name: 'another' })
  ).rejects.toThrow('identity mismatch');
  await expect(
    inspectPinnedNpmPackage(a.path, {
      ...a.workspaceEntry.source,
      integrity: 'sha512-' + 'A'.repeat(86) + '==',
    })
  ).rejects.toThrow('integrity mismatch');
  const { Lody } = await import('../lib/lody');
  const { LoroRepo } = await import('loro-repo');
  const { getWorkspaceFlockDocId, readWorkspaceFlockRowsFromFlock, listWorkspacePlugins } =
    await import('@lody/shared');
  const workspaceId = 'workspace' as import('@lody/shared').WorkspaceId;
  const repo = await LoroRepo.create({});
  try {
    const handle = await repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
    const registry = {
      installOwnerNpm: (entry, signal, admit) =>
        Effect.tryPromise(async () => {
          admit();
          return installWorkspacePin(
            entry,
            join(root, 'workspace-machine'),
            signal,
            async () => new Response(bytes)
          );
        }),
    } satisfies Pick<typeof Registry.Service, 'installOwnerNpm'>;
    const host = ManagedRuntime.make(Layer.succeed(Registry, registry as typeof Registry.Service));
    t.onTestFinished(() => host.dispose());
    const runtime = Object.assign(Object.create(Lody.prototype), {
      workspaceId,
      encryptedWorkspace: {
        pluginAuthoritySignal: new AbortController().signal,
        authorizeWorkspacePluginInstall: async () => () => true,
      },
      encryptedPlugin: Promise.resolve(host),
      documentManager: { repo, syncFlockDocOrThrow: async () => {} },
    }) as InstanceType<typeof Lody>;
    const cmd = {
      action: 'install-npm' as const,
      path: a.path,
      source: a.workspaceEntry.source,
      permissions: a.workspaceEntry.permissions,
    };
    await expect(
      runtime.dispatchEncryptedPluginControl({ ...cmd, permissions: [] })
    ).rejects.toThrow('disclosure changed');
    expect(listWorkspacePlugins(readWorkspaceFlockRowsFromFlock(handle.flock))).toEqual([]);
    await runtime.dispatchEncryptedPluginControl(cmd);
    expect(listWorkspacePlugins(readWorkspaceFlockRowsFromFlock(handle.flock))).toEqual([
      a.workspaceEntry,
    ]);
    const { watchPluginOwnerDecisions } = await import('./owner-pin-reconciler');
    const { pluginOwnerSyncSubject, syncChallengeSchema } =
      await import('@lody/shared/plugins/workspace-entry');
    const { workspaceFlockKeys } = await import('@lody/shared');
    const { generateKeyPairSync, sign, verify } = await import('node:crypto');
    const keys = generateKeyPairSync('ed25519');
    type Pin = typeof a.workspaceEntry;
    const subject = (pin: Pin) => Buffer.from(JSON.stringify(pluginOwnerSyncSubject(pin)));
    const signed = (pin: Pin): Pin => ({
      ...pin,
      sync_signature: sign(null, subject(pin), keys.privateKey).toString('hex'),
    });
    const decision = signed({
      ...a.workspaceEntry,
      machine_sync: 'owner_machines',
      sync_decision_id: crypto.randomUUID(),
      sync_owner_user_id: 'alice',
    });
    const manual = signed({
      ...decision,
      machine_sync: 'manual',
      sync_decision_id: crypto.randomUUID(),
    });
    const decisionKey = workspaceFlockKeys.pluginOwnerSync('alice', decision.plugin_id),
      key = workspaceFlockKeys.pluginSyncChallenge('alice', 'target', decision.plugin_id);
    let installed = false;
    const observe = () =>
      watchPluginOwnerDecisions({
        flock: handle.flock,
        owner: 'alice',
        machine: 'target',
        signal: new AbortController().signal,
        verify: async (pin) => {
          if (!verify(null, subject(pin), keys.publicKey, Buffer.from(pin.sync_signature!, 'hex')))
            throw Error('Invalid signature');
          return () => {};
        },
        installed: async () => installed,
        install: async (_pin, _signal, admit) => {
          (await admit())();
          installed = true;
        },
        flush: () => repo.flush(),
        warn: () => {},
      });
    const set = (k: typeof decisionKey | typeof key, v: unknown) => {
      handle.flock.set(k, v);
      handle.flock.commit();
    };
    const readChallenge = () =>
      syncChallengeSchema.parse([...handle.flock.scan({ prefix: key })][0]?.value);
    const reply = (challenge: ReturnType<typeof readChallenge>) => {
      const { confirmation: _, confirmedAt: _time, ...bound } = challenge;
      const confirmedAt = Date.now();
      return {
        ...bound,
        confirmedAt,
        confirmation: signed({ ...decision, sync_confirmed_at: confirmedAt, sync_challenge: bound })
          .sync_signature,
      };
    };
    let watcher = observe();
    try {
      set(decisionKey, decision);
      await watcher.refresh();
      const old = reply(readChallenge());
      set(decisionKey, manual);
      await watcher.refresh();
      set(key, old);
      set(decisionKey, decision);
      await watcher.refresh();
      expect(installed).toBe(false);
      expect(readChallenge().nonce).not.toBe(old.nonce);
      watcher.stop();
      set(key, old);
      watcher = observe();
      await watcher.refresh();
      expect(installed).toBe(false);
      expect(readChallenge().nonce).not.toBe(old.nonce);
      set(key, reply(readChallenge()));
      await watcher.refresh();
      expect(installed).toBe(true);
    } finally {
      watcher.stop();
    }
  } finally {
    await repo.destroy();
  }
  const tar = gunzipSync(bytes);
  expect(tar.includes('package/lody.integrity.json')).toBe(true);
  expect(tar.includes('MUST_NOT_SHIP')).toBe(false);
  const info = await inspectProposalPackage(a.path);
  expect(info.requestedCapabilities).toEqual(
    expect.arrayContaining(['client', 'sessions.approve', 'unstable.rawState'])
  );
  const current = await installPackage(a.path, generations, info.sha256);
  expect(current.clientDigest).toBe(a.workspaceEntry.client_digest);
  expect(await readFile(join(current.directory, 'client.js'), 'utf8')).toContain('123');
  await expect(installPackage(b.path, generations, '0'.repeat(64))).rejects.toThrow(/changed/);
  const registry = async () => new Response(bytes);
  const signal = new AbortController().signal;
  const syncRoot = join(root, 'synced');
  await expect(
    installWorkspacePin(
      {
        ...a.workspaceEntry,
        source: {
          ...a.workspaceEntry.source,
          package_name: 'different-package',
        },
      },
      syncRoot,
      signal,
      registry
    )
  ).rejects.toThrow(/disclosure/);
  await expect(
    installWorkspacePin(
      a.workspaceEntry,
      syncRoot,
      signal,
      async () => new Response('other archive')
    )
  ).rejects.toThrow(/integrity/);
  const synced = await installWorkspacePin(a.workspaceEntry, syncRoot, signal, registry);
  expect(synced.clientDigest).toBe(current.clientDigest);
  expect(await readdir(syncRoot)).toHaveLength(1);
  const { makePluginRuntime } = await import('./plugin-runtime');
  const daemon = makePluginRuntime(join(root, 'owned-machine'), 'workspace', 'target', () => {});
  const pin = {
    ...a.workspaceEntry,
    machine_sync: 'owner_machines' as const,
    sync_decision_id: crypto.randomUUID(),
    sync_owner_user_id: 'alice',
    sync_signature: 'owner-proof',
  };
  try {
    await daemon.runPromise(Effect.flatMap(Registry, (r) => r.start));
    vi.stubGlobal('fetch', registry);
    const reconcile = (
      owner: string,
      verify: () => Promise<() => void>,
      row = pin as typeof a.workspaceEntry
    ) =>
      daemon.runPromise(
        Effect.flatMap(Registry, (r) => r.reconcileOwnerPin(row, owner, signal, verify))
      );
    const admit = async () => () => {};
    await reconcile('bob', admit);
    await reconcile('alice', admit, a.workspaceEntry);
    await expect(
      reconcile('alice', async () => {
        throw Error('invalid signature');
      })
    ).rejects.toThrow();
    expect(
      await daemon.runPromise(Effect.flatMap(Registry, (r) => r.dispatch({ action: 'list' })))
    ).toMatchObject({ plugins: [] });
    await reconcile('alice', admit);
    expect(
      await daemon.runPromise(Effect.flatMap(Registry, (r) => r.dispatch({ action: 'list' })))
    ).toMatchObject({
      plugins: [{ pluginId: 'demo', enabled: false }],
    });
    const catalog = JSON.parse(await readFile(join(root, 'owned-machine', 'catalog.json'), 'utf8'));
    expect(catalog[0]).not.toHaveProperty('declaredGrant');
    expect(catalog[0]).not.toHaveProperty('preferences');
    const installed = async () =>
      await daemon.runPromise(
        Effect.flatMap(Registry, (r) =>
          r.machineRpc(
            { workspaceId: 'workspace', machineId: 'target', method: 'plugin/catalog', params: {} },
            { userId: 'member', machineOwner: false }
          )
        )
      );
    expect(await installed()).toMatchObject({
      installations: [{ source: a.workspaceEntry.source }],
    });
    await daemon.runPromise(
      Effect.flatMap(Registry, (r) =>
        r.dispatch({ action: 'install', path: a.path, sha256: a.sha256 })
      )
    );
    expect(await installed()).toMatchObject({
      installations: [{ source: { kind: 'local', origin: 'archive' } }],
    });
    await daemon.runPromise(
      Effect.flatMap(Registry, (r) => r.dispatch({ action: 'rollback', pluginId: 'demo' }))
    );
    expect(await installed()).toMatchObject({
      installations: [{ source: a.workspaceEntry.source }],
    });

    const nextManifest = {
      ...a.workspaceEntry.manifest_summary,
      version: '1.2.0',
      client: 'main.ts',
    };
    await writeFile(join(source, 'lody.plugin.json'), JSON.stringify(nextManifest));
    const next = await packPlugin(source, join(root, 'upgrade'));
    const archive = await readFile(next.path);
    vi.stubGlobal('fetch', async () => new Response(archive));
    await daemon.runPromise(
      Effect.flatMap(Registry, (r) => r.installOwnerNpm(next.workspaceEntry, signal, () => {}))
    );
    expect(await installed()).toMatchObject({
      installations: [{ source: next.workspaceEntry.source }],
    });
    await daemon.runPromise(
      Effect.flatMap(Registry, (r) => r.dispatch({ action: 'rollback', pluginId: 'demo' }))
    );
    expect(await installed()).toMatchObject({
      installations: [{ source: a.workspaceEntry.source }],
    });
    await reconcile('alice', admit);
    expect(await readdir(join(root, 'owned-machine', 'generations'))).toHaveLength(2);
  } finally {
    vi.unstubAllGlobals();
    await daemon.dispose();
  }
  for (const malformed of [
    Buffer.concat([bytes, Buffer.from('x')]),
    bytes.subarray(0, -1),
    gzipSync(Buffer.from(tar.toString('latin1').replace('client.js', '../bad.js'), 'latin1')),
    gzipSync(Buffer.from(tar.toString('latin1').replace('123', '456'), 'latin1')),
  ]) {
    await writeFile(b.path, malformed);
    await expect(inspectProposalPackage(b.path)).rejects.toThrow();
    await expect(installPackage(b.path, generations)).rejects.toThrow();
  }
  expect(await readdir(generations)).toHaveLength(1);
});

test('release removal preserves data and replays missed events unless purge was explicitly requested', async (t) => {
  const { makePluginRuntime } = await import('./plugin-runtime');
  const { build } = await import('esbuild');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'release-remove-')),
    source = join(root, 'source'),
    worker = join(root, 'worker.mjs');
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(source);
  await build({
    entryPoints: [fileURLToPath(new URL('./plugin-worker-entry.ts', import.meta.url))],
    outfile: worker,
    platform: 'node',
    format: 'esm',
    bundle: true,
  });
  const daemon = makePluginRuntime(
    root,
    'w',
    'm',
    () => {},
    undefined,
    undefined,
    worker,
    async () => true
  );
  try {
    await daemon.runPromise(Effect.flatMap(Registry, (r) => r.start));
    await writeFile(
      join(source, 'machine.ts'),
      `import {appendFileSync} from 'node:fs';import {join} from 'node:path';export default {kind:'machine-plugin',register(m){const append=(ctx,s)=>appendFileSync(join(ctx.dataDir,'journal'),s+'\\n');m.onStart(async ctx=>append(ctx,'start:'+((await ctx.storage.get('last'))??'empty')));m.onUninstall(async ctx=>{await ctx.storage.set('last','uninstalled');append(ctx,'uninstall')});m.events.on('session.created',async(ctx,p)=>{await ctx.storage.set('last',p);append(ctx,p);},{resumeFromCursor:true})}}`
    );
    const release = async (id: string) => {
      await writeFile(
        join(source, 'lody.plugin.json'),
        JSON.stringify({ id, title: id, sdk: '^1.0.0', version: '1.0.0', machine: 'machine.ts' })
      );
      const { path, sha256 } = await packPlugin(source, join(root, id + '.tgz'));
      return { action: 'install', path, sha256 };
    };
    const a = await release('primary'),
      b = await release('sibling');
    const journal = (id: string) => readFile(join(root, 'data', id, 'journal'), 'utf8');
    const event = (n: string) =>
      daemon.runPromise(
        Effect.flatMap(PluginHost, (r) =>
          r.broadcast(
            { type: 'event', eventType: 'session.created', eventId: n, payload: n },
            async () => true
          )
        )
      );
    await daemon.runPromise(Effect.flatMap(Registry, (r) => r.dispatch(a)));
    await daemon.runPromise(Effect.flatMap(Registry, (r) => r.dispatch(b)));
    await event('before');
    await daemon.runPromise(
      Effect.flatMap(Registry, (r) => r.dispatch({ action: 'remove', pluginId: 'primary' }))
    );
    await daemon.runPromise(
      Effect.flatMap(Registry, (r) => r.dispatch({ action: 'remove', pluginId: 'sibling' }))
    );
    await event('while-removed');
    await daemon.runPromise(Effect.flatMap(Registry, (r) => r.dispatch(a)));
    expect(await journal('primary')).toBe(
      'start:empty\nbefore\nuninstall\nstart:uninstalled\nwhile-removed\n'
    );
    await daemon.runPromise(
      Effect.flatMap(Registry, (r) =>
        r.dispatch({ action: 'remove', pluginId: 'primary', purgeData: true })
      )
    );
    await expect(journal('primary')).rejects.toMatchObject({ code: 'ENOENT' });
    await event('after-purge');
    await daemon.runPromise(Effect.flatMap(Registry, (r) => r.dispatch(a)));
    expect(await journal('primary')).toBe('start:empty\n');
    await daemon.runPromise(Effect.flatMap(Registry, (r) => r.dispatch(b)));
    expect(await journal('sibling')).toBe(
      'start:empty\nbefore\nuninstall\nstart:uninstalled\nwhile-removed\nafter-purge\n'
    );
  } finally {
    await daemon.dispose();
  }
});
