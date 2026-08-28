import * as crypto from 'crypto';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Directory (relative to the session workspace root) where human→agent file
 * attachments are materialized. Excluded from version control and from
 * code-collab file watching. Kept under `.lody/` so a single ignore entry
 * covers all Lody-managed runtime state.
 */
export const ATTACHMENTS_DIR_RELATIVE = path.join('.lody', 'attachments');

/** The path segment we ensure is present in `.git/info/exclude`. */
export const ATTACHMENTS_EXCLUDE_ENTRY = '.lody/';

const EXCLUDE_HEADER_COMMENT =
  '# Added by Lody: runtime state and session file attachments (do not commit).';

/**
 * Sanitize an untrusted file name into a single safe path component:
 * - strip any directory portion (so `../../etc/passwd` → `passwd`);
 * - replace path separators, control chars, and reserved characters with `_`;
 * - collapse leading dots so the result can never become `.`/`..` or a dotfile
 *   that hides the attachment;
 * - bound the length.
 *
 * Pure and unit-testable.
 */
export const sanitizeAttachmentFileName = (rawName: string): string => {
  // Take only the final path component; treat both separators as boundaries.
  const normalized = rawName.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const base = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;

  const cleaned = Array.from(base)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      // Control chars, DEL, and characters that are unsafe across filesystems.
      if (code < 0x20 || code === 0x7f) {
        return '_';
      }
      if (char === '/' || char === '\\' || char === ':' || char === '\0') {
        return '_';
      }
      return char;
    })
    .join('')
    .trim();

  // Drop leading dots and whitespace so we never produce `.`, `..`, or a
  // hidden dotfile from the original name.
  const withoutLeadingDots = cleaned.replace(/^[.\s]+/, '');
  const bounded = withoutLeadingDots.slice(0, 200).trim();
  return bounded.length > 0 ? bounded : 'file';
};

/**
 * Build the workspace-relative destination path for a materialized attachment:
 * `.lody/attachments/<fileId first 8 chars>-<sanitized name>`. If that name is
 * already taken (collision), a numeric suffix is added before the extension.
 *
 * `existingNames` is the set of basenames already present in the attachments
 * directory; callers pass the on-disk listing. Pure and unit-testable.
 */
export const buildAttachmentFileName = (
  fileId: string,
  rawFileName: string,
  existingNames: ReadonlySet<string> = new Set()
): string => {
  const prefix = fileId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'file';
  const safeName = sanitizeAttachmentFileName(rawFileName);
  const base = `${prefix}-${safeName}`;

  if (!existingNames.has(base)) {
    return base;
  }

  const ext = path.extname(safeName);
  const stem = ext.length > 0 ? base.slice(0, base.length - ext.length) : base;
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }
  // Extremely unlikely fallback: append a random token.
  return `${stem}-${crypto.randomBytes(4).toString('hex')}${ext}`;
};

/**
 * Compute the lines that should be present in a `.git/info/exclude` file after
 * ensuring the attachments entry is included. Returns `null` when the existing
 * content already contains the entry (idempotent no-op). Otherwise returns the
 * full new file content with a commented header explaining provenance.
 *
 * Pure and unit-testable.
 */
export const computeExcludeFileContent = (existingContent: string): string | null => {
  const lines = existingContent.split('\n');
  const hasEntry = lines.some((line) => line.trim() === ATTACHMENTS_EXCLUDE_ENTRY);
  if (hasEntry) {
    return null;
  }

  const trimmedEnd = existingContent.replace(/\n+$/, '');
  const parts: string[] = [];
  if (trimmedEnd.length > 0) {
    parts.push(trimmedEnd, '');
  }
  parts.push(EXCLUDE_HEADER_COMMENT, ATTACHMENTS_EXCLUDE_ENTRY, '');
  return parts.join('\n');
};

/**
 * Resolve the absolute path to the git repo's `info/exclude` file for a
 * workspace, honoring worktrees and submodules (where `.git` is a file
 * pointing at the real gitdir). Returns `null` when the workspace is not a git
 * repository.
 */
export const resolveGitInfoExcludePath = async (workspaceRoot: string): Promise<string | null> => {
  try {
    // `--git-path info/exclude` resolves correctly for worktrees/submodules.
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    const raw = stdout.trim();
    if (!raw) {
      return null;
    }
    return path.isAbsolute(raw) ? raw : path.resolve(workspaceRoot, raw);
  } catch {
    // Not a git repo (or git unavailable) → nothing to maintain.
    return null;
  }
};

/**
 * Ensure `.lody/` is listed in the workspace's `.git/info/exclude`. Idempotent;
 * a no-op for non-git workspaces. Failures are swallowed by the caller (the
 * attachment still works; it just may show up as an untracked change).
 */
export const ensureAttachmentsGitExcluded = async (workspaceRoot: string): Promise<void> => {
  const excludePath = await resolveGitInfoExcludePath(workspaceRoot);
  if (!excludePath) {
    return;
  }

  let existing = '';
  try {
    existing = await fs.promises.readFile(excludePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') {
      throw error;
    }
    // Missing exclude file is fine; we create it below.
  }

  const next = computeExcludeFileContent(existing);
  if (next === null) {
    return;
  }

  await fs.promises.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.promises.writeFile(excludePath, next, 'utf8');
};

/** Hex sha256 of a buffer. */
export const sha256Hex = (bytes: Uint8Array): string => {
  return crypto.createHash('sha256').update(bytes).digest('hex');
};

const formatSizeForPrompt = (sizeBytes: number): string => {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = sizeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
};

/**
 * Build the prompt text block that references a materialized attachment by
 * name, size, type, and workspace-relative path. File contents are NEVER
 * inlined (decision #7); the agent decides what to read.
 *
 * Pure and unit-testable.
 */
/**
 * Format an untrusted display name for prompt text.
 * File names are caller-supplied and may contain brackets or line breaks.
 */
export const formatUntrustedFileNameForPrompt = (fileName: string): string => {
  return fileName.replaceAll('\\', '\\\\').replaceAll(']', '\\]').replaceAll(/[\r\n]+/g, ' ');
};

export const buildAttachmentPromptText = (args: {
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  relativePath: string;
}): string => {
  const size = formatSizeForPrompt(args.sizeBytes);
  const mime = args.mimeType.trim() || 'application/octet-stream';
  const fileName = formatUntrustedFileNameForPrompt(args.fileName);
  return `[User sent a file: ${fileName} (${size}, ${mime})]\nSaved to: ${args.relativePath}`;
};

/** Prompt text for a file that could not be downloaded yet (e.g. r2 404). */
export const buildUnavailableAttachmentPromptText = (args: {
  fileName: string;
  sizeBytes: number;
  mimeType: string;
}): string => {
  const size = formatSizeForPrompt(args.sizeBytes);
  const mime = args.mimeType.trim() || 'application/octet-stream';
  const fileName = formatUntrustedFileNameForPrompt(args.fileName);
  return `[User sent a file: ${fileName} (${size}, ${mime})]\nThe file is not available yet and could not be downloaded; ask the user to resend it if you need its contents.`;
};

/**
 * Resolve an agent-supplied upload path and enforce session-workspace
 * containment. Relative paths resolve against the workspace root; the
 * candidate's PARENT directory is canonicalized with realpath so symlinked
 * intermediate directories cannot escape the root (the final component is
 * separately protected by the caller's O_NOFOLLOW open).
 *
 * This is the security boundary for the agent-facing `lody_upload_files`
 * channel: the agent's own filesystem tools gate out-of-workspace reads behind
 * user approval, and an upload tool that accepted arbitrary host paths would
 * silently bypass that gate (e.g. exfiltrate `~/.ssh`). The desktop
 * local-handoff channel (`session/file-send-local`) intentionally does NOT use
 * this check — its caller is the user's own desktop app staging user-picked
 * files via tmpdir, with the same privileges as the user.
 *
 * Pure aside from filesystem reads; unit-testable.
 */
export const resolveContainedUploadPath = async (
  filePath: string,
  workspaceRoot: string
): Promise<string> => {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new Error('File path is empty');
  }
  const candidate = path.isAbsolute(trimmed) ? trimmed : path.resolve(workspaceRoot, trimmed);

  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(workspaceRoot);
  } catch (error) {
    throw new Error(`Session workspace root is not accessible: ${workspaceRoot}`, {
      cause: error,
    });
  }
  let realParent: string;
  try {
    realParent = await fs.promises.realpath(path.dirname(candidate));
  } catch (error) {
    throw new Error(`File not found: ${filePath}`, { cause: error });
  }

  const contained = realParent === realRoot || realParent.startsWith(realRoot + path.sep);
  if (!contained) {
    throw new Error(
      `File is outside the session workspace: ${filePath}. ` +
        'Copy it into the workspace first, then upload the workspace path.'
    );
  }
  return path.join(realParent, path.basename(candidate));
};
