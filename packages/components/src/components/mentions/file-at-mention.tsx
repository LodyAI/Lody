import * as React from 'react';
import { forEachAtTokenSpan, type HydratedMentions } from '@/components/mentions/mention-hydration';
import { useAtomValue } from 'jotai';

import { currentWorkspaceIdAtom } from '@/atoms';
import { buildPathSuggestions } from './file-search/engine';
export * from './file-search/engine';
import {
  fetchRepoFilePaths,
  getRepoFilePathsCacheKey,
  isRepoFilePathsStale,
  readCachedRepoFilePaths,
  type RepoFilePathsCacheEntry,
} from '@/lib/repo-file-paths-cache';

export type { RepoFilePathsResult } from '@/lib/repo-file-paths-cache';

export function hydrateFileMentionsFromText(text: string, knownPaths: Set<string>) {
  const mentions: HydratedMentions['mentions'] = [];
  const values = new Set<string>();

  forEachAtTokenSpan(text, ({ token, start, end }) => {
    if (!token) return false;
    // Match the candidate directly, or with a trailing slash for directories
    // whose display text has the slash stripped.
    const matchedToken = knownPaths.has(token)
      ? token
      : knownPaths.has(`${token}/`)
        ? `${token}/`
        : null;
    if (!matchedToken) return false;
    mentions.push({
      value: matchedToken,
      start,
      end,
      // The known-path set marks a directory with a trailing slash; the
      // committed text has it stripped, which is why the lookup above tries
      // both. The chip needs the distinction back to pick folder vs file glyph.
      kind: matchedToken.endsWith('/') ? 'dir' : 'file',
    });
    values.add(matchedToken);
    return true;
  });

  return { mentions, values: Array.from(values) };
}

export function useRepoFilePaths(repoFullName?: string) {
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const [data, setData] = React.useState<{
    entry: RepoFilePathsCacheEntry | null;
    status: 'idle' | 'loading' | 'ready' | 'refreshing' | 'error';
    error?: string;
  }>({ entry: null, status: 'idle' });

  React.useEffect(() => {
    if (!workspaceId || !repoFullName) {
      setData({ entry: null, status: 'idle' });
      return undefined;
    }

    const workspaceIdValue = workspaceId;
    const repoFullNameValue = repoFullName;

    let cancelled = false;
    const now = Date.now();
    const key = getRepoFilePathsCacheKey(workspaceIdValue, repoFullNameValue);

    async function run() {
      const cached = await readCachedRepoFilePaths(key);
      if (cancelled) return;
      if (cached) {
        setData({
          entry: cached,
          status: isRepoFilePathsStale(cached, now) ? 'refreshing' : 'ready',
        });
        if (!isRepoFilePathsStale(cached, Date.now())) return;
      } else {
        setData({ entry: null, status: 'loading' });
      }

      try {
        const entry = await fetchRepoFilePaths(workspaceIdValue, repoFullNameValue);
        if (cancelled) return;
        setData({ entry, status: 'ready' });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setData((prev) => ({
          entry: prev.entry,
          status: 'error',
          error: message,
        }));
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, [repoFullName, workspaceId]);

  return data;
}

/**
 * Hook that fetches repository file paths and returns a Set of known file tokens
 * for efficient lookup during mention hydration.
 */
export function useKnownFileTokens(repoFullName?: string) {
  const fileData = useRepoFilePaths(repoFullName);

  const knownTokens = React.useMemo(() => {
    const filePaths = fileData.entry?.paths ?? [];
    if (!filePaths.length) return new Set<string>();
    return buildPathSuggestions(filePaths).allTokens;
  }, [fileData.entry]);

  return { knownTokens, status: fileData.status, error: fileData.error };
}
