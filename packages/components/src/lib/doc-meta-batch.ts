import type { LoroRepo } from 'loro-repo';
import { isLoroRepoDocDeleted, isMachineDocRoomId, isSessionDocRoomId } from '@lody/shared';
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
  if (batchedEntries) return batchedEntries;
  const entries = await repo.listDoc();
  return entries.map((entry) => ({
    ...entry,
    meta: entry.meta as Record<string, unknown>,
  }));
}

/**
 * Session and machine metadata already projected by the doc-meta cache, or null
 * when no ready projection for this repo exists. The projection is kept current
 * by its own watch, so readers need not rescan the meta namespace.
 */
export type DocMetaCacheSnapshot = {
  sessions: Readonly<Record<string, Record<string, unknown>>>;
  machines: Readonly<Record<string, Record<string, unknown>>>;
};

export type ReadDocMetaCache = (repo: LoroRepo) => DocMetaCacheSnapshot | null;

/**
 * Live session and machine metadata by room id. Prefers the ready doc-meta
 * projection: a full scan of a large workspace's meta namespace is one
 * synchronous Flock call of several hundred milliseconds, so every startup
 * reader after the first must reuse the projection instead of scanning again.
 */
export async function readSessionAndMachineMetas(
  repo: LoroRepo,
  readCache: ReadDocMetaCache | undefined
): Promise<DocMetaCacheSnapshot> {
  const cached = readCache?.(repo);
  if (cached) return cached;
  const sessions: Record<string, Record<string, unknown>> = {};
  const machines: Record<string, Record<string, unknown>> = {};
  for (const entry of await listDocMetaEntries(repo)) {
    if (isLoroRepoDocDeleted(entry)) continue;
    if (isSessionDocRoomId(entry.docId)) sessions[entry.docId] = entry.meta;
    else if (isMachineDocRoomId(entry.docId)) machines[entry.docId] = entry.meta;
  }
  return { sessions, machines };
}
