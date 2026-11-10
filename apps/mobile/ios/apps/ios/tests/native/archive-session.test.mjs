import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Flock } from '@loro-dev/flock-wasm/base64';

const bundle = await build({
  entryPoints: [
    new URL(
      '../../../../packages/cloud-runtime/src/runtime/archive-session.ts',
      import.meta.url,
    ).pathname,
  ],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  plugins: [
    {
      name: 'streams',
      setup(b) {
        b.onResolve({ filter: /^@loro-dev\/streams-client$/ }, () => ({
          path: 'mock',
          namespace: 'test',
        }));
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents:
            'export class StreamsClient { constructor(args) { return new globalThis.__archiveClient(args); } }',
        }));
      },
    },
  ],
});
const {
  archiveSession,
  setTabClosed,
  deleteSession,
  pinSession,
  markSessionRead,
  renameSession,
  setSessionOwner,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
const unframe = (body) =>
  JSON.parse(new TextDecoder().decode(body.subarray(4)));

test('delete commits root and contained tabs only after acknowledgement, preserving independently opened sessions', async () => {
  const flock = new Flock('delete-source'),
    remote = new Flock('delete-remote');
  for (const [id, fields] of Object.entries({
    root: {},
    tab: { parentSessionId: 'root' },
    independent: { openedBySessionId: 'root' },
  })) {
    flock.set(['e', `session-${id}`], true);
    flock.set(['m', `session-${id}`], {
      id,
      status: { type: 'completed' },
      ...fields,
    });
  }
  flock.commit();
  remote.importFile(flock.exportFile());
  let fail = true;
  const meta = {
    flock,
    client: {
      async append({ part }) {
        assert.equal(flock.get(['e', 'session-root']), true);
        if (fail) throw new Error('offline');
        remote.importJson(unframe(part.body));
        return { ok: true };
      },
    },
  };
  const args = { sessionId: 'root', sessionIds: ['root', 'tab'] };
  await assert.rejects(deleteSession(args, meta), /offline/);
  assert.equal(flock.get(['e', 'session-root']), true);
  await assert.rejects(
    deleteSession({ ...args, sessionIds: ['root'] }, meta),
    /targets_changed/,
  );
  flock.set(['m', 'session-tab', 'status'], { type: 'running' });
  await assert.rejects(deleteSession(args, meta), /session_busy/);
  flock.set(['m', 'session-tab', 'status'], { type: 'completed' });
  fail = false;
  assert.deepEqual(await deleteSession(args, meta), ['root', 'tab']);
  for (const replica of [flock, remote]) {
    assert.equal(replica.get(['e', 'session-root']), false);
    assert.equal(replica.get(['e', 'session-tab']), false);
    assert.equal(replica.get(['e', 'session-independent']), true);
  }
});

test('archive writes the machine command after the session meta; restore clears it', async () => {
  const meta = new Flock('meta'),
    machine = new Flock('machine'),
    remoteMeta = new Flock('remote-meta'),
    remoteMachine = new Flock('remote-machine');
  meta.set(['m', 'session-s1'], {
    id: 's1',
    machineId: 'm1',
    status: { type: 'running' },
    isArchived: false,
  });
  remoteMeta.importFile(meta.exportFile());
  const urls = [];
  globalThis.__archiveClient = class {
    constructor({ url }) {
      this.url = decodeURIComponent(url);
    }
    async append({ part }) {
      urls.push(this.url);
      remoteMachine.importJson(unframe(part.body));
      return { ok: true, result: {} };
    }
  };
  const replica = {
    flock: meta,
    client: {
      async append({ part }) {
        urls.push('meta');
        remoteMeta.importJson(unframe(part.body));
        return { ok: true, result: {} };
      },
    },
  };
  const grant = async () => ({ token: 't', gatewayBaseUrl: 'https://x' });
  const machines = new Map([['m1', machine]]);
  await assert.rejects(
    archiveSession(
      { workspaceId: 'w1', sessionId: 'missing', archived: true },
      replica,
      machines,
      grant,
    ),
    /session_not_found/,
  );
  await archiveSession(
    { workspaceId: 'w1', sessionId: 's1', archived: true },
    replica,
    machines,
    grant,
  );
  assert.deepEqual(urls, ['meta', 'https://x/ds/lody/w1:mf:m1']);
  assert.equal(remoteMeta.get(['m', 'session-s1', 'isArchived']), true);
  assert.deepEqual(remoteMeta.get(['m', 'session-s1', 'status']), {
    type: 'idle',
  });
  assert.equal(remoteMeta.get(['m', 'session-s1']).id, 's1');
  assert.equal(remoteMachine.get(['cmd', 'archiveSession', 's1']).v, 1);
  assert.equal(machine.get(['cmd', 'archiveSession', 's1']).v, 1);
  await archiveSession(
    { workspaceId: 'w1', sessionId: 's1', archived: false },
    replica,
    machines,
    grant,
  );
  assert.equal(meta.get(['m', 'session-s1', 'isArchived']), false);
  assert.equal(machine.get(['cmd', 'archiveSession', 's1']), undefined);
  assert.equal(remoteMachine.get(['cmd', 'archiveSession', 's1']), undefined);
  await pinSession({ sessionId: 's1', pinned: true }, replica);
  assert.equal(remoteMeta.get(['m', 'session-s1', 'isPinned']), true);
  await assert.rejects(
    pinSession({ sessionId: 'missing', pinned: true }, replica),
    /session_not_found/,
  );
});

test('mark read writes lastReadAt onto the session meta', async () => {
  const meta = new Flock('meta'),
    remoteMeta = new Flock('remote-meta');
  meta.set(['m', 'session-s1'], {
    id: 's1',
    machineId: 'm1',
    lastMessageAt: 100,
  });
  remoteMeta.importFile(meta.exportFile());
  const replica = {
    flock: meta,
    client: {
      async append({ part }) {
        remoteMeta.importJson(unframe(part.body));
        return { ok: true, result: {} };
      },
    },
  };
  await markSessionRead({ sessionId: 's1', lastReadAt: 250 }, replica);
  assert.equal(remoteMeta.get(['m', 'session-s1', 'lastReadAt']), 250);
  assert.equal(meta.get(['m', 'session-s1', 'lastReadAt']), 250);
  await markSessionRead({ sessionId: 's1', lastReadAt: 200 }, replica);
  assert.equal(meta.get(['m', 'session-s1', 'lastReadAt']), 250);
  await assert.rejects(
    markSessionRead({ sessionId: 'missing', lastReadAt: 1 }, replica),
    /session_not_found/,
  );
  await assert.rejects(
    markSessionRead({ sessionId: 's1', lastReadAt: Number.NaN }, replica),
    /invalid_session/,
  );
});

test('archive lands on the session even when the machine flock is unavailable', async () => {
  const meta = new Flock('meta'),
    remoteMeta = new Flock('remote-meta');
  meta.set(['m', 'session-s2'], {
    id: 's2',
    machineId: 'gone',
    isArchived: false,
  });
  globalThis.__archiveClient = class {
    async append() {
      throw new Error('offline');
    }
  };
  const replica = {
    flock: meta,
    client: {
      async append({ part }) {
        remoteMeta.importJson(unframe(part.body));
        return { ok: true, result: {} };
      },
    },
  };
  const grant = async () => ({ token: 't', gatewayBaseUrl: 'https://x' });
  await archiveSession(
    { workspaceId: 'w1', sessionId: 's2', archived: true },
    replica,
    new Map(),
    grant,
  );
  assert.equal(remoteMeta.get(['m', 'session-s2', 'isArchived']), true);
  const machine = new Flock('machine');
  await archiveSession(
    { workspaceId: 'w1', sessionId: 's2', archived: false },
    replica,
    new Map([['gone', machine]]),
    grant,
  );
  assert.equal(remoteMeta.get(['m', 'session-s2', 'isArchived']), false);
  assert.equal(machine.get(['cmd', 'archiveSession', 's2']), undefined);
});

test('archive and pin accept field-level session metadata', async () => {
  const meta = new Flock('meta'),
    machine = new Flock('machine'),
    remoteMeta = new Flock('remote-meta'),
    remoteMachine = new Flock('remote-machine');
  meta.put(['e', 'session-s3'], true);
  meta.put(['m', 'session-s3', 'id'], 's3');
  meta.put(['m', 'session-s3', 'machineId'], 'm1');
  meta.put(['m', 'session-s3', 'isArchived'], false);
  meta.put(['m', 'session-s3', 'status'], { type: 'running' });
  meta.commit();
  remoteMeta.importFile(meta.exportFile());
  globalThis.__archiveClient = class {
    constructor({ url }) {
      this.url = decodeURIComponent(url);
    }
    async append({ part }) {
      remoteMachine.importJson(unframe(part.body));
      return { ok: true, result: {} };
    }
  };
  const replica = {
    flock: meta,
    client: {
      async append({ part }) {
        remoteMeta.importJson(unframe(part.body));
        return { ok: true, result: {} };
      },
    },
  };
  const grant = async () => ({ token: 't', gatewayBaseUrl: 'https://x' });
  await pinSession({ sessionId: 's3', pinned: true }, replica);
  assert.equal(remoteMeta.get(['m', 'session-s3', 'isPinned']), true);
  assert.equal(remoteMeta.get(['m', 'session-s3']), undefined);
  await archiveSession(
    { workspaceId: 'w1', sessionId: 's3', archived: true },
    replica,
    new Map([['m1', machine]]),
    grant,
  );
  assert.equal(remoteMeta.get(['m', 'session-s3', 'isArchived']), true);
  assert.deepEqual(remoteMeta.get(['m', 'session-s3', 'status']), {
    type: 'idle',
  });
  assert.equal(remoteMeta.get(['m', 'session-s3']), undefined);
  assert.equal(remoteMachine.get(['cmd', 'archiveSession', 's3']).v, 1);
  assert.equal(machine.get(['cmd', 'archiveSession', 's3']).v, 1);
});

test('archive cascades to child sessions and only queues the root machine command', async () => {
  const meta = new Flock('meta'),
    machine = new Flock('machine'),
    remoteMeta = new Flock('remote-meta'),
    remoteMachine = new Flock('remote-machine');
  for (const [room, fields] of [
    ['session-root', { id: 'root', machineId: 'm1' }],
    [
      'session-child',
      { id: 'child', machineId: 'm1', parentSessionId: 'root' },
    ],
  ]) {
    meta.put(['e', room], true);
    for (const [key, value] of Object.entries(fields))
      meta.put(['m', room, key], value);
  }
  meta.commit();
  remoteMeta.importFile(meta.exportFile());
  globalThis.__archiveClient = class {
    async append({ part }) {
      remoteMachine.importJson(unframe(part.body));
      return { ok: true, result: {} };
    }
  };
  const replica = {
    flock: meta,
    client: {
      async append({ part }) {
        remoteMeta.importJson(unframe(part.body));
        return { ok: true, result: {} };
      },
    },
  };
  const grant = async () => ({ token: 't', gatewayBaseUrl: 'https://x' });
  await archiveSession(
    { workspaceId: 'w1', sessionId: 'root', archived: true },
    replica,
    new Map([['m1', machine]]),
    grant,
  );
  assert.equal(remoteMeta.get(['m', 'session-root', 'isArchived']), true);
  assert.equal(remoteMeta.get(['m', 'session-child', 'isArchived']), true);
  assert.equal(machine.get(['cmd', 'archiveSession', 'root']).v, 1);
  assert.equal(machine.get(['cmd', 'archiveSession', 'child']), undefined);
  await archiveSession(
    { workspaceId: 'w1', sessionId: 'root', archived: false },
    replica,
    new Map([['m1', machine]]),
    grant,
  );
  assert.equal(remoteMeta.get(['m', 'session-root', 'isArchived']), false);
  assert.equal(remoteMeta.get(['m', 'session-child', 'isArchived']), false);
  assert.equal(machine.get(['cmd', 'archiveSession', 'root']), undefined);
});

test('archive records needToArchiveSessions on machine meta', async () => {
  const meta = new Flock('meta'),
    remoteMeta = new Flock('remote-meta');
  meta.put(['e', 'session-s4'], true);
  meta.put(['e', 'machine-m1'], true);
  meta.put(['m', 'session-s4', 'id'], 's4');
  meta.put(['m', 'session-s4', 'machineId'], 'm1');
  meta.commit();
  remoteMeta.importFile(meta.exportFile());
  const replica = {
    flock: meta,
    client: {
      async append({ part }) {
        remoteMeta.importJson(unframe(part.body));
        return { ok: true, result: {} };
      },
    },
  };
  const grant = async () => ({ token: 't', gatewayBaseUrl: 'https://x' });
  await archiveSession(
    { workspaceId: 'w1', sessionId: 's4', archived: true },
    replica,
    new Map(),
    grant,
  );
  assert.deepEqual(
    remoteMeta.get(['m', 'machine-m1', 'needToArchiveSessions']),
    { s4: true },
  );
  await archiveSession(
    { workspaceId: 'w1', sessionId: 's4', archived: false },
    replica,
    new Map(),
    grant,
  );
  assert.deepEqual(
    remoteMeta.get(['m', 'machine-m1', 'needToArchiveSessions']),
    {},
  );
});

test('rename writes a user-directed title onto the session meta', async () => {
  const meta = new Flock('meta'),
    remoteMeta = new Flock('remote-meta');
  meta.set(['m', 'session-s1'], {
    id: 's1',
    machineId: 'm1',
    title: 'Old',
    titleSource: 'draft',
  });
  remoteMeta.importFile(meta.exportFile());
  const replica = {
    flock: meta,
    client: {
      async append({ part }) {
        remoteMeta.importJson(unframe(part.body));
        return { ok: true, result: {} };
      },
    },
  };
  await renameSession({ sessionId: 's1', title: '  New title  ' }, replica);
  assert.equal(remoteMeta.get(['m', 'session-s1', 'title']), 'New title');
  assert.equal(remoteMeta.get(['m', 'session-s1', 'titleSource']), 'user');
  assert.equal(meta.get(['m', 'session-s1']).id, 's1');
  await assert.rejects(
    renameSession({ sessionId: 'missing', title: 'X' }, replica),
    /session_not_found/,
  );
  await assert.rejects(
    renameSession({ sessionId: 's1', title: '   ' }, replica),
    /invalid_session/,
  );
  await assert.rejects(
    renameSession({ sessionId: 's1', title: 'x'.repeat(201) }, replica),
    /invalid_session/,
  );
});

test('changing the owner rewrites only SessionMeta.userId, never sharing', async () => {
  const meta = new Flock('owner'),
    remoteMeta = new Flock('owner-remote');
  meta.set(['m', 'session-s1'], {
    id: 's1',
    userId: 'alice',
    visibility: 'private',
  });
  meta.commit();
  remoteMeta.importFile(meta.exportFile());
  let fail = true;
  const replica = {
    flock: meta,
    client: {
      async append({ part }) {
        if (fail) throw new Error('offline');
        remoteMeta.importJson(unframe(part.body));
        return { ok: true, result: {} };
      },
    },
  };
  await assert.rejects(
    setSessionOwner({ sessionId: 's1', userId: 'bob' }, replica),
    /offline/,
  );
  fail = false;
  await setSessionOwner({ sessionId: 's1', userId: ' carol ' }, replica);
  assert.equal(remoteMeta.get(['m', 'session-s1', 'userId']), 'carol');
  assert.equal(remoteMeta.get(['m', 'session-s1']).visibility, 'private');
  await assert.rejects(
    setSessionOwner({ sessionId: 'missing', userId: 'bob' }, replica),
    /session_not_found/,
  );
  await assert.rejects(
    setSessionOwner({ sessionId: 's1', userId: '  ' }, replica),
    /invalid_session/,
  );
});

test('closing and reopening a Tab changes only that shared flag after acknowledgement', async () => {
  assert.equal(typeof setTabClosed, 'function');
  const flock = new Flock('tabs'),
    remote = new Flock('tabs-remote');
  for (const id of ['root', 'child']) {
    flock.set(['e', `session-${id}`], true);
    flock.set(['m', `session-${id}`], {
      id,
      isArchived: false,
      status: { type: 'running' },
      ...(id === 'child' ? { parentSessionId: 'root' } : {}),
    });
  }
  flock.commit();
  remote.importFile(flock.exportFile());
  let fail = true;
  const meta = {
    flock,
    client: {
      async append({ part }) {
        if (fail) throw Error('offline');
        remote.importJson(unframe(part.body));
        return { ok: true };
      },
    },
  };
  await assert.rejects(
    setTabClosed({ sessionId: 'root', closed: true }, meta),
    /offline/,
  );
  assert.equal(flock.get(['m', 'session-root', 'isTabClosed']), undefined);
  fail = false;
  await setTabClosed({ sessionId: 'root', closed: true }, meta);
  assert.equal(remote.get(['m', 'session-root', 'isTabClosed']), true);
  assert.equal(flock.get(['m', 'session-child', 'isTabClosed']), undefined);
  assert.equal(flock.get(['e', 'session-root']), true);
  assert.equal(flock.get(['m', 'session-root']).isArchived, false);
  assert.deepEqual(flock.get(['m', 'session-root']).status, {
    type: 'running',
  });
  await setTabClosed({ sessionId: 'root', closed: false }, meta);
  assert.equal(remote.get(['m', 'session-root', 'isTabClosed']), false);
  await assert.rejects(
    setTabClosed({ sessionId: 'missing', closed: true }, meta),
    /session_not_found/,
  );
});
