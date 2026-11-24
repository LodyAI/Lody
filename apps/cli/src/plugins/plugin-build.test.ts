import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { cp, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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

test('Sorbet binds managed Pi and speaks MCP over stdio from an external plugin directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sorbet-reference-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'source');
  const stage = join(root, 'staged');
  await cp(
    fileURLToPath(
      new URL('../../../../scripts/fixtures/plugin-sdk/examples/sorbet-workflow/', import.meta.url)
    ),
    sourceDir,
    { recursive: true }
  );
  await mkdir(stage);
  const { manifest, machineDigest, clientDigest } = await compilePlugin({ sourceDir, stage });
  assert.ok(machineDigest && clientDigest);
  const exchange = (entry: string, calls: [string, object][]) => {
    const result = spawnSync(process.execPath, [entry], {
      cwd: stage,
      encoding: 'utf8',
      timeout: 10000,
      input:
        calls
          .map(([method, params], id) => JSON.stringify({ jsonrpc: '2.0', id, method, params }))
          .join('\n') + '\n',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  };
  const mcp = exchange(manifest.mcpServers![0]!.entry, [
    ['initialize', { protocolVersion: '2025-03-26' }],
    ['tools/call', { name: 'remember', arguments: { key: 'plan', text: 'Synthetic scope' } }],
    ['tools/call', { name: 'recall', arguments: { key: 'plan' } }],
  ]);
  assert.equal(mcp[2].result.content[0].text, 'Synthetic scope');
  assert.equal(manifest.acpProviders![0]!.managedAgent, 'pi');
  const { pluginManifestSchema } = await import('@lody/shared/plugins/manifest-schema');
  for (const invalid of [
    { entry: 'runtime.mjs' },
    { managedAgent: 'pi', entry: 'runtime.mjs' },
    { managedAgent: 'unknown' },
  ])
    assert.equal(
      pluginManifestSchema.safeParse({
        ...manifest,
        acpProviders: [{ id: 'sorbet', title: 'Sorbet', ...invalid }],
      }).success,
      false
    );
});
