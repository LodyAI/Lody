import type { FileTreeItem } from '@lody/shared';
import { useEffect, useState } from 'react';
import { buildFileTreeFromPaths } from '../lib/file-tree';
import type {
  FileWorkspaceProvider,
  FileWorkspaceProviderEntry,
} from '../lib/file-workspace-provider';
import { logCodeCollabDebug, warnCodeCollab } from '@/lib/code-collab-debug';

export function buildFileTreeFromFileWorkspaceProviderEntries(
  entries: readonly FileWorkspaceProviderEntry[]
): FileTreeItem[] {
  const tree = buildFileTreeFromPaths(
    entries.filter((entry) => entry.entryType !== 'lazy-directory').map((entry) => entry.path),
    new Set(
      entries
        .filter((entry) => entry.entryType !== 'lazy-directory' && entry.modifiedTime !== undefined)
        .map((entry) => entry.path)
    )
  );
  const directoriesByChildren = new WeakMap<FileTreeItem[], Map<string, FileTreeItem>>();
  const changedChildren = new Set<FileTreeItem[]>();
  for (const entry of entries) {
    if (entry.entryType !== 'lazy-directory' || !entry.directoryId) continue;
    const segments = entry.path.split('/').filter(Boolean);
    let current = tree;
    for (let index = 0; index < segments.length; index += 1) {
      const path = segments.slice(0, index + 1).join('/');
      let directories = directoriesByChildren.get(current);
      if (!directories) {
        directories = new Map(
          current.filter((item) => item.type === 'directory').map((item) => [item.path, item])
        );
        directoriesByChildren.set(current, directories);
      }
      let item = directories.get(path);
      if (!item) {
        item = { path, type: 'directory', children: [] };
        current.push(item);
        directories.set(path, item);
        changedChildren.add(current);
      }
      if (index === segments.length - 1) item.lazyDirectoryId = entry.directoryId;
      item.children ??= [];
      current = item.children;
    }
  }
  for (const children of changedChildren) children.sort(compareFileTreeItems);
  return tree;
}

export const buildFileTreeFromSessionFileProviderEntries =
  buildFileTreeFromFileWorkspaceProviderEntries;

function compareFileTreeItems(left: FileTreeItem, right: FileTreeItem): number {
  if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
  return left.path.localeCompare(right.path);
}

export const useFileWorkspaceTree = (
  provider: FileWorkspaceProvider | null | undefined,
  options?: { enabled?: boolean }
): { state: FileTreeItem[]; ready: boolean; synced: boolean; message?: string } => {
  const enabled = options?.enabled ?? true;
  const [state, setState] = useState<FileTreeItem[]>([]);
  const [ready, setReady] = useState(false);
  const [synced, setSynced] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setState([]);
    setReady(false);
    setSynced(false);
    setMessage(undefined);

    if (!enabled || !provider) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const providerState = provider.getState();
      setMessage(providerState.message);
      logCodeCollabDebug('provider file tree load start', {
        providerKind: provider.kind,
        providerReady: providerState.ready,
        providerSourceState: providerState.sourceState,
        providerMessage: providerState.message ?? null,
      });
      try {
        const entries = await provider.listFiles();
        if (cancelled) return;
        const tree = buildFileTreeFromFileWorkspaceProviderEntries(entries);
        setState(tree);
        setReady(true);
        setSynced(providerState.ready && providerState.sourceState !== 'degraded');
        logCodeCollabDebug('provider file tree load completed', {
          providerKind: provider.kind,
          providerReady: providerState.ready,
          providerSourceState: providerState.sourceState,
          entryCount: entries.length,
          treeRootCount: tree.length,
          firstPaths: entries.slice(0, 5).map((entry) => entry.path),
          synced: providerState.ready && providerState.sourceState !== 'degraded',
          message: providerState.message ?? null,
        });
      } catch (error) {
        if (cancelled) return;
        warnCodeCollab('provider file tree load failed', {
          providerKind: provider.kind,
          providerReady: providerState.ready,
          providerSourceState: providerState.sourceState,
          error: error instanceof Error ? error.message : String(error),
        });
        setReady(true);
        setSynced(false);
        setMessage(error instanceof Error ? error.message : 'Failed to load files.');
      }
    })();

    const unsubscribeFiles = provider.subscribeFiles?.((entries) => {
      if (cancelled) return;
      const providerState = provider.getState();
      const tree = buildFileTreeFromFileWorkspaceProviderEntries(entries);
      setState(tree);
      setReady(true);
      setSynced(providerState.ready && providerState.sourceState !== 'degraded');
      setMessage(providerState.message);
      logCodeCollabDebug('provider file tree subscription update', {
        providerKind: provider.kind,
        entryCount: entries.length,
        treeRootCount: tree.length,
        synced: providerState.ready && providerState.sourceState !== 'degraded',
      });
    });

    return () => {
      cancelled = true;
      unsubscribeFiles?.();
    };
  }, [enabled, provider]);

  return { state, ready, synced, ...(message === undefined ? {} : { message }) };
};

export const useSessionFileProviderTree = useFileWorkspaceTree;
