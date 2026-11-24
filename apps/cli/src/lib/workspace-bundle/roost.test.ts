import { createSessionMirror } from '@lody/shared/session-mirror';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type SessionHistoryInput } from '@lody/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createBundleWriter, openBundle } from './bundle-file';
import { exportWorkspaceBundle } from './export';
import { applyWorkspaceImport, planWorkspaceImport } from './import';
import { openTestRepo, writeDoc, tempDir as makeTempDir } from './test-support';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
const tempDir = () => makeTempDir(cleanup, 'lody-bundle-roost-');

const SID = '44444444-4444-4444-8444-444444444444';
const turns: SessionHistoryInput[] = [
  {
    id: 'u1',
    role: 'user',
    timestamp: '2026-11-19T00:00:00.000Z',
    items: [{ type: 'text', text: 'question' }],
  },
  {
    id: 'a1',
    role: 'assistant',
    timestamp: '2026-11-19T00:00:01.000Z',
    items: [{ type: 'text', text: 'answer' }],
  },
];

async function roostBundle() {
  const source = await openTestRepo(await tempDir());
  cleanup.push(() => source.close());
  await writeDoc(
    source.repo,
    `session-${SID}`,
    { title: 'Roost one', historyBackend: 'roost' },
    (doc) => doc.getMap('session').set('id', SID)
  );
  const out = path.join(await tempDir(), 'r.lodybundle');
  const manifest = await exportWorkspaceBundle({
    repo: source.repo,
    workspaceId: 'ws_a',
    writer: await createBundleWriter(out),
    source: {
      workspaceId: 'ws_a',
      exporterUserId: 'u',
      exporterMachineId: 'm',
      lodyVersion: 't',
      startedAt: 'a',
    },
    roostHistory: async (sessionId) => (sessionId === SID ? turns : []),
  });
  const bundle = await openBundle(out);
  cleanup.push(() => bundle.close());
  return { manifest, bundle };
}

describe('Roost conversations', () => {
  it('exports visible turns and rewrites them as Loro history in a workspace without the session', async () => {
    const { manifest, bundle } = await roostBundle();
    expect(manifest.rooms.find((room) => room.codec === 'roost-turns/v1')).toMatchObject({
      id: `roost:session-${SID}`,
      model: 'roost',
    });
    expect(manifest.gaps.filter((gap) => gap.kind === 'roost')).toEqual([]);

    const target = await openTestRepo(await tempDir());
    cleanup.push(() => target.close());
    const plan = await planWorkspaceImport({
      bundle,
      repo: target.repo,
      workspaceId: 'ws_b',
      role: 'owner',
      actorUserId: 'u',
    });
    expect(plan.rooms.find((room) => room.codec === 'roost-turns/v1')).toMatchObject({
      action: 'merge',
      state: 'new',
    });
    await applyWorkspaceImport({
      plan,
      bundle,
      repo: target.repo,
      journalPath: path.join(await tempDir(), 'j'),
    });

    expect((await target.repo.getDocMeta(`session-${SID}`))?.meta).toMatchObject({
      title: 'Roost one',
      historyBackend: 'loro',
    });
    const doc = await target.repo.openDetachedDoc(`session-${SID}`);
    const mirror = createSessionMirror({ doc, initialState: {} });
    expect(mirror.historyWriter.readStored().map((turn) => turn.id)).toEqual(['u1', 'a1']);
    mirror.dispose();

    const again = await planWorkspaceImport({
      bundle,
      repo: target.repo,
      workspaceId: 'ws_b',
      role: 'owner',
      actorUserId: 'u',
    });
    expect(again.rooms.find((room) => room.codec === 'roost-turns/v1')).toMatchObject({
      action: 'skip',
      reason: 'roost-exists',
    });
  });

  it('leaves a Roost conversation the target already has untouched', async () => {
    const { bundle } = await roostBundle();
    const target = await openTestRepo(await tempDir());
    cleanup.push(() => target.close());
    await target.repo.upsertDocMeta(`session-${SID}`, {
      title: 'Here already',
      historyBackend: 'roost',
    });
    const plan = await planWorkspaceImport({
      bundle,
      repo: target.repo,
      workspaceId: 'ws_a',
      role: 'owner',
      actorUserId: 'u',
    });
    expect(plan.rooms.find((room) => room.codec === 'roost-turns/v1')).toMatchObject({
      action: 'skip',
      reason: 'roost-exists',
    });
    await applyWorkspaceImport({
      plan,
      bundle,
      repo: target.repo,
      journalPath: path.join(await tempDir(), 'j'),
    });
    expect((await target.repo.getDocMeta(`session-${SID}`))?.meta).toMatchObject({
      historyBackend: 'roost',
    });
  });
});
