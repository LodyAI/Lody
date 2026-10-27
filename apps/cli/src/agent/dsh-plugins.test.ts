import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { fileLocksLegacy } from '@/utils/file-lock';
import { platformLayer } from '@/platform/process-options';
import { dshPluginArguments, manageDshPlugins } from './dsh-plugins';
import {
  dshProfileLockName,
  resolveDeepSeekHarnessProcessLaunch,
} from './deepseek-harness-runtime';
import type { DshPluginsRequest } from '@lody/shared';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-plugins-test-'));
  roots.push(rootDir);
  const launch = await resolveDeepSeekHarnessProcessLaunch({
    rootDir,
    adapterPath: '/synthetic/acp.js',
  });
  const profile = join(rootDir, 'profiles', 'lody-acp');
  const manifest = join(profile, 'package.json');
  const run = (request: DshPluginsRequest, script = '') =>
    fileLocksLegacy.runPromise(
      manageDshPlugins(
        request,
        {
          ...launch,
          command: process.execPath,
          args: ['-e', script, manifest],
        },
        { ...process.env, DEEPSEEK_API_KEY: 'synthetic-not-forwarded', PATH: '/synthetic/bin' }
      ).pipe(Effect.provide(platformLayer({})))
    );
  return { run, profile, manifest, rootDir };
}

describe('DSH plugin management', () => {
  it('lists the resulting package versions and activation after install, update and removal', async () => {
    const { run } = await fixture();
    const configId = 'synthetic-provider';
    expect(await run({ configId, action: 'list' })).toEqual([]);
    const save = `if(process.env.DEEPSEEK_API_KEY || process.env.PATH !== '/synthetic/bin') throw new Error('Unexpected package environment'); const fs = require('node:fs'); const p = process.argv[1]; const m = JSON.parse(fs.readFileSync(p));`;
    const install = `${save} m.dependencies = { 'synthetic-plugin': '1.0.0' }; m.dsh.profile.bundles.push('synthetic-plugin'); fs.writeFileSync(p, JSON.stringify(m));`;
    expect(
      await run({ configId, action: 'install', package: 'synthetic-plugin' }, install)
    ).toEqual([{ name: 'synthetic-plugin', version: '1.0.0', active: true }]);
    expect(
      await run(
        { configId, action: 'update', package: 'synthetic-plugin' },
        `${save} m.dependencies['synthetic-plugin']='2.0.0'; fs.writeFileSync(p,JSON.stringify(m));`
      )
    ).toEqual([{ name: 'synthetic-plugin', version: '2.0.0', active: true }]);
    expect(
      await run(
        { configId, action: 'remove', package: 'synthetic-plugin' },
        `${save} delete m.dependencies['synthetic-plugin']; m.dsh.profile.bundles=m.dsh.profile.bundles.filter(n=>n!=='synthetic-plugin'); fs.writeFileSync(p,JSON.stringify(m));`
      )
    ).toEqual([]);
  });

  it('reports installer failure without pretending success or resetting user configuration', async () => {
    const { run, manifest, profile } = await fixture();
    const original = await readFile(manifest, 'utf8');
    const patch = '- id: synthetic\n  disabled: true\n';
    await writeFile(join(profile, 'cordis.patch.yml'), patch);
    await expect(
      run(
        { configId: 'p', action: 'install', package: 'synthetic-plugin' },
        `const fs=require('node:fs'); fs.writeFileSync(process.argv[1], JSON.stringify({dependencies:{bad:'1.0.0'},dsh:{profile:{bundles:[]}}})); fs.writeFileSync(require('node:path').join(require('node:path').dirname(process.argv[1]),'pnpm-lock.yaml'),'partial'); process.exitCode=1`
      )
    ).rejects.toThrow('failed');
    expect(await readFile(manifest, 'utf8')).toBe(original);
    await expect(readFile(join(profile, 'pnpm-lock.yaml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(patch);
    expect(await run({ configId: 'p', action: 'list' })).toEqual([]);
    await expect(run({ configId: 'p', action: 'remove', package: 'missing' })).rejects.toThrow(
      'not installed'
    );
  });

  it('serializes startup with an in-progress package mutation without losing its bundle', async () => {
    const { manifest, rootDir } = await fixture();
    let enter = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const install = fileLocksLegacy.withLock(
      dshProfileLockName(rootDir),
      async () => {
        const saved = JSON.parse(await readFile(manifest, 'utf8'));
        enter();
        await released;
        saved.dependencies = { 'synthetic-plugin': '3.0.0' };
        saved.dsh.profile.bundles.push('synthetic-plugin');
        await writeFile(manifest, JSON.stringify(saved));
      },
      { locksDir: join(rootDir, 'lody-locks') }
    );
    await entered;
    const startup = resolveDeepSeekHarnessProcessLaunch({
      rootDir,
      adapterPath: '/synthetic/v2/acp.js',
    });
    release();
    await Promise.all([install, startup]);
    const saved = JSON.parse(await readFile(manifest, 'utf8'));
    expect(saved.dependencies).toEqual({ 'synthetic-plugin': '3.0.0' });
    expect(saved.dsh.profile.bundles.at(-1)).toBe('synthetic-plugin');
  });

  it('only constructs registry operations and protects the pinned runtime', () => {
    expect(
      dshPluginArguments({ configId: 'p', action: 'install', package: '@example/plugin@1.2.3' })
    ).toEqual(['add', '--save-exact', '@example/plugin@1.2.3']);
    expect(
      dshPluginArguments({ configId: 'p', action: 'update', package: '@example/plugin' })
    ).toEqual(['update', '--latest', '@example/plugin']);
    for (const pkg of [
      '@deepseek-ai/dsh',
      'pnpm',
      '@lody/dsh-host-abcd',
      '--config.foo=bar',
      'file:../outside',
    ]) {
      expect(() =>
        dshPluginArguments({ configId: 'p', action: 'install', package: pkg })
      ).toThrow();
    }
  });
});
