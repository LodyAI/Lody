import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroDoc } from 'loro-crdt';
import { afterEach, describe, expect, it } from 'vitest';
import { createBundleWriter, openBundle } from './bundle-file';
import { classifyRoom } from './codecs';
import { exportWorkspaceBundle } from './export';
import { openTestRepo, writeDoc, writeFlock, type TestRepo } from './test-support';

const WS = 'ws_a';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function repoWithData(): Promise<TestRepo> {
  const test = await openTestRepo();
  cleanup.push(() => fs.rm(test.dir, { recursive: true, force: true }));
  cleanup.push(() => test.close());
  const { repo } = test;
  await writeDoc(repo, 'session-s1', { title: 'One' }, (doc) => doc.getText('t').insert(0, 'hi'));
  await writeDoc(repo, 'session-gone', { title: 'Gone' }, (doc) => doc.getMap('m').set('a', 1));
  await repo.deleteDoc('session-gone');
  await writeDoc(repo, 'session-r1', { title: 'Roost', historyBackend: 'roost' }, (doc) =>
    doc.getMap('session').set('id', 'r1')
  );
  await writeDoc(repo, 'schedule-x', { kind: 'schedule' }, (doc) =>
    doc.getText('prompt').insert(0, 'p')
  );
  await writeDoc(repo, 'today-u-2026-11-20', { userId: 'u', date: '2026-11-20' }, (doc) =>
    doc.getTree('outline').createNode()
  );
  await writeDoc(repo, 'mystery-1', {}, (doc) => doc.getMap('m').set('a', 1));
  // Machine records keep all fields in Meta and have no document body.
  await repo.upsertDocMeta('machine-m1', { name: 'M' });
  await writeFlock(repo, `${WS}:wf:workspace`, (flock) => {
    flock.put(['project', 'p1'], { name: 'P' });
    flock.put(['project', 'p2'], { name: 'Q' });
    flock.delete(['project', 'p2']);
  });
  await writeFlock(repo, `${WS}:sr`, (flock) => flock.put(['schedule', 'x'], { on: true }));
  await writeFlock(repo, `${WS}:mf:m1`, (flock) => flock.put(['localProject', 'a'], { p: 1 }));
  await writeFlock(repo, `${WS}:fi:s1`, (flock) => flock.put(['f'], 1));
  await repo.flush();
  return test;
}

describe('exportWorkspaceBundle', () => {
  it('exports raw rooms with deletion records and clocks, and reports gaps', async () => {
    const test = await repoWithData();
    const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'lody-export-')), 'w.lodybundle');
    cleanup.push(() => fs.rm(path.dirname(out), { recursive: true, force: true }));
    const writer = await createBundleWriter(out);
    const manifest = await exportWorkspaceBundle({
      repo: test.repo,
      workspaceId: WS,
      writer,
      source: {
        workspaceId: WS,
        exporterUserId: 'u',
        exporterMachineId: 'm',
        lodyVersion: 't',
        startedAt: 'a',
      },
    });

    const ids = manifest.rooms.map((room) => room.id).sort();
    expect(ids).toEqual(
      [
        'meta',
        'schedule-x',
        'session-r1',
        'today-u-2026-11-20',
        'session-s1',
        `${WS}:mf:m1`,
        `${WS}:sr`,
        `${WS}:wf:workspace`,
      ].sort()
    );
    expect(manifest.gaps).toEqual(
      expect.arrayContaining([
        { id: 'mystery-1', kind: 'unknown', reason: 'Unknown document kind' },
        { id: 'session-r1', kind: 'roost', reason: expect.stringContaining('Roost') },
      ])
    );
    expect(manifest.gaps.map((gap) => gap.id)).not.toContain('machine-m1');

    const bundle = await openBundle(out);
    cleanup.push(() => bundle.close());
    const room = (id: string) => {
      const entry = manifest.rooms.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(id);
      return bundle.readRoom(entry);
    };

    const doc = new LoroDoc();
    doc.import(await room('session-s1'));
    expect(doc.getText('t').toString()).toBe('hi');

    const catalog = Flock.fromFile(await room(`${WS}:wf:workspace`));
    expect(catalog.get(['project', 'p1'])).toEqual({ name: 'P' });
    const tombstone = catalog.getEntry(['project', 'p2']);
    expect(tombstone).toBeDefined();
    expect(tombstone?.data).toBeUndefined();
    const live = test.repo.getMeta();
    const meta = Flock.fromFile(await room('meta'));
    expect(meta.version()).toEqual(live.version());
  });

  it('records rooms the exporter cannot read as gaps and keeps going', async () => {
    const test = await repoWithData();
    const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'lody-export-')), 'w.lodybundle');
    cleanup.push(() => fs.rm(path.dirname(out), { recursive: true, force: true }));
    const manifest = await exportWorkspaceBundle({
      repo: test.repo,
      workspaceId: WS,
      writer: await createBundleWriter(out),
      source: {
        workspaceId: WS,
        exporterUserId: 'u',
        exporterMachineId: 'm',
        lodyVersion: 't',
        startedAt: 'a',
      },
      prepareRoom: async (roomId) => {
        if (roomId === 'schedule-x') throw new Error('forbidden');
      },
    });
    expect(manifest.rooms.map((room) => room.id)).not.toContain('schedule-x');
    expect(manifest.rooms.map((room) => room.id)).toContain('session-s1');
    expect(manifest.gaps).toContainEqual({
      id: 'schedule-x',
      kind: 'unreadable',
      reason: 'forbidden',
    });
  });
});
