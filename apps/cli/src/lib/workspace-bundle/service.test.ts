import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runWorkspaceExport, runWorkspaceImport, type BundleWorkspace } from './service';
import { openTestRepo, writeDoc, type TestRepo, tempDir as makeTempDir } from './test-support';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const tempDir = () => makeTempDir(cleanup, 'lody-bundle-svc-');

function workspace(test: TestRepo, id: string, synced: string[] = []): BundleWorkspace {
  return {
    id,
    repo: test.repo,
    syncRoom: async (roomId) => {
      synced.push(roomId);
    },
  };
}

const actor = { userId: 'owner-1', machineId: 'machine-1', lodyVersion: 'test' };

describe('workspace bundle service', () => {
  it('exports to a file and imports it into another workspace with a dry run first', async () => {
    const source = await openTestRepo(await tempDir());
    cleanup.push(() => source.close());
    await writeDoc(source.repo, 'session-s1', { title: 'One' }, (doc) =>
      doc.getText('t').insert(0, 'hi')
    );
    await source.repo.flush();
    const out = path.join(await tempDir(), 'w.lodybundle');
    const synced: string[] = [];
    const exported = await runWorkspaceExport({
      workspace: workspace(source, 'ws_a', synced),
      role: 'admin',
      actor,
      out,
    });
    expect(exported.rooms).toBe(2);
    expect(synced).toContain('session-s1');

    const target = await openTestRepo(await tempDir());
    cleanup.push(() => target.close());
    const journalDir = await tempDir();
    const dry = await runWorkspaceImport({
      workspace: workspace(target, 'ws_b'),
      role: 'owner',
      actor,
      file: out,
      journalDir,
      dryRun: true,
    });
    expect(dry.result).toBeUndefined();
    expect(dry.plan.rooms.find((room) => room.id === 'session-s1')).toMatchObject({ state: 'new' });
    expect(await target.repo.listDoc()).toEqual([]);

    const uploaded: string[] = [];
    const done = await runWorkspaceImport({
      workspace: workspace(target, 'ws_b', uploaded),
      role: 'owner',
      actor,
      file: out,
      journalDir,
    });
    expect(done.result?.imported).toBeGreaterThan(0);
    expect(uploaded).toContain('session-s1');
    expect((await target.repo.getDocMeta('session-s1'))?.meta).toMatchObject({ title: 'One' });
  });

  it('refuses members before touching the file system', async () => {
    const source = await openTestRepo(await tempDir());
    cleanup.push(() => source.close());
    const out = path.join(await tempDir(), 'w.lodybundle');
    await expect(
      runWorkspaceExport({ workspace: workspace(source, 'ws_a'), role: 'member', actor, out })
    ).rejects.toThrow(/owners and admins/);
    await expect(fs.stat(out)).rejects.toThrow();
  });
});
