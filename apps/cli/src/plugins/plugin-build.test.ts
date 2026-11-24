import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compilePlugin } from './plugin-build';

test('a browser edit changes only client identity; invalid source cannot replace a prior bundle', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-compile-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'lody.plugin.json'),
    JSON.stringify({
      id: 'demo',
      version: '1.0.0',
      title: 'Demo',
      sdk: '^1.0.0',
      machine: 'machine.ts',
      client: 'client.ts',
    })
  );
  await writeFile(join(root, 'machine.ts'), 'export default 1');
  const build = async (name: string) => {
    const stage = join(root, name);
    await mkdir(stage);
    return compilePlugin({ sourceDir: root, stage });
  };
  await writeFile(join(root, 'client.ts'), 'export default 1');
  const first = await build('a');
  await writeFile(join(root, 'client.ts'), 'export default 2');
  const second = await build('b');
  assert.equal(second.machineDigest, first.machineDigest);
  assert.notEqual(second.clientDigest, first.clientDigest);
  const prior = await readFile(join(root, 'b', 'client.js'));
  await writeFile(join(root, 'client.ts'), 'export !!!');
  await assert.rejects(build('c'));
  assert.deepEqual(await readFile(join(root, 'b', 'client.js')), prior);
});

test.each([
  ['client', 'import "@lody/plugin-sdk/machine"'],
  ['client', 'import "node:fs"'],
  ['machine', 'import "@lody/plugin-sdk/client"'],
  ['machine', 'export default () => document.title'],
])('%s rejects forbidden transitive dependency %s', async (side, code) => {
  const sourceDir = await mkdtemp(join(tmpdir(), 'purity-'));
  try {
    const stage = join(sourceDir, 'stage');
    await mkdir(stage);
    await writeFile(
      join(sourceDir, 'lody.plugin.json'),
      JSON.stringify({
        id: 'demo',
        version: '1.0.0',
        title: 'Demo',
        sdk: '^1.0.0',
        [side]: 'index.ts',
      })
    );
    await writeFile(
      join(sourceDir, 'index.ts'),
      'export * from "./nested"; import "./nested"; export { default } from "./nested";'
    );
    await writeFile(
      join(sourceDir, 'nested.ts'),
      code.includes('export default') ? code : code + ';export default 1'
    );
    await assert.rejects(compilePlugin({ sourceDir, stage }), /cannot import|DOM global/);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
});

test('outside the workspace the machine entry bundles the host SDK without installing in the plugin', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-sdk-runtime-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, 'stage');
  await mkdir(stage);
  await writeFile(
    join(root, 'lody.plugin.json'),
    JSON.stringify({
      id: 'demo',
      version: '1.0.0',
      title: 'Demo',
      sdk: '^1.0.0',
      machine: 'machine.ts',
    })
  );
  await writeFile(
    join(root, 'machine.ts'),
    'import {defineMachinePlugin} from "@lody/plugin-sdk/machine";export default defineMachinePlugin(()=>{})'
  );
  await compilePlugin({ sourceDir: root, stage });
  assert.equal(
    (await import(/* @vite-ignore */ join(stage, 'machine.js'))).default.kind,
    'machine-plugin'
  );
});

test('a skill-only plugin stages its named SKILL.md without a process entry or client digest', async (t) => {
  const sourceDir = await mkdtemp(join(tmpdir(), 'plugin-skill-'));
  t.onTestFinished(() => rm(sourceDir, { recursive: true, force: true }));
  const stage = join(sourceDir, 'stage');
  await mkdir(stage);
  await mkdir(join(sourceDir, 'skills', 'review'), { recursive: true });
  await writeFile(join(sourceDir, 'skills/review/SKILL.md'), '# Review');
  await writeFile(
    join(sourceDir, 'lody.plugin.json'),
    JSON.stringify({
      id: 'reviewer',
      version: '1.0.0',
      sdk: '^1.0.0',
      title: 'Reviewer',
      skills: ['review'],
    })
  );
  const { machineDigest, clientDigest } = await compilePlugin({ sourceDir, stage });
  assert.equal(machineDigest, undefined);
  assert.equal(clientDigest, undefined);
  assert.equal(await readFile(join(stage, 'skills/review/SKILL.md'), 'utf8'), '# Review');
});
