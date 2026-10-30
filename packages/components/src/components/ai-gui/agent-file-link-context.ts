import {
  resolveDirectMarkdownFileOpenTarget,
  normalizeIndexedRelativePath,
} from '@/lib/session-file-open-target';
import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import type { AgentFileLinkIndex } from '@/lib/agent-file-link-index';
import { isAbsoluteFilePath } from '@/lib/session-local-file-path';
import { parseMarkdownAgentFileHref } from '@/lib/markdown-agent-file-link';

export const AgentFileLinkIndexContext = createContext<AgentFileLinkIndex | null>(null);
const subscribeNothing = () => () => {};

/** Only this leaf subscribes; index changes do not reparse the Markdown body. */
export function useAgentFileLinkMatch(href: string) {
  const index = useContext(AgentFileLinkIndexContext);
  const path = resolveDirectMarkdownFileOpenTarget(href)?.filePath ?? null;
  const absolute = isAbsoluteFilePath(path ?? parseMarkdownAgentFileHref(href)?.filePath ?? href);
  const relativePath = path !== null && !absolute ? normalizeIndexedRelativePath(path) : null;
  const getSnapshot = useCallback(
    () =>
      index === null
        ? absolute || path !== null
        : absolute || (relativePath !== null && index.has(relativePath)),
    [absolute, index, path, relativePath]
  );
  const matched = useSyncExternalStore(
    index?.subscribe ?? subscribeNothing,
    getSnapshot,
    getSnapshot
  );
  useEffect(() => {
    if (relativePath !== null) index?.request();
  }, [index, relativePath]);
  return {
    matched,
    valid: path !== null,
  };
}
