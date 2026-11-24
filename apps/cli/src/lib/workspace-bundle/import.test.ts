import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LoroMap } from 'loro-crdt';
import { afterEach, describe, expect, it } from 'vitest';
import { getImportFence, isScheduleImportFenced, type SessionMeta } from '@lody/shared';
import { createBundleWriter, openBundle, type OpenBundle } from './bundle-file';
import { exportWorkspaceBundle } from './export';
import { applyWorkspaceImport, ImportRefusedError, planWorkspaceImport } from './import';
import {
  openTestRepo,
  writeDoc,
  writeFlock,
  type TestRepo,
  tempDir as makeTempDir,
} from './test-support';

const WS = 'ws_a';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const tempDir = () => makeTempDir(cleanup, 'lody-import-');

async function repo(): Promise<TestRepo> {
  const test = await openTestRepo(await tempDir());
  cleanup.push(() => test.close());
  return test;
}

async function exportFrom(source: TestRepo, workspaceId: string): Promise<OpenBundle> {
  await source.repo.flush();
  const out = path.join(await tempDir(), `${workspaceId}-${cleanup.length}.lodybundle`);
  await exportWorkspaceBundle({
    repo: source.repo,
    workspaceId,
    writer: await createBundleWriter(out),
    source: {
      workspaceId,
      exporterUserId: 'u',
      exporterMachineId: 'm',
      lodyVersion: 't',
      startedAt: 'a',
    },
  });
  const bundle = await openBundle(out);
  cleanup.push(() => bundle.close());
  return bundle;
}

async function sourceBundle(): Promise<OpenBundle> {
  const source = await repo();
  await writeDoc(source.repo, 'session-s1', { title: 'One' }, (doc) =>
    doc.getText('t').insert(0, 'hi')
  );
  await writeDoc(source.repo, 'schedule-x', { kind: 'schedule' }, (doc) =>
    doc.getText('prompt').insert(0, 'p')
  );
  await writeFlock(source.repo, `${WS}:wf:workspace`, (flock) => {
    flock.put(['project', 'p1'], { name: 'P' });
    flock.put(['project', 'p2'], { name: 'Q' });
    flock.delete(['project', 'p2']);
  });
  const bundle = await exportFrom(source, WS);
  return bundle;
}

const owner = { workspaceId: WS, role: 'owner', actorUserId: 'owner-1' } as const;

async function importAll(bundle: OpenBundle, target: TestRepo, journalPath: string) {
  const plan = await planWorkspaceImport({ bundle, repo: target.repo, ...owner });
  return {
    plan,
    result: await applyWorkspaceImport({ plan, bundle, repo: target.repo, journalPath }),
  };
}

describe('workspace import', () => {
  it('merges a bundle into an empty workspace and survives a restart', async () => {
    const bundle = await sourceBundle();
    const dir = await tempDir();
    const target = await openTestRepo(dir);
    const { plan } = await importAll(bundle, target, path.join(dir, 'journal.json'));
    expect(plan.rooms.find((room) => room.id === 'session-s1')).toMatchObject({
      action: 'merge',
      state: 'new',
    });
    expect(plan.rooms.find((room) => room.id === 'session-s1')?.label).toBe('One');
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
    await writeDoc(target.repo, 'session-s1', { title: 'Mine' }, (doc) =>
      doc.getText('t').insert(0, 'mine')
    );
    const { plan } = await importAll(bundle, target, path.join(await tempDir(), 'j.json'));
    expect(plan.rooms.find((room) => room.id === 'session-s1')).toMatchObject({
      action: 'skip',
      reason: 'unrelated-same-id',
    });
    // The skipped item is the bundle's conversation: name it as the bundle does.
    expect(plan.rooms.find((room) => room.id === 'session-s1')?.label).toBe('One');
    const doc = await target.repo.openDetachedDoc('session-s1');
    expect(doc.getText('t').toString()).toBe('mine');
    expect((await target.repo.getDocMeta('session-s1'))?.meta).toMatchObject({ title: 'Mine' });
    expect(plan.rooms.find((room) => room.id === 'schedule-x')).toMatchObject({ action: 'merge' });
  });

  it('refuses members, unknown codecs and rooms whose codec does not match their id', async () => {
    const bundle = await sourceBundle();
    const target = await repo();
    await expect(
      planWorkspaceImport({
        bundle,
        repo: target.repo,
        workspaceId: WS,
        role: 'member',
        actorUserId: 'm-1',
      })
    ).rejects.toBeInstanceOf(ImportRefusedError);

    const craft = async (
      room: Parameters<Awaited<ReturnType<typeof createBundleWriter>>['addRoom']>[0]
    ) => {
      const out = path.join(await tempDir(), 'odd.lodybundle');
      const writer = await createBundleWriter(out);
      await writer.addRoom(room, new Uint8Array([1]));
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
      return planWorkspaceImport({ bundle: odd, repo: target.repo, ...owner });
    };
    await expect(
      craft({ id: 'x-1', model: 'loro', codec: 'odd/v9', encoding: 'loro-snapshot/v1' })
    ).rejects.toThrow(/odd\/v9/);
    // A machine document labelled as a conversation would cross workspaces unnoticed.
    await expect(
      craft({ id: 'machine-m1', model: 'loro', codec: 'session/v1', encoding: 'loro-snapshot/v1' })
    ).rejects.toThrow(/machine-m1/);
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
    const result = await applyWorkspaceImport({
      plan,
      bundle,
      repo: target.repo,
      journalPath: journal,
    });
    expect(result.resumed).toBeGreaterThan(0);
    expect((await target.repo.getDocMeta('session-s1'))?.meta).toMatchObject({ title: 'One' });
  });

  it('maps a bundle from another workspace without machines and fences imported work there only', async () => {
    const source = await repo();
    await writeDoc(source.repo, 'session-s1', { title: 'One', latestUserMsgId: 'u1' }, (doc) => {
      doc.getText('t').insert(0, 'hi');
      const queued = doc.getMovableList('mq').insertContainer(0, new LoroMap());
      queued.set('userTurnId', 'q1');
    });
    await writeDoc(source.repo, 'schedule-x', { kind: 'schedule' }, (doc) => {
      doc.getMap('definition').set('enabled', true);
      doc.getMap('definition').set('activationId', 'act-1');
    });
    await writeDoc(source.repo, 'machine-m1', { name: 'M' }, (doc) => doc.getMap('m').set('a', 1));
    await source.repo.upsertDocMeta('machine-m2', { name: 'Meta only' });
    await writeFlock(source.repo, `${WS}:wf:workspace`, (flock) =>
      flock.put(['project', 'p1'], { name: 'P' })
    );
    await writeFlock(source.repo, `${WS}:mf:m1`, (flock) =>
      flock.put(['localProject', 'a'], { p: 1 })
    );
    await writeFlock(source.repo, `${WS}:sr`, (flock) => {
      flock.put(['schedule', 'x'], { on: true });
      flock.put(['runtime', 'x', 'm1'], { next: 1 });
    });
    const bundle = await exportFrom(source, WS);

    const target = await repo();
    const plan = await planWorkspaceImport({
      bundle,
      repo: target.repo,
      workspaceId: 'ws_b',
      role: 'admin',
      actorUserId: 'admin-1',
    });
    expect(plan.rooms.find((room) => room.id === `${WS}:wf:workspace`)).toMatchObject({
      targetId: 'ws_b:wf:workspace',
      action: 'merge',
    });
    expect(plan.rooms.find((room) => room.id === `${WS}:mf:m1`)).toMatchObject({
      action: 'skip',
      reason: 'machine-room',
    });
    expect(plan.rooms.find((room) => room.id === 'machine-m1')).toMatchObject({
      action: 'skip',
      reason: 'machine-room',
    });
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

    // Imported pending input is fenced in the target, not rewritten.
    const meta = (await target.repo.getDocMeta('session-s1'))?.meta as SessionMeta | undefined;
    expect(meta).toMatchObject({ title: 'One', latestUserMsgId: 'u1' });
    expect(meta).not.toHaveProperty('collaborationStopped');
    const session = await target.repo.openDetachedDoc('session-s1');
    expect(session.getMovableList('mq').length).toBe(1);
    expect(session.getText('t').toString()).toBe('hi');
    const fence = getImportFence(meta, 'ws_b');
    expect([...fence.turnIds].sort()).toEqual(['q1', 'u1']);
    expect(fence.queueItemIds).toHaveLength(1);
    expect(getImportFence(meta, WS).turnIds).toHaveLength(0);
    // The importer may read the imported conversation here; nobody else gains anything.
    expect(meta?.importFence?.importedBy).toBe('admin-1');
    const schedule = await target.repo.openDetachedDoc('schedule-x');
    expect(schedule.getMap('definition').get('enabled')).toBe(true);
    expect(
      isScheduleImportFenced((await target.repo.getDocMeta('schedule-x'))?.meta, 'ws_b', 'act-1')
    ).toBe(true);
    expect(
      isScheduleImportFenced((await target.repo.getDocMeta('schedule-x'))?.meta, 'ws_b', 'act-2')
    ).toBe(false);

    // The return trip: the target's bundle carries the fence back, and the source ignores it.
    const backBundle = await exportFrom(target, 'ws_b');
    await applyWorkspaceImport({
      plan: await planWorkspaceImport({
        bundle: backBundle,
        repo: source.repo,
        workspaceId: WS,
        role: 'owner',
        actorUserId: 'u',
      }),
      bundle: backBundle,
      repo: source.repo,
      journalPath: path.join(await tempDir(), 'back.json'),
    });
    const original = (await source.repo.getDocMeta('session-s1'))?.meta as SessionMeta | undefined;
    expect(original).toMatchObject({ latestUserMsgId: 'u1' });
    expect(original).not.toHaveProperty('collaborationStopped');
    expect(getImportFence(original, WS).turnIds).toHaveLength(0);
    expect(
      isScheduleImportFenced((await source.repo.getDocMeta('schedule-x'))?.meta, WS, 'act-1')
    ).toBe(false);
    expect(
      (await source.repo.openDetachedDoc('schedule-x')).getMap('definition').get('enabled')
    ).toBe(true);

    const again = await planWorkspaceImport({
      bundle,
      repo: target.repo,
      workspaceId: 'ws_b',
      role: 'admin',
      actorUserId: 'admin-1',
    });
    expect(
      again.rooms
        .filter((room) => room.action === 'merge')
        .every((room) => room.state === 'unchanged')
    ).toBe(true);
  });

  it("rejects a room that changes another member's Role, and imports the rest", async () => {
    const source = await repo();
    await writeDoc(source.repo, 'session-s1', { title: 'One' }, (doc) =>
      doc.getText('t').insert(0, 'hi')
    );
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
        source: {
          workspaceId: WS,
          exporterUserId: 'u',
          exporterMachineId: 'm',
          lodyVersion: 't',
          startedAt: 'a',
        },
      });
      const opened = await openBundle(out);
      cleanup.push(() => opened.close());
      return opened;
    };
    const target = await repo();
    const first = await exportTo('1.lodybundle');
    await applyWorkspaceImport({
      plan: await planWorkspaceImport({
        bundle: first,
        repo: target.repo,
        ...owner,
        actorUserId: 'admin-1',
      }),
      bundle: first,
      repo: target.repo,
      journalPath: path.join(await tempDir(), 'j.json'),
    });

    await writeFlock(source.repo, `${WS}:wf:workspace`, (flock) =>
      flock.put(['agentRole', 'r1'], { name: 'Hijacked', ownerUserId: 'other' })
    );
    await writeDoc(source.repo, 'session-s1', { title: 'One' }, (doc) =>
      doc.getText('t').insert(2, '!')
    );
    await source.repo.flush();
    const second = await exportTo('2.lodybundle');
    const plan = await planWorkspaceImport({
      bundle: second,
      repo: target.repo,
      ...owner,
      actorUserId: 'admin-1',
    });
    expect(plan.rooms.find((room) => room.id === `${WS}:wf:workspace`)).toMatchObject({
      action: 'skip',
      reason: 'unauthorized',
      detail: expect.stringContaining('r1'),
    });
    await applyWorkspaceImport({
      plan,
      bundle: second,
      repo: target.repo,
      journalPath: path.join(await tempDir(), 'j2.json'),
    });
    const catalog = await target.repo.openDetachedFlockDoc(`${WS}:wf:workspace`);
    expect(catalog.get(['agentRole', 'r1'])).toMatchObject({ name: 'Reviewer' });
    expect((await target.repo.openDetachedDoc('session-s1')).getText('t').toString()).toBe('hi!');

    const byOwner = await planWorkspaceImport({
      bundle: second,
      repo: target.repo,
      ...owner,
      actorUserId: 'other',
    });
    expect(byOwner.rooms.find((room) => room.id === `${WS}:wf:workspace`)).toMatchObject({
      action: 'merge',
    });
  });

  it('fences imported work even when a cross-workspace import resumes after a crash', async () => {
    const source = await repo();
    await writeDoc(source.repo, 'session-s1', { title: 'One', latestUserMsgId: 'u1' }, (doc) =>
      doc.getText('t').insert(0, 'hi')
    );
    await writeDoc(source.repo, 'schedule-x', { kind: 'schedule' }, (doc) =>
      doc.getMap('definition').set('activationId', 'act-1')
    );
    const bundle = await exportFrom(source, WS);
    const target = await repo();
    const journal = path.join(await tempDir(), 'j.json');
    const input = {
      bundle,
      repo: target.repo,
      workspaceId: 'ws_b',
      role: 'owner',
      actorUserId: 'u',
    };
    let rooms = 0;
    await expect(
      applyWorkspaceImport({
        plan: await planWorkspaceImport(input),
        bundle,
        repo: target.repo,
        journalPath: journal,
        checkContinue: async () => {
          rooms += 1;
          if (rooms === 3) throw new Error('crash');
        },
      })
    ).rejects.toThrow('crash');
    // The rerun plans the merged rooms as unchanged; their fences were written with them.
    await applyWorkspaceImport({
      plan: await planWorkspaceImport(input),
      bundle,
      repo: target.repo,
      journalPath: journal,
    });
    const meta = (await target.repo.getDocMeta('session-s1'))?.meta as SessionMeta | undefined;
    expect(getImportFence(meta, 'ws_b').turnIds).toContain('u1');
    expect(
      isScheduleImportFenced((await target.repo.getDocMeta('schedule-x'))?.meta, 'ws_b', 'act-1')
    ).toBe(true);
  });

  it('fences new work when the same source is imported into the workspace again', async () => {
    const source = await repo();
    await writeDoc(source.repo, 'session-s1', { title: 'One', latestUserMsgId: 'u1' }, (doc) =>
      doc.getText('t').insert(0, 'hi')
    );
    await writeDoc(source.repo, 'schedule-x', { kind: 'schedule' }, (doc) =>
      doc.getMap('definition').set('activationId', 'act-1')
    );
    const target = await repo();
    const input = { repo: target.repo, workspaceId: 'ws_b', role: 'owner', actorUserId: 'u' };
    const importInto = async (bundle: OpenBundle) =>
      applyWorkspaceImport({
        plan: await planWorkspaceImport({ bundle, ...input }),
        bundle,
        repo: target.repo,
        journalPath: path.join(await tempDir(), 'j.json'),
      });
    await importInto(await exportFrom(source, WS));

    // The conversation and schedule went on in the source after the first import.
    await writeDoc(source.repo, 'session-s1', { latestUserMsgId: 'u2' }, (doc) => {
      const queued = doc.getMovableList('mq').insertContainer(0, new LoroMap());
      queued.set('userTurnId', 'q2');
    });
    await writeDoc(source.repo, 'schedule-x', {}, (doc) =>
      doc.getMap('definition').set('activationId', 'act-2')
    );
    await importInto(await exportFrom(source, WS));

    const meta = (await target.repo.getDocMeta('session-s1'))?.meta as SessionMeta | undefined;
    expect(meta).toMatchObject({ latestUserMsgId: 'u2' });
    expect([...getImportFence(meta, 'ws_b').turnIds].sort()).toEqual(['q2', 'u1', 'u2']);
    expect(getImportFence(meta, 'ws_b').queueItemIds).toHaveLength(1);
    expect(
      isScheduleImportFenced((await target.repo.getDocMeta('schedule-x'))?.meta, 'ws_b', 'act-2')
    ).toBe(true);
  });
});
