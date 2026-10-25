import {
  decodeSessionFilePath,
  getProjectMemberRootId,
  MAIN_SESSION_FILE_ROOT_ID,
  type ProjectMemberId,
  type SessionProjectRun,
} from '@lody/shared';

/**
 * Where a Project group member that lives outside the main directory appears
 * in the session's file surfaces.
 *
 * Members accessed as an additional directory or a link are separate file
 * roots on the machine, and synced data names their files with an encoded key
 * (`\0lody-root:member:<id>/<path>`) that is never a filesystem path. The file
 * tree, `@` search and open actions all speak in one path namespace, so each
 * such root is shown at the member's directory name — exactly where a link
 * would have put it — and requests are split back into `rootId` + relative
 * path at the transport boundary. Nothing here grants access: the machine
 * resolves every root from its own registry and authorizes the real path.
 */
export type SessionFileRootMount = {
  readonly rootId: string;
  readonly memberId: ProjectMemberId;
  /** Display prefix, e.g. `docs`. */
  readonly mountPath: string;
};

export type SessionFileRootMounts = readonly SessionFileRootMount[];

export const EMPTY_SESSION_FILE_ROOT_MOUNTS: SessionFileRootMounts = Object.freeze([]);

export function buildSessionFileRootMounts(
  projectRun: SessionProjectRun | null | undefined
): SessionFileRootMounts {
  if (!projectRun) return EMPTY_SESSION_FILE_ROOT_MOUNTS;
  const mounts: SessionFileRootMount[] = [];
  for (const [memberId, member] of Object.entries(projectRun.members)) {
    if (member.access !== 'additional' && member.access !== 'link') continue;
    mounts.push({
      rootId: getProjectMemberRootId(memberId),
      memberId: memberId as ProjectMemberId,
      mountPath: member.path,
    });
  }
  return mounts.length === 0 ? EMPTY_SESSION_FILE_ROOT_MOUNTS : mounts;
}

/** A stable key for memoization: mounts change only when the snapshot does. */
export function getSessionFileRootMountsKey(mounts: SessionFileRootMounts): string {
  return mounts.map((mount) => `${mount.rootId}=${mount.mountPath}`).join('\n');
}

/**
 * The path a synced key is shown at. Main paths are unchanged; a member key is
 * shown under its mount. A key whose root this snapshot does not mount (an
 * older snapshot, a removed member) is shown under a neutral prefix rather
 * than as a raw key with a NUL in it.
 */
export function toSessionFileDisplayPath(key: string, mounts: SessionFileRootMounts): string {
  const decoded = decodeSessionFilePath(key);
  if (!decoded) return key;
  if (decoded.rootId === MAIN_SESSION_FILE_ROOT_ID) return decoded.relativePath;
  const mount = mounts.find((candidate) => candidate.rootId === decoded.rootId);
  const prefix = mount?.mountPath ?? decoded.rootId.replace(/^member:/, 'member-');
  return `${prefix}/${decoded.relativePath}`;
}

export type SessionFileRequestPath = { readonly path: string; readonly rootId?: string };

/**
 * Split a display path (or a raw synced key) into what a file RPC takes.
 * Anything not under a mount stays a main-root path, unchanged, so sessions
 * without extra roots send exactly what they sent before.
 */
export function toSessionFileRequestPath(
  path: string,
  mounts: SessionFileRootMounts
): SessionFileRequestPath {
  if (path.startsWith('\0')) {
    const decoded = decodeSessionFilePath(path);
    if (decoded && decoded.rootId !== MAIN_SESSION_FILE_ROOT_ID) {
      return { rootId: decoded.rootId, path: decoded.relativePath };
    }
    return { path: decoded?.relativePath ?? path };
  }
  if (mounts.length === 0) return { path };
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const mount of mounts) {
    const prefix = `${mount.mountPath}/`;
    if (normalized.startsWith(prefix) && normalized.length > prefix.length) {
      return { rootId: mount.rootId, path: normalized.slice(prefix.length) };
    }
  }
  return { path };
}

/** Re-key a path-keyed record (file tree, All Changes) into display paths. */
export function remapSessionFileRecord<T>(
  record: Readonly<Record<string, T>>,
  mounts: SessionFileRootMounts
): Record<string, T> {
  const keys = Object.keys(record);
  if (!keys.some((key) => key.startsWith('\0'))) return record as Record<string, T>;
  const remapped: Record<string, T> = {};
  for (const key of keys) {
    remapped[toSessionFileDisplayPath(key, mounts)] = record[key] as T;
  }
  return remapped;
}
