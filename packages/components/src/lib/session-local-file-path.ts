const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;

/**
 * Joins a session workspace root with a workspace-relative viewer path so the
 * desktop bridge can reveal or open the real file.
 *
 * Only a genuinely relative path is joinable: an absolute path did not come
 * from this workspace, and a `..` segment would escape it. Both resolve to
 * `null` rather than to a path handed to the OS.
 */
export function resolveLocalWorkspaceFilePath(
  workspacePath: string | null | undefined,
  relativePath: string | null | undefined
): string | null {
  const root = workspacePath?.trim();
  const relative = relativePath?.trim();
  if (!root || !relative) return null;
  if (relative.startsWith('/') || relative.startsWith('\\') || WINDOWS_ABSOLUTE_PATH.test(relative))
    return null;

  const segments = relative.split(/[\\/]+/u).filter((segment) => segment && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;

  // Windows roots arrive as `C:\...`; everything else is posix.
  const separator = WINDOWS_ABSOLUTE_PATH.test(root) && !root.includes('/') ? '\\' : '/';
  const normalizedRoot = root.replace(/[\\/]+$/u, '');
  return `${normalizedRoot}${separator}${segments.join(separator)}`;
}
