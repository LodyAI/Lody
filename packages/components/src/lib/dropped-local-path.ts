import { isElectronRenderer } from '@/lib/electron';

/**
 * Turning a folder dropped from the OS into a `@path` mention.
 *
 * Only the desktop shell can name the path: Electron's preload exposes
 * `webUtils.getPathForFile`, the one sanctioned way to read a dropped `File`'s
 * location now that `File.path` is gone. Web and mobile have no equivalent, so
 * there a directory drop resolves to nothing — never to an upload, which is
 * what produced the failed attachment chip this replaces.
 */

type PathForFileBridge = {
  webUtils?: {
    getPathForFile?: (file: File) => string;
  };
};

/** Absolute on-disk path of a dropped `File`; null on web/mobile or an older preload. */
export function getDroppedFileLocalPath(file: File): string | null {
  if (!isElectronRenderer()) return null;
  const bridge = (window as unknown as { electron?: PathForFileBridge }).electron;
  const webUtils = bridge?.webUtils;
  if (typeof webUtils?.getPathForFile !== 'function') return null;
  try {
    const path = webUtils.getPathForFile(file);
    return typeof path === 'string' && path.trim() ? path : null;
  } catch {
    return null;
  }
}

export type PathMentionInsertion = {
  /** Absolute, forward-slash, no trailing slash. */
  path: string;
  kind: 'dir' | 'file';
};

/**
 * The mention a dropped path becomes: the ABSOLUTE path, deliberately. The
 * agent resolves it wherever its cwd is — a worktree, another project, the
 * home folder — where a path made relative to the wrong root would name the
 * wrong place, and the user can read exactly what was dropped.
 */
export function toPathMentionInsertion(
  absolutePath: string,
  kind: PathMentionInsertion['kind']
): PathMentionInsertion {
  const forward = absolutePath.replace(/\\/g, '/');
  const trimmed = forward.replace(/\/+$/, '');
  // Keep a bare filesystem root (`/`) rather than collapsing it to nothing.
  return { path: trimmed || (forward.startsWith('/') ? '/' : forward), kind };
}
