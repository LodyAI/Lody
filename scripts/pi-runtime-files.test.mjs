import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyPiRuntimeFiles } from './pi-runtime-files.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-runtime-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const build = path.join(root, 'build');
  const output = path.join(root, 'package');
  await mkdir(path.join(build, 'dist'), { recursive: true });
  await mkdir(path.join(build, 'node_modules', '.bin'), { recursive: true });
  await writeFile(path.join(build, 'package.json'), '{}');
  await writeFile(path.join(build, 'LICENSE'), 'synthetic');
  await writeFile(path.join(build, 'dist', 'index.js'), 'export const value = 42;');
  return { root, build, output };
}

test('runtime links remain relative and usable after removing the build directory', async (t) => {
  const { build, output } = await fixture(t);
  await symlink('../dist/index.js', path.join(build, 'node_modules', 'entry.js'));
  await symlink('../removed-dev/index.js', path.join(build, 'node_modules', '.bin', 'dev'));
  for (const name of ['.modules.yaml', '.pnpm-workspace-state-v1.json']) {
    await writeFile(path.join(build, 'node_modules', name), 'synthetic builder path');
  }
  await copyPiRuntimeFiles(build, output);
  await rm(build, { recursive: true });
  assert.equal(await readlink(path.join(output, 'node_modules', 'entry.js')), '../dist/index.js');
  assert.equal(
    await readFile(path.join(output, 'node_modules', 'entry.js'), 'utf8'),
    'export const value = 42;'
  );
  for (const name of ['.modules.yaml', '.pnpm-workspace-state-v1.json', '.bin/dev']) {
    await assert.rejects(readFile(path.join(output, 'node_modules', name)), { code: 'ENOENT' });
  }
});

test('absolute, escaping and dangling dependency links cannot be packaged', async (t) => {
  for (const kind of ['absolute', 'escaping', 'dangling']) {
    await t.test(kind, async (t) => {
      const { root, build, output } = await fixture(t);
      await writeFile(path.join(root, 'outside.js'), 'synthetic');
      const target =
        kind === 'absolute'
          ? path.join(build, 'dist', 'index.js')
          : kind === 'escaping'
            ? '../../outside.js'
            : './missing.js';
      await symlink(target, path.join(build, 'node_modules', 'entry.js'));
      await assert.rejects(
        copyPiRuntimeFiles(build, output),
        kind === 'dangling'
          ? { code: 'ENOENT' }
          : new RegExp(kind === 'absolute' ? 'Absolute runtime symlink' : 'escapes package')
      );
    });
  }
});
