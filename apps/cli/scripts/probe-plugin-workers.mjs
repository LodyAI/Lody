import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dist = path.resolve(process.argv[2]);
const root = await mkdtemp(path.join(tmpdir(), 'plugin-worker-probe-'));
const stage = path.join(root, 'stage');
const children = [];
function spawnWorker(name, args = []) {
  const child = fork(path.join(dist, `${name}.js`), args, { cwd: root, execArgv: [] });
  children.push(child);
  return child;
}
async function exchange(child, frame) {
  const controller = new AbortController();
  try {
    const options = { signal: controller.signal };
    const reply = Promise.race([
      once(child, 'message', options).then(([value]) => value),
      once(child, 'exit', options).then(([code]) => {
        throw new Error(`Worker exited: ${code}`);
      }),
    ]);
    child.send(frame);
    return await reply;
  } finally {
    controller.abort();
  }
}
try {
  await mkdir(stage);
  await writeFile(
    path.join(root, 'lody.plugin.json'),
    JSON.stringify({
      id: 'probe',
      title: 'Probe',
      sdk: '^1.0.0',
      version: '1.0.0',
      machine: 'machine.ts',
    })
  );
  await writeFile(
    path.join(root, 'machine.ts'),
    `import {defineMachinePlugin} from '@lody/plugin-sdk/machine'; import {defineQuery} from '@lody/plugin-sdk'; import {z} from 'zod'; export default defineMachinePlugin(m => m.query(defineQuery('machine','probe.read',{input:z.null(),output:z.string()}), ()=>'ready'));`
  );
  const compiler = spawnWorker('plugin-compiler-worker');
  const result = await exchange(compiler, { sourceDir: root, stage });
  assert.equal(result.ok, true, result.message);
  const worker = spawnWorker('plugin-worker', [
    path.join(stage, result.manifest.machine),
    'workspace',
    'machine',
  ]);
  assert.equal(
    (
      await exchange(worker, {
        type: 'init',
        pluginId: 'probe',
        instanceId: 1,
        dataDir: root,
        config: {},
        permissions: [],
      })
    ).type,
    'ready'
  );
  assert.equal((await exchange(worker, { type: 'start', contextId: 'startup' })).ok, true);
  assert.equal(
    (
      await exchange(worker, {
        type: 'invoke',
        callId: 'read',
        kind: 'query',
        descriptorId: 'probe.read',
        scope: 'machine',
        target: { workspaceId: 'workspace', machineId: 'machine' },
        actorUserId: 'probe',
        input: null,
      })
    ).data,
    'ready'
  );
} finally {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit');
        child.kill();
        await exit;
      }
    })
  );
  await rm(root, { recursive: true, force: true });
}
