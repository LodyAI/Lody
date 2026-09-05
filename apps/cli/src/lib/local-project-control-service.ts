import fs from 'node:fs';
import path, { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  LocalProjectBrowseDirectoryResult,
  LocalProjectBrowseRootsResult,
  LocalProjectGitState,
  LocalProjectCheckoutBranchResult,
  LocalProjectDirectoryListResult,
  LocalProjectFileListResult,
  LocalProjectFileReadResult,
  LocalProjectId,
  ProjectSkill,
  ProjectSkillGroup,
  ProjectSkillScope,
  ProjectSkillsResult,
  RepoId,
  SessionId,
} from '@lody/shared';
import {
  ALL_KNOWN_GLOBAL_SKILL_DIRS,
  ALL_KNOWN_SYSTEM_SKILL_DIRS,
  applyProjectSkillsResultBudget,
  buildProjectSkill,
  isBinaryImagePath,
} from '@lody/shared';
import {
  checkoutLocalProjectBranchAtRootPath,
  createLocalProjectId,
  ensureLocalProjectRootPath,
  getLocalProjectGitStateAtRootPath,
  getLocalProjectNameFromRootPath,
} from '@lody/shared/node/local-project';
import {
  deriveRepoIdFromGitHubRepo,
  getWorktreeHostPathFromDotlodyPath,
} from '@lody/shared/node/worktree-paths';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

const DEFAULT_LOCAL_PROJECT_MAX_FILES = 80_000;
const HARD_LOCAL_PROJECT_MAX_FILES = 200_000;
const DEFAULT_LOCAL_PROJECT_LIST_DIR_LIMIT = 1_000;
const HARD_LOCAL_PROJECT_LIST_DIR_LIMIT = 10_000;
const DEFAULT_LOCAL_PROJECT_BROWSE_DIR_LIMIT = 500;
const HARD_LOCAL_PROJECT_BROWSE_DIR_LIMIT = 5_000;
const DEFAULT_LOCAL_PROJECT_READ_MAX_BYTES = 64 * 1024;
const DEFAULT_LOCAL_PROJECT_SKILL_MD_MAX_BYTES = 256 * 1024;
const LOCAL_PROJECT_SKILL_DIR_MAX_CHILDREN = 2_000;
// Raised from 1MB so binary image previews (read as raw bytes, then base64'd for
// transport) can carry typical screenshots/photos. Text reads still default to
// 64KB; the file-browser provider opts into the larger cap only for images.
const HARD_LOCAL_PROJECT_READ_MAX_BYTES = 5 * 1024 * 1024;
const GIT_COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const LOCAL_PROJECT_GIT_COMMAND_TIMEOUT_MS = 5_000;
const LOCAL_PROJECT_WALK_YIELD_EVERY_ENTRIES = 1_000;
const execFileAsync = promisify(execFile);
const LOCAL_REPO_ID_RE = /^local---[0-9a-f]{12}$/;

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  if (normalized < min) {
    return min;
  }
  if (normalized > max) {
    return max;
  }
  return normalized;
}

function normalizeProjectRelativePath(pathValue: string): string {
  return pathValue
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

function isPathWithinRoot(rootPath: string, targetPath: string): boolean {
  const relPath = relative(rootPath, targetPath);
  if (relPath === '') return true;
  return !relPath.startsWith('..') && !isAbsolute(relPath);
}

function toProjectRelativePath(rootPath: string, absolutePath: string): string {
  return normalizeProjectRelativePath(relative(rootPath, absolutePath));
}

function isBlockedLocalProjectRelativePath(relativePath: string): boolean {
  const normalized = normalizeProjectRelativePath(relativePath);
  if (!normalized) return false;
  return normalized.split('/').some((segment) => segment === '.git');
}

function shouldExcludeLocalProjectRelativePath(
  relativePath: string,
  shouldIgnorePath: ((relativePath: string) => boolean) | null
): boolean {
  const normalized = normalizeProjectRelativePath(relativePath);
  if (!normalized) return false;
  if (isBlockedLocalProjectRelativePath(normalized)) return true;
  return shouldIgnorePath?.(normalized) ?? false;
}

function resolveSafeProjectFilePath(rootPath: string, relativePath: string): string | null {
  const normalizedRelativePath = normalizeProjectRelativePath(relativePath.trim());
  if (!normalizedRelativePath) return null;
  if (normalizedRelativePath.includes('\0')) return null;

  const absolutePath = resolvePath(rootPath, normalizedRelativePath);
  if (!isPathWithinRoot(rootPath, absolutePath)) return null;
  return absolutePath;
}

function resolveSafeProjectDirectoryPath(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeProjectRelativePath(relativePath.trim());
  if (normalizedRelativePath.includes('\0')) {
    throw new Error('Invalid project directory path.');
  }

  const absolutePath = normalizedRelativePath
    ? resolvePath(rootPath, normalizedRelativePath)
    : rootPath;
  if (!isPathWithinRoot(rootPath, absolutePath)) {
    throw new Error('Project directory path escapes project root.');
  }
  return absolutePath;
}

function readLocalFileAtRoot(
  rootPath: string,
  relativePath: string,
  maxBytes: number,
  allowBinary = false
): LocalProjectFileReadResult | null {
  const requestedRelativePath = normalizeProjectRelativePath(relativePath.trim());
  const safePath = resolveSafeProjectFilePath(rootPath, requestedRelativePath);
  if (!safePath) return null;

  let rootRealPath: string;
  try {
    rootRealPath = fs.realpathSync(rootPath);
  } catch {
    return null;
  }

  let targetRealPath: string;
  try {
    targetRealPath = fs.realpathSync(safePath);
  } catch {
    return null;
  }

  if (!isPathWithinRoot(rootRealPath, targetRealPath)) {
    return null;
  }

  const targetRelativePath = toProjectRelativePath(rootRealPath, targetRealPath);
  const shouldIgnorePath = buildGitignoreMatcher(rootRealPath);
  if (
    shouldExcludeLocalProjectRelativePath(requestedRelativePath, shouldIgnorePath) ||
    shouldExcludeLocalProjectRelativePath(targetRelativePath, shouldIgnorePath)
  ) {
    return null;
  }

  let fd: number;
  try {
    fd = fs.openSync(targetRealPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;

    // Read to EOF, or to one byte past the budget so a file AT the limit is not
    // reported as truncated.
    //
    // The buffer starts at the stat size rather than at the budget, because
    // `Buffer.alloc(maxBytes + 1)` reserved the whole ceiling on every read and
    // a viewer-sized budget would tax every small read with it. That makes
    // `stat` a HINT, never the end condition: an agent appending to the file
    // between the stat and the read would otherwise fill the buffer exactly,
    // and returning that prefix as the whole file is worse than any budget —
    // it is wrong content with no flag on it. A full buffer therefore grows and
    // keeps reading, and only `read === 0` (EOF) or the budget stops the loop.
    // The loop is also what makes a SHORT read safe, which a single `readSync`
    // never was.
    const readLimit = maxBytes + 1;
    let buffer = Buffer.alloc(Math.max(1, Math.min(readLimit, stat.size + 1)));
    let bytesRead = 0;
    for (;;) {
      if (bytesRead >= readLimit) break;
      if (bytesRead === buffer.length) {
        const grown = Buffer.alloc(Math.min(readLimit, buffer.length * 2));
        buffer.copy(grown, 0, 0, bytesRead);
        buffer = grown;
      }
      const read = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (read === 0) break;
      bytesRead += read;
    }
    // Derived from what was actually read, never from the possibly stale
    // `stat.size`: a file that SHRANK to fit is not truncated either.
    const truncated = bytesRead > maxBytes;
    const safeBytes = Math.min(bytesRead, maxBytes);
    const resolvedRelativePath = toProjectRelativePath(rootRealPath, targetRealPath);
    // Image files are read as raw bytes and base64-encoded so they survive the
    // JSON/Streams transport intact; a UTF-8 decode would corrupt them. A
    // truncated image is unusable, so the caller treats `truncated` as
    // "too large to preview" rather than rendering a partial blob.
    if (allowBinary && isBinaryImagePath(resolvedRelativePath)) {
      return {
        path: resolvedRelativePath,
        content: buffer.subarray(0, safeBytes).toString('base64'),
        truncated,
        encoding: 'base64',
      };
    }
    // Backward compatibility: text reads must NOT carry `encoding`. Older
    // clients validate this response with a `.strict()` zod schema that rejects
    // unknown keys, so emitting `encoding: 'utf8'` here would make a newer CLI
    // break *every* text read for an older web/mobile bundle (version skew is
    // real: the CLI auto-updates on the machine independently of the loaded
    // client). Absent `encoding` is the documented UTF-8 default, so omitting it
    // keeps the wire format byte-identical to the legacy format.
    return {
      path: resolvedRelativePath,
      content: buffer.subarray(0, safeBytes).toString('utf8'),
      truncated,
    };
  } finally {
    fs.closeSync(fd);
  }
}

type GitCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

async function runGitCommand(rootPath: string, args: string[]): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync('git', args, {
      cwd: rootPath,
      encoding: 'utf8',
      maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
      timeout: LOCAL_PROJECT_GIT_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
    return {
      status: 0,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
  } catch (error) {
    const withOutput = error as
      | (Error & { code?: number | string; stdout?: string; stderr?: string })
      | undefined;
    const message = formatErrorMessage(error);
    return {
      status: typeof withOutput?.code === 'number' ? withOutput.code : null,
      stdout: String(withOutput?.stdout ?? ''),
      stderr: String(withOutput?.stderr ?? message),
    };
  }
}

function normalizeRootPath(rootPath: string): string {
  try {
    return ensureLocalProjectRootPath(rootPath);
  } catch {
    throw new Error('Local project path not found.');
  }
}

function getLocalProjectBrowsePlatform(): LocalProjectBrowseRootsResult['platform'] {
  const platform = os.platform();
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    return platform;
  }
  throw new Error(`Unsupported local project browse platform: ${platform}`);
}

function getPathSeparator(): LocalProjectBrowseRootsResult['pathSeparator'] {
  return path.sep === '\\' ? '\\' : '/';
}

async function listWindowsDrives(): Promise<string[]> {
  if (os.platform() !== 'win32') {
    return [];
  }

  const drives: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    try {
      await fs.promises.access(drive, fs.constants.R_OK);
      drives.push(drive);
    } catch {
      // Drive letters are sparse; inaccessible drives are not useful picker roots.
    }
  }

  const homeRoot = path.parse(os.homedir()).root;
  if (homeRoot && !drives.includes(homeRoot)) {
    drives.unshift(homeRoot);
  }
  return drives;
}

function resolveLocalProjectBrowsePath(absolutePath: string | undefined): string {
  const requestedPath = absolutePath?.trim() || os.homedir();
  if (requestedPath.includes('\0')) {
    throw new Error('Browse path is invalid.');
  }
  if (!path.isAbsolute(requestedPath)) {
    throw new Error('Browse path must be absolute.');
  }
  return requestedPath;
}

function parseLocalProjectBrowseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  if (!/^[0-9]+$/.test(cursor)) {
    throw new Error('Browse cursor is invalid.');
  }
  return Number.parseInt(cursor, 10);
}

function getBrowseParentPath(directoryPath: string): string | null {
  const parentPath = path.dirname(directoryPath);
  return parentPath === directoryPath ? null : parentPath;
}

async function canReadDirectory(directoryPath: string): Promise<boolean> {
  try {
    await fs.promises.access(directoryPath, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await fs.promises.access(pathValue, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function getLocalProjectBrowseHints(
  directoryPath: string
): Promise<LocalProjectBrowseDirectoryResult['entries'][number]['hints']> {
  const git = await pathExists(path.join(directoryPath, '.git'));
  return git ? { git: true } : undefined;
}

async function buildRegisteredProjectPathIndex(
  registeredProjects: Record<LocalProjectId, string> | undefined
): Promise<Map<string, LocalProjectId>> {
  const index = new Map<string, LocalProjectId>();
  if (!registeredProjects) {
    return index;
  }

  for (const [localProjectId, rootPath] of Object.entries(registeredProjects)) {
    const trimmedRootPath = rootPath.trim();
    if (!trimmedRootPath) {
      continue;
    }
    try {
      index.set(await fs.promises.realpath(trimmedRootPath), localProjectId as LocalProjectId);
    } catch {
      // Stale project metadata should not break browsing unrelated directories.
    }
  }
  return index;
}

async function listLocalProjectFilesFromGit(
  rootPath: string,
  maxFiles: number
): Promise<LocalProjectFileListResult | null> {
  const tracked = await runGitCommand(rootPath, ['ls-files', '-z']);
  if (tracked.status !== 0) return null;

  const untracked = await runGitCommand(rootPath, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  if (untracked.status !== 0) return null;

  const merged = `${tracked.stdout}${untracked.stdout}`;
  const deduped = new Set<string>();
  let truncated = false;

  for (const entry of merged.split('\0')) {
    const normalized = normalizeProjectRelativePath(entry);
    if (!normalized) continue;
    if (deduped.has(normalized)) continue;
    if (deduped.size >= maxFiles) {
      truncated = true;
      break;
    }
    deduped.add(normalized);
  }

  return {
    paths: Array.from(deduped).sort((a, b) => a.localeCompare(b)),
    truncated,
  };
}

function escapeForRegex(value: string): string {
  let output = '';
  for (const char of value) {
    if (
      char === '\\' ||
      char === '.' ||
      char === '+' ||
      char === '^' ||
      char === '$' ||
      char === '{' ||
      char === '}' ||
      char === '(' ||
      char === ')' ||
      char === '[' ||
      char === ']' ||
      char === '|'
    ) {
      output += `\\${char}`;
      continue;
    }
    output += char;
  }
  return output;
}

function globToRegexSource(pattern: string): string {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (!char) {
      continue;
    }
    if (char === '*') {
      const next = pattern[index + 1];
      if (next === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeForRegex(char);
  }
  return source;
}

function buildGitignoreMatcher(rootPath: string): ((relativePath: string) => boolean) | null {
  let content = '';
  try {
    content = fs.readFileSync(path.join(rootPath, '.gitignore'), 'utf8');
  } catch {
    return null;
  }

  const rules: Array<{ negated: boolean; regex: RegExp }> = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let patternText = line;
    let negated = false;
    if (patternText.startsWith('!')) {
      negated = true;
      patternText = patternText.slice(1).trim();
    }
    if (!patternText || patternText.startsWith('#')) continue;

    const anchored = patternText.startsWith('/');
    if (anchored) {
      patternText = patternText.replace(/^\/+/, '');
    }

    const directoryOnly = patternText.endsWith('/');
    if (directoryOnly) {
      patternText = patternText.replace(/\/+$/, '');
    }

    const normalizedPattern = normalizeProjectRelativePath(patternText);
    if (!normalizedPattern) continue;

    const hasSlash = normalizedPattern.includes('/');
    const patternSource = globToRegexSource(normalizedPattern);
    const prefix = anchored || hasSlash ? '^' : '(^|.*/)';
    const suffix = directoryOnly ? '($|/.*)' : '$';
    rules.push({ negated, regex: new RegExp(`${prefix}${patternSource}${suffix}`) });
  }

  if (rules.length === 0) {
    return null;
  }

  return (relativePath: string): boolean => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.regex.test(relativePath)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  };
}

async function listLocalProjectFilesByWalk(
  rootPath: string,
  maxFiles: number
): Promise<LocalProjectFileListResult> {
  const paths: string[] = [];
  const stack: Array<{ absolutePath: string; relativePath: string }> = [
    { absolutePath: rootPath, relativePath: '' },
  ];
  const shouldIgnorePath = buildGitignoreMatcher(rootPath);
  let truncated = false;
  let entriesSinceYield = 0;

  while (stack.length > 0 && !truncated) {
    const current = stack.pop();
    if (!current) break;

    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(current.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      entriesSinceYield += 1;
      if (entriesSinceYield >= LOCAL_PROJECT_WALK_YIELD_EVERY_ENTRIES) {
        entriesSinceYield = 0;
        await yieldToEventLoop();
      }

      const name = entry.name;
      if (!name || name === '.' || name === '..') {
        continue;
      }

      const entryRelativePath = current.relativePath ? `${current.relativePath}/${name}` : name;
      const normalizedRelativePath = normalizeProjectRelativePath(entryRelativePath);
      if (!normalizedRelativePath) {
        continue;
      }
      if (shouldExcludeLocalProjectRelativePath(normalizedRelativePath, shouldIgnorePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        stack.push({
          absolutePath: path.join(current.absolutePath, name),
          relativePath: normalizedRelativePath,
        });
        continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue;
      }

      if (paths.length >= maxFiles) {
        truncated = true;
        break;
      }
      paths.push(normalizedRelativePath);
    }
  }

  paths.sort((a, b) => a.localeCompare(b));
  return { paths, truncated };
}

async function listFilesAtRootPath(
  rootPath: string,
  maxFiles: number
): Promise<LocalProjectFileListResult> {
  const normalizedRootPath = normalizeRootPath(rootPath);
  return (
    (await listLocalProjectFilesFromGit(normalizedRootPath, maxFiles)) ??
    (await listLocalProjectFilesByWalk(normalizedRootPath, maxFiles))
  );
}

async function listDirectoryAtRootPath(
  rootPath: string,
  relativePath: string,
  limit: number
): Promise<LocalProjectDirectoryListResult> {
  const normalizedRootPath = normalizeRootPath(rootPath);
  const requestedRelativePath = normalizeProjectRelativePath(relativePath.trim());
  const directoryPath = resolveSafeProjectDirectoryPath(normalizedRootPath, requestedRelativePath);
  const rootRealPath = await fs.promises.realpath(normalizedRootPath);
  const directoryRealPath = await fs.promises.realpath(directoryPath);
  if (!isPathWithinRoot(rootRealPath, directoryRealPath)) {
    throw new Error('Project directory path escapes project root.');
  }

  const directoryRelativePath = toProjectRelativePath(rootRealPath, directoryRealPath);
  const shouldIgnorePath = buildGitignoreMatcher(rootRealPath);
  if (
    shouldExcludeLocalProjectRelativePath(requestedRelativePath, shouldIgnorePath) ||
    shouldExcludeLocalProjectRelativePath(directoryRelativePath, shouldIgnorePath)
  ) {
    throw new Error('Project directory is not browsable.');
  }

  const directoryStat = await fs.promises.stat(directoryRealPath);
  if (!directoryStat.isDirectory()) {
    throw new Error('Project path is not a directory.');
  }

  const entries: LocalProjectDirectoryListResult['entries'] = [];
  let truncated = false;
  let entriesSinceYield = 0;

  const dir = await fs.promises.opendir(directoryRealPath);
  for await (const entry of dir) {
    entriesSinceYield += 1;
    if (entriesSinceYield >= LOCAL_PROJECT_WALK_YIELD_EVERY_ENTRIES) {
      entriesSinceYield = 0;
      await yieldToEventLoop();
    }

    const name = entry.name;
    if (!name || name === '.' || name === '..') {
      continue;
    }

    const requestedChildPath = requestedRelativePath ? `${requestedRelativePath}/${name}` : name;
    if (shouldExcludeLocalProjectRelativePath(requestedChildPath, shouldIgnorePath)) {
      continue;
    }

    let childRealPath: string;
    try {
      childRealPath = await fs.promises.realpath(path.join(directoryRealPath, name));
    } catch {
      continue;
    }
    if (!isPathWithinRoot(rootRealPath, childRealPath)) {
      continue;
    }

    const childRelativePath = toProjectRelativePath(rootRealPath, childRealPath);
    if (shouldExcludeLocalProjectRelativePath(childRelativePath, shouldIgnorePath)) {
      continue;
    }

    let childStat: fs.Stats;
    try {
      childStat = await fs.promises.stat(childRealPath);
    } catch {
      continue;
    }
    if (!childStat.isDirectory() && !childStat.isFile()) {
      continue;
    }
    if (entries.length >= limit) {
      truncated = true;
      break;
    }

    entries.push({
      name,
      type: childStat.isDirectory() ? 'directory' : 'file',
    });
  }

  entries.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  return { entries, truncated };
}

type ResolvedProjectEntry =
  | {
      kind: 'inside';
      realPath: string;
      stat: fs.Stats;
      isSymlink: boolean;
    }
  | {
      kind: 'external-symlink';
      realPath: string;
    };

type SkillFingerprintPart = {
  scope: ProjectSkillScope;
  groupDir: string;
  relativePath: string;
  realPath: string;
  size: number;
  mtimeMs: number;
};

function isNodeNotFoundError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function normalizeSkillScanDir(skillDir: string): string {
  const trimmed = skillDir.trim();
  if (!trimmed) {
    throw new Error('Skill scan directory is required.');
  }
  if (trimmed.includes('\0')) {
    throw new Error(`Invalid skill scan directory: ${skillDir}`);
  }
  if (path.isAbsolute(trimmed)) {
    throw new Error(`Skill scan directory must be project-relative: ${skillDir}`);
  }

  const normalized = normalizeProjectRelativePath(trimmed);
  if (!normalized) {
    throw new Error(`Invalid skill scan directory: ${skillDir}`);
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error(`Skill scan directory escapes project root: ${skillDir}`);
  }
  return normalized;
}

function normalizeKnownGlobalSkillScanDir(skillDir: string): {
  displayDir: string;
  relativeDir: string;
} {
  const trimmed = skillDir.trim().replace(/\\/g, '/');
  if (!trimmed) {
    throw new Error('Global skill scan directory is required.');
  }
  if (trimmed.includes('\0')) {
    throw new Error(`Invalid global skill scan directory: ${skillDir}`);
  }
  if (!trimmed.startsWith('~/')) {
    throw new Error(`Global skill scan directory must be home-relative: ${skillDir}`);
  }

  const relativeDir = normalizeSkillScanDir(trimmed.slice(2));
  return {
    displayDir: `~/${relativeDir}`,
    relativeDir,
  };
}

function toHomeDisplayPath(relativePath: string): string {
  return `~/${normalizeProjectRelativePath(relativePath)}`;
}

async function resolveProjectEntry(
  rootRealPath: string,
  absolutePath: string
): Promise<ResolvedProjectEntry | null> {
  let lstat: fs.Stats;
  try {
    lstat = await fs.promises.lstat(absolutePath);
  } catch (error) {
    if (isNodeNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  let realPath: string;
  try {
    realPath = await fs.promises.realpath(absolutePath);
  } catch (error) {
    if (isNodeNotFoundError(error)) {
      return null;
    }
    throw error;
  }
  if (!isPathWithinRoot(rootRealPath, realPath)) {
    if (lstat.isSymbolicLink()) {
      return { kind: 'external-symlink', realPath };
    }
    throw new Error('Resolved project path escapes project root.');
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(realPath);
  } catch (error) {
    if (isNodeNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  return {
    kind: 'inside',
    realPath,
    stat,
    isSymlink: lstat.isSymbolicLink(),
  };
}

async function readSkillMarkdownFile(
  rootRealPath: string,
  absolutePath: string
): Promise<
  | {
      content: string;
      stat: fs.Stats;
      realPath: string;
      isSymlink: boolean;
    }
  | null
  | 'external-symlink'
> {
  const resolved = await resolveProjectEntry(rootRealPath, absolutePath);
  if (!resolved) {
    return null;
  }
  if (resolved.kind === 'external-symlink') {
    return 'external-symlink';
  }
  if (!resolved.stat.isFile()) {
    return null;
  }
  if (resolved.stat.size > DEFAULT_LOCAL_PROJECT_SKILL_MD_MAX_BYTES) {
    throw new Error('SKILL.md is too large to read.');
  }

  const handle = await fs.promises.open(
    resolved.realPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return null;
    }
    if (stat.size > DEFAULT_LOCAL_PROJECT_SKILL_MD_MAX_BYTES) {
      throw new Error('SKILL.md is too large to read.');
    }
    return {
      content: await handle.readFile('utf8'),
      stat,
      realPath: resolved.realPath,
      isSymlink: resolved.isSymlink,
    };
  } finally {
    await handle.close();
  }
}

async function addProjectSkillFromDirectory(args: {
  rootRealPath: string;
  scope: ProjectSkillScope;
  groupDir: string;
  displaySkillDir: string;
  realSkillDir: string;
  inheritedSymlink: boolean;
  skills: ProjectSkill[];
  fingerprintParts: SkillFingerprintPart[];
}): Promise<'added' | 'missing' | 'external-symlink'> {
  const skillMdPath = path.join(args.realSkillDir, 'SKILL.md');
  const skillMd = await readSkillMarkdownFile(args.rootRealPath, skillMdPath);
  if (skillMd === null) {
    return 'missing';
  }
  if (skillMd === 'external-symlink') {
    return 'external-symlink';
  }

  const relativePath = normalizeProjectRelativePath(`${args.displaySkillDir}/SKILL.md`);
  const isSymlink = args.inheritedSymlink || skillMd.isSymlink;
  const skill = buildProjectSkill({
    groupDir: args.groupDir,
    displaySkillDir: args.displaySkillDir,
    markdown: skillMd.content,
    relativePath,
    // Home-scoped skills (global + system) carry the absolute SKILL.md path for
    // prompt expansion; project-relative skills intentionally omit it.
    absolutePath: args.scope === 'project' ? undefined : skillMd.realPath,
    isSymlink,
    symlinkTarget: isSymlink
      ? toProjectRelativePath(args.rootRealPath, path.dirname(skillMd.realPath))
      : undefined,
  });
  args.skills.push(skill);
  args.fingerprintParts.push({
    groupDir: args.groupDir,
    scope: args.scope,
    relativePath,
    realPath: skillMd.realPath,
    size: skillMd.stat.size,
    mtimeMs: skillMd.stat.mtimeMs,
  });
  return 'added';
}

async function scanProjectSkillGroup(args: {
  rootRealPath: string;
  scope: ProjectSkillScope;
  skillDir: string;
  shouldIgnorePath: ((relativePath: string) => boolean) | null;
  fingerprintParts: SkillFingerprintPart[];
}): Promise<ProjectSkillGroup | null> {
  const groupDir = normalizeSkillScanDir(args.skillDir);
  if (shouldExcludeLocalProjectRelativePath(groupDir, args.shouldIgnorePath)) {
    return null;
  }

  const groupPath = resolveSafeProjectDirectoryPath(args.rootRealPath, groupDir);
  const resolvedGroup = await resolveProjectEntry(args.rootRealPath, groupPath);
  if (!resolvedGroup) {
    return null;
  }

  let skippedExternalSymlinks = 0;
  if (resolvedGroup.kind === 'external-symlink') {
    return {
      scope: args.scope,
      dir: groupDir,
      skills: [],
      truncated: false,
      skippedExternalSymlinks: 1,
    };
  }
  if (!resolvedGroup.stat.isDirectory()) {
    return null;
  }

  const resolvedGroupRelativePath = toProjectRelativePath(
    args.rootRealPath,
    resolvedGroup.realPath
  );
  if (shouldExcludeLocalProjectRelativePath(resolvedGroupRelativePath, args.shouldIgnorePath)) {
    return null;
  }

  const skills: ProjectSkill[] = [];

  // No realpath dedup: a symlinked skill or a duplicate that resolves to the
  // same target as another entry is still listed under its own path, so the UI
  // shows every entry (the scan is depth-1, so duplicates can't cause a loop).
  const rootSkillResult = await addProjectSkillFromDirectory({
    rootRealPath: args.rootRealPath,
    scope: args.scope,
    groupDir,
    displaySkillDir: groupDir,
    realSkillDir: resolvedGroup.realPath,
    inheritedSymlink: resolvedGroup.isSymlink,
    skills,
    fingerprintParts: args.fingerprintParts,
  });
  if (rootSkillResult === 'external-symlink') {
    skippedExternalSymlinks += 1;
  }

  const entries = await fs.promises.readdir(resolvedGroup.realPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  let truncated = entries.length > LOCAL_PROJECT_SKILL_DIR_MAX_CHILDREN;
  for (const entry of entries.slice(0, LOCAL_PROJECT_SKILL_DIR_MAX_CHILDREN)) {
    const name = entry.name;
    if (!name || name === '.' || name === '..' || name === 'SKILL.md') {
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }

    const displaySkillDir = normalizeProjectRelativePath(`${groupDir}/${name}`);
    if (shouldExcludeLocalProjectRelativePath(displaySkillDir, args.shouldIgnorePath)) {
      continue;
    }

    const childPath = path.join(resolvedGroup.realPath, name);
    const resolvedChild = await resolveProjectEntry(args.rootRealPath, childPath);
    if (!resolvedChild) {
      continue;
    }
    if (resolvedChild.kind === 'external-symlink') {
      skippedExternalSymlinks += 1;
      continue;
    }
    if (!resolvedChild.stat.isDirectory()) {
      continue;
    }

    const resolvedChildRelativePath = toProjectRelativePath(
      args.rootRealPath,
      resolvedChild.realPath
    );
    if (shouldExcludeLocalProjectRelativePath(resolvedChildRelativePath, args.shouldIgnorePath)) {
      continue;
    }

    const addResult = await addProjectSkillFromDirectory({
      rootRealPath: args.rootRealPath,
      scope: args.scope,
      groupDir,
      displaySkillDir,
      realSkillDir: resolvedChild.realPath,
      inheritedSymlink: resolvedGroup.isSymlink || resolvedChild.isSymlink,
      skills,
      fingerprintParts: args.fingerprintParts,
    });
    if (addResult === 'external-symlink') {
      skippedExternalSymlinks += 1;
    }
    if (addResult !== 'missing') {
      continue;
    }

    const nestedEntries = await fs.promises.readdir(resolvedChild.realPath, {
      withFileTypes: true,
    });
    nestedEntries.sort((left, right) => left.name.localeCompare(right.name));
    truncated = truncated || nestedEntries.length > LOCAL_PROJECT_SKILL_DIR_MAX_CHILDREN;
    for (const nestedEntry of nestedEntries.slice(0, LOCAL_PROJECT_SKILL_DIR_MAX_CHILDREN)) {
      const nestedName = nestedEntry.name;
      if (!nestedName || nestedName === '.' || nestedName === '..' || nestedName === 'SKILL.md') {
        continue;
      }
      if (!nestedEntry.isDirectory() && !nestedEntry.isSymbolicLink()) {
        continue;
      }

      const nestedDisplaySkillDir = normalizeProjectRelativePath(
        `${displaySkillDir}/${nestedName}`
      );
      if (shouldExcludeLocalProjectRelativePath(nestedDisplaySkillDir, args.shouldIgnorePath)) {
        continue;
      }

      const nestedPath = path.join(resolvedChild.realPath, nestedName);
      const resolvedNested = await resolveProjectEntry(args.rootRealPath, nestedPath);
      if (!resolvedNested) {
        continue;
      }
      if (resolvedNested.kind === 'external-symlink') {
        skippedExternalSymlinks += 1;
        continue;
      }
      if (!resolvedNested.stat.isDirectory()) {
        continue;
      }

      const resolvedNestedRelativePath = toProjectRelativePath(
        args.rootRealPath,
        resolvedNested.realPath
      );
      if (
        shouldExcludeLocalProjectRelativePath(resolvedNestedRelativePath, args.shouldIgnorePath)
      ) {
        continue;
      }

      const nestedAddResult = await addProjectSkillFromDirectory({
        rootRealPath: args.rootRealPath,
        scope: args.scope,
        groupDir,
        displaySkillDir: nestedDisplaySkillDir,
        realSkillDir: resolvedNested.realPath,
        inheritedSymlink:
          resolvedGroup.isSymlink || resolvedChild.isSymlink || resolvedNested.isSymlink,
        skills,
        fingerprintParts: args.fingerprintParts,
      });
      if (nestedAddResult === 'external-symlink') {
        skippedExternalSymlinks += 1;
      }
    }
  }

  skills.sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    return nameCompare === 0 ? left.relativePath.localeCompare(right.relativePath) : nameCompare;
  });

  if (skills.length === 0 && skippedExternalSymlinks === 0 && !truncated) {
    return null;
  }

  return {
    scope: args.scope,
    dir: groupDir,
    skills,
    truncated,
    ...(skippedExternalSymlinks > 0 ? { skippedExternalSymlinks } : {}),
  };
}

function buildProjectSkillsFingerprint(
  groups: readonly ProjectSkillGroup[],
  fingerprintParts: readonly SkillFingerprintPart[]
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        groups: groups.map((group) => ({
          dir: group.dir,
          scope: group.scope,
          skills: group.skills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            version: skill.version,
            author: skill.author,
            relativePath: skill.relativePath,
            isSymlink: skill.isSymlink,
            symlinkTarget: skill.symlinkTarget,
          })),
          truncated: group.truncated,
          skippedExternalSymlinks: group.skippedExternalSymlinks ?? 0,
          error: group.error,
        })),
        files: [...fingerprintParts].sort((left, right) =>
          `${left.scope}:${left.relativePath}`.localeCompare(`${right.scope}:${right.relativePath}`)
        ),
      })
    )
    .digest('hex');
}

async function listProjectSkillsAtRootPath(
  rootPath: string,
  skillDirs: readonly string[]
): Promise<ProjectSkillsResult> {
  const normalizedRootPath = normalizeRootPath(rootPath);
  const rootRealPath = await fs.promises.realpath(normalizedRootPath);
  const shouldIgnorePath = buildGitignoreMatcher(rootRealPath);
  const groups: ProjectSkillGroup[] = [];
  const fingerprintParts: SkillFingerprintPart[] = [];
  const uniqueSkillDirs = [
    ...new Set(skillDirs.map((skillDir) => normalizeSkillScanDir(skillDir))),
  ];

  // The known skill dirs (dozens of candidates, mostly nonexistent) are
  // independent, so scan them concurrently. Order is irrelevant: `groups` is
  // sorted below and `fingerprintParts` is sorted before hashing.
  const scannedGroups = await Promise.all(
    uniqueSkillDirs.map(async (skillDir): Promise<ProjectSkillGroup | null> => {
      try {
        return await scanProjectSkillGroup({
          rootRealPath,
          scope: 'project',
          skillDir,
          shouldIgnorePath,
          fingerprintParts,
        });
      } catch (error) {
        return {
          scope: 'project',
          dir: normalizeSkillScanDir(skillDir),
          skills: [],
          truncated: false,
          error: formatErrorMessage(error),
        };
      }
    })
  );
  for (const group of scannedGroups) {
    if (group) {
      groups.push(group);
    }
  }

  groups.sort((left, right) => left.dir.localeCompare(right.dir));

  return {
    groups: applyProjectSkillsResultBudget(groups),
    contentFingerprint: buildProjectSkillsFingerprint(groups, fingerprintParts),
  };
}

function toHomeSkillGroup(
  group: ProjectSkillGroup,
  scope: Extract<ProjectSkillScope, 'global' | 'system'>
): ProjectSkillGroup {
  return {
    ...group,
    scope,
    dir: toHomeDisplayPath(group.dir),
    skills: group.skills.map((skill) => ({
      ...skill,
      id: toHomeDisplayPath(skill.id),
      relativePath: toHomeDisplayPath(skill.relativePath),
      ...(skill.symlinkTarget ? { symlinkTarget: toHomeDisplayPath(skill.symlinkTarget) } : {}),
    })),
  };
}

async function scanHomeSkillDirs(
  homeRealPath: string,
  knownSkillDirs: readonly string[],
  scope: Extract<ProjectSkillScope, 'global' | 'system'>,
  fingerprintParts: SkillFingerprintPart[]
): Promise<ProjectSkillGroup[]> {
  const uniqueSkillDirs = [
    ...new Map(
      knownSkillDirs.map((skillDir) => {
        const normalized = normalizeKnownGlobalSkillScanDir(skillDir);
        return [normalized.displayDir, normalized] as const;
      })
    ).values(),
  ];

  const scannedGroups = await Promise.all(
    uniqueSkillDirs.map(async (skillDir): Promise<ProjectSkillGroup | null> => {
      try {
        const group = await scanProjectSkillGroup({
          rootRealPath: homeRealPath,
          scope,
          skillDir: skillDir.relativeDir,
          shouldIgnorePath: null,
          fingerprintParts,
        });
        return group ? toHomeSkillGroup(group, scope) : null;
      } catch (error) {
        return {
          scope,
          dir: skillDir.displayDir,
          skills: [],
          truncated: false,
          error: formatErrorMessage(error),
        };
      }
    })
  );
  return scannedGroups.filter((group): group is ProjectSkillGroup => group !== null);
}

/**
 * Scans the current user's home for both `global` (user-authored) and `system`
 * (agent built-in, e.g. codex `~/.codex/skills/.system`) skills over the
 * machine RPC. System dirs are tagged with the dedicated `'system'` scope so
 * the UI can present them separately from `global`.
 */
async function listGlobalSkillsAtHomePath(homePath: string): Promise<ProjectSkillsResult> {
  const homeRealPath = await fs.promises.realpath(homePath);
  const fingerprintParts: SkillFingerprintPart[] = [];

  const [globalGroups, systemGroups] = await Promise.all([
    scanHomeSkillDirs(homeRealPath, ALL_KNOWN_GLOBAL_SKILL_DIRS, 'global', fingerprintParts),
    scanHomeSkillDirs(homeRealPath, ALL_KNOWN_SYSTEM_SKILL_DIRS, 'system', fingerprintParts),
  ]);
  const groups = [...globalGroups, ...systemGroups];

  groups.sort((left, right) => left.dir.localeCompare(right.dir));

  return {
    groups: applyProjectSkillsResultBudget(groups),
    contentFingerprint: buildProjectSkillsFingerprint(groups, fingerprintParts),
  };
}

function resolveSessionWorktreeRootPath(repoKey: string, sessionId: string): string | null {
  const normalizedRepoKey = repoKey.trim();
  const normalizedSessionId = sessionId.trim();
  if (!normalizedRepoKey || !normalizedSessionId) {
    return null;
  }

  try {
    const repoId = LOCAL_REPO_ID_RE.test(normalizedRepoKey)
      ? (normalizedRepoKey as RepoId)
      : deriveRepoIdFromGitHubRepo(normalizedRepoKey);
    return getWorktreeHostPathFromDotlodyPath(
      repoId,
      normalizedSessionId as SessionId,
      getLodyDataDir(undefined, os.homedir())
    );
  } catch {
    return null;
  }
}

export class LocalProjectControlService {
  constructor(private readonly logger: Logger) {}

  prepareProject(rootPath: string): {
    localProjectId: LocalProjectId;
    name: string;
    rootPath: string;
  } {
    const normalized = rootPath.trim();
    if (!normalized) {
      throw new Error('Project path is required');
    }

    const resolvedRootPath = ensureLocalProjectRootPath(normalized);
    const localProjectId = createLocalProjectId(resolvedRootPath);

    this.logger.debug(`[local-project] Prepared path ${resolvedRootPath} as ${localProjectId}`);

    return {
      localProjectId,
      name: getLocalProjectNameFromRootPath(resolvedRootPath),
      rootPath: resolvedRootPath,
    };
  }

  async getProjectGitState(rootPath: string): Promise<LocalProjectGitState> {
    return await getLocalProjectGitStateAtRootPath(rootPath);
  }

  async listBrowseRoots(): Promise<LocalProjectBrowseRootsResult> {
    const platform = getLocalProjectBrowsePlatform();
    const homeDir = await fs.promises.realpath(os.homedir());
    return {
      platform,
      pathSeparator: getPathSeparator(),
      homeDir,
      ...(platform === 'win32' ? { drives: await listWindowsDrives() } : {}),
    };
  }

  async browseDirectory(options?: {
    absolutePath?: string;
    showHidden?: boolean;
    limit?: number;
    cursor?: string;
    registeredProjects?: Record<LocalProjectId, string>;
  }): Promise<LocalProjectBrowseDirectoryResult> {
    const requestedPath = resolveLocalProjectBrowsePath(options?.absolutePath);
    const directoryRealPath = await fs.promises.realpath(requestedPath);
    const directoryStat = await fs.promises.stat(directoryRealPath);
    if (!directoryStat.isDirectory()) {
      throw new Error('Browse path is not a directory.');
    }

    const limit = clampInteger(
      options?.limit,
      1,
      HARD_LOCAL_PROJECT_BROWSE_DIR_LIMIT,
      DEFAULT_LOCAL_PROJECT_BROWSE_DIR_LIMIT
    );
    const offset = parseLocalProjectBrowseCursor(options?.cursor);
    const registeredProjectByPath = await buildRegisteredProjectPathIndex(
      options?.registeredProjects
    );

    const showHidden = options?.showHidden ?? false;
    const dirents = await fs.promises.readdir(directoryRealPath, { withFileTypes: true });
    const candidates: Array<{
      name: string;
      absolutePath: string;
      isSymlink: boolean;
      hidden: boolean;
    }> = [];
    let entriesSinceYield = 0;

    for (const dirent of dirents) {
      entriesSinceYield += 1;
      if (entriesSinceYield >= LOCAL_PROJECT_WALK_YIELD_EVERY_ENTRIES) {
        entriesSinceYield = 0;
        await yieldToEventLoop();
      }

      const name = dirent.name;
      if (!name || name === '.' || name === '..') {
        continue;
      }
      const hidden = name.startsWith('.');
      if (hidden && !showHidden) {
        continue;
      }

      const entryPath = path.join(directoryRealPath, name);
      const isSymlink = dirent.isSymbolicLink();
      if (!dirent.isDirectory() && !isSymlink) {
        continue;
      }

      let entryRealPath: string;
      let entryStat: fs.Stats;
      try {
        entryRealPath = await fs.promises.realpath(entryPath);
        entryStat = await fs.promises.stat(entryRealPath);
      } catch {
        continue;
      }
      if (!entryStat.isDirectory()) {
        continue;
      }

      candidates.push({
        name,
        absolutePath: entryRealPath,
        isSymlink,
        hidden,
      });
    }

    candidates.sort((left, right) => left.name.localeCompare(right.name));
    const page = candidates.slice(offset, offset + limit);
    const entries: LocalProjectBrowseDirectoryResult['entries'] = [];

    for (const candidate of page) {
      const registeredProjectId = registeredProjectByPath.get(candidate.absolutePath);
      if (!(await canReadDirectory(candidate.absolutePath))) {
        entries.push({
          name: candidate.name,
          absolutePath: candidate.absolutePath,
          isSymlink: candidate.isSymlink,
          hidden: candidate.hidden,
          ...(registeredProjectId ? { registeredProjectId } : {}),
          error: 'unreadable',
        });
        continue;
      }

      const hints = await getLocalProjectBrowseHints(candidate.absolutePath);
      entries.push({
        name: candidate.name,
        absolutePath: candidate.absolutePath,
        isSymlink: candidate.isSymlink,
        hidden: candidate.hidden,
        ...(hints ? { hints } : {}),
        ...(registeredProjectId ? { registeredProjectId } : {}),
      });
    }

    const nextOffset = offset + page.length;
    const truncated = nextOffset < candidates.length;
    return {
      path: directoryRealPath,
      parentPath: getBrowseParentPath(directoryRealPath),
      entries,
      truncated,
      ...(truncated ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  async listProjectFiles(
    rootPath: string,
    options?: { maxFiles?: number }
  ): Promise<LocalProjectFileListResult> {
    const maxFiles = clampInteger(
      options?.maxFiles,
      1,
      HARD_LOCAL_PROJECT_MAX_FILES,
      DEFAULT_LOCAL_PROJECT_MAX_FILES
    );

    return await listFilesAtRootPath(rootPath, maxFiles);
  }

  async listProjectDirectory(
    rootPath: string,
    relativePath: string,
    options?: { limit?: number }
  ): Promise<LocalProjectDirectoryListResult> {
    const limit = clampInteger(
      options?.limit,
      1,
      HARD_LOCAL_PROJECT_LIST_DIR_LIMIT,
      DEFAULT_LOCAL_PROJECT_LIST_DIR_LIMIT
    );

    return await listDirectoryAtRootPath(rootPath, relativePath, limit);
  }

  async listProjectSkills(
    rootPath: string,
    skillDirs: readonly string[]
  ): Promise<ProjectSkillsResult> {
    return await listProjectSkillsAtRootPath(rootPath, skillDirs);
  }

  async listGlobalSkills(options?: { homePath?: string }): Promise<ProjectSkillsResult> {
    return await listGlobalSkillsAtHomePath(options?.homePath ?? os.homedir());
  }

  readProjectFile(
    rootPath: string,
    relativePath: string,
    options?: { maxBytes?: number }
  ): LocalProjectFileReadResult | null {
    const maxBytes = clampInteger(
      options?.maxBytes,
      1,
      HARD_LOCAL_PROJECT_READ_MAX_BYTES,
      DEFAULT_LOCAL_PROJECT_READ_MAX_BYTES
    );

    // Local-project reads back the file browser, which can render images, so
    // image files are returned as base64 bytes here.
    return readLocalFileAtRoot(rootPath, relativePath, maxBytes, true);
  }

  async checkoutProjectBranch(
    rootPath: string,
    branchName: string
  ): Promise<LocalProjectCheckoutBranchResult> {
    try {
      const result = await checkoutLocalProjectBranchAtRootPath(rootPath, branchName);
      return {
        success: true,
        currentBranch: result.currentBranch,
      };
    } catch (error) {
      return {
        success: false,
        error: formatErrorMessage(error),
      };
    }
  }

  async listWorktreeFiles(
    repoKey: string,
    sessionId: string,
    options?: { maxFiles?: number }
  ): Promise<LocalProjectFileListResult> {
    const rootPath = resolveSessionWorktreeRootPath(repoKey, sessionId);
    if (!rootPath) {
      throw new Error('Session worktree path not found.');
    }

    const maxFiles = clampInteger(
      options?.maxFiles,
      1,
      HARD_LOCAL_PROJECT_MAX_FILES,
      DEFAULT_LOCAL_PROJECT_MAX_FILES
    );

    return await listFilesAtRootPath(rootPath, maxFiles);
  }

  readWorktreeFile(
    repoKey: string,
    sessionId: string,
    relativePath: string,
    options?: { maxBytes?: number }
  ): LocalProjectFileReadResult | null {
    const rootPath = resolveSessionWorktreeRootPath(repoKey, sessionId);
    if (!rootPath) {
      return null;
    }

    const maxBytes = clampInteger(
      options?.maxBytes,
      1,
      HARD_LOCAL_PROJECT_READ_MAX_BYTES,
      DEFAULT_LOCAL_PROJECT_READ_MAX_BYTES
    );

    return readLocalFileAtRoot(rootPath, relativePath, maxBytes);
  }
}
