import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { META_ROOM, type RepoClient } from '@loro-dev/loro-repo-client';
import { connectEngine } from '@loro-dev/loro-repo-client/node';
import {
  ExternalMetadataNotCommittedError,
  LoroRepo,
  type JsonObject,
  type RepoEvent,
} from 'loro-repo';

const notCommitted = (reason: string) => new ExternalMetadataNotCommittedError(reason);
import { Flock } from '@loro-dev/flock-wasm';
import { createNativeFlockDocs } from '../src/node/native-flock-docs';
import {
  createDocRoom,
  createNativeDocs,
  createNativeRemoteHistoryPort,
  importLegacyDoc,
} from '../src/node/native-docs';
import { LoroDoc, LoroList, LoroMap, isContainer, type Container } from 'loro-crdt';
import { createHistoryWriter } from '../src/history-writer';
import { createSessionControlPlaneMirror } from '../src/session-control-plane';
import {
  createLoroSessionData,
  createRemoteControlState,
  createRemoteHistoryCommands,
  createRemoteLoroHistoryReader,
  readRemoteHistoryTranscript,
  readRemoteLatestGoal,
  selectTranscriptHistoryPositions,
  shareObservation,
  type SessionDataChange,
} from '../src/session-data';
import type { SessionHistory, SessionId } from '../src';
import {
  connectNativeRepo,
  importLegacyRoom,
  type LegacyFlockBundle,
} from '../src/node/native-repo';
import { createNativeWorkspaceMeta } from '../src/node/native-workspace-meta';
import { ScheduleRepository, type ScheduleRepositoryPort } from '../src/schedule-repository';
import { isNativeDocId } from '../src/native-workspace-meta-ipc';

const hostScript = fileURLToPath(new URL('./fixtures/native-repo-host.mjs', import.meta.url));
const launcher = () => ({ command: process.execPath, args: [hostScript] });
const ns = 'ws-native-meta';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

async function hostPid(dataDir: string) {
  return (JSON.parse(await readFile(join(dataDir, 'engine.json'), 'utf8')) as { pid: number }).pid;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function untilGone(pid: number) {
  while (alive(pid)) await new Promise((resolve) => setImmediate(resolve));
}
async function killHost(dataDir: string, signal: NodeJS.Signals) {
  const pid = await hostPid(dataDir);
  process.kill(pid, signal);
  await untilGone(pid);
}

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'lody-native-meta-'));
  const connection = await connectNativeRepo({ launcher, dataDir });
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  cleanups.push(() => killHost(dataDir, 'SIGTERM'));
  cleanups.push(() => connection.close());
  return { dataDir, connection };
}

/** A second process's connection (desktop main in production). */
async function peer(dataDir: string) {
  const client = await connectEngine(dataDir, { queueWhileReconnecting: false });
  cleanups.push(() => client.close());
  return client;
}

async function nativeRepo(client: RepoClient) {
  const meta = createNativeWorkspaceMeta(client, ns, notCommitted);
  const repo = await LoroRepo.createWithExternalMetadata<JsonObject>({}, meta);
  cleanups.push(() => meta.close());
  cleanups.push(() => repo.destroy());
  const events: RepoEvent<JsonObject>[] = [];
  repo.watch((event) => events.push(event));
  return { repo, events };
}

function nextEvent(
  events: RepoEvent<JsonObject>[],
  match: (event: RepoEvent<JsonObject>) => boolean
) {
  const start = events.length;
  return new Promise<RepoEvent<JsonObject>>((resolve) => {
    const poll = () => {
      const found = events.slice(start).find(match);
      if (found) resolve(found);
      else setImmediate(poll);
    };
    poll();
  });
}

async function legacyBundle() {
  // A real legacy Meta Flock: soft deletions, removed fields, an unknown field
  // and a named Flock with expiry.
  const legacy = await LoroRepo.create<JsonObject>({});
  await legacy.upsertDocMeta('session-a', { title: 'A', futureField: { nested: [1, 2] } });
  await legacy.upsertDocMeta('session-b', { title: 'B', pinned: true });
  await legacy.upsertDocMeta('session-b', { pinned: undefined });
  await legacy.upsertDocMeta('session-c', { title: 'C' });
  await legacy.deleteDoc('session-c');
  const flock = await legacy.openFlockDoc('ws:fi:one');
  flock.flock.put(['x'], 1);
  await legacy.persistFlockDocNow('ws:fi:one', flock.flock);
  const bundle = legacy.getMeta().exportJson() as LegacyFlockBundle;
  await legacy.destroy();
  return bundle;
}

describe('native Workspace Meta', () => {
  it('migrates legacy Meta losslessly and publishes once', async () => {
    const { connection } = await setup();
    const bundle = await legacyBundle();
    expect(
      await importLegacyRoom(connection.client, ns, META_ROOM, 'cli', async () => bundle)
    ).toBe('imported');
    // Registers keep their original clocks, tombstones included.
    const { registers } = await connection.client.flockReadRegisters(ns, META_ROOM);
    for (const [key, record] of Object.entries(bundle.entries)) {
      const register = registers.find((row) => JSON.stringify(row.key) === key);
      const clock = register?.clock;
      expect(`${clock?.physicalTime},${clock?.logicalCounter},${clock?.peerId}`).toBe(record.c);
      expect(register?.deleted).toBe(record.d === undefined);
    }
    const { repo } = await nativeRepo(connection.client);
    expect((await repo.getDocMeta('session-a'))?.meta).toEqual({
      title: 'A',
      futureField: { nested: [1, 2] },
    });
    expect((await repo.getDocMeta('session-b'))?.meta).toEqual({ title: 'B' });
    expect((await repo.getDocMeta('session-c'))?.deleted).toBe(true);
    expect((await repo.getFlockDoc('ws:fi:one'))?.deleted).toBe(false);
    // A published source is not imported again, even if its replica changed.
    expect(
      await importLegacyRoom(connection.client, ns, META_ROOM, 'cli', () => {
        throw new Error('must not load');
      })
    ).toBe('already-published');
  });

  it('shares one host between processes; one side closing leaves the other working', async () => {
    const { dataDir, connection } = await setup();
    const other = await peer(dataDir);
    const daemon = await nativeRepo(connection.client);
    const main = await nativeRepo(other);

    const seen = nextEvent(
      main.events,
      (e) => e.kind === 'doc-metadata' && e.docId === 'session-1'
    );
    await daemon.repo.upsertDocMeta('session-1', { title: 'from daemon' });
    expect(await seen).toMatchObject({ patch: { title: 'from daemon' }, by: 'sync' });
    // A write by the other side is visible to its own repo on return.
    await main.repo.upsertDocMeta('session-1', { lastReadAt: 5 });
    expect((await main.repo.getDocMeta('session-1'))?.meta).toEqual({
      title: 'from daemon',
      lastReadAt: 5,
    });

    await connection.close();
    await main.repo.deleteDoc('session-1');
    expect((await main.repo.getDocMeta('session-1'))?.deleted).toBe(true);
  });

  it('recovers every view from a new snapshot after the host crashes', async () => {
    const { dataDir, connection } = await setup();
    const daemon = await nativeRepo(connection.client);
    await daemon.repo.upsertDocMeta('session-1', { title: 'before' });

    const reconnected = new Promise<void>((resolve) => {
      const stop = connection.client.onConnectionStateChange((state) => {
        if (state === 'connected') {
          stop();
          resolve();
        }
      });
    });
    await killHost(dataDir, 'SIGKILL');
    // The connection relaunches the host itself; the old pid cannot return.
    await reconnected;
    const reset = nextEvent(daemon.events, (e) => e.kind === 'doc-metadata' && e.docId === 'x');
    // Another process writes against the relaunched host.
    const other = await peer(dataDir);
    const writer = createNativeWorkspaceMeta(other, ns, notCommitted);
    cleanups.push(() => writer.close());
    await writer.open(() => {});
    await writer.commit({ kind: 'upsert-doc', docId: 'x', patch: { title: 'after' } });
    await reset;
    expect((await daemon.repo.getDocMeta('session-1'))?.meta).toEqual({ title: 'before' });
    await daemon.repo.upsertDocMeta('session-1', { title: 'again' });
    expect((await daemon.repo.getDocMeta('session-1'))?.meta).toEqual({ title: 'again' });
  });

  it('applies concurrent field writes from two writers without losing either', async () => {
    const { dataDir, connection } = await setup();
    const a = createNativeWorkspaceMeta(connection.client, ns, notCommitted);
    const b = createNativeWorkspaceMeta(await peer(dataDir), ns, notCommitted);
    cleanups.push(
      () => a.close(),
      () => b.close()
    );
    await Promise.all([a.open(() => {}), b.open(() => {})]);
    await Promise.all([
      a.commit({ kind: 'upsert-doc', docId: 'd', patch: { left: 1 } }),
      b.commit({ kind: 'upsert-doc', docId: 'd', patch: { right: 2 } }),
      b.commit({ kind: 'ensure-doc', docId: 'd' }),
    ]);
    const { repo } = await nativeRepo(connection.client);
    expect((await repo.getDocMeta('d'))?.meta).toEqual({ left: 1, right: 2 });
  });

  it('keeps writes made by another process while a large view is still paging in', async () => {
    const { dataDir, connection } = await setup();
    const entries: LegacyFlockBundle['entries'] = {};
    for (let i = 0; i < 6000; i++) {
      const id = `doc-${i.toString().padStart(5, '0')}`;
      entries[JSON.stringify(['e', id])] = { c: `${1_000 + i},0,seed`, d: true };
      entries[JSON.stringify(['m', id, 'n'])] = { c: `${1_000 + i},1,seed`, d: 0 };
    }
    await importLegacyRoom(connection.client, ns, META_ROOM, 'seed', async () => ({
      version: 0,
      entries,
    }));
    const writer = createNativeWorkspaceMeta(await peer(dataDir), ns, notCommitted);
    cleanups.push(() => writer.close());
    await writer.open(() => {});
    // Writes race the paged load across several pages of the 12k-row room.
    const touched = ['doc-00000', 'doc-02999', 'doc-05999', 'doc-new'];
    const [{ repo }] = await Promise.all([
      nativeRepo(connection.client),
      (async () => {
        for (let round = 1; round <= 5; round++)
          for (const id of touched)
            await writer.commit({ kind: 'upsert-doc', docId: id, patch: { n: round } });
        await writer.commit({ kind: 'delete-doc', docId: 'doc-03000' });
      })(),
    ]);
    const settled = new Promise<void>((resolve) => {
      const check = async () => {
        const last = await repo.getDocMeta('doc-03000');
        if (last?.deleted) resolve();
        else setImmediate(() => void check());
      };
      void check();
    });
    await settled;
    for (const id of touched) expect((await repo.getDocMeta(id))?.meta).toEqual({ n: 5 });
    expect(repo.listDocSync().length).toBe(6001);
  });
});

describe('natively owned named Flock documents', () => {
  const CATALOG = 'ws:wf:workspace';
  const owner = (client: RepoClient) =>
    createNativeFlockDocs(
      client,
      ns,
      (id) => id === CATALOG,
      (file) => Flock.fromFile(file).exportJson()
    );
  const replica = async (client: RepoClient) => {
    const repo = await LoroRepo.create({ externalFlockDocs: owner(client) });
    cleanups.push(() => repo.destroy());
    return { repo, handle: await repo.openFlockDoc(CATALOG) };
  };
  const until = async (check: () => boolean) => {
    while (!check()) await new Promise((resolve) => setImmediate(resolve));
  };

  it('migrates the legacy body and converges a daemon and a renderer replica', async () => {
    const { dataDir, connection } = await setup();
    const legacy = new Flock('legacy');
    legacy.put(['mcpServer', 'a'], { name: 'a' });
    legacy.delete(['mcpServer', 'gone']);
    await importLegacyRoom(
      connection.client,
      ns,
      { kind: 'flock', id: CATALOG },
      'cli',
      async () => legacy.exportJson() as LegacyFlockBundle
    );
    const daemon = await replica(connection.client);
    const renderer = await replica(await peer(dataDir));
    expect(daemon.handle.flock.get(['mcpServer', 'a'])).toEqual({ name: 'a' });

    // Same key from both sides, plus one key each.
    daemon.handle.flock.put(['role', 'shared'], 'daemon');
    renderer.handle.flock.put(['role', 'shared'], 'renderer');
    daemon.handle.flock.put(['role', 'daemon'], 1);
    renderer.handle.flock.put(['role', 'renderer'], 2);
    await Promise.all([
      daemon.repo.persistFlockDocNow(CATALOG, daemon.handle.flock),
      renderer.repo.persistFlockDocNow(CATALOG, renderer.handle.flock),
    ]);
    const settled = (flock: Flock) =>
      flock.get(['role', 'daemon']) === 1 && flock.get(['role', 'renderer']) === 2;
    await until(() => settled(daemon.handle.flock) && settled(renderer.handle.flock));
    const native = Flock.fromFile(
      (await connection.client.exportFlockRaw(ns, { kind: 'flock', id: CATALOG })).bytes
    );
    const winner = native.get(['role', 'shared']);
    expect(['daemon', 'renderer']).toContain(winner);
    await until(
      () =>
        daemon.handle.flock.get(['role', 'shared']) === winner &&
        renderer.handle.flock.get(['role', 'shared']) === winner
    );
    expect(native.get(['role', 'daemon'])).toBe(1);
    expect(native.get(['role', 'renderer'])).toBe(2);
  });

  it('keeps a change pending while the host is down and commits it after relaunch', async () => {
    const { dataDir, connection } = await setup();
    const daemon = await replica(connection.client);
    const reconnected = new Promise<void>((resolve) => {
      const stop = connection.client.onConnectionStateChange((state) => {
        if (state === 'connected') {
          stop();
          resolve();
        }
      });
    });
    await killHost(dataDir, 'SIGKILL');
    daemon.handle.flock.put(['row'], 'offline');
    await expect(daemon.repo.persistFlockDocNow(CATALOG, daemon.handle.flock)).rejects.toThrow();
    expect(daemon.handle.flock.get(['row'])).toBe('offline');
    await reconnected;
    await daemon.repo.flush();
    const native = Flock.fromFile(
      (await connection.client.exportFlockRaw(ns, { kind: 'flock', id: CATALOG })).bytes
    );
    expect(native.get(['row'])).toBe('offline');
  });
});

describe('remote Session history reader', () => {
  const DOC = 'session-remote';
  const turn = (index: number, extra: Partial<SessionHistory> = {}): SessionHistory =>
    ({
      id: `turn-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      items: [{ type: 'text', text: `body ${index}` }],
      fileDiff: [],
      ...(index % 2 === 0
        ? { inputConfig: { prompt: 'secret prompt', agentRoleId: 'role-a', mcpServerIds: [] } }
        : { userTurnId: `turn-${index - 1}` }),
      ...extra,
    }) as SessionHistory;
  const until = async (check: () => boolean) => {
    while (!check()) await new Promise((resolve) => setImmediate(resolve));
  };

  /** The daemon's writing replica and a second process's remote reader. */
  async function open() {
    const { dataDir, connection } = await setup();
    const repo = await LoroRepo.create({
      externalDocs: createNativeDocs(connection.client, ns, (id) => id === DOC),
    });
    cleanups.push(() => repo.destroy());
    const { doc } = await repo.openPersistedDoc(DOC);
    const data = createLoroSessionData({ sessionId: 'remote' as SessionId, doc });
    const commit = () => repo.persistDocNow(DOC, doc);
    const port = createNativeRemoteHistoryPort(await peer(dataDir), ns, DOC);
    const remote = createRemoteLoroHistoryReader(port);
    return { data, commit, remote, port };
  }

  it('reads the latest page, turns and outputs as the in-process reader does', async () => {
    const { data, commit, remote } = await open();
    for (let i = 0; i < 90; i++) await data.commands.appendTurn(turn(i));
    await commit();
    const local = await data.history.readLatestDirectoryPage!(40);
    const page = await remote.readLatestDirectoryPage!(40);
    const facts = (rows: typeof page.rows) =>
      rows.map((row) => ({ ...row, inputConfig: row.inputConfig }));
    expect(facts(page.rows)).toEqual(facts(local.rows));
    expect(page).toMatchObject({ startPosition: 50, totalCount: 90, hasMoreOlder: true });
    // Directory rows carry the send configuration, never the prompt.
    expect(JSON.stringify(page.rows)).not.toContain('secret prompt');
    const older = await remote.readOlderDirectoryPage!(page.cursor!, 40);
    expect(older.rows.map((row) => row.turnId)).toEqual(
      Array.from({ length: 40 }, (_, i) => `turn-${10 + i}`)
    );
    expect(await remote.readTurn('turn-3')).toEqual(data.history.readTurn('turn-3'));
    expect(await remote.readTurn('turn-404')).toEqual({ state: 'missing' });
    expect(await remote.readTurnOutput('turn-88')).toEqual(data.history.readTurnOutput('turn-88'));
  });

  it('reads a whole directory past the page byte limit and the newest goal as the in-process reader does', async () => {
    const { data, commit, remote, port } = await open();
    const goal = (status: string) => ({
      type: 'goal',
      threadId: 'thread-1',
      turnId: null,
      objective: 'ship the release',
      status,
      tokenBudget: null,
      tokensUsed: 1,
      timeUsedSeconds: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(await readRemoteLatestGoal(port)).toBeNull();
    // Large configurations push one directory read past a single page's byte limit.
    const big = 'x'.repeat(8192);
    for (let i = 0; i < 400; i++)
      await data.commands.appendTurn(
        i === 41
          ? turn(i, { items: [goal('complete'), goal('active')] } as never)
          : turn(i, i % 2 === 0 ? ({ inputConfig: { agentRoleId: big } } as never) : {})
      );
    await commit();
    const whole = await remote.readDirectory(0, 400);
    expect(whole.map((row) => row.turnId)).toEqual(
      data.history.readDirectory(0, 400).map((row) => row.turnId)
    );
    // The goal sits ten pages back from the tail: the scan finds the newest item.
    expect(await readRemoteLatestGoal(port)).toEqual(data.readLatestGoal());
    expect(data.readLatestGoal()).toMatchObject({ status: 'active' });
  });

  it('selects the same visible transcript tail as the in-process history', async () => {
    const { data, commit, port } = await open();
    for (let i = 0; i < 120; i++)
      await data.commands.appendTurn(
        // Blank and image-only turns exercise the visibility rules.
        i % 7 === 0
          ? turn(i, { items: [{ type: 'text', text: '   ' }] } as never)
          : i % 11 === 0
            ? turn(i, {
                items: [
                  {
                    type: 'image',
                    imageId: 'synthetic-image',
                    mimeType: 'image/png',
                    sizeBytes: 9,
                  },
                ],
              } as never)
            : turn(i)
      );
    await commit();
    for (const options of [{ limit: 10 }, { limit: 500, reverse: true }]) {
      const local = selectTranscriptHistoryPositions(
        data.writer.readQuery({ transcriptVisibility: true }),
        options
      );
      const remote = await readRemoteHistoryTranscript(port, options);
      expect({ total: remote.total, positions: remote.positions }).toEqual(local);
      expect(remote.entries).toEqual(
        data.writer.readSelected(() => local.positions, { transcriptVisibility: true })
      );
    }
  });

  it('notifies appends structurally and field edits by turn id, never by content', async () => {
    const { data, commit, remote } = await open();
    for (let i = 0; i < 4; i++) await data.commands.appendTurn(turn(i));
    await commit();
    const changes: SessionDataChange[] = [];
    const observation = remote.observe((change) => changes.push(change));
    await observation.initial;
    await remote.readLatestDirectoryPage!(40);

    await data.commands.appendTurn(turn(4));
    await commit();
    await until(() => changes.some((change) => change.kind === 'structure'));
    // Establishing the observation notifies nothing; the append is the first change.
    expect(changes).toEqual([{ kind: 'structure', from: 4, to: 5 }]);

    await data.commands.applyHistoryAction({
      kind: 'user-status',
      turnId: 'turn-2',
      status: 'failed',
    });
    await commit();
    await until(() => changes.some((change) => change.kind === 'changed'));
    expect(changes.at(-1)).toEqual({ kind: 'changed', ids: ['turn-2'] });
    expect((await remote.readTurn('turn-2')).state).toBe('ready');
    observation.unsubscribe();
  });
});

describe('remote Session writes', () => {
  /** Container kind at every path, then the plain JSON, of a document. */
  const shape = (doc: LoroDoc) => {
    const kinds: Record<string, string> = {};
    const walk = (value: unknown, path: string) => {
      if (!isContainer(value)) return;
      const container = value as Container;
      kinds[path] = container.kind();
      if (container.kind() === 'Map') {
        const map = container as unknown as { keys(): string[]; get(k: string): unknown };
        for (const key of map.keys()) walk(map.get(key), `${path}.${key}`);
      } else if (container.kind() === 'List' || container.kind() === 'MovableList') {
        const list = container as unknown as { length: number; get(i: number): unknown };
        for (let i = 0; i < list.length; i++) walk(list.get(i), `${path}[${i}]`);
      }
    };
    const roots = doc.getShallowValue() as Record<string, unknown>;
    const json = doc.toJSON() as Record<string, unknown>;
    // A Mirror registers every control root when it opens; an empty one holds nothing.
    const empty = (value: unknown) =>
      value === undefined ||
      (Array.isArray(value) ? value.length === 0 : Object.keys(value as object).length === 0);
    for (const name of Object.keys(roots)) {
      if (empty(json[name])) continue;
      const kind = String(roots[name]).split(':').pop() ?? '';
      const root =
        kind === 'List'
          ? doc.getList(name)
          : kind === 'MovableList'
            ? doc.getMovableList(name)
            : kind === 'Text'
              ? doc.getText(name)
              : doc.getMap(name);
      walk(root, name);
    }
    return {
      kinds,
      json: Object.fromEntries(Object.entries(json).filter(([, value]) => !empty(value))),
    };
  };

  it('creates the containers the HistoryWriter and the control Mirror create', async () => {
    const { connection } = await setup();
    const client = connection.client;
    const turn = {
      id: 'u-1',
      role: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      status: 'pending',
      items: [{ type: 'text', text: 'hello' }],
      fileDiff: [],
      plan: [{ content: 'step', status: 'pending', priority: 'medium' }],
      inputConfig: { prompt: 'hello', agentRoleId: 'role-a', mcpServerIds: ['m'] },
    } as unknown as SessionHistory;
    const queued = {
      task: 'next',
      userId: 'local:me',
      timestamp: '2026-01-01T00:00:00Z',
      project: { kind: 'local', id: 'p' },
      acpSessionConfig: { prompt: 'next', cliType: 'codex', agentType: 'codex' },
    };

    // Reference: a local replica written by the HistoryWriter and the Mirror.
    const local = new LoroDoc();
    createHistoryWriter(local).append(turn);
    const mirror = createSessionControlPlaneMirror({
      doc: local,
      initialState: { session: { id: 'remote' } } as never,
    });
    mirror.setState((draft) => {
      draft.mq = [queued as never];
      draft.humanInputReceipts = { 'u-1': { userId: 'local:me' } } as never;
      draft.cancelRequest = { id: 'c-1', turnId: 'u-1' } as never;
    });
    local.commit();
    await createDocRoom(client, ns, 'session-reference');
    await client.importRoomState(
      ns,
      { kind: 'loro_doc', id: 'session-reference' },
      {
        snapshot: local.export({ mode: 'snapshot' }),
      }
    );

    // Remote: the same writes as JSON patches applied by the engine.
    await createDocRoom(client, ns, 'session-remote-writes');
    const room = { kind: 'loro_doc' as const, id: 'session-remote-writes' };
    await client.applyDocPatch(ns, room, [
      { op: 'arr_splice', path: ['history'], at: 0, del: 0, items: [turn as never] },
      { op: 'arr_splice', path: ['mq'], at: 0, del: 0, items: [queued as never] },
      { op: 'set', path: ['humanInputReceipts', 'u-1'], value: { userId: 'local:me' } },
      { op: 'set', path: ['cancelRequest', 'id'], value: 'c-1' },
      { op: 'set', path: ['cancelRequest', 'turnId'], value: 'u-1' },
    ]);

    const load = async (id: string) =>
      LoroDoc.fromSnapshot((await client.exportLoroRaw(ns, { kind: 'loro_doc', id })).bytes);
    const reference = shape(await load('session-reference'));
    const remote = shape(await load('session-remote-writes'));
    expect(remote.kinds).toEqual(reference.kinds);
    expect(remote.json).toEqual(reference.json);
  });

  const CONTROL_ROOTS = ['mq', 'humanInputReceipts', 'cancelRequest'] as const;
  type Control = Record<(typeof CONTROL_ROOTS)[number], unknown>;
  const until = async (check: () => boolean) => {
    while (!check()) await new Promise((resolve) => setImmediate(resolve));
  };

  /** The daemon's writing replica plus two renderer-side remote views. */
  async function openRemote(docId: string) {
    const { dataDir, connection } = await setup();
    const repo = await LoroRepo.create({
      externalDocs: createNativeDocs(connection.client, ns, (id) => id === docId),
    });
    cleanups.push(() => repo.destroy());
    const { doc } = await repo.openPersistedDoc(docId);
    const daemon = {
      doc,
      data: createLoroSessionData({ sessionId: 'remote' as SessionId, doc }),
      mirror: createSessionControlPlaneMirror({
        doc,
        initialState: { session: { id: 'remote' } } as never,
      }),
      commit: () => repo.persistDocNow(docId, doc),
    };
    const view = async () => {
      const port = shareObservation(createNativeRemoteHistoryPort(await peer(dataDir), ns, docId));
      const control = createRemoteControlState<Control>(port, CONTROL_ROOTS, {} as Control);
      cleanups.push(async () => control.close());
      await control.ready;
      return { port, control, commands: createRemoteHistoryCommands(port) };
    };
    return { daemon, a: await view(), b: await view() };
  }

  it('queues, edits, reorders and removes control rows by identity across replicas', async () => {
    const { daemon, a, b } = await openRemote('session-control');
    const item = (task: string) => ({
      task,
      userId: 'local:me',
      timestamp: '2026-01-01T00:00:00Z',
      acpSessionConfig: { prompt: task, cliType: 'codex', agentType: 'codex' },
    });
    const mq = (state: Control) => (state.mq ?? []) as { $cid?: string; task: string }[];
    await a.control.update((draft) => {
      draft.mq = [...mq(draft), item('one'), item('two')];
      draft.humanInputReceipts = { 'u-1': { userId: 'local:me' } };
    });
    await until(() => mq(b.control.getState()).length === 2);
    const [one, two] = mq(b.control.getState());
    expect(one?.$cid).toEqual(expect.any(String));

    // The daemon's Mirror sees the same rows, with the same identities.
    await until(() => (daemon.mirror.getState().mq ?? []).length === 2);
    expect(daemon.mirror.getState().mq?.map((row) => row.$cid)).toEqual([one!.$cid, two!.$cid]);

    // B edits and reorders by identity while the daemon pops a row concurrently.
    daemon.mirror.setState((draft) => {
      draft.mq = (draft.mq ?? []).filter((row) => row.$cid !== one!.$cid);
    });
    daemon.doc.commit();
    await daemon.commit();
    await b.control.update((draft) => {
      draft.mq = mq(draft)
        .map((row) => (row.$cid === two!.$cid ? { ...row, task: 'two (edited)' } : row))
        .concat([item('three') as never]);
    });
    await until(
      () =>
        JSON.stringify(mq(a.control.getState()).map((row) => row.task)) ===
        JSON.stringify(['two (edited)', 'three'])
    );
    expect(daemon.mirror.getState().humanInputReceipts).toEqual({ 'u-1': { userId: 'local:me' } });
  });

  it('appends, edits and answers turns with the writer planners under concurrent writes', async () => {
    const { daemon, a } = await openRemote('session-history');
    await daemon.data.commands.appendTurn({
      id: 'u-1',
      role: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      status: 'pending',
      items: [{ type: 'text', text: 'hi' }],
      fileDiff: [],
    } as never);
    await daemon.data.commands.appendTurn({
      id: 'a-1',
      role: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      userTurnId: 'u-1',
      items: [
        { type: 'text', text: 'working' },
        {
          type: 'tool_call',
          toolCallId: 'tc-1',
          title: 'Run',
          status: 'pending',
          permissionRequest: { requestId: 'p-1', options: [] },
        },
      ],
      fileDiff: [],
    } as never);
    await daemon.commit();

    // The daemon keeps writing while the renderer answers the request: each of
    // its commits moves the head, so the renderer's conditional edit retries.
    const writing = (async () => {
      for (let i = 0; i < 10; i++) {
        await daemon.data.commands.appendTurn({
          id: `n-${i}`,
          role: 'assistant',
          timestamp: '2026-01-01T00:00:00Z',
          items: [{ type: 'text', text: `note ${i}` }],
          fileDiff: [],
        } as never);
        await daemon.commit();
      }
    })();
    const answered = await a.commands.respondPermission(
      'p-1',
      { outcome: 'selected', optionId: 'allow' } as never,
      { turnId: 'a-1' }
    );
    await writing;
    expect(answered).toBe(true);

    await a.commands.appendTurn({
      id: 'u-2',
      role: 'user',
      timestamp: '2026-01-01T00:00:01Z',
      status: 'pending',
      items: [{ type: 'text', text: 'next' }],
      fileDiff: [],
    } as never);
    await a.commands.applyHistoryAction({
      kind: 'user-status',
      turnId: 'u-2',
      status: 'processing',
    } as never);

    await until(() => daemon.data.history.count() === 13);
    const answer = daemon.data.history.readTurn('a-1');
    expect(answer.state).toBe('ready');
    const tool = (
      answer as { turn: { items: { permissionRequest?: { outcome?: unknown } }[] } }
    ).turn.items.find((item) => item.permissionRequest);
    expect(tool?.permissionRequest?.outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
    await until(() => {
      const read = daemon.data.history.readTurn('u-2');
      return read.state === 'ready' && read.turn.status === 'processing';
    });
  });

  it('writes the same history as the HistoryWriter for every renderer command', async () => {
    // Differential guard: the remote commands re-apply the writer's planners as
    // patches, so the same command sequence must leave the same stored history,
    // containers, results and refusals as the HistoryWriter on a local replica.
    const { connection } = await setup();
    await createDocRoom(connection.client, ns, 'session-parity');
    const port = createNativeRemoteHistoryPort(connection.client, ns, 'session-parity');
    const remote = createRemoteHistoryCommands(port);
    const doc = new LoroDoc();
    const local = createLoroSessionData({ sessionId: 'parity' as SessionId, doc }).commands;
    const user = (id: string, text: string, extra: object = {}) =>
      ({
        id,
        role: 'user',
        timestamp: '2026-01-01T00:00:00Z',
        status: 'pending',
        items: [{ type: 'text', text }],
        fileDiff: [],
        inputConfig: { prompt: text, mcpServerIds: [], configOptionValues: { effort: 'high' } },
        ...extra,
      }) as never;
    const steps: [string, (c: typeof local) => Promise<unknown>][] = [
      ['append user', (c) => c.appendTurn(user('u-1', 'hello'))],
      [
        'append assistant with a request',
        (c) =>
          c.appendTurn({
            id: 'a-1',
            role: 'assistant',
            timestamp: '2026-01-01T00:00:00Z',
            userTurnId: 'u-1',
            items: [
              { type: 'text', text: 'working' },
              {
                type: 'tool_call',
                toolCallId: 'tc-1',
                title: 'Run',
                status: 'pending',
                permissionRequest: { requestId: 'p-1', options: [] },
              },
            ],
            plan: [{ content: 'step', status: 'pending', priority: 'medium' }],
            fileDiff: [],
          } as never),
      ],
      ['replace user', (c) => c.replaceTurn('u-1', user('u-1', 'hello again', { read: true }))],
      [
        'answer request',
        (c) =>
          c.respondPermission('p-1', { outcome: 'selected', optionId: 'allow' } as never, {
            turnId: 'a-1',
          }),
      ],
      [
        'answer again (never overwrites)',
        (c) => c.respondPermission('p-1', { outcome: 'cancelled' } as never),
      ],
      [
        'answer an unknown request',
        (c) => c.respondPermission('p-404', { outcome: 'cancelled' } as never),
      ],
      [
        'status processing',
        (c) =>
          c.applyHistoryAction({
            kind: 'user-status',
            turnId: 'u-1',
            status: 'processing',
          } as never),
      ],
      [
        'guarded status refused once started',
        (c) =>
          c.applyHistoryAction({
            kind: 'user-status',
            turnId: 'u-1',
            status: 'canceled',
            onlyAwaitingStart: true,
          } as never),
      ],
      ['duplicate copy', (c) => c.appendTurn(user('u-1', 'copy'))],
      [
        'status of every copy',
        (c) =>
          c.applyHistoryAction({
            kind: 'user-status',
            turnId: 'u-1',
            status: 'completed',
          } as never),
      ],
      ['invalid append', (c) => c.appendTurn({ id: 'bad', role: 'user', items: 'nope' } as never)],
      ['replace missing', (c) => c.replaceTurn('nope', user('nope', 'x'))],
    ];
    const outcome = async (run: () => Promise<unknown>) => {
      try {
        return { ok: await run() };
      } catch (error) {
        return { error: (error as Error).name };
      }
    };
    for (const [label, step] of steps) {
      const a = await outcome(() => step(local));
      const b = await outcome(() => step(remote as never));
      expect({ label, result: b }).toEqual({ label, result: a });
    }
    const stored = LoroDoc.fromSnapshot(
      (await connection.client.exportLoroRaw(ns, { kind: 'loro_doc', id: 'session-parity' })).bytes
    );
    expect(shape(stored)).toEqual(shape(doc));
  });
});

describe('natively owned Schedule documents', () => {
  it('writes a Schedule in one replica and reads it in another through the same owner', async () => {
    const { dataDir, connection } = await setup();
    const rows = new Map<string, unknown>();
    /** One process's repository over its own connection; the registry rows are shared. */
    const open = async (client: RepoClient) => {
      const repo = await LoroRepo.create({
        externalDocs: createNativeDocs(client, ns, isNativeDocId),
      });
      cleanups.push(() => repo.destroy());
      const opened = new Map<string, LoroDoc>();
      const port: ScheduleRepositoryPort = {
        openPersistedDoc: async (id) => {
          const { doc } = await repo.openPersistedDoc(id);
          opened.set(id, doc);
          return { doc };
        },
        openFlockDoc: async () => ({
          flock: {
            scan: () => [...rows].map(([key, value]) => ({ key: JSON.parse(key), value })),
            get: (key) => rows.get(JSON.stringify(key)),
            set: (key, value) => rows.set(JSON.stringify(key), value),
          },
        }),
        flush: async () => {
          for (const [id, doc] of opened) await repo.persistDocNow(id, doc);
        },
      };
      return new ScheduleRepository(port, ns as never);
    };
    const daemon = await open(connection.client);
    const saved = await daemon.save({
      scheduleId: 'native',
      draft: {
        title: 'Nightly',
        machineId: 'machine',
        trigger: { kind: 'interval', everyMs: 60_000, anchorAt: '2026-01-01T00:00:00Z' },
        agent: { agentConfigId: 'agent', modeId: 'safe' },
        misfirePolicy: { kind: 'skip' },
        overlapPolicy: 'queue_one',
        retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
        prompt: 'summarize the day',
      },
      actorId: 'owner',
      now: 1,
      activationId: 'activation',
      activityId: 'created',
      create: true,
    });
    const desktop = await open(await peer(dataDir));
    expect(await desktop.read('native')).toEqual(saved);
    // The engine holds the document the Mirror wrote, readable by root without a replica.
    const stored = LoroDoc.fromSnapshot(
      (await connection.client.exportLoroRaw(ns, { kind: 'loro_doc', id: 'schedule-native' })).bytes
    );
    expect(stored.getText('prompt').toString()).toBe('summarize the day');
  });
});

describe('natively owned Preview comment documents', () => {
  it('imports a replica the owning process never opens, then serves it to a renderer replica', async () => {
    const { dataDir, connection } = await setup();
    const docId = 'preview-comment-session-1';
    // The CLI's legacy copy: renderer-authored comments it only relayed.
    const legacy = new LoroDoc();
    legacy.getMap('meta').set('sessionId', 'session-1');
    const turn = legacy.getMap('turns').setContainer('turn-1', new LoroMap());
    turn.set('turnId', 'turn-1');
    const comment = turn.setContainer('comments', new LoroList()).insertContainer(0, new LoroMap());
    comment.set('id', 'comment-1');
    comment.set('body', 'tighten the header');
    legacy.commit();
    const load = async () => ({
      snapshot: legacy.export({ mode: 'snapshot' }),
      version: Object.fromEntries(legacy.oplogVersion().toJSON()),
    });
    expect(await importLegacyDoc(connection.client, ns, docId, 'cli-sqlite', load)).toBe(
      'imported'
    );
    expect(await importLegacyDoc(connection.client, ns, docId, 'cli-sqlite', load)).toBe(
      'already-published'
    );

    const renderer = await LoroRepo.create({
      externalDocs: createNativeDocs(await peer(dataDir), ns, isNativeDocId),
    });
    cleanups.push(() => renderer.destroy());
    const { doc } = await renderer.openPersistedDoc(docId);
    expect(doc.toJSON()).toEqual(legacy.toJSON());
  });
});
