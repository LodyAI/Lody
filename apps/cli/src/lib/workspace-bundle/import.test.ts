import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBundleWriter, openBundle, type OpenBundle } from './bundle-file';
import { exportWorkspaceBundle } from './export';
import { applyWorkspaceImport, ImportRefusedError, planWorkspaceImport } from './import';
import { openTestRepo, writeDoc, writeFlock, type TestRepo } from './test-support';

const WS = 'ws_a';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-import-'));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function repo(): Promise<TestRepo> {
  const test = await openTestRepo(await tempDir());
  cleanup.push(() => test.close());
  return test;
}

async function sourceBundle(): Promise<OpenBundle> {
  const source = await repo();
  await writeDoc(source.repo, 'session-s1', { title: 'One' }, (doc) => doc.getText('t').insert(0, 'hi'));
  await writeDoc(source.repo, 'schedule-x', { kind: 'schedule' }, (doc) =>
    doc.getText('prompt').insert(0, 'p')
  );
  await writeFlock(source.repo, `${WS}:wf:workspace`, (flock) => {
    flock.put(['project', 'p1'], { name: 'P' });
    flock.put(['project', 'p2'], { name: 'Q' });
    flock.delete(['project', 'p2']);
  });
  await source.repo.flush();
  const out = path.join(await tempDir(), 'b.lodybundle');
  await exportWorkspaceBundle({
    repo: source.repo,
    workspaceId: WS,
    writer: await createBundleWriter(out),
    source: { workspaceId: WS, exporterUserId: 'u', exporterMachineId: 'm', lodyVersion: 't', startedAt: 'a' },
  });
  const bundle = await openBundle(out);
  cleanup.push(() => bundle.close());
  return bundle;
}

const owner = { workspaceId: WS, role: 'owner', actorUserId: 'owner-1' } as const;

async function importAll(bundle: OpenBundle, target: TestRepo, journalPath: string) {
  const plan = await planWorkspaceImport({ bundle, repo: target.repo, ...owner });
  return { plan, result: await applyWorkspaceImport({ plan, bundle, repo: target.repo, journalPath }) };
}

describe('workspace import', () => {
  it('merges a bundle into an empty workspace and survives a restart', async () => {
    const bundle = await sourceBundle();
    const dir = await tempDir();
    const target = await openTestRepo(dir);
    const { plan } = await importAll(bundle, target, path.join(dir, 'journal.json'));
    expect(plan.rooms.find((room) => room.id === 'session-s1')).toMatchObject({ action: 'merge', state: 'new' });
    await target.close();

    const reopened = await openTestRepo(dir);
    cleanup.push(() => reopened.close());
    const sessions = await reopened.repo.listDoc();
    expect(sessions.find((entry) => entry.docId === 'session-s1')).toMatchObject({
      deleted: false,
      meta: { title: 'One' },
    });
    const doc = await reopened.repo.openDetachedDoc('session-s1');
    expect(doc.getText('t').toString()).toBe('hi');
    const catalog = await reopened.repo.openDetachedFlockDoc(`${WS}:wf:workspace`);
    expect(catalog.get(['project', 'p1'])).toEqual({ name: 'P' });
    expect(catalog.getEntry(['project', 'p2'])).toBeDefined();
  });

  it('plans without writing, and a repeated import changes nothing', async () => {
    const bundle = await sourceBundle();
    const target = await repo();
    const before = target.repo.getMeta().version();
    const plan = await planWorkspaceImport({ bundle, repo: target.repo, ...owner });
    expect(plan.rooms.length).toBeGreaterThan(0);
    expect(target.repo.getMeta().version()).toEqual(before);
    expect(await target.repo.listDoc()).toEqual([]);

    const journal = path.join(await tempDir(), 'j.json');
    await applyWorkspaceImport({ plan, bundle, repo: target.repo, journalPath: journal });
    const afterFirst = target.repo.getMeta().version();
    const again = await planWorkspaceImport({ bundle, repo: target.repo, ...owner });
    expect(again.rooms.every((room) => room.state === 'unchanged')).toBe(true);
    await applyWorkspaceImport({
      plan: again,
      bundle,
      repo: target.repo,
      journalPath: path.join(await tempDir(), 'j2.json'),
    });
    expect(target.repo.getMeta().version()).toEqual(afterFirst);
  });

  it('keeps a deletion made in the target after the first import', async () => {
    const bundle = await sourceBundle();
    const target = await repo();
    await importAll(bundle, target, path.join(await tempDir(), 'j.json'));
    await target.repo.deleteDoc('session-s1');
    const { plan } = await importAll(bundle, target, path.join(await tempDir(), 'j2.json'));
    expect(plan.rooms.find((room) => room.id === 'session-s1')).toMatchObject({ action: 'skip' });
    const entry = (await target.repo.listDoc()).find((doc) => doc.docId === 'session-s1');
    expect(entry?.deleted).toBe(true);
  });

  it('skips a same-ID session with no shared history and leaves it untouched', async () => {
    const bundle = await sourceBundle();
    const target = await repo();
    await writeDoc(target.repo, 'session-s1', { title: 'Mine' }, (doc) => doc.getText('t').insert(0, 'mine'));
    const { plan } = await importAll(bundle, target, path.join(await tempDir(), 'j.json'));
    expect(plan.rooms.find((room) => room.id === 'session-s1')).toMatchObject({
      action: 'skip',
      reason: 'unrelated-same-id',
    });
    const doc = await target.repo.openDetachedDoc('session-s1');
    expect(doc.getText('t').toString()).toBe('mine');
    expect((await target.repo.getDocMeta('session-s1'))?.meta).toMatchObject({ title: 'Mine' });
    expect(plan.rooms.find((room) => room.id === 'schedule-x')).toMatchObject({ action: 'merge' });
  });

  it('refuses members and bundles with unknown codecs', async () => {
    const bundle = await sourceBundle();
    const target = await repo();
    await expect(
      planWorkspaceImport({ bundle, repo: target.repo, workspaceId: WS, role: 'member', actorUserId: 'm-1' })
    ).rejects.toBeInstanceOf(ImportRefusedError);

    const out = path.join(await tempDir(), 'odd.lodybundle');
    const writer = await createBundleWriter(out);
    await writer.addRoom({ id: 'x-1', model: 'loro', codec: 'odd/v9', encoding: 'loro-snapshot/v1' }, new Uint8Array([1]));
    await writer.finish({
      workspaceId: WS,
      exporterUserId: 'u',
      exporterMachineId: 'm',
      lodyVersion: 't',
      startedAt: 'a',
      finishedAt: 'b',
    });
    const odd = await openBundle(out);
    cleanup.push(() => odd.close());
    await expect(planWorkspaceImport({ bundle: odd, repo: target.repo, ...owner })).rejects.toThrow(/odd\/v9/);
  });

  it('resumes after an interruption and ends in the same state', async () => {
    const bundle = await sourceBundle();
    const target = await repo();
    const journal = path.join(await tempDir(), 'j.json');
    const plan = await planWorkspaceImport({ bundle, repo: target.repo, ...owner });
    let rooms = 0;
    await expect(
      applyWorkspaceImport({
        plan,
        bundle,
        repo: target.repo,
        journalPath: journal,
        checkContinue: async () => {
          rooms += 1;
          if (rooms === 2) throw new Error('revoked');
        },
      })
    ).rejects.toThrow('revoked');
    // Meta is last: an interrupted import has not merged any source metadata yet.
    for (const entry of await target.repo.listDoc()) expect(entry.meta).toEqual({});
    const result = await applyWorkspaceImport({ plan, bundle, repo: target.repo, journalPath: journal });
    expect(result.resumed).toBeGreaterThan(0);
    expect((await target.repo.getDocMeta('session-s1'))?.meta).toMatchObject({ title: 'One' });
  });

  it('maps a bundle from another workspace without machines and stops imported work', async () => {
    const source = await repo();
    await writeDoc(source.repo, 'session-s1', { title: 'One', latestUserMsgId: 'u1' }, (doc) => {
      doc.getText('t').insert(0, 'hi');
      doc.getMovableList('mq').push('queued');
    });
    await writeDoc(source.repo, 'schedule-x', { kind: 'schedule' }, (doc) =>
      doc.getMap('definition').set('enabled', true)
    );
    await writeDoc(source.repo, 'machine-m1', { name: 'M' }, (doc) => doc.getMap('m').set('a', 1));
    await writeFlock(source.repo, `${WS}:wf:workspace`, (flock) => flock.put(['project', 'p1'], { name: 'P' }));
    await writeFlock(source.repo, `${WS}:mf:m1`, (flock) => flock.put(['localProject', 'a'], { p: 1 }));
    await writeFlock(source.repo, `${WS}:sr`, (flock) => {
      flock.put(['schedule', 'x'], { on: true });
      flock.put(['runtime', 'x', 'm1'], { next: 1 });
    });
    await source.repo.flush();
    const out = path.join(await tempDir(), 'a.lodybundle');
    await exportWorkspaceBundle({
      repo: source.repo,
      workspaceId: WS,
      writer: await createBundleWriter(out),
      source: { workspaceId: WS, exporterUserId: 'u', exporterMachineId: 'm', lodyVersion: 't', startedAt: 'a' },
    });
    const bundle = await openBundle(out);
    cleanup.push(() => bundle.close());

    const target = await repo();
    const plan = await planWorkspaceImport({ bundle, repo: target.repo, workspaceId: 'ws_b', role: 'admin', actorUserId: 'admin-1' });
    expect(plan.rooms.find((room) => room.id === `${WS}:wf:workspace`)).toMatchObject({
      targetId: 'ws_b:wf:workspace',
      action: 'merge',
    });
    expect(plan.rooms.find((room) => room.id === `${WS}:mf:m1`)).toMatchObject({ action: 'skip', reason: 'machine-room' });
    expect(plan.rooms.find((room) => room.id === 'machine-m1')).toMatchObject({ action: 'skip', reason: 'machine-room' });
    const journal = path.join(await tempDir(), 'j.json');
    await applyWorkspaceImport({
      plan,
      bundle,
      repo: target.repo,
      journalPath: journal,
      actor: { userId: 'admin-1' },
      now: () => '2026-11-19T00:00:00.000Z',
    });

    const flocks = (await target.repo.listFlockDoc()).map((entry) => entry.flockDocId).sort();
    expect(flocks).toEqual(['ws_b:sr', 'ws_b:wf:workspace']);
    const docs = (await target.repo.listDoc()).map((entry) => entry.docId).sort();
    expect(docs).toEqual(['schedule-x', 'session-s1']);
    const catalog = await target.repo.openDetachedFlockDoc('ws_b:wf:workspace');
    expect(catalog.get(['project', 'p1'])).toEqual({ name: 'P' });
    expect(catalog.get(['importReceipt', bundle.manifest.digest])).toMatchObject({
      actorUserId: 'admin-1',
      sourceWorkspaceId: WS,
      importedAt: '2026-11-19T00:00:00.000Z',
    });
    const registry = await target.repo.openDetachedFlockDoc('ws_b:sr');
    expect(registry.get(['schedule', 'x'])).toEqual({ on: true });
    expect(registry.get(['runtime', 'x', 'm1'])).toBeUndefined();

    const meta = (await target.repo.getDocMeta('session-s1'))?.meta;
    expect(meta).toMatchObject({ title: 'One', collaborationStopped: true, status: { type: 'idle' } });
    expect(meta).not.toHaveProperty('latestUserMsgId');
    const session = await target.repo.openDetachedDoc('session-s1');
    expect(session.getMovableList('mq').length).toBe(0);
    expect(session.getText('t').toString()).toBe('hi');
    const schedule = await target.repo.openDetachedDoc('schedule-x');
    expect(schedule.getMap('definition').get('enabled')).toBe(false);

    const again = await planWorkspaceImport({ bundle, repo: target.repo, workspaceId: 'ws_b', role: 'admin', actorUserId: 'admin-1' });
    expect(again.rooms.filter((room) => room.action === 'merge').every((room) => room.state === 'unchanged')).toBe(true);
  });

  it("rejects a room that changes another member's Role, and imports the rest", async () => {
    const source = await repo();
    await writeDoc(source.repo, 'session-s1', { title: 'One' }, (doc) => doc.getText('t').insert(0, 'hi'));
    await writeFlock(source.repo, `${WS}:wf:workspace`, (flock) =>
      flock.put(['agentRole', 'r1'], { name: 'Reviewer', ownerUserId: 'other' })
    );
    await source.repo.flush();
    const exportTo = async (name: string) => {
      const out = path.join(await tempDir(), name);
      await exportWorkspaceBundle({
        repo: source.repo,
        workspaceId: WS,
        writer: await createBundleWriter(out),
        source: { workspaceId: WS, exporterUserId: 'u', exporterMachineId: 'm', lodyVersion: 't', startedAt: 'a' },
      });
      const opened = await openBundle(out);
      cleanup.push(() => opened.close());
      return opened;
    };
    const target = await repo();
    const first = await exportTo('1.lodybundle');
    await applyWorkspaceImport({
      plan: await planWorkspaceImport({ bundle: first, repo: target.repo, ...owner, actorUserId: 'admin-1' }),
      bundle: first,
      repo: target.repo,
      journalPath: path.join(await tempDir(), 'j.json'),
    });

    await writeFlock(source.repo, `${WS}:wf:workspace`, (flock) =>
      flock.put(['agentRole', 'r1'], { name: 'Hijacked', ownerUserId: 'other' })
    );
    await writeDoc(source.repo, 'session-s1', { title: 'One' }, (doc) => doc.getText('t').insert(2, '!'));
    await source.repo.flush();
    const second = await exportTo('2.lodybundle');
    const plan = await planWorkspaceImport({ bundle: second, repo: target.repo, ...owner, actorUserId: 'admin-1' });
    expect(plan.rooms.find((room) => room.id === `${WS}:wf:workspace`)).toMatchObject({
      action: 'skip',
      reason: 'unauthorized',
      detail: expect.stringContaining('r1'),
    });
    await applyWorkspaceImport({ plan, bundle: second, repo: target.repo, journalPath: path.join(await tempDir(), 'j2.json') });
    const catalog = await target.repo.openDetachedFlockDoc(`${WS}:wf:workspace`);
    expect(catalog.get(['agentRole', 'r1'])).toMatchObject({ name: 'Reviewer' });
    expect((await target.repo.openDetachedDoc('session-s1')).getText('t').toString()).toBe('hi!');

    const byOwner = await planWorkspaceImport({ bundle: second, repo: target.repo, ...owner, actorUserId: 'other' });
    expect(byOwner.rooms.find((room) => room.id === `${WS}:wf:workspace`)).toMatchObject({ action: 'merge' });
  });
});
