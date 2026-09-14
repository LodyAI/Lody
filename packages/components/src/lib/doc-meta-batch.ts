import type { LoroRepo } from 'loro-repo';
import {
  getAttachedSessionLifecycleRepository,
  isSessionDocRoomId,
  projectSessionLifecycleMetadata,
  SESSION_DOC_PREFIX,
  type SessionId,
} from '@lody/shared';
import { collectDocExistenceValues, collectDocMetadataPatchesFromEntries } from './flock-existence';

type FlockScanRow = {
  readonly key: readonly unknown[];
  readonly value?: unknown;
};

type FlockScanner = {
  scan(options?: {
    prefix?: readonly unknown[];
  }): Iterable<FlockScanRow> | Promise<Iterable<FlockScanRow>>;
};

type RepoWithMetaScanner = LoroRepo & {
  getMeta?: () => FlockScanner | null | undefined;
};

export type DocMetaEntry = {
  docId: string;
  meta: Record<string, unknown>;
  exists?: boolean;
};

async function scanRows(
  scanner: FlockScanner,
  prefix: readonly unknown[]
): Promise<FlockScanRow[]> {
  return Array.from(await scanner.scan({ prefix }));
}

async function tryListDocMetaEntriesFromFlock(repo: LoroRepo): Promise<DocMetaEntry[] | null> {
  const scanner = (repo as RepoWithMetaScanner).getMeta?.();
  if (!scanner) return null;

  try {
    const [metadataRows, existenceRows] = await Promise.all([
      scanRows(scanner, ['m']),
      scanRows(scanner, ['e']),
    ]);
    const metadataByDocId = collectDocMetadataPatchesFromEntries(metadataRows);
    const existenceByDocId = collectDocExistenceValues({ events: existenceRows });
    const entries: DocMetaEntry[] = [];
    for (const [docId, meta] of metadataByDocId) {
      const existence = existenceByDocId.get(docId);
      if (existence !== 'active') continue;
      entries.push({
        docId,
        meta,
        exists: true,
      });
    }
    return entries;
  } catch {
    return null;
  }
}

export async function listDocMetaEntries(repo: LoroRepo): Promise<DocMetaEntry[]> {
  const batchedEntries = await tryListDocMetaEntriesFromFlock(repo);
  const entries =
    batchedEntries ??
    (await repo.listDoc()).map((entry) => ({
      ...entry,
      meta: entry.meta as Record<string, unknown>,
    }));
  const lifecycle = getAttachedSessionLifecycleRepository(repo);
  return entries.map((entry) => ({
    ...entry,
    meta:
      lifecycle && isSessionDocRoomId(entry.docId)
        ? projectSessionLifecycleMetadata(
            lifecycle,
            entry.docId.slice(SESSION_DOC_PREFIX.length) as SessionId,
            entry.meta
          )
        : entry.meta,
  }));
}
