const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;
// `~` or `~/...` (either separator). The `~user` form is not home-rooted here:
// other users' homes cannot be resolved, so it stays workspace-relative.
const HOME_ROOTED_PATH = /^~(?:[\\/]|$)/u;

/**
 * True for host-absolute paths (POSIX, Windows drive, or Windows UNC). The
 * session file surfaces use this to decide whether a path already carries its
 * own absolute identity instead of one derived from the workspace root.
 */
export function isAbsoluteFilePath(path: string | null | undefined): boolean {
  const trimmed = path?.trim();
  if (!trimmed) return false;
  return trimmed.startsWith('/') || trimmed.startsWith('\\') || WINDOWS_ABSOLUTE_PATH.test(trimmed);
}

function joinHostPath(root: string, segments: readonly string[]): string {
  // Windows roots arrive as `C:\...`; everything else is posix.
  const separator = WINDOWS_ABSOLUTE_PATH.test(root) && !root.includes('/') ? '\\' : '/';
  const normalizedRoot = root.replace(/[\\/]+$/u, '');
  return segments.length === 0
    ? normalizedRoot
    : `${normalizedRoot}${separator}${segments.join(separator)}`;
}

/**
 * Joins a session workspace root with a workspace-relative viewer path so the
 * desktop bridge can reveal or open the real file.
 *
 * Absolute paths are accepted only for an explicitly local-machine target.
 * Parent-relative paths are also accepted only for that local target. A
 * home-rooted `~/...` path expands against `homeDir` under that same local
 * gate and stays unresolved while the home directory is unknown — it is never
 * joined onto the workspace root. This resolves identity; callers must also
 * gate shell actions on the Electron/local-machine boundary.
 */
export function resolveLocalWorkspaceFilePath(
  workspacePath: string | null | undefined,
  relativePath: string | null | undefined,
  allowExternalPaths = false,
  homeDir?: string | null
): string | null {
  const root = workspacePath?.trim();
  const relative = relativePath?.trim();
  if (!relative) return null;
  if (isAbsoluteFilePath(relative)) return allowExternalPaths ? relative : null;
  if (HOME_ROOTED_PATH.test(relative)) {
    const home = homeDir?.trim();
    if (!allowExternalPaths || !home) return null;
    const segments = relative
      .slice(1)
      .split(/[\\/]+/u)
      .filter((segment) => segment && segment !== '.');
    return joinHostPath(home, segments);
  }
  if (!root) return null;

  const segments = relative.split(/[\\/]+/u).filter((segment) => segment && segment !== '.');
  if (segments.length === 0 || (!allowExternalPaths && segments.includes('..'))) return null;

  return joinHostPath(root, segments);
}
