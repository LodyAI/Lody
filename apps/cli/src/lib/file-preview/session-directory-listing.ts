import {
  FILE_PREVIEW_PROTOCOL_VERSION,
  filePreviewV3Error,
  type SessionDirectoryEntry,
  type SessionDirectoryListRequest,
  type SessionDirectoryListResponse,
  type SessionId,
} from '@lody/shared';
import type { FilePreviewWorkspaceResolver } from './file-preview-service';

/** Mobile Project files lists at most this many entries per folder unless it asks for fewer. */
export const SESSION_DIRECTORY_LIST_DEFAULT_LIMIT = 2_000;

export type SessionDirectoryListingDeps = {
  /** The same resolver `file/preview` uses: the session's own workspace (its worktree). */
  readonly resolveWorkspace: FilePreviewWorkspaceResolver;
  /**
   * Lists one folder under `rootPath` with the local-project browser's rules: containment
   * on the symlink-resolved path, gitignore and VCS-directory exclusion, folders first.
   */
  readonly listDirectory: (
    rootPath: string,
    relativePath: string,
    limit: number
  ) => Promise<{ entries: readonly SessionDirectoryEntry[]; truncated: boolean }>;
};

/** A workspace-relative folder: no absolute paths, no `..`, no NUL; '' is the root. */
export function normalizeSessionDirectoryPath(value: string): string | null {
  const path = value
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  if (path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null;
  const segments = path === '' ? [] : path.split('/');
  if (segments.some((segment) => segment === '..')) return null;
  return segments.filter((segment) => segment !== '.').join('/');
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * `file/list-dir`: one folder of the session's own workspace, the root `file/preview`
 * reads from, so a listed file always opens. A plain read: it never activates Code
 * Collab, and every domain failure is a typed `status: 'error'` response.
 */
export async function listSessionDirectory(
  deps: SessionDirectoryListingDeps,
  request: SessionDirectoryListRequest
): Promise<SessionDirectoryListResponse> {
  const path = normalizeSessionDirectoryPath(request.path);
  if (path === null) return filePreviewV3Error('invalid_path', { message: 'Invalid folder path.' });
  const workspace = await deps.resolveWorkspace(request.sessionId as SessionId);
  if (!workspace.ok)
    return filePreviewV3Error(workspace.code, {
      message: workspace.message,
      retryable: workspace.code === 'transient_io' || workspace.code === 'machine_offline',
    });
  try {
    const listing = await deps.listDirectory(
      workspace.workspaceRoot,
      path,
      request.limit ?? SESSION_DIRECTORY_LIST_DEFAULT_LIMIT
    );
    return {
      status: 'ok',
      v: FILE_PREVIEW_PROTOCOL_VERSION,
      path,
      entries: listing.entries.map(({ name, type }) => ({ name, type })),
      truncated: listing.truncated,
    };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return filePreviewV3Error('file_not_found', { path: path || undefined });
    if (code === 'EACCES' || code === 'EPERM')
      return filePreviewV3Error('permission_denied', { path: path || undefined });
    const message = error instanceof Error ? error.message : '';
    // The local-project lister refuses escaping or ignored folders with plain errors.
    if (/escapes|not browsable/i.test(message))
      return filePreviewV3Error('path_not_allowed', { path: path || undefined });
    if (/not a directory/i.test(message))
      return filePreviewV3Error('invalid_path', { path: path || undefined });
    return filePreviewV3Error('transient_io', { path: path || undefined, retryable: true });
  }
}
