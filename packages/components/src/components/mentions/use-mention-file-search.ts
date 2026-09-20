import * as React from 'react';
import type { MentionFileSearchEntry, PathSuggestion } from './mention-file-search';
import { createFileSearchClient } from './mention-file-search-client';

const EMPTY_ITEMS: PathSuggestion[] = [];

/** null term releases the worker. Never fall back to searching on the UI thread. */
export function useMentionFileSearch(entry: MentionFileSearchEntry | null, term: string | null) {
  const enabled = entry !== null && term !== null;
  const client = React.useRef<ReturnType<typeof createFileSearchClient> | null>(null);
  const [result, setResult] = React.useState<{
    entry: MentionFileSearchEntry;
    term: string;
    items: PathSuggestion[];
  } | null>(null);
  const [failure, setFailure] = React.useState<MentionFileSearchEntry | null>(null);

  React.useEffect(() => {
    if (!enabled || !entry) return;
    let alive = true;
    setResult(null);
    setFailure(null);
    try {
      const worker = new Worker(new URL('./mention-file-search.worker.ts', import.meta.url), {
        type: 'module',
      });
      client.current = createFileSearchClient(
        worker,
        entry,
        (query, items) => {
          if (alive) setResult({ entry, term: query, items });
        },
        () => {
          if (alive) setFailure(entry);
        }
      );
    } catch {
      setFailure(entry);
    }
    return () => {
      alive = false;
      client.current?.dispose();
      client.current = null;
    };
  }, [entry, enabled]);

  React.useEffect(() => {
    if (enabled && term !== null) client.current?.query(term);
  }, [entry, enabled, term]);

  const current = enabled && result?.entry === entry && result.term === term;
  const error = enabled && failure === entry;
  return {
    items: current && !error ? result.items : EMPTY_ITEMS,
    status: error
      ? ('error' as const)
      : enabled && !current
        ? ('loading' as const)
        : ('ready' as const),
  };
}
