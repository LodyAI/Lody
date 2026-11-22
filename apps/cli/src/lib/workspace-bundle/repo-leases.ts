import type { Flock } from '@loro-dev/flock-wasm';
import type { LoroDoc } from 'loro-crdt';
import type { JsonObject, LoroRepo } from 'loro-repo';

/** Edits a document through a lease and persists it before releasing. */
export async function withDoc<T>(
  repo: LoroRepo<JsonObject>,
  docId: string,
  edit: (doc: LoroDoc) => T | Promise<T>
): Promise<T> {
  const lease = await repo.acquireDoc(docId);
  try {
    const result = await edit(lease.doc);
    await repo.persistDocNow(docId, lease.doc);
    return result;
  } finally {
    lease.release();
  }
}

/** Edits a named Flock through a lease and persists it before releasing. */
export async function withFlock<T>(
  repo: LoroRepo<JsonObject>,
  flockDocId: string,
  edit: (flock: Flock) => T | Promise<T>
): Promise<T> {
  const lease = await repo.acquireFlockDoc(flockDocId);
  try {
    const result = await edit(lease.flock);
    await repo.persistFlockDocNow(flockDocId, lease.flock);
    return result;
  } finally {
    lease.release();
  }
}
