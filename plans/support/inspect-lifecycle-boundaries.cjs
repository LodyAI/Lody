// Characterize the pinned dependencies with synthetic in-memory replicas.
// This intentionally asserts existing limitations, not production fix acceptance.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { dirname, resolve } = require('node:path');

const manifest = resolve(process.argv[2] ?? 'packages/components/package.json');
const dependencyRequire = createRequire(manifest);
const { Flock } = dependencyRequire('@loro-dev/flock-wasm');
const { LoroRepo } = dependencyRequire('loro-repo');
const versionOf = (name) => {
  const entry = dependencyRequire.resolve(name);
  return JSON.parse(readFileSync(resolve(dirname(entry), '..', 'package.json'), 'utf8')).version;
};
const versions = {
  repo: versionOf('loro-repo'),
  wasm: versionOf('@loro-dev/flock-wasm'),
};
assert.deepEqual(versions, { repo: '0.20.0', wasm: '0.4.3' });

const originalNow = Date.now;
Date.now = () => 1000;

function inspectRollback() {
  const local = new Flock('lifecycle-probe-local');
  const remote = new Flock('lifecycle-probe-remote');
  const root = ['m', 'session-root', 'isArchived'];
  const child = ['m', 'session-child', 'isArchived'];
  const status = ['m', 'session-child', 'status'];
  local.txn(() => {
    local.put(root, false, 1000);
    local.put(child, false, 1000);
    local.put(status, { type: 'running' }, 1000);
  });
  remote.importJson(local.exportJson());
  remote.txn(() => {
    remote.put(child, true, 2000);
    remote.put(status, { type: 'requestPermission' }, 2000);
  });
  local.importJson(remote.exportJson());
  const before = local.exportJson();
  const events = [];
  local.subscribe((event) => events.push(event));
  assert.throws(
    () =>
      local.txn(() => {
        local.put(status, { type: 'idle' }, 3000);
        local.put(root, true, 3000);
        throw new Error('injected before commit');
      }),
    /injected before commit/
  );
  assert.equal(local.get(root), false);
  assert.equal(local.get(child), true);
  assert.deepEqual(local.get(status), { type: 'requestPermission' });
  assert.deepEqual(local.exportJson(), before);
  assert.equal(events.length, 0);
  remote.importJson(local.exportJson());
  assert.deepEqual(remote.get(status), { type: 'requestPermission' });
  return { peerUpdatePreserved: true, exportUnchanged: true, emittedBatches: 0 };
}

async function inspectRepositoryPublication() {
  const local = await LoroRepo.create({ metaDebounceCommitMs: 0 });
  let remote;
  try {
    remote = await LoroRepo.create({ metaDebounceCommitMs: 0 });
    await local.upsertDocMeta('session-child', { isArchived: false, parentSessionId: 'root' });
    await local.upsertDocMeta('session-root', { isArchived: false });
    remote.getMeta().importJson(local.getMeta().exportJson());
    // Pinned-version diagnostic only; product code must not depend on this private queue.
    await remote.syncRunner.metaHydrationQueue;
    await local.getDocMeta('session-root');
    await local.getDocMeta('session-child');
    const observations = [];
    remote.watch((event) => {
      if (event.kind !== 'doc-metadata') return;
      observations.push(
        Promise.all([remote.getDocMeta('session-child'), remote.getDocMeta('session-root')]).then(
          ([child, root]) => ({
            eventDoc: event.docId,
            child: child.meta.isArchived,
            root: root.meta.isArchived,
          })
        )
      );
    });
    local.getMeta().txn(() => {
      local.getMeta().put(['m', 'session-child', 'isArchived'], true);
      local.getMeta().put(['m', 'session-root', 'isArchived'], true);
    });
    const raw = [
      local.getMeta().get(['m', 'session-child', 'isArchived']),
      local.getMeta().get(['m', 'session-root', 'isArchived']),
    ];
    const cached = [
      (await local.getDocMeta('session-child')).meta.isArchived,
      (await local.getDocMeta('session-root')).meta.isArchived,
    ];
    assert.deepEqual(raw, [true, true]);
    assert.deepEqual(cached, [false, false]);
    remote.getMeta().importJson(local.getMeta().exportJson());
    await remote.syncRunner.metaHydrationQueue;
    const snapshots = await Promise.all(observations);
    assert(snapshots.some((snapshot) => snapshot.child !== snapshot.root));
    assert.equal((await remote.getDocMeta('session-root')).meta.isArchived, true);
    return { localRaw: raw, localCached: cached, remoteWatchSnapshots: snapshots };
  } finally {
    await Promise.all([local.destroy(), remote?.destroy()]);
  }
}

(async () => {
  try {
    console.log(
      JSON.stringify(
        {
          versions,
          rollback: inspectRollback(),
          publication: await inspectRepositoryPublication(),
        },
        null,
        2
      )
    );
  } finally {
    Date.now = originalNow;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
