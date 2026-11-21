import type { LoroRepo } from 'loro-repo';
import type { LoroDocumentManager } from './doc';

/**
 * Active doc ids from the external (native) Meta view, which has no raw Flock
 * to scan. Returns undefined in legacy mode so callers keep their scan.
 */
export async function listExternalActiveDocIds(
  repo: Pick<LoroRepo, 'metadataMode' | 'listDoc'>,
  predicate: (docId: string) => boolean
): Promise<string[] | undefined> {
  if (repo.metadataMode !== 'external') return undefined;
  return (await repo.listDoc())
    .filter((row) => !row.deleted && predicate(row.docId))
    .map((row) => row.docId);
}

type RepoExistenceManager = Pick<LoroDocumentManager, 'repo'>;

export async function listAliveRoomIds(
  manager: RepoExistenceManager,
  predicate: (roomId: string) => boolean
): Promise<string[]> {
  const external = await listExternalActiveDocIds(manager.repo, predicate);
  if (external) return external;
  const scanner = manager.repo.getMeta();
  if (!scanner) {
    return [];
  }

  const ids = new Set<string>();
  // `e/<docId>` is loro-repo's authoritative existence index. Reading it also
  // avoids materializing every application metadata value under `m/<docId>/*`.
  const rows = await scanner.scan({ prefix: ['e'], includeRaw: false });
  for (const row of rows) {
    const key = row.key;
    if (!Array.isArray(key) || key.length < 2) {
      continue;
    }
    const roomId = key[1];
    if (row.value !== true || typeof roomId !== 'string' || !predicate(roomId)) {
      continue;
    }
    ids.add(roomId);
  }

  return Array.from(ids);
}
