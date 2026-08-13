import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

/**
 * Which paths File Preview v3 is allowed to read.
 *
 * The session workspace is the primary root. Preview additionally serves a small,
 * FIXED set of extra roots so an agent-produced temporary file is previewable:
 * the OS temp directory and Lody's own chat working directories. Everything else
 * — the user's home directory included — is rejected with `path_not_allowed`.
 *
 * Deliberately NOT allowlisted: the `.lody` data directory root. It holds
 * `credentials.json` and the git credential broker state, so the roots below
 * name specific subdirectories instead of the parent.
 *
 * `LODY_FILE_PREVIEW_EXTRA_ROOTS` (platform path-delimiter separated) is the one
 * explicit opt-in for widening this on a machine the operator controls.
 */
export const FILE_PREVIEW_EXTRA_ROOTS_ENV_VAR = 'LODY_FILE_PREVIEW_EXTRA_ROOTS';

export type FilePreviewPathRejection =
  | { readonly code: 'invalid_path'; readonly message: string }
  | { readonly code: 'path_not_allowed'; readonly message: string }
  | { readonly code: 'file_not_found'; readonly message: string }
  | { readonly code: 'not_a_file'; readonly message: string }
  | { readonly code: 'permission_denied'; readonly message: string }
  | { readonly code: 'transient_io'; readonly message: string };

export type ResolvedPreviewPath = {
  /** The real (symlink-resolved) absolute path to read. */
  readonly absolutePath: string;
  /**
   * Workspace-relative POSIX path when the file lives inside the workspace root,
   * otherwise the absolute path. This is what the response reports back.
   */
  readonly reportedPath: string;
  /** True when the file resolved outside the session workspace root. */
  readonly external: boolean;
  readonly sizeBytes: number;
};

export type FilePreviewPathResolution =
  | { readonly ok: true; readonly resolved: ResolvedPreviewPath }
  | { readonly ok: false; readonly rejection: FilePreviewPathRejection };

export type FilePreviewPathPolicyOptions = {
  /** Overrides the fixed extra roots. Tests pass an empty array or a temp dir. */
  readonly extraRoots?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
};

/**
 * The fixed extra roots, before symlink resolution. Missing directories are fine:
 * `resolveRealPathOrNull` drops them, and a root that cannot be resolved simply
 * grants nothing.
 */
export function getDefaultFilePreviewExtraRoots(
  options: FilePreviewPathPolicyOptions = {}
): readonly string[] {
  const env = options.env ?? process.env;
  const configured = (env[FILE_PREVIEW_EXTRA_ROOTS_ENV_VAR] ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry));
  return [
    os.tmpdir(),
    // Chat sessions without a repository run in this directory, so an agent that
    // writes a file "in the working directory" lands here.
    path.join(getLodyDataDir(undefined, options.homeDir), 'chats'),
    ...configured,
  ];
}

function resolveRealPathOrNull(candidate: string): string | null {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    try {
      return fs.realpathSync(candidate);
    } catch {
      return null;
    }
  }
}

/**
 * Case-insensitive on macOS/Windows because their default filesystems are, so a
 * case-differing prefix comparison would reject a legitimately contained path.
 */
function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  if (relativePath === '') return true;
  if (path.isAbsolute(relativePath)) return false;
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return false;
    const caseInsensitive = path.relative(rootPath.toLowerCase(), targetPath.toLowerCase());
    return (
      caseInsensitive !== '' &&
      !path.isAbsolute(caseInsensitive) &&
      caseInsensitive !== '..' &&
      !caseInsensitive.startsWith(`..${path.sep}`)
    );
  }
  return true;
}

function expandHome(input: string, homeDir: string): string {
  if (input === '~') return homeDir;
  if (input.startsWith('~/') || input.startsWith(`~${path.sep}`)) {
    return path.join(homeDir, input.slice(2));
  }
  return input;
}

/**
 * Resolve and authorize a requested preview path.
 *
 * Order matters: containment is checked against the SYMLINK-RESOLVED target, so
 * a symlink inside the workspace pointing at `~/.ssh/id_rsa` is rejected. When
 * the target does not exist we still verify the lexical path is inside an
 * allowed root before reporting `file_not_found`, so a caller cannot use
 * not-found vs not-allowed as an existence probe outside the boundary.
 */
export function resolveFilePreviewPath(args: {
  readonly workspaceRoot: string;
  readonly requestedPath: string;
  readonly extraRoots?: readonly string[];
  readonly options?: FilePreviewPathPolicyOptions;
}): FilePreviewPathResolution {
  const requested = args.requestedPath;
  if (requested.includes('\0')) {
    return {
      ok: false,
      rejection: { code: 'invalid_path', message: 'Path contains a NUL byte.' },
    };
  }
  const trimmed = requested.trim();
  if (!trimmed) {
    return { ok: false, rejection: { code: 'invalid_path', message: 'Path is empty.' } };
  }

  const homeDir = args.options?.homeDir ?? os.homedir();
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const expanded = expandHome(trimmed, homeDir);
  const lexicalPath = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(workspaceRoot, expanded);

  const extraRoots = args.extraRoots ?? getDefaultFilePreviewExtraRoots(args.options);
  const realWorkspaceRoot = resolveRealPathOrNull(workspaceRoot) ?? workspaceRoot;
  const realRoots = [realWorkspaceRoot, ...extraRoots.map(resolveRealPathOrNull)].filter(
    (root): root is string => root !== null
  );

  const notAllowed: FilePreviewPathResolution = {
    ok: false,
    rejection: {
      code: 'path_not_allowed',
      // The wording matters: the web error surface keys the dedicated
      // "outside the workspace" presentation off this phrase.
      message:
        'File is outside the workspace: preview is limited to this session’s workspace and Lody temporary directories.',
    },
  };

  const realTarget = resolveRealPathOrNull(lexicalPath);
  if (realTarget === null) {
    // Only reveal "missing" for a path that would have been allowed anyway.
    return realRoots.some((root) => isWithinRoot(root, lexicalPath))
      ? { ok: false, rejection: { code: 'file_not_found', message: 'File was not found.' } }
      : notAllowed;
  }
  if (!realRoots.some((root) => isWithinRoot(root, realTarget))) {
    return notAllowed;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realTarget);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, rejection: { code: 'file_not_found', message: 'File was not found.' } };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        ok: false,
        rejection: { code: 'permission_denied', message: 'Permission denied.' },
      };
    }
    return {
      ok: false,
      rejection: { code: 'transient_io', message: 'File could not be inspected.' },
    };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      rejection: { code: 'not_a_file', message: 'Only regular files can be previewed.' },
    };
  }

  const workspaceRelative = path.relative(realWorkspaceRoot, realTarget);
  const external = !isWithinRoot(realWorkspaceRoot, realTarget);
  return {
    ok: true,
    resolved: {
      absolutePath: realTarget,
      reportedPath: external ? realTarget : workspaceRelative.split(path.sep).join('/'),
      external,
      sizeBytes: stat.size,
    },
  };
}
