import type { LoroRepo } from 'loro-repo';
import { isLoroRepoDocDeleted, isMachineDocRoomId, isSessionDocRoomId } from '@lody/shared';
import {
  createLegacyWorkspaceDirectoryReader,
  type WorkspaceDirectoryReader,
} from '@lody/shared/workspace-directory';
export type { WorkspaceDirectoryEntry as DocMetaEntry } from '@lody/shared/workspace-directory';
import type { WorkspaceDirectoryEntry as DocMetaEntry } from '@lody/shared/workspace-directory';

export async function listDocMetaEntries(
  repo: LoroRepo,
  directory?: WorkspaceDirectoryReader
): Promise<DocMetaEntry[]> {
  return (directory ?? createLegacyWorkspaceDirectoryReader(repo)).listEntries();
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
  readCache: ReadDocMetaCache | undefined,
  directory?: WorkspaceDirectoryReader
): Promise<DocMetaCacheSnapshot> {
  const cached = readCache?.(repo);
  if (cached) return cached;
  const sessions: Record<string, Record<string, unknown>> = {};
  const machines: Record<string, Record<string, unknown>> = {};
  for (const entry of await listDocMetaEntries(repo, directory)) {
    if (isLoroRepoDocDeleted(entry)) continue;
    if (isSessionDocRoomId(entry.docId)) sessions[entry.docId] = entry.meta;
    else if (isMachineDocRoomId(entry.docId)) machines[entry.docId] = entry.meta;
  }
  return { sessions, machines };
}
