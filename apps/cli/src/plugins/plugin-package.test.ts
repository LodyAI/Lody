import { gzipSync, gunzipSync } from 'node:zlib';
import { test, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packPlugin, inspectProposalPackage, installPackage } from './plugin-package';

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
  const a = await packPlugin(source, join(root, 'a'));
  await writeFile(join(source, '.env'), 'MUST_NOT_SHIP');
  const b = await packPlugin(source, join(root, 'b'));
  expect(b.sha256).toBe(a.sha256);
  const bytes = await readFile(a.path);
  const tar = gunzipSync(bytes);
  expect(tar.includes('package/lody.integrity.json')).toBe(true);
  expect(tar.includes('MUST_NOT_SHIP')).toBe(false);
  const info = await inspectProposalPackage(a.path);
  expect(info.requestedCapabilities).toEqual(
    expect.arrayContaining(['client', 'sessions.approve', 'unstable.rawState'])
  );
  const current = await installPackage(a.path, generations, info.sha256);
  expect(await readFile(join(current.directory, 'client.js'), 'utf8')).toContain('123');
  await expect(installPackage(b.path, generations, '0'.repeat(64))).rejects.toThrow(/changed/);
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
  const { PluginDaemon } = await import('./plugin-host-legacy');
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
  const daemon = new PluginDaemon(
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
    await daemon.start();
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
      daemon.event(
        { type: 'event', eventType: 'session.created', eventId: n, payload: n },
        async () => true
      );
    await daemon.dispatch(a);
    await daemon.dispatch(b);
    await event('before');
    await daemon.dispatch({ action: 'remove', pluginId: 'primary' });
    await daemon.dispatch({ action: 'remove', pluginId: 'sibling' });
    await event('while-removed');
    await daemon.dispatch(a);
    expect(await journal('primary')).toBe(
      'start:empty\nbefore\nuninstall\nstart:uninstalled\nwhile-removed\n'
    );
    await daemon.dispatch({ action: 'remove', pluginId: 'primary', purgeData: true });
    await expect(journal('primary')).rejects.toMatchObject({ code: 'ENOENT' });
    await event('after-purge');
    await daemon.dispatch(a);
    expect(await journal('primary')).toBe('start:empty\n');
    await daemon.dispatch(b);
    expect(await journal('sibling')).toBe(
      'start:empty\nbefore\nuninstall\nstart:uninstalled\nwhile-removed\nafter-purge\n'
    );
  } finally {
    await daemon.dispose();
  }
});
