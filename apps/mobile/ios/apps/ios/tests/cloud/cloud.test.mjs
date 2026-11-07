import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Flock } from '@loro-dev/flock-wasm/base64';

test('real Flock snapshot plus framed updates produces current catalog without deleted documents or private fields', async () => {
  const bundle = await build({
    entryPoints: ['apps/ios/runtime/decoder/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  });
  await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
  const flock = new Flock('synthetic-test');
  flock.set(['e', 'machine-m1'], true, 1);
  flock.set(
    ['m', 'machine-m1'],
    {
      name: 'Test computer',
      localProjects: { p1: { name: 'Legacy project', rootPath: '/legacy' } },
    },
    2,
  );
  flock.set(['e', 'session-s1'], true, 3);
  flock.set(
    ['m', 'session-s1'],
    {
      machineId: 'm1',
      title: 'Before',
      project: { kind: 'local', localProjectId: 'p1' },
      privatePrompt: 'must never leave decoder',
    },
    4,
  );
  flock.set(['e', 'session-deleted'], true, 5);
  flock.set(['m', 'session-deleted'], { title: 'Removed' }, 6);
  const version = flock.version();
  const snapshot = Buffer.from(flock.exportFile()).toString('base64');
  flock.set(['m', 'session-s1', 'title'], 'After', 7);
  flock.set(['e', 'session-deleted'], false, 8);
  const update = Buffer.from(JSON.stringify(flock.exportJson(version)));
  const framed = Buffer.alloc(update.length + 4);
  framed.writeUInt32BE(update.length);
  update.copy(framed, 4);
  const result = JSON.parse(
    globalThis.decodeFlock(snapshot, [framed.toString('base64')], 'meta'),
  );
  assert.deepEqual(result.machineIds, ['m1']);
  assert.equal(result.machineNames.m1, 'Test computer');
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].title, 'After');
  assert.equal(result.sessions[0].projectId, 'm1:local:p1');
  assert.equal(result.projects[0].name, 'Legacy project');
  assert.ok(!JSON.stringify(result).includes('privatePrompt'));
  assert.throws(
    () =>
      globalThis.decodeFlock(
        '',
        [Buffer.from([0, 0, 0, 5, 1]).toString('base64')],
        'meta',
      ),
    /Truncated/,
  );
  const machine = new Flock('synthetic-machine');
  machine.set(
    ['localProject', 'p1'],
    { name: 'Project', rootPath: '/synthetic' },
    1,
  );
  const project = JSON.parse(
    globalThis.decodeFlock(
      Buffer.from(machine.exportFile()).toString('base64'),
      [],
      'm1',
    ),
  ).projects[0];
  assert.equal(project.id, result.sessions[0].projectId);
  assert.equal(project.name, 'Project');
});
