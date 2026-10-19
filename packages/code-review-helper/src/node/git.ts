import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { runCommandTextLegacy } from '@lody/shared/node/process';

import { parseReviewMarkdown } from '../parser';
import { createSparseTextForRanges } from '../sparse-text';
import type {
  LineRange,
  ReviewBundle,
  ReviewDiagnostic,
  ReviewFileStatus,
  ReviewResolvedBlock,
  ReviewResolvedCommit,
  ReviewResolvedFile,
  ReviewResolvedGroup,
} from '../types';
import { countLines, validateParsedReviewDocument, validateResolvedBlock } from '../validation';

export interface ResolveReviewBundleOptions {
  readonly reviewFilePath: string;
  readonly repoPath?: string;
}

interface GitStatusEntry {
  readonly status: ReviewFileStatus;
  readonly path: string;
  readonly oldPath?: string;
  readonly newPath?: string;
}

interface GitNumstatEntry {
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

export async function resolveReviewBundle(
  options: ResolveReviewBundleOptions
): Promise<ReviewBundle> {
  const reviewFilePath = path.resolve(options.reviewFilePath);
  const repoPath = path.resolve(options.repoPath ?? process.cwd());
  const markdown = await readFile(reviewFilePath, 'utf8');
  const document = parseReviewMarkdown(markdown, { sourcePath: reviewFilePath });
  const diagnostics: ReviewDiagnostic[] = validateParsedReviewDocument(document);

  await validateCommit(repoPath, document.frontmatter.mergeBase, 'merge_base', diagnostics);
  await validateCommit(repoPath, document.frontmatter.currentCommit, 'current_commit', diagnostics);

  const statusEntries = await getNameStatus(
    repoPath,
    document.frontmatter.mergeBase,
    document.frontmatter.currentCommit,
    diagnostics
  );
  const statusByPath = buildStatusMap(statusEntries);
  const numstatByPath = await getNumstat(
    repoPath,
    document.frontmatter.mergeBase,
    document.frontmatter.currentCommit,
    diagnostics
  );
  const referencedPaths = [
    ...new Set(document.groups.flatMap((group) => group.blocks.map((block) => block.path))),
  ];
  const files: Record<string, ReviewResolvedFile> = {};

  for (const reviewPath of referencedPaths) {
    files[reviewPath] = await resolveFile({
      repoPath,
      mergeBase: document.frontmatter.mergeBase,
      currentCommit: document.frontmatter.currentCommit,
      reviewPath,
      status: statusByPath.get(reviewPath),
      numstat: numstatByPath.get(reviewPath),
    });
  }

  const groups: ReviewResolvedGroup[] = document.groups.map((group) => {
    const blocks: ReviewResolvedBlock[] = group.blocks.map((block) => {
      const file = files[block.path];
      const rangeFiltered = block.oldRange !== undefined || block.newRange !== undefined;
      const displayOldText =
        file === undefined
          ? ''
          : rangeFiltered
            ? sparseOrBlank(file.oldText, block.oldRange)
            : file.oldText;
      const displayNewText =
        file === undefined
          ? ''
          : rangeFiltered
            ? sparseOrBlank(file.newText, block.newRange)
            : file.newText;
      const resolvedBlock: ReviewResolvedBlock = {
        ...block,
        ...(file === undefined ? {} : { file }),
        displayOldText,
        displayNewText,
        diagnostics: [],
      };
      return {
        ...resolvedBlock,
        diagnostics: validateResolvedBlock(resolvedBlock),
      };
    });
    return {
      ...group,
      blocks,
      diagnostics: [],
    };
  });

  const commits = await resolveCommits(repoPath, document.groups, diagnostics);

  return {
    reviewFilePath,
    repoPath,
    document,
    groups,
    files,
    commits,
    diagnostics,
  };
}

const COMMIT_FIELD_SEPARATOR = '';
const COMMIT_FORMAT = ['%H', '%h', '%an', '%ae', '%aI', '%s', '%b'].join(COMMIT_FIELD_SEPARATOR);

async function resolveCommits(
  repoPath: string,
  groups: readonly { readonly commits: readonly string[] }[],
  diagnostics: ReviewDiagnostic[]
): Promise<Record<string, ReviewResolvedCommit>> {
  const refs = [...new Set(groups.flatMap((group) => group.commits))].filter(
    (ref) => ref.length > 0
  );
  const resolved = await Promise.all(refs.map((ref) => resolveCommit(repoPath, ref, diagnostics)));
  const commits: Record<string, ReviewResolvedCommit> = {};
  for (const commit of resolved) {
    if (commit) {
      commits[commit.ref] = commit;
    }
  }
  return commits;
}

async function resolveCommit(
  repoPath: string,
  ref: string,
  diagnostics: ReviewDiagnostic[]
): Promise<ReviewResolvedCommit | undefined> {
  try {
    const output = await runGit(repoPath, [
      'show',
      '-s',
      `--format=${COMMIT_FORMAT}`,
      `${ref}^{commit}`,
    ]);
    const fields = output.replace(/\n$/u, '').split(COMMIT_FIELD_SEPARATOR);
    const [sha = '', shortSha = '', authorName = '', authorEmail = '', authorDate = ''] = fields;
    const subject = fields[5] ?? '';
    const body = (fields[6] ?? '').trim();
    return {
      ref,
      sha,
      shortSha,
      subject,
      body,
      authorName,
      authorEmail,
      ...(authorDate.length === 0 ? {} : { authorDate }),
    };
  } catch (error) {
    diagnostics.push({
      severity: 'warning',
      message: `Failed to resolve commit ${ref}: ${formatGitError(error)}`,
      code: 'commit_resolve_failed',
    });
    return undefined;
  }
}

async function validateCommit(
  repoPath: string,
  commit: string,
  field: string,
  diagnostics: ReviewDiagnostic[]
): Promise<void> {
  if (!commit) {
    return;
  }
  try {
    await runGit(repoPath, ['rev-parse', '--verify', `${commit}^{commit}`]);
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      message: `frontmatter.${field} does not resolve to a commit: ${formatGitError(error)}`,
      code: 'invalid_commit',
    });
  }
}

async function getNameStatus(
  repoPath: string,
  mergeBase: string,
  currentCommit: string,
  diagnostics: ReviewDiagnostic[]
): Promise<GitStatusEntry[]> {
  if (!mergeBase || !currentCommit) {
    return [];
  }
  try {
    const output = await runGit(repoPath, [
      'diff',
      '--name-status',
      '-M',
      mergeBase,
      currentCommit,
    ]);
    return parseNameStatus(output);
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      message: `Failed to read git name-status diff: ${formatGitError(error)}`,
      code: 'git_name_status_failed',
    });
    return [];
  }
}

async function getNumstat(
  repoPath: string,
  mergeBase: string,
  currentCommit: string,
  diagnostics: ReviewDiagnostic[]
): Promise<Map<string, GitNumstatEntry>> {
  const entries = new Map<string, GitNumstatEntry>();
  if (!mergeBase || !currentCommit) {
    return entries;
  }
  try {
    const output = await runGit(repoPath, ['diff', '--numstat', '-M', mergeBase, currentCommit]);
    for (const line of output.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const [additionsRaw, deletionsRaw, filePath] = line.split('\t');
      if (!filePath) {
        continue;
      }
      const binary = additionsRaw === '-' || deletionsRaw === '-';
      const entry = {
        additions: binary ? 0 : Number(additionsRaw),
        deletions: binary ? 0 : Number(deletionsRaw),
        binary,
      };
      entries.set(normalizeDiffPath(filePath), entry);
      const renameTarget = parseRenameNumstatPath(filePath);
      if (renameTarget) {
        entries.set(renameTarget, entry);
      }
    }
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      message: `Failed to read git numstat diff: ${formatGitError(error)}`,
      code: 'git_numstat_failed',
    });
  }
  return entries;
}

async function resolveFile(input: {
  readonly repoPath: string;
  readonly mergeBase: string;
  readonly currentCommit: string;
  readonly reviewPath: string;
  readonly status?: GitStatusEntry;
  readonly numstat?: GitNumstatEntry;
}): Promise<ReviewResolvedFile> {
  const diagnostics: ReviewDiagnostic[] = [];
  const status = input.status?.status ?? 'unknown';
  const oldPath =
    input.status?.oldPath ??
    (status === 'added' ? undefined : (input.status?.path ?? input.reviewPath));
  const newPath =
    input.status?.newPath ??
    (status === 'deleted' ? undefined : (input.status?.path ?? input.reviewPath));
  const oldText =
    oldPath === undefined
      ? ''
      : await readFileAtCommit(input.repoPath, input.mergeBase, oldPath, diagnostics);
  const newText =
    newPath === undefined
      ? ''
      : await readFileAtCommit(input.repoPath, input.currentCommit, newPath, diagnostics);

  return {
    path: input.reviewPath,
    ...(oldPath === undefined ? {} : { oldPath }),
    ...(newPath === undefined ? {} : { newPath }),
    status,
    oldText,
    newText,
    additions: input.numstat?.additions ?? 0,
    deletions: input.numstat?.deletions ?? 0,
    ...(input.numstat?.binary === true ? { binary: true } : {}),
    diagnostics,
  };
}

async function readFileAtCommit(
  repoPath: string,
  commit: string,
  filePath: string,
  diagnostics: ReviewDiagnostic[]
): Promise<string> {
  try {
    return await runGit(repoPath, ['show', `${commit}:${filePath}`], 20 * 1024 * 1024);
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      message: `Failed to read ${filePath} at ${commit}: ${formatGitError(error)}`,
      code: 'git_show_failed',
    });
    return '';
  }
}

function sparseOrBlank(text: string, range: LineRange | undefined): string {
  if (range === undefined) {
    const lineCount = countLines(text);
    return lineCount === 0 ? '' : Array.from({ length: lineCount }, () => '').join('\n');
  }
  return createSparseTextForRanges(text, [range]);
}

function parseNameStatus(output: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split('\t');
    const statusRaw = parts[0] ?? '';
    const code = statusRaw[0];
    if (code === 'R') {
      const oldPath = normalizeDiffPath(parts[1] ?? '');
      const newPath = normalizeDiffPath(parts[2] ?? '');
      entries.push({ status: 'renamed', path: newPath, oldPath, newPath });
      continue;
    }
    const filePath = normalizeDiffPath(parts[1] ?? '');
    if (!filePath) {
      continue;
    }
    if (code === 'A') {
      entries.push({ status: 'added', path: filePath, newPath: filePath });
    } else if (code === 'D') {
      entries.push({ status: 'deleted', path: filePath, oldPath: filePath });
    } else if (code === 'M') {
      entries.push({ status: 'modified', path: filePath, oldPath: filePath, newPath: filePath });
    } else {
      entries.push({ status: 'unknown', path: filePath, oldPath: filePath, newPath: filePath });
    }
  }
  return entries;
}

function buildStatusMap(entries: readonly GitStatusEntry[]): Map<string, GitStatusEntry> {
  const statusByPath = new Map<string, GitStatusEntry>();
  for (const entry of entries) {
    statusByPath.set(entry.path, entry);
    if (entry.oldPath) {
      statusByPath.set(entry.oldPath, entry);
    }
    if (entry.newPath) {
      statusByPath.set(entry.newPath, entry);
    }
  }
  return statusByPath;
}

function normalizeDiffPath(filePath: string): string {
  return filePath.replace(/\\/gu, '/');
}

function parseRenameNumstatPath(filePath: string): string | undefined {
  const brace = /^(.*)\{(.+?) => (.+?)\}(.*)$/u.exec(filePath);
  if (brace) {
    return normalizeDiffPath(`${brace[1] ?? ''}${brace[3] ?? ''}${brace[4] ?? ''}`);
  }
  const arrow = /^(.+?) => (.+)$/u.exec(filePath);
  if (arrow) {
    return normalizeDiffPath(arrow[2] ?? '');
  }
  return undefined;
}

/** Every read is local; a git that runs longer than this is stuck, not slow. */
const GIT_TIMEOUT_MS = 60_000;

async function runGit(repoPath: string, args: readonly string[], maxBuffer = 8 * 1024 * 1024) {
  const result = await runCommandTextLegacy({
    command: 'git',
    args,
    cwd: repoPath,
    maxOutputBytes: maxBuffer,
    timeout: GIT_TIMEOUT_MS,
    check: 'exit-0',
  });
  return result.stdout;
}

function formatGitError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
