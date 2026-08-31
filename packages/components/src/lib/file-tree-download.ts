import type { FileTreeItem } from '@lody/shared';

/**
 * Planning a "download this folder" against the file INDEX, before any bytes are
 * requested.
 *
 * A folder download is N File Preview reads plus one zip built in renderer
 * memory, so the plan is what keeps it bounded and what makes the refusal
 * explainable: the user is told the count that was too large, not just that it
 * failed. Kept free of React and of the provider so it can be tested directly.
 */

export const FILE_TREE_DOWNLOAD_LIMITS = {
  /**
   * One File Preview round trip per file, with no per-file progress to watch.
   * Past a few hundred this stops being a download and becomes a sync, which
   * wants a machine-side archive rather than this path.
   */
  maxFiles: 300,
  /**
   * The save bridge takes the finished archive as ONE structured clone
   * (`IMAGE_EXPORT_MAX_BYTES`, 64 MiB), and the zip is fully assembled in
   * renderer memory first.
   *
   * Applied to the raw bytes as an EARLY exit — it stops a hopeless download
   * before spending every round trip — and then to the finished archive, which
   * is the size that actually has to fit. Passing the raw check does not imply
   * passing the second one: deflate grows incompressible data and each entry
   * carries a local header plus a central-directory record, so 64 MiB of random
   * bytes lands at about 64.01 MiB.
   */
  maxTotalBytes: 64 * 1024 * 1024,
} as const;

export type FileTreeDownloadPlan =
  | {
      readonly status: 'ready';
      /** Workspace-relative paths, in tree order. */
      readonly filePaths: readonly string[];
    }
  | {
      /**
       * The subtree still holds directories the index has never listed, so the
       * file set is not knowable yet. Carries their ids so the caller can ask
       * the machine for them and make the retry succeed.
       */
      readonly status: 'needs-directory-load';
      readonly lazyDirectoryIds: readonly string[];
    }
  | { readonly status: 'empty' }
  | { readonly status: 'too-many-files'; readonly fileCount: number; readonly limit: number };

/**
 * Every file under `folderPath`, depth-first in tree order.
 *
 * An uninitialized lazy directory is NOT silently skipped: a zip that quietly
 * omits a subtree is indistinguishable from a complete one, so the whole plan
 * fails over to `needs-directory-load` instead.
 */
export function planFileTreeFolderDownload(
  items: readonly FileTreeItem[],
  folderPath: string,
  limits: { readonly maxFiles: number } = FILE_TREE_DOWNLOAD_LIMITS
): FileTreeDownloadPlan {
  const folder = findFileTreeItem(items, folderPath);
  if (!folder || folder.type !== 'directory') {
    return { status: 'empty' };
  }

  const filePaths: string[] = [];
  const lazyDirectoryIds: string[] = [];
  const walk = (node: FileTreeItem): void => {
    if (node.type === 'file') {
      filePaths.push(node.path);
      return;
    }
    const children = node.children ?? [];
    if (children.length === 0 && node.lazyDirectoryId !== undefined) {
      lazyDirectoryIds.push(node.lazyDirectoryId);
      return;
    }
    for (const child of children) {
      walk(child);
    }
  };
  walk(folder);

  if (lazyDirectoryIds.length > 0) {
    return { status: 'needs-directory-load', lazyDirectoryIds };
  }
  if (filePaths.length === 0) {
    return { status: 'empty' };
  }
  if (filePaths.length > limits.maxFiles) {
    return { status: 'too-many-files', fileCount: filePaths.length, limit: limits.maxFiles };
  }
  return { status: 'ready', filePaths };
}

export function findFileTreeItem(
  items: readonly FileTreeItem[],
  path: string
): FileTreeItem | null {
  for (const item of items) {
    if (item.path === path) return item;
    // Tree paths are `/`-joined workspace paths, so a subtree can only contain
    // `path` when it prefixes it at a segment boundary. Skipping the rest keeps
    // this linear in the depth of the target instead of the size of the tree.
    if (item.type === 'directory' && path.startsWith(`${item.path}/`)) {
      const found = findFileTreeItem(item.children ?? [], path);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Entry names inside the archive, relative to the folder's PARENT, so unzipping
 * recreates the folder itself rather than spilling its contents into the
 * destination.
 */
export function toArchiveEntryName(filePath: string, folderPath: string): string {
  const parentPath = folderPath.includes('/')
    ? folderPath.slice(0, folderPath.lastIndexOf('/'))
    : '';
  if (!parentPath) return filePath;
  return filePath.startsWith(`${parentPath}/`) ? filePath.slice(parentPath.length + 1) : filePath;
}
