import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LoroRepo } from 'loro-repo';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import type { JsonObject } from 'loro-repo';

/** A real on-disk Loro repo, as the daemon and one-shot commands use. Test-only. */
export type TestRepo = { repo: LoroRepo<JsonObject>; dir: string; close(): Promise<void> };

export async function openTestRepo(dir?: string): Promise<TestRepo> {
  const root = dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'lody-bundle-repo-')));
  const store = new SqliteRepoStore({ path: path.join(root, 'repo.sqlite3') });
  const repo = await LoroRepo.create<JsonObject>({
    storageAdapter: store.storage,
    metaDebounceCommitMs: 0,
  });
  return {
    repo,
    dir: root,
    async close() {
      await repo.flush();
      await repo.destroy();
      store.close();
    },
  };
}

export async function writeDoc(
  repo: LoroRepo<JsonObject>,
  docId: string,
  meta: JsonObject,
  edit: (doc: import('loro-crdt').LoroDoc) => void
): Promise<void> {
  const lease = await repo.acquireDoc(docId);
  try {
    edit(lease.doc);
    lease.doc.commit();
    await repo.persistDocNow(docId, lease.doc);
  } finally {
    lease.release();
  }
  await repo.upsertDocMeta(docId, meta);
}

export async function writeFlock(
  repo: LoroRepo<JsonObject>,
  flockDocId: string,
  edit: (flock: import('@loro-dev/flock-wasm').Flock) => void
): Promise<void> {
  const lease = await repo.acquireFlockDoc(flockDocId);
  try {
    edit(lease.flock);
    await repo.persistFlockDocNow(flockDocId, lease.flock);
  } finally {
    lease.release();
  }
}
