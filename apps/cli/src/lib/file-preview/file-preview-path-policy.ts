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
  /**
   * Same-machine Electron preview only. The desktop user explicitly controls
   * this local IPC path, so it may inspect any readable regular file. Remote
   * File Preview v3 requests MUST leave this false and keep the root boundary.
   */
  readonly allowArbitraryPaths?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  /**
   * Overrides the two directory reads the tolerant walk makes. Only the WALK
   * uses it — realpath, stat and containment always go to the real filesystem —
   * so a test can force the fold branch to run while still exercising the real
   * authorization check. See `FilePreviewDirectoryReader`.
   */
  readonly directoryReader?: FilePreviewDirectoryReader;
};

/**
 * The two filesystem reads the tolerant walk needs, injectable so its folding
 * rule can be tested for real.
 *
 * Without this seam the walk is only reachable on a case- and
 * normalization-SENSITIVE volume: everywhere else `exists` answers true for the
 * requested spelling and the fold branch never runs. macOS ships
 * case-insensitive APFS by default, and this repository gates changes on a
 * local check rather than CI, so the fold rule would ship with no executed
 * coverage on the machine that approved it.
 */
export type FilePreviewDirectoryReader = {
  /** Follows symlinks, like `fs.existsSync`. False for a broken link. */
  readonly exists: (candidatePath: string) => boolean;
  /** Entry names in `directoryPath`, or null when it cannot be listed. */
  readonly readNames: (directoryPath: string) => readonly string[] | null;
};

const NODE_DIRECTORY_READER: FilePreviewDirectoryReader = {
  exists: (candidatePath) => fs.existsSync(candidatePath),
  readNames: (directoryPath) => {
    try {
      return fs.readdirSync(directoryPath);
    } catch {
      return null;
    }
  },
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
 * Exact, case-SENSITIVE containment.
 *
 * There is deliberately no case-insensitive fallback. It would be unsound on a
 * case-sensitive APFS volume, where `/Users/x/Data` and `/Users/x/data` are two
 * different directories — folding case there would treat one as contained in the
 * other and hand out files from outside the allowed root. It also buys almost
 * nothing: both sides of every comparison come from `realpathSync.native`, which
 * returns the on-disk casing, so a case-insensitive volume already yields
 * matching spellings on its own.
 */
function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  if (relativePath === '') return true;
  if (path.isAbsolute(relativePath)) return false;
  return relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`);
}

function expandHome(input: string, homeDir: string): string {
  if (input === '~') return homeDir;
  if (input.startsWith('~/') || input.startsWith(`~${path.sep}`)) {
    return path.join(homeDir, input.slice(2));
  }
  return input;
}

function toLexicalPath(input: string, workspaceRoot: string, homeDir: string): string {
  const expanded = expandHome(input, homeDir);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(workspaceRoot, expanded);
}

/**
 * The spellings of one request we are willing to look for on disk, in priority
 * order. The verbatim string always wins: a file really can be named `" a.md"`
 * or `"draft .md"`, and trimming first would make it permanently unopenable.
 * The trimmed spelling is only a fallback, for whitespace a caller picked up in
 * transit rather than from the filename.
 */
function buildLexicalCandidates(
  requested: string,
  workspaceRoot: string,
  homeDir: string
): readonly string[] {
  const spellings = requested.trim() === requested ? [requested] : [requested, requested.trim()];
  const candidates: string[] = [];
  for (const spelling of spellings) {
    const lexicalPath = toLexicalPath(spelling, workspaceRoot, homeDir);
    if (!candidates.includes(lexicalPath)) candidates.push(lexicalPath);
  }
  return candidates;
}

/**
 * Two spellings of one name that macOS, Linux and Git disagree about: letter
 * case, and Unicode normalization (`é` as one code point vs `e` + U+0301).
 * Matches `pathSegmentComparisonKey` in `code-collab-v2-service.ts` on purpose —
 * the file index is built with that key, so a path the index hands us must
 * resolve by the same rule here.
 */
function pathSegmentComparisonKey(segment: string): string {
  return segment.normalize('NFC').toLocaleLowerCase('en-US');
}

/**
 * Find the real on-disk spelling of `relativePath` under `rootPath`, tolerating
 * case and Unicode-normalization differences per segment.
 *
 * This is RESOLUTION, not authorization, and the distinction is the whole
 * reason it is sound. It never widens what may be read: each step appends one
 * segment to the directory it is standing in — either the requested name
 * verbatim, or a single listed entry that folds to it — and `.`/`..` are
 * refused outright, so the walk cannot climb, jump absolute, or invent a
 * segment. Whatever it returns still goes through the unchanged
 * symlink-resolved, case-SENSITIVE containment check below, so a directory that
 * is a symlink out of the root is still rejected there, exactly as before.
 * (The walk may LIST a directory outside the root when it is reached through
 * such a symlink; it can still never return a readable path from one.)
 *
 * Why it has to exist, precisely — the two halves are not the same claim:
 * - NFC/NFD is a RESTORATION. `code-collab/open-text` resolved it
 *   (`resolveExistingPathWithoutConflicts`), v3 replaced that with a raw
 *   `path.resolve`, and files that had always opened stopped opening. A file
 *   index holding the NFC spelling of a name stored on disk as NFD is routine.
 * - Letter case is NEW tolerance. `open-text` never resolved it: its match test
 *   is `entry.name === segment` then NFC-equality, so `readme.md` never found
 *   `README.md` there either. Folding case is a deliberate widening for agents
 *   that write a path from memory with the wrong case on a case-sensitive
 *   volume. Note that WRITES stay case-exact — see the asymmetry recorded in
 *   this directory's AGENTS.md.
 *
 * Ambiguity declines instead of guessing: if more than one entry answers to the
 * folded spelling, the caller keeps its `file_not_found`.
 *
 * Exported for its own unit tests — see `FilePreviewDirectoryReader` for why the
 * fold rule cannot be exercised through the public entry point on a typical
 * development machine.
 */
export function resolveExistingPathIgnoringCaseAndNormalization(
  rootPath: string,
  relativePath: string,
  reader: FilePreviewDirectoryReader = NODE_DIRECTORY_READER
): string | null {
  const segments = relativePath.split(path.sep).filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  // The caller only reaches here with a path already known to be inside the
  // root, so `path.relative` cannot have produced these. Refusing them anyway
  // keeps this function safe to read on its own: the exact-name probe below
  // would happily walk `..` upward if a future caller passed one.
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;

  let currentPath = rootPath;
  for (const segment of segments) {
    // Usually only the last segment is spelled differently, so probe the exact
    // name first: one `existsSync` instead of listing a directory that may hold
    // a hundred thousand entries (`node_modules/.pnpm`). This walk is synchronous
    // like the rest of the policy, so an avoidable `readdirSync` is event-loop
    // time the daemon does not get back.
    const exactPath = path.join(currentPath, segment);
    if (reader.exists(exactPath)) {
      currentPath = exactPath;
      continue;
    }
    const entryNames = reader.readNames(currentPath);
    if (entryNames === null) return null;
    const comparisonKey = pathSegmentComparisonKey(segment);
    const matches = entryNames.filter((name) => pathSegmentComparisonKey(name) === comparisonKey);
    // Exactly one real file may answer to a folded spelling, or we decline. The
    // ambiguity test MUST come before any preferred-match pick: `café.md` in NFC
    // and in NFD are two different files that both look "exact" once you compare
    // normalized, so picking one would hand back whichever `readdir` listed
    // first. The byte-identical name was already taken by the probe above, so
    // reaching here means no spelling is unambiguously right.
    // `code-collab-v2-service.ts` rejects the same case as `path_conflict`.
    if (matches.length !== 1) return null;
    currentPath = path.join(currentPath, matches[0] as string);
  }
  return currentPath;
}

/**
 * Retry a missed path against the real on-disk spelling, under the workspace
 * root only. The extra roots (tmpdir, chats) hold machine-generated names that
 * no index round-trips, so they have nothing to reconcile.
 */
function resolveWorkspacePathTolerantly(
  lexicalPath: string,
  workspaceRoots: readonly string[],
  reader: FilePreviewDirectoryReader
): string | null {
  for (const root of workspaceRoots) {
    if (!isWithinRoot(root, lexicalPath)) continue;
    const relativePath = path.relative(root, lexicalPath);
    if (!relativePath) continue;
    const resolved = resolveExistingPathIgnoringCaseAndNormalization(root, relativePath, reader);
    if (resolved !== null) return resolved;
  }
  return null;
}

/**
 * Resolve and authorize a requested preview path.
 *
 * Order matters: containment is checked against the SYMLINK-RESOLVED target, so
 * a symlink inside the workspace pointing at `~/.ssh/id_rsa` is rejected. When
 * the target does not exist we still verify the lexical path is inside an
 * allowed root before reporting `file_not_found`, so a remote caller cannot
 * use not-found vs not-allowed as an existence probe outside the boundary.
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
  const lexicalCandidates = buildLexicalCandidates(requested, workspaceRoot, homeDir);

  const extraRoots = args.extraRoots ?? getDefaultFilePreviewExtraRoots(args.options);
  const realWorkspaceRoot = resolveRealPathOrNull(workspaceRoot) ?? workspaceRoot;
  // Authorization compares symlink-resolved paths only.
  const realRoots = [realWorkspaceRoot, ...extraRoots.map(resolveRealPathOrNull)].filter(
    (root): root is string => root !== null
  );
  // Classification-only root set, used when the target does NOT exist and so has
  // no realpath to compare. A root is very often reached through a symlink —
  // macOS `os.tmpdir()` is `/var/folders/…`, which really lives at
  // `/private/var/folders/…` — so comparing an unresolved lexical path against
  // resolved roots alone never matches, and every missing temp file would be
  // reported as "outside the workspace" instead of "not found". Widening here is
  // safe: the file does not exist on either spelling, so this only picks the
  // error message, never grants a read.
  const classificationRoots = [...realRoots, workspaceRoot, ...extraRoots];

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

  // Find a spelling that exists. Everything below authorizes whatever this
  // step landed on, unchanged — resolution never grants a read on its own.
  let realTarget: string | null = null;
  for (const candidate of lexicalCandidates) {
    realTarget = resolveRealPathOrNull(candidate);
    if (realTarget !== null) break;
  }
  if (realTarget === null) {
    // Nothing matched literally. Before calling it missing, look for the real
    // on-disk spelling of the name (case / Unicode normalization), which is how
    // `code-collab/open-text` always resolved and what the file index encodes.
    // Both spellings of the root are needed only when they actually differ (the
    // lexical candidate is built from the unresolved one, so on macOS
    // `/var/folders/…` vs `/private/var/folders/…` only one of them contains
    // it). Passing the same string twice runs the whole synchronous walk twice.
    const tolerantRoots =
      realWorkspaceRoot === workspaceRoot ? [workspaceRoot] : [realWorkspaceRoot, workspaceRoot];
    const reader = args.options?.directoryReader ?? NODE_DIRECTORY_READER;
    for (const candidate of lexicalCandidates) {
      const tolerant = resolveWorkspacePathTolerantly(candidate, tolerantRoots, reader);
      if (tolerant !== null) {
        realTarget = resolveRealPathOrNull(tolerant);
        if (realTarget !== null) break;
      }
    }
  }
  if (realTarget === null) {
    if (args.options?.allowArbitraryPaths) {
      return { ok: false, rejection: { code: 'file_not_found', message: 'File was not found.' } };
    }
    // Only reveal "missing" when EVERY spelling we were willing to look for is
    // inside an allowed root. `every`, not `some` — `some` turns the two codes
    // into an existence oracle for the whole filesystem: `" /etc/passwd"` keeps
    // the leading space in the verbatim candidate, so that one resolves under
    // the workspace and vouches for the trimmed candidate that actually escaped.
    // The caller then reads `file_not_found` vs `path_not_allowed` as "does this
    // path exist outside the workspace", which the boundary exists to prevent.
    return lexicalCandidates.every((candidate) =>
      classificationRoots.some((root) => isWithinRoot(root, candidate))
    )
      ? { ok: false, rejection: { code: 'file_not_found', message: 'File was not found.' } }
      : notAllowed;
  }
  if (
    !args.options?.allowArbitraryPaths &&
    !realRoots.some((root) => isWithinRoot(root, realTarget))
  ) {
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
