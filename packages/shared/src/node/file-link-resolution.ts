import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  filePreviewV3Error,
  type FileLinkCandidate,
  type FileLinkResolution,
  type FilePreviewV3Error,
} from '@lody/shared/file-preview';
import {
  resolveFilePreviewPath,
  type ResolvedPreviewPath,
} from '@lody/shared/node/file-preview-path-policy';
import { runCommandTextLegacy } from '@lody/shared/node/process';

const MAX_WORKTREES = 128;
const MISSING_CODES: readonly string[] = ['file_not_found', 'not_a_file'];

const WorktreeSchema = z.object({
  root: z.string().min(1).refine(path.isAbsolute),
  head: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .nullable(),
  branch: z.string().nullable(),
});
type Worktree = z.infer<typeof WorktreeSchema>;

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

/** -z avoids Git's quoting of spaces, Unicode, tabs and newlines in paths. */
export function parseFileLinkWorktrees(output: string): Worktree[] {
  return output
    .split('\0\0')
    .filter(Boolean)
    .map((record) => {
      const fields = record.split('\0');
      const value = (prefix: string) =>
        fields.find((field) => field.startsWith(prefix))?.slice(prefix.length) ?? null;
      return WorktreeSchema.parse({
        root: value('worktree '),
        head: value('HEAD '),
        branch: value('branch '),
      });
    });
}

async function listWorktrees(root: string): Promise<Worktree[]> {
  // Ordinary chat directories need no Git; only a checkout root opts into discovery.
  if (!fs.existsSync(path.join(root, '.git'))) return [];
  const result = await runCommandTextLegacy({
    command: 'git',
    args: ['--no-optional-locks', '-C', root, 'worktree', 'list', '--porcelain', '-z'],
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
    ),
    timeout: 5_000,
    maxOutputBytes: 256 * 1024,
    check: 'exit-0',
  });
  return parseFileLinkWorktrees(result.stdout);
}

/**
 * Same-repository worktrees physically inside the session root. Discovery is
 * best effort: when Git is unavailable or its output unusable, the link keeps
 * its pre-discovery meaning (the session root alone) instead of failing.
 */
async function containedWorktrees(
  workspaceRoot: string,
  realRoot: string,
  discover: (root: string) => Promise<readonly Worktree[]>
): Promise<Worktree[]> {
  let listed: readonly Worktree[];
  try {
    listed = await discover(workspaceRoot);
  } catch {
    return [];
  }
  if (listed.length > MAX_WORKTREES) return [];
  const contained: Worktree[] = [];
  for (const tree of listed) {
    if (!within(realRoot, tree.root) && !within(workspaceRoot, tree.root)) continue;
    let root: string;
    try {
      root = fs.realpathSync(tree.root);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    // Symlinked worktrees must not escape the session root.
    if (within(realRoot, root)) contained.push({ ...tree, root });
  }
  return contained;
}

/** Resolve identities only. Selecting or discovering a path never grants a read. */
export async function resolveMarkdownFileLink(
  args: Parameters<typeof resolveFilePreviewPath>[0],
  discover: (root: string) => Promise<readonly Worktree[]> = listWorktrees
): Promise<FileLinkResolution | FilePreviewV3Error> {
  const { workspaceRoot, requestedPath } = args;
  try {
    const direct = resolveFilePreviewPath(args);
    if (!direct.ok && !MISSING_CODES.includes(direct.rejection.code))
      return filePreviewV3Error(direct.rejection.code, {
        message: direct.rejection.message,
        path: requestedPath,
      });

    const candidates = new Map<string, FileLinkCandidate>();
    const add = (resolved: ResolvedPreviewPath, tree: Worktree | null) => {
      if (candidates.has(resolved.absolutePath)) return;
      candidates.set(resolved.absolutePath, {
        path: resolved.reportedPath,
        absolutePath: resolved.absolutePath,
        worktreeRoot: tree?.root ?? workspaceRoot,
        branch: tree?.branch ?? null,
        head: tree?.head ?? null,
        mtimeMs: fs.statSync(resolved.absolutePath).mtimeMs,
      });
    };

    // Explicit absolute/home/parent-relative references retain their meaning.
    const relative =
      workspaceRoot !== null &&
      !path.isAbsolute(requestedPath) &&
      !requestedPath.trim().startsWith('~') &&
      !requestedPath.split(/[\\/]/).includes('..');
    const realRoot = relative && workspaceRoot !== null ? fs.realpathSync(workspaceRoot) : null;
    const trees =
      realRoot === null || workspaceRoot === null
        ? []
        : await containedWorktrees(workspaceRoot, realRoot, discover);
    if (direct.ok) add(direct.resolved, trees.find((tree) => tree.root === realRoot) ?? null);
    if (realRoot !== null) {
      for (const tree of trees) {
        if (tree.root === realRoot) continue;
        const result = resolveFilePreviewPath({ ...args, relativeBase: tree.root });
        if (!result.ok) {
          if ([...MISSING_CODES, 'path_not_allowed'].includes(result.rejection.code)) continue;
          return filePreviewV3Error(result.rejection.code, {
            message: result.rejection.message,
            path: requestedPath,
          });
        }
        if (within(realRoot, result.resolved.absolutePath)) add(result.resolved, tree);
      }
    }
    if (candidates.size > MAX_WORKTREES) throw new Error('Too many matching files.');
    return candidates.size
      ? { status: 'resolved-link', v: 3, candidates: [...candidates.values()] }
      : filePreviewV3Error('file_not_found', { path: requestedPath });
  } catch (error) {
    const denied = ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');
    return filePreviewV3Error(denied ? 'permission_denied' : 'transient_io', {
      path: requestedPath,
      message: denied ? 'Permission denied.' : 'Could not resolve file link candidates. Try again.',
      retryable: !denied,
    });
  }
}
