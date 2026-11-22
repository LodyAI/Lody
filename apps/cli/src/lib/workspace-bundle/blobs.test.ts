import { createSessionMirror } from '@lody/shared/session-mirror';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type SessionId } from '@lody/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSessionFileBlobPath } from '@/lib/session-file-blob-store';
import { createBundleWriter, openBundle } from './bundle-file';
import { exportWorkspaceBundle } from './export';
import { applyWorkspaceImport, planWorkspaceImport } from './import';
import { localSessionFileBlobs, restoreSessionFileBlobs } from './blobs';
import { sha256 } from './manifest';
import { openTestRepo, tempDir as makeTempDir } from './test-support';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const step of cleanup.splice(0).reverse()) await step();
});
const tempDir = () => makeTempDir(cleanup, 'lody-bundle-blobs-');
const SID = '11111111-1111-4111-8111-111111111111';

describe('session file blobs', () => {
  it('bundles local attachment bytes and restores them for the target workspace', async () => {
    vi.stubEnv('LODY_DATA_DIR', await tempDir());
    const blob = Buffer.from('synthetic attachment');
    const stored = getSessionFileBlobPath({ workspaceId: 'ws_a', sessionId: SID, fileId: 'file1' });
    await fs.mkdir(path.dirname(stored), { recursive: true });
    await fs.writeFile(stored, blob);

    const source = await openTestRepo(await tempDir());
    cleanup.push(() => source.close());
    const lease = await source.repo.acquireDoc(`session-${SID}`);
    const mirror = createSessionMirror({
      doc: lease.doc,
      initialState: { session: { id: SID as SessionId }, history: [] },
    });
    const file = {
      type: 'file' as const,
      fileName: 'note.txt',
      mimeType: 'text/plain',
      textPreview: true,
      uploadedAt: 1,
      machineId: 'machine-a',
    };
    mirror.historyWriter.update(() => [
      {
        id: 'u1',
        role: 'user',
        timestamp: '2026-11-19T00:00:00.000Z',
        items: [
          {
            ...file,
            fileId: 'file1',
            transport: 'local',
            sizeBytes: blob.length,
            sha256: sha256(blob),
          },
          {
            ...file,
            fileId: 'cloud1',
            transport: 'r2',
            sizeBytes: 3,
            sha256: sha256(Buffer.from('abc')),
          },
        ],
      },
    ]);
    mirror.dispose();
    await source.repo.persistDocNow(`session-${SID}`, lease.doc);
    lease.release();
    await source.repo.upsertDocMeta(`session-${SID}`, { title: 'With file' });

    const out = path.join(await tempDir(), 'b.lodybundle');
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
      sessionBlobs: localSessionFileBlobs('ws_a'),
    });
    expect(manifest.blobs).toEqual([
      expect.objectContaining({
        sha256: sha256(blob),
        kind: 'session-file',
        refs: [`session-file:${SID}/file1`],
      }),
    ]);
    expect(manifest.gaps).toContainEqual(
      expect.objectContaining({ id: `session-file:${SID}/cloud1`, kind: 'attachment' })
    );

    const bundle = await openBundle(out);
    cleanup.push(() => bundle.close());
    const target = await openTestRepo(await tempDir());
    cleanup.push(() => target.close());
    const plan = await planWorkspaceImport({
      bundle,
      repo: target.repo,
      workspaceId: 'ws_b',
      role: 'owner',
      actorUserId: 'u',
    });
    await applyWorkspaceImport({
      plan,
      bundle,
      repo: target.repo,
      journalPath: path.join(await tempDir(), 'j'),
    });
    const restored = await restoreSessionFileBlobs({ bundle, plan });
    expect(restored).toEqual({ written: 1, existing: 0 });
    const copy = getSessionFileBlobPath({ workspaceId: 'ws_b', sessionId: SID, fileId: 'file1' });
    expect(await fs.readFile(copy)).toEqual(blob);
    expect(await restoreSessionFileBlobs({ bundle, plan })).toEqual({ written: 0, existing: 1 });
  });
});
