import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import topLevelAwait from '../packages/components/vite-top-level-await-fixed.cjs';

const componentRequire = createRequire(
  new URL('../packages/components/package.json', import.meta.url)
);

test('the renderer can load an eager icon from a provider with a lazy dependency', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lody-renderer-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = {
    'boot.js': "export const loadScreen = () => import('./screen.js');",
    'screen.js': "export { icon } from './icon.js';",
    'icon.js':
      "import { createIcon } from './provider.js'; export const icon = createIcon('shield-check');",
    'provider.js':
      "import { loadDetail } from './shared.js'; export const createIcon = name => ({ name, loadDetail }); export const loadHelp = () => import('./detail.js');",
    'shared.js': "export const loadDetail = () => import('./detail.js');",
    'detail.js': "export const label = await Promise.resolve('detail');",
  };
  for (const [name, source] of Object.entries(sources)) {
    await writeFile(join(root, name), source);
  }
  const { build } = await import(pathToFileURL(componentRequire.resolve('vite')).href);
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [topLevelAwait()],
    build: {
      target: 'es2020',
      lib: {
        entry: Object.keys(sources).map((name) => join(root, name)),
        formats: ['es'],
        fileName: (_format, name) => name + '.mjs',
      },
    },
  });

  const boot = await import(pathToFileURL(join(root, 'dist/boot.mjs')).href);
  await boot.__tla;
  const { icon } = await boot.loadScreen();
  assert.equal(icon.name, 'shield-check');
  assert.equal((await icon.loadDetail()).label, 'detail');
});
