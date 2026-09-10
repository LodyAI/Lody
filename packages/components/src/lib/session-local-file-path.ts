const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;

/**
 * Joins a session workspace root with a workspace-relative viewer path so the
 * desktop bridge can reveal or open the real file.
 *
 * Absolute paths are accepted only for an explicitly local-machine target.
 * Parent-relative paths are also accepted only for that local target. This resolves identity;
 * callers must also gate shell actions on the Electron/local-machine boundary.
 */
export function resolveLocalWorkspaceFilePath(
  workspacePath: string | null | undefined,
  relativePath: string | null | undefined,
  allowExternalPaths = false
): string | null {
  const root = workspacePath?.trim();
  const relative = relativePath?.trim();
  if (!relative) return null;
  if (relative.startsWith('/') || relative.startsWith('\\') || WINDOWS_ABSOLUTE_PATH.test(relative))
    return allowExternalPaths ? relative : null;
  if (!root) return null;

  const segments = relative.split(/[\\/]+/u).filter((segment) => segment && segment !== '.');
  if (segments.length === 0 || (!allowExternalPaths && segments.includes('..'))) return null;

  // Windows roots arrive as `C:\...`; everything else is posix.
  const separator = WINDOWS_ABSOLUTE_PATH.test(root) && !root.includes('/') ? '\\' : '/';
  const normalizedRoot = root.replace(/[\\/]+$/u, '');
  return `${normalizedRoot}${separator}${segments.join(separator)}`;
}
