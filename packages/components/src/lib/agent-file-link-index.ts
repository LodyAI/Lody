import { resolveCodeCollabSymlinkTarget } from '@lody/shared';
import type { FileWorkspaceProviderEntry } from './file-workspace-provider';

/** A conversation-local projection; the workspace cache still owns the index. */
export function createAgentFileLinkIndex(request: () => void = () => undefined) {
  let paths = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    request,
    has(path: string) {
      return paths.has(path);
    },
    setFiles(files: readonly FileWorkspaceProviderEntry[]) {
      const entries = new Map(files.map((file) => [file.path, file]));
      const next = new Set<string>();
      const isFile = (entry: FileWorkspaceProviderEntry | undefined) =>
        entry &&
        entry.entryType !== 'lazy-directory' &&
        ['text', 'binary', 'large'].includes(entry.kind);
      for (const file of files) {
        if (isFile(file)) next.add(file.path);
        else if (file.kind === 'symlink') {
          const target = resolveCodeCollabSymlinkTarget(file.path, entries);
          if (target.kind === 'resolved' && isFile(entries.get(target.path))) next.add(file.path);
        }
      }
      if (next.size === paths.size && [...next].every((path) => paths.has(path))) return;
      paths = next;
      notify();
    },
  };
}

export type AgentFileLinkIndex = ReturnType<typeof createAgentFileLinkIndex>;
