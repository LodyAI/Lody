import path from 'node:path';

export const CODE_COLLAB_IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'target',
  // pnpm's content-addressable store when `store-dir` sits inside the project.
  // It holds tens of thousands of cache files and is often not gitignored.
  '.pnpm-store',
]);

/**
 * Product-level cache policy shared by the watcher, FS fallback scans, and the
 * untracked half of Git listings. Git-tracked files are never filtered by it.
 */
export function isInCodeCollabIgnoredDirectory(workspacePath: string): boolean {
  return workspacePath
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .some((segment) => CODE_COLLAB_IGNORED_DIRECTORY_NAMES.has(segment));
}

export function shouldIgnoreWorkspaceWatchFilename(filename: string): boolean {
  return isInCodeCollabIgnoredDirectory(filename);
}

export function normalizeWorkspaceWatchFilename(filename: string | Buffer): string | null {
  const value = Buffer.isBuffer(filename) ? filename.toString('utf8') : filename;
  if (!value || value.includes('\0') || path.isAbsolute(value)) {
    return null;
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  return normalized === '..' || normalized.startsWith('../') ? null : normalized;
}
