/**
 * Pure GitHub API client functions.
 *
 * These functions take a backend-issued GitHub token and call GitHub directly.
 * They are intended to run on the client side (browser, Electron, mobile).
 */
import { z } from 'zod';
import type {
  CommentAnchor,
  GitHubAuthorAssociation,
  GitHubCheckRun,
  GitHubCheckRunConclusion,
  GitHubCheckRunStatus,
  GitHubCheckRunsSummary,
  GitHubIssueComment,
  GitHubMergeableState,
  GitHubMergeMethod,
  GitHubPullRequestDetails,
  GitHubPullRequestState,
  GitHubReactionRollup,
  GitHubReview,
  GitHubReviewComment,
  GitHubReviewState,
  GitHubReviewThread,
  GitHubUser,
} from './session-comment-types';
import type { SessionPullRequestMeta, SessionPullRequestLegacyMetaFields } from './schema';
import {
  applyProjectSkillsResultBudget,
  buildProjectSkill,
  type ProjectSkill,
  type ProjectSkillGroup,
  type ProjectSkillsResult,
} from './acp/skills';

// ============================================================================
// Schemas
// ============================================================================

const GithubRepoDefaultBranchSchema = z.object({ default_branch: z.string() }).passthrough();

const GithubBranchItemSchema = z.object({ name: z.string() }).passthrough();
const GithubBranchListSchema = z.array(GithubBranchItemSchema);

const GithubRefSchema = z
  .object({ object: z.object({ sha: z.string() }).passthrough() })
  .passthrough();

const GithubTreeEntrySchema = z
  .object({
    path: z.string(),
    type: z.string().optional(),
    sha: z.string().optional(),
    size: z.number().optional(),
    mode: z.string().optional(),
  })
  .passthrough();

const GithubTreeSchema = z
  .object({ truncated: z.boolean().optional(), tree: z.array(GithubTreeEntrySchema) })
  .passthrough();

const GithubBlobSchema = z
  .object({
    content: z.string(),
    encoding: z.string(),
    size: z.number().optional(),
  })
  .passthrough();

const GithubContentsItemSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    type: z.string(),
    sha: z.string().optional(),
    size: z.number().optional(),
    target: z.string().optional(),
  })
  .passthrough();

const GithubContentsResponseSchema = z.union([
  GithubContentsItemSchema,
  z.array(GithubContentsItemSchema),
]);

const GithubMentionIssueOrPrSchema = z
  .object({
    number: z.number(),
    title: z.string(),
    state: z.string(),
    updated_at: z.string(),
    html_url: z.string().url(),
    pull_request: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const GithubMentionIssuesResponseSchema = z.array(GithubMentionIssueOrPrSchema);

const GithubPullRequestHeadSchema = z
  .object({
    head: z.object({ sha: z.string() }).passthrough(),
  })
  .passthrough();

const GithubUserSchema = z
  .object({
    login: z.string(),
    id: z.number(),
    avatar_url: z.string(),
    html_url: z.string(),
  })
  .passthrough()
  .transform(
    (item): GitHubUser => ({
      login: item.login,
      id: item.id,
      avatarUrl: item.avatar_url,
      htmlUrl: item.html_url,
    })
  );

const GithubReactionRollupSchema = z
  .object({
    total_count: z.number().optional(),
    '+1': z.number().optional(),
    '-1': z.number().optional(),
    laugh: z.number().optional(),
    hooray: z.number().optional(),
    confused: z.number().optional(),
    heart: z.number().optional(),
    rocket: z.number().optional(),
    eyes: z.number().optional(),
  })
  .passthrough()
  .transform(
    (item): GitHubReactionRollup => ({
      totalCount: item.total_count ?? 0,
      '+1': item['+1'] ?? 0,
      '-1': item['-1'] ?? 0,
      laugh: item.laugh ?? 0,
      hooray: item.hooray ?? 0,
      confused: item.confused ?? 0,
      heart: item.heart ?? 0,
      rocket: item.rocket ?? 0,
      eyes: item.eyes ?? 0,
    })
  );

const GITHUB_AUTHOR_ASSOCIATIONS = new Set<string>([
  'COLLABORATOR',
  'CONTRIBUTOR',
  'FIRST_TIMER',
  'FIRST_TIME_CONTRIBUTOR',
  'MANNEQUIN',
  'MEMBER',
  'NONE',
  'OWNER',
]);

function normalizeAuthorAssociation(value: string): GitHubAuthorAssociation {
  return GITHUB_AUTHOR_ASSOCIATIONS.has(value) ? (value as GitHubAuthorAssociation) : 'NONE';
}

function normalizeReviewSide(value: string | null | undefined): 'LEFT' | 'RIGHT' {
  return value === 'LEFT' ? 'LEFT' : 'RIGHT';
}

function normalizeReviewSubjectType(value: string | null | undefined): 'line' | 'file' {
  return value === 'file' ? 'file' : 'line';
}

const GithubReviewCommentSchema = z
  .object({
    id: z.number(),
    node_id: z.string(),
    pull_request_review_id: z.number().nullable().optional(),
    body: z.string(),
    path: z.string(),
    commit_id: z.string(),
    original_commit_id: z.string().nullable().optional(),
    diff_hunk: z.string().optional(),
    in_reply_to_id: z.number().optional(),
    subject_type: z.string().nullable().optional(),
    user: GithubUserSchema.nullable(),
    author_association: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    html_url: z.string(),
    line: z.number().nullable().optional(),
    original_line: z.number().nullable().optional(),
    side: z.string().nullable().optional(),
    start_line: z.number().nullable().optional(),
    original_start_line: z.number().nullable().optional(),
    start_side: z.string().nullable().optional(),
    reactions: GithubReactionRollupSchema.optional(),
  })
  .passthrough()
  .transform(
    (item): GitHubReviewComment => ({
      id: item.id,
      nodeId: item.node_id,
      pullRequestReviewId: item.pull_request_review_id ?? null,
      body: item.body,
      path: item.path,
      commitId: item.commit_id,
      originalCommitId: item.original_commit_id ?? item.commit_id,
      diffHunk: item.diff_hunk ?? '',
      inReplyToId: item.in_reply_to_id,
      subjectType: normalizeReviewSubjectType(item.subject_type),
      user: item.user,
      authorAssociation: normalizeAuthorAssociation(item.author_association),
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      htmlUrl: item.html_url,
      line: item.line ?? null,
      originalLine: item.original_line ?? null,
      side: normalizeReviewSide(item.side),
      startLine: item.start_line ?? null,
      originalStartLine: item.original_start_line ?? null,
      startSide: item.start_side === 'LEFT' || item.start_side === 'RIGHT' ? item.start_side : null,
      reactions: item.reactions,
    })
  );

const GithubReviewCommentsResponseSchema = z.array(GithubReviewCommentSchema);

const GITHUB_REVIEW_STATES = new Set<GitHubReviewState>([
  'approved',
  'changes_requested',
  'commented',
  'dismissed',
  'pending',
]);

function normalizeReviewState(value: string | null | undefined): GitHubReviewState {
  if (!value) return 'commented';
  const lower = value.toLowerCase();
  return GITHUB_REVIEW_STATES.has(lower as GitHubReviewState)
    ? (lower as GitHubReviewState)
    : 'commented';
}

const GithubReviewSchema = z
  .object({
    id: z.number(),
    node_id: z.string(),
    body: z.string().nullable().optional(),
    state: z.string(),
    user: GithubUserSchema.nullable(),
    author_association: z.string(),
    commit_id: z.string().nullable().optional(),
    submitted_at: z.string().nullable().optional(),
    html_url: z.string(),
  })
  .passthrough()
  .transform(
    (item): GitHubReview => ({
      id: item.id,
      nodeId: item.node_id,
      body: item.body ?? '',
      state: normalizeReviewState(item.state),
      user: item.user,
      authorAssociation: normalizeAuthorAssociation(item.author_association),
      commitId: item.commit_id ?? null,
      submittedAt: item.submitted_at ?? null,
      htmlUrl: item.html_url,
    })
  );

const GithubReviewsResponseSchema = z.array(GithubReviewSchema);

// ============================================================================
// Types
// ============================================================================

export type GitHubIssueOrPR = {
  number: number;
  url: string;
  title: string;
  type: 'issue' | 'pr';
  updatedAtMs: number;
};

export type GitHubBranchesResult = {
  defaultBranch: string;
  branches: string[];
};

export type GitHubFilePathsResult = {
  defaultBranch: string;
  headSha: string;
  paths: string[];
  truncated: boolean;
};

export type GitHubDefaultBranchHeadResult = {
  defaultBranch: string;
  headSha: string;
};

export type GitHubTreeLevelEntry = {
  path: string;
  type: string;
  sha: string;
  size?: number;
};

export type GitHubTreeLevelResult = {
  entries: GitHubTreeLevelEntry[];
  truncated: boolean;
};

export type GitHubReviewCommentPosition = {
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  commit_id: string;
};

export type GitHubCreateReviewCommentInput = {
  body: string;
  path: string;
  commitId: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  startLine?: number | null;
  startSide?: 'LEFT' | 'RIGHT' | null;
};

// ============================================================================
// Errors
// ============================================================================

/**
 * Thrown when the GitHub API returns 401 (token expired/revoked).
 * Callers can catch this to invalidate cached tokens and retry.
 */
export class GitHubAuthError extends Error {
  constructor(message?: string) {
    super(
      message ??
        'Your GitHub authorization has expired or been revoked. Please sign in with GitHub again to reconnect.'
    );
    this.name = 'GitHubAuthError';
  }
}

/**
 * Thrown when a GitHub App installation lacks the permission to access a
 * resource (e.g. missing `checks:read`). Callers should surface a CTA to
 * update the app installation permissions.
 */
export class GitHubPermissionError extends Error {
  readonly code = 'github_permission_error';
  readonly resource: string;
  readonly status: number;

  constructor(options: { resource: string; status: number; message?: string }) {
    super(
      options.message ??
        `GitHub App is missing permission to access ${options.resource}. Update the installation to grant access.`
    );
    this.name = 'GitHubPermissionError';
    this.resource = options.resource;
    this.status = options.status;
  }
}

/**
 * Thrown when a file does not exist at the requested GitHub ref.
 */
export class GitHubFileNotFoundError extends Error {
  readonly code = 'github_file_not_found';
  readonly repoFullName: string;
  readonly path: string;
  readonly commitHash: string;

  constructor(options: { repoFullName: string; path: string; commitHash: string }) {
    super(
      `GitHub file not found: ${options.repoFullName}/${options.path} at ${options.commitHash}`
    );
    this.name = 'GitHubFileNotFoundError';
    this.repoFullName = options.repoFullName;
    this.path = options.path;
    this.commitHash = options.commitHash;
  }
}

/**
 * Thrown before reading a GitHub file body that exceeds the caller's byte cap.
 */
export class GitHubFileTooLargeError extends Error {
  readonly code = 'github_file_too_large';
  readonly repoFullName: string;
  readonly path: string;
  readonly commitHash: string;
  readonly maxBytes: number;

  constructor(options: {
    repoFullName: string;
    path: string;
    commitHash: string;
    maxBytes: number;
  }) {
    super(
      `GitHub file is too large to open: ${options.repoFullName}/${options.path} at ${options.commitHash}`
    );
    this.name = 'GitHubFileTooLargeError';
    this.repoFullName = options.repoFullName;
    this.path = options.path;
    this.commitHash = options.commitHash;
    this.maxBytes = options.maxBytes;
  }
}

// ============================================================================
// Helpers
// ============================================================================

const GITHUB_API_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
} as const;

export interface GitHubReadRequestOptions {
  cache?: RequestCache;
}

function authHeaders(token: string) {
  return { ...GITHUB_API_HEADERS, authorization: `Bearer ${token}` };
}

const DEFAULT_GITHUB_FILE_READ_MAX_BYTES = 1024 * 1024;

type GitHubFileReadOptions = {
  repoFullName: string;
  path: string;
  commitHash: string;
  maxBytes: number;
};

async function readGitHubFileBytesWithLimit(
  response: Response,
  options: GitHubFileReadOptions
): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
    throw new GitHubFileTooLargeError(options);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > options.maxBytes) {
      throw new GitHubFileTooLargeError(options);
    }
    return buffer;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    const chunk = result.value;
    totalBytes += chunk.byteLength;
    if (totalBytes > options.maxBytes) {
      await reader.cancel();
      throw new GitHubFileTooLargeError(options);
    }
    chunks.push(chunk);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readGitHubFileTextWithLimit(
  response: Response,
  options: GitHubFileReadOptions
): Promise<string> {
  return new TextDecoder().decode(await readGitHubFileBytesWithLimit(response, options));
}

async function requestGithubJson<T>(
  url: string,
  token: string,
  schema: z.ZodType<T>,
  init?: RequestInit
): Promise<T> {
  const headers = new Headers(authHeaders(token));
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  const res = await fetch(url, {
    ...init,
    headers,
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) {
      throw new GitHubAuthError();
    }
    throw new Error(`GitHub API error: ${res.status} ${text}`);
  }
  const json = JSON.parse(text) as unknown;
  return schema.parse(json);
}

async function fetchGithubJson<T>(
  url: string,
  token: string,
  schema: z.ZodType<T>,
  init?: RequestInit
): Promise<T> {
  return requestGithubJson(url, token, schema, init);
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',').map((part) => part.trim());
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (!match) continue;
    const url = match[1];
    const rel = match[2];
    if (rel === 'next' && url) {
      return url;
    }
  }
  return null;
}

function encodeGitHubPath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function parseGithubUpdatedAtMs(updatedAt: string): number {
  const ms = Date.parse(updatedAt);
  return Number.isFinite(ms) ? ms : Date.now();
}

type GitHubTreeEntry = z.infer<typeof GithubTreeEntrySchema>;
type GitHubContentsItem = z.infer<typeof GithubContentsItemSchema>;

const GITHUB_SYMLINK_MODE = '120000';
const DEFAULT_GITHUB_SKILL_MD_MAX_BYTES = 256 * 1024;

function normalizeGitHubRepoPath(pathValue: string): string | null {
  const trimmed = pathValue.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.includes('\0')) {
    return null;
  }
  if (trimmed.startsWith('/')) {
    return null;
  }

  const parts: string[] = [];
  for (const rawPart of trimmed.split('/')) {
    if (!rawPart || rawPart === '.') {
      continue;
    }
    if (rawPart === '..') {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
      continue;
    }
    parts.push(rawPart);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

function normalizeGitHubSkillDir(skillDir: string): string {
  const normalized = normalizeGitHubRepoPath(skillDir);
  if (!normalized) {
    throw new Error(`Invalid project skill directory: ${skillDir}`);
  }
  return normalized;
}

function getGitHubPathParent(pathValue: string): string {
  const index = pathValue.lastIndexOf('/');
  return index === -1 ? '' : pathValue.slice(0, index);
}

function getGitHubPathBasename(pathValue: string): string {
  const index = pathValue.lastIndexOf('/');
  return index === -1 ? pathValue : pathValue.slice(index + 1);
}

function resolveGitHubSymlinkTarget(linkPath: string, rawTarget: string): string | null {
  const target = rawTarget.trim();
  if (!target || target.startsWith('/')) {
    return null;
  }
  const parent = getGitHubPathParent(linkPath);
  return normalizeGitHubRepoPath(parent ? `${parent}/${target}` : target);
}

function isGitHubSymlinkTreeEntry(
  entry: GitHubTreeEntry | undefined
): entry is GitHubTreeEntry & { mode: typeof GITHUB_SYMLINK_MODE } {
  return entry?.mode === GITHUB_SYMLINK_MODE;
}

function hasTreePathPrefix(treeByPath: ReadonlyMap<string, GitHubTreeEntry>, pathValue: string) {
  const prefix = `${pathValue}/`;
  for (const pathKey of treeByPath.keys()) {
    if (pathKey.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function decodeBase64Utf8(content: string): string {
  const normalized = content.replace(/\s/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

async function githubFetchBlobText(
  token: string,
  repoFullName: string,
  sha: string,
  maxBytes = DEFAULT_GITHUB_SKILL_MD_MAX_BYTES
): Promise<string> {
  const blob = await fetchGithubJson(
    `https://api.github.com/repos/${repoFullName}/git/blobs/${encodeURIComponent(sha)}`,
    token,
    GithubBlobSchema
  );
  if (blob.encoding !== 'base64') {
    throw new Error(`Unsupported GitHub blob encoding: ${blob.encoding}`);
  }
  if (typeof blob.size === 'number' && blob.size > maxBytes) {
    throw new GitHubFileTooLargeError({
      repoFullName,
      path: sha,
      commitHash: sha,
      maxBytes,
    });
  }
  const decoded = decodeBase64Utf8(blob.content);
  if (new TextEncoder().encode(decoded).byteLength > maxBytes) {
    throw new GitHubFileTooLargeError({
      repoFullName,
      path: sha,
      commitHash: sha,
      maxBytes,
    });
  }
  return decoded;
}

async function readGitHubSymlinkTreeTarget(
  token: string,
  repoFullName: string,
  entry: GitHubTreeEntry
): Promise<string> {
  if (!entry.sha) {
    throw new Error(`GitHub symlink entry is missing blob sha: ${entry.path}`);
  }
  return await githubFetchBlobText(token, repoFullName, entry.sha);
}

async function resolveGitHubTreeDirectory(args: {
  token: string;
  repoFullName: string;
  treeByPath: ReadonlyMap<string, GitHubTreeEntry>;
  pathValue: string;
  depth?: number;
}): Promise<{ kind: 'directory'; path: string; isSymlink: boolean } | 'external-symlink' | null> {
  const depth = args.depth ?? 0;
  if (depth > 8) {
    throw new Error(`GitHub symlink loop while resolving ${args.pathValue}`);
  }

  const entry = args.treeByPath.get(args.pathValue);
  if (entry?.type === 'tree') {
    return { kind: 'directory', path: args.pathValue, isSymlink: false };
  }
  if (!entry && hasTreePathPrefix(args.treeByPath, args.pathValue)) {
    return { kind: 'directory', path: args.pathValue, isSymlink: false };
  }
  const symlinkEntry = entry;
  if (symlinkEntry === undefined || !isGitHubSymlinkTreeEntry(symlinkEntry)) {
    return null;
  }

  const target = resolveGitHubSymlinkTarget(
    args.pathValue,
    await readGitHubSymlinkTreeTarget(args.token, args.repoFullName, symlinkEntry)
  );
  if (!target) {
    return 'external-symlink';
  }

  const resolved = await resolveGitHubTreeDirectory({
    ...args,
    pathValue: target,
    depth: depth + 1,
  });
  if (resolved === 'external-symlink' || resolved === null) {
    return resolved;
  }
  return { kind: 'directory', path: resolved.path, isSymlink: true };
}

async function resolveGitHubTreeFile(args: {
  token: string;
  repoFullName: string;
  treeByPath: ReadonlyMap<string, GitHubTreeEntry>;
  pathValue: string;
  depth?: number;
}): Promise<{ kind: 'file'; path: string; isSymlink: boolean } | 'external-symlink' | null> {
  const depth = args.depth ?? 0;
  if (depth > 8) {
    throw new Error(`GitHub symlink loop while resolving ${args.pathValue}`);
  }

  const entry = args.treeByPath.get(args.pathValue);
  if (!entry) {
    return null;
  }
  if (entry.type === 'blob' && !isGitHubSymlinkTreeEntry(entry)) {
    return { kind: 'file', path: args.pathValue, isSymlink: false };
  }
  const symlinkEntry = entry;
  if (!isGitHubSymlinkTreeEntry(symlinkEntry)) {
    return null;
  }

  const target = resolveGitHubSymlinkTarget(
    args.pathValue,
    await readGitHubSymlinkTreeTarget(args.token, args.repoFullName, symlinkEntry)
  );
  if (!target) {
    return 'external-symlink';
  }
  const resolved = await resolveGitHubTreeFile({
    ...args,
    pathValue: target,
    depth: depth + 1,
  });
  if (resolved === 'external-symlink' || resolved === null) {
    return resolved;
  }
  return { kind: 'file', path: resolved.path, isSymlink: true };
}

function getGitHubTreeDirectChildren(
  treeByPath: ReadonlyMap<string, GitHubTreeEntry>,
  parentPath: string
): GitHubTreeEntry[] {
  const prefix = `${parentPath}/`;
  const children = new Map<string, GitHubTreeEntry>();
  for (const entry of treeByPath.values()) {
    if (!entry.path.startsWith(prefix)) {
      continue;
    }
    const rest = entry.path.slice(prefix.length);
    if (!rest || rest.includes('/')) {
      continue;
    }
    children.set(rest, entry);
  }
  return Array.from(children.values()).sort((left, right) => left.path.localeCompare(right.path));
}

async function addGitHubTreeSkillFromDirectory(args: {
  token: string;
  repoFullName: string;
  commitHash: string;
  treeByPath: ReadonlyMap<string, GitHubTreeEntry>;
  groupDir: string;
  displaySkillDir: string;
  realSkillDir: string;
  inheritedSymlink: boolean;
  skills: ProjectSkill[];
}): Promise<'added' | 'missing' | 'external-symlink'> {
  const skillMd = await resolveGitHubTreeFile({
    token: args.token,
    repoFullName: args.repoFullName,
    treeByPath: args.treeByPath,
    pathValue: `${args.realSkillDir}/SKILL.md`,
  });
  if (skillMd === null) {
    return 'missing';
  }
  if (skillMd === 'external-symlink') {
    return 'external-symlink';
  }

  const markdown = await githubFetchFileAtCommit(
    args.token,
    args.repoFullName,
    skillMd.path,
    args.commitHash,
    { maxBytes: DEFAULT_GITHUB_SKILL_MD_MAX_BYTES }
  );
  const isSymlink = args.inheritedSymlink || skillMd.isSymlink;
  args.skills.push(
    buildProjectSkill({
      groupDir: args.groupDir,
      displaySkillDir: args.displaySkillDir,
      markdown,
      relativePath: `${args.displaySkillDir}/SKILL.md`,
      isSymlink,
      symlinkTarget: isSymlink ? skillMd.path.split('/').slice(0, -1).join('/') : undefined,
    })
  );
  return 'added';
}

async function scanGitHubTreeProjectSkillGroup(args: {
  token: string;
  repoFullName: string;
  commitHash: string;
  treeByPath: ReadonlyMap<string, GitHubTreeEntry>;
  skillDir: string;
}): Promise<ProjectSkillGroup | null> {
  const groupDir = normalizeGitHubSkillDir(args.skillDir);
  const resolvedGroup = await resolveGitHubTreeDirectory({
    token: args.token,
    repoFullName: args.repoFullName,
    treeByPath: args.treeByPath,
    pathValue: groupDir,
  });
  if (!resolvedGroup) {
    return null;
  }

  let skippedExternalSymlinks = 0;
  if (resolvedGroup === 'external-symlink') {
    return {
      scope: 'project',
      dir: groupDir,
      skills: [],
      truncated: false,
      skippedExternalSymlinks: 1,
    };
  }

  const skills: ProjectSkill[] = [];
  // No dedup by resolved path: symlinked / duplicate skill dirs are each listed
  // under their own path so the UI shows every entry (depth-1 scan, no loop).
  const rootSkillResult = await addGitHubTreeSkillFromDirectory({
    token: args.token,
    repoFullName: args.repoFullName,
    commitHash: args.commitHash,
    treeByPath: args.treeByPath,
    groupDir,
    displaySkillDir: groupDir,
    realSkillDir: resolvedGroup.path,
    inheritedSymlink: resolvedGroup.isSymlink,
    skills,
  });
  if (rootSkillResult === 'external-symlink') {
    skippedExternalSymlinks += 1;
  }

  for (const child of getGitHubTreeDirectChildren(args.treeByPath, resolvedGroup.path)) {
    if (child.path.endsWith('/SKILL.md') || child.path === `${resolvedGroup.path}/SKILL.md`) {
      continue;
    }
    if (child.type !== 'tree' && !isGitHubSymlinkTreeEntry(child)) {
      continue;
    }

    const childName = getGitHubPathBasename(child.path);
    const resolvedChild = await resolveGitHubTreeDirectory({
      token: args.token,
      repoFullName: args.repoFullName,
      treeByPath: args.treeByPath,
      pathValue: child.path,
    });
    if (!resolvedChild) {
      continue;
    }
    if (resolvedChild === 'external-symlink') {
      skippedExternalSymlinks += 1;
      continue;
    }

    const addResult = await addGitHubTreeSkillFromDirectory({
      token: args.token,
      repoFullName: args.repoFullName,
      commitHash: args.commitHash,
      treeByPath: args.treeByPath,
      groupDir,
      displaySkillDir: `${groupDir}/${childName}`,
      realSkillDir: resolvedChild.path,
      inheritedSymlink: resolvedGroup.isSymlink || resolvedChild.isSymlink,
      skills,
    });
    if (addResult === 'external-symlink') {
      skippedExternalSymlinks += 1;
    }
  }

  skills.sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    return nameCompare === 0 ? left.relativePath.localeCompare(right.relativePath) : nameCompare;
  });

  if (skills.length === 0 && skippedExternalSymlinks === 0) {
    return null;
  }
  return {
    scope: 'project',
    dir: groupDir,
    skills,
    truncated: false,
    ...(skippedExternalSymlinks > 0 ? { skippedExternalSymlinks } : {}),
  };
}

async function githubFetchContentsOrNull(
  token: string,
  repoFullName: string,
  pathValue: string,
  ref: string
): Promise<GitHubContentsItem | GitHubContentsItem[] | null> {
  const encodedPath = encodeGitHubPath(pathValue);
  const apiUrl = new URL(`https://api.github.com/repos/${repoFullName}/contents/${encodedPath}`);
  apiUrl.searchParams.set('ref', ref);
  const res = await fetch(apiUrl.toString(), { headers: authHeaders(token) });
  const text = await res.text();
  if (res.status === 404) {
    return null;
  }
  if (res.status === 401) {
    throw new GitHubAuthError();
  }
  if (!res.ok) {
    throw new Error(`GitHub contents API error: ${res.status} ${text}`);
  }
  return GithubContentsResponseSchema.parse(JSON.parse(text) as unknown);
}

function isGitHubContentsDirectory(
  value: GitHubContentsItem | GitHubContentsItem[]
): value is GitHubContentsItem[] {
  return Array.isArray(value);
}

async function resolveGitHubContentsDirectory(args: {
  token: string;
  repoFullName: string;
  commitHash: string;
  pathValue: string;
  depth?: number;
}): Promise<
  | { kind: 'directory'; path: string; entries: GitHubContentsItem[]; isSymlink: boolean }
  | 'external-symlink'
  | null
> {
  const depth = args.depth ?? 0;
  if (depth > 8) {
    throw new Error(`GitHub symlink loop while resolving ${args.pathValue}`);
  }
  const contents = await githubFetchContentsOrNull(
    args.token,
    args.repoFullName,
    args.pathValue,
    args.commitHash
  );
  if (!contents) {
    return null;
  }
  if (isGitHubContentsDirectory(contents)) {
    return { kind: 'directory', path: args.pathValue, entries: contents, isSymlink: false };
  }
  if (contents.type !== 'symlink') {
    return null;
  }

  const rawTarget =
    contents.target ??
    (contents.sha
      ? await githubFetchBlobText(args.token, args.repoFullName, contents.sha)
      : undefined);
  if (!rawTarget) {
    throw new Error(`GitHub symlink is missing target: ${contents.path}`);
  }
  const target = resolveGitHubSymlinkTarget(args.pathValue, rawTarget);
  if (!target) {
    return 'external-symlink';
  }
  const resolved = await resolveGitHubContentsDirectory({
    ...args,
    pathValue: target,
    depth: depth + 1,
  });
  if (!resolved || resolved === 'external-symlink') {
    return resolved;
  }
  return { ...resolved, isSymlink: true };
}

async function resolveGitHubContentsFile(args: {
  token: string;
  repoFullName: string;
  commitHash: string;
  pathValue: string;
  depth?: number;
}): Promise<{ kind: 'file'; path: string; isSymlink: boolean } | 'external-symlink' | null> {
  const depth = args.depth ?? 0;
  if (depth > 8) {
    throw new Error(`GitHub symlink loop while resolving ${args.pathValue}`);
  }
  const contents = await githubFetchContentsOrNull(
    args.token,
    args.repoFullName,
    args.pathValue,
    args.commitHash
  );
  if (!contents || isGitHubContentsDirectory(contents)) {
    return null;
  }
  if (contents.type === 'file') {
    return { kind: 'file', path: args.pathValue, isSymlink: false };
  }
  if (contents.type !== 'symlink') {
    return null;
  }

  const rawTarget =
    contents.target ??
    (contents.sha
      ? await githubFetchBlobText(args.token, args.repoFullName, contents.sha)
      : undefined);
  if (!rawTarget) {
    throw new Error(`GitHub symlink is missing target: ${contents.path}`);
  }
  const target = resolveGitHubSymlinkTarget(args.pathValue, rawTarget);
  if (!target) {
    return 'external-symlink';
  }
  const resolved = await resolveGitHubContentsFile({
    ...args,
    pathValue: target,
    depth: depth + 1,
  });
  if (!resolved || resolved === 'external-symlink') {
    return resolved;
  }
  return { kind: 'file', path: resolved.path, isSymlink: true };
}

async function addGitHubContentsSkillFromDirectory(args: {
  token: string;
  repoFullName: string;
  commitHash: string;
  groupDir: string;
  displaySkillDir: string;
  realSkillDir: string;
  inheritedSymlink: boolean;
  skills: ProjectSkill[];
}): Promise<'added' | 'missing' | 'external-symlink'> {
  const skillMd = await resolveGitHubContentsFile({
    token: args.token,
    repoFullName: args.repoFullName,
    commitHash: args.commitHash,
    pathValue: `${args.realSkillDir}/SKILL.md`,
  });
  if (!skillMd) {
    return 'missing';
  }
  if (skillMd === 'external-symlink') {
    return 'external-symlink';
  }

  const markdown = await githubFetchFileAtCommit(
    args.token,
    args.repoFullName,
    skillMd.path,
    args.commitHash,
    { maxBytes: DEFAULT_GITHUB_SKILL_MD_MAX_BYTES }
  );
  const isSymlink = args.inheritedSymlink || skillMd.isSymlink;
  args.skills.push(
    buildProjectSkill({
      groupDir: args.groupDir,
      displaySkillDir: args.displaySkillDir,
      markdown,
      relativePath: `${args.displaySkillDir}/SKILL.md`,
      isSymlink,
      symlinkTarget: isSymlink ? skillMd.path.split('/').slice(0, -1).join('/') : undefined,
    })
  );
  return 'added';
}

async function scanGitHubContentsProjectSkillGroup(args: {
  token: string;
  repoFullName: string;
  commitHash: string;
  skillDir: string;
}): Promise<ProjectSkillGroup | null> {
  const groupDir = normalizeGitHubSkillDir(args.skillDir);
  const resolvedGroup = await resolveGitHubContentsDirectory({
    token: args.token,
    repoFullName: args.repoFullName,
    commitHash: args.commitHash,
    pathValue: groupDir,
  });
  if (!resolvedGroup) {
    return null;
  }
  if (resolvedGroup === 'external-symlink') {
    return {
      scope: 'project',
      dir: groupDir,
      skills: [],
      truncated: false,
      skippedExternalSymlinks: 1,
    };
  }

  let skippedExternalSymlinks = 0;
  const skills: ProjectSkill[] = [];
  // No dedup by resolved path: symlinked / duplicate skill dirs are each listed
  // under their own path so the UI shows every entry (depth-1 scan, no loop).
  const rootSkillResult = await addGitHubContentsSkillFromDirectory({
    token: args.token,
    repoFullName: args.repoFullName,
    commitHash: args.commitHash,
    groupDir,
    displaySkillDir: groupDir,
    realSkillDir: resolvedGroup.path,
    inheritedSymlink: resolvedGroup.isSymlink,
    skills,
  });
  if (rootSkillResult === 'external-symlink') {
    skippedExternalSymlinks += 1;
  }

  for (const entry of [...resolvedGroup.entries].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    if (entry.name === 'SKILL.md' || (entry.type !== 'dir' && entry.type !== 'symlink')) {
      continue;
    }

    let realSkillDir = entry.path;
    let entryIsSymlink = false;
    if (entry.type === 'symlink') {
      const rawTarget =
        entry.target ??
        (entry.sha ? await githubFetchBlobText(args.token, args.repoFullName, entry.sha) : '');
      const target = resolveGitHubSymlinkTarget(entry.path, rawTarget);
      if (!target) {
        skippedExternalSymlinks += 1;
        continue;
      }
      realSkillDir = target;
      entryIsSymlink = true;
    }

    const addResult = await addGitHubContentsSkillFromDirectory({
      token: args.token,
      repoFullName: args.repoFullName,
      commitHash: args.commitHash,
      groupDir,
      displaySkillDir: `${groupDir}/${entry.name}`,
      realSkillDir,
      inheritedSymlink: resolvedGroup.isSymlink || entryIsSymlink,
      skills,
    });
    if (addResult === 'external-symlink') {
      skippedExternalSymlinks += 1;
    }
  }

  skills.sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    return nameCompare === 0 ? left.relativePath.localeCompare(right.relativePath) : nameCompare;
  });

  if (skills.length === 0 && skippedExternalSymlinks === 0) {
    return null;
  }
  return {
    scope: 'project',
    dir: groupDir,
    skills,
    truncated: false,
    ...(skippedExternalSymlinks > 0 ? { skippedExternalSymlinks } : {}),
  };
}

function resolveGitHubReviewThreadLine(root: GitHubReviewComment): number {
  return root.line ?? root.originalLine ?? root.startLine ?? root.originalStartLine ?? 0;
}

export function groupGitHubReviewComments(
  comments: readonly GitHubReviewComment[]
): GitHubReviewThread[] {
  const roots = new Map<number, GitHubReviewComment>();
  const byRootId = new Map<number, GitHubReviewComment[]>();

  for (const comment of comments) {
    if (comment.inReplyToId === undefined) {
      roots.set(comment.id, comment);
      byRootId.set(comment.id, [comment]);
      continue;
    }

    const existing = byRootId.get(comment.inReplyToId);
    if (existing) {
      existing.push(comment);
    } else {
      byRootId.set(comment.inReplyToId, [comment]);
    }
  }

  for (const [rootId, threadComments] of byRootId) {
    if (roots.has(rootId)) {
      continue;
    }
    const fallbackRoot = threadComments[0];
    if (fallbackRoot) {
      roots.set(rootId, fallbackRoot);
    }
  }

  return Array.from(byRootId.entries())
    .map(([rootId, threadComments]): GitHubReviewThread | null => {
      const root = roots.get(rootId);
      if (!root) {
        return null;
      }
      const sortedComments = [...threadComments].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt)
      );
      const anchorLine = resolveGitHubReviewThreadLine(root);
      return {
        id: rootId,
        anchor: {
          path: root.path,
          line: anchorLine,
          side: root.side,
          startLine: root.startLine,
          startSide: root.startSide,
        },
        comments: sortedComments,
        outdated: root.line === null,
        diffHunk: root.diffHunk,
        subjectType: root.subjectType,
      };
    })
    .filter((thread): thread is GitHubReviewThread => thread !== null)
    .sort((a, b) => {
      const pathCompare = a.anchor.path.localeCompare(b.anchor.path);
      if (pathCompare !== 0) return pathCompare;
      if (a.anchor.line !== b.anchor.line) return a.anchor.line - b.anchor.line;
      return a.id - b.id;
    });
}

export function lodyAnchorToGitHubParams(
  anchor: CommentAnchor,
  prMeta: SessionPullRequestMeta,
  headCommitSha: string | undefined = (prMeta as SessionPullRequestLegacyMetaFields).headCommitSha
): GitHubReviewCommentPosition {
  if (anchor.anchorType !== 'diff') {
    throw new Error('Only diff comments can be synced to GitHub review comments.');
  }
  const path = anchor.path.trim();
  if (!path) {
    throw new Error('Cannot sync comment to GitHub without a file path.');
  }
  if (anchor.side !== 'additions' && anchor.side !== 'deletions') {
    throw new Error('Cannot sync comment to GitHub without a diff side.');
  }
  if (!Number.isFinite(anchor.lineNumber) || anchor.lineNumber <= 0) {
    throw new Error('Cannot sync comment to GitHub without a valid line number.');
  }
  const commitSha = headCommitSha?.trim();
  if (!commitSha) {
    throw new Error('Cannot sync comment to GitHub without the pull request head commit SHA.');
  }

  return {
    path,
    side: anchor.side === 'additions' ? 'RIGHT' : 'LEFT',
    line: anchor.lineNumber,
    commit_id: commitSha,
  };
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Fetch a file's content at a specific commit.
 * Falls back to raw.githubusercontent.com for large files.
 */
/**
 * Fetch a file's contents from the GitHub contents API at a commit/branch,
 * reading the response body with `readBody` (text or raw bytes). Shared by the
 * text and bytes public helpers so the auth/404/too-large + raw fallback logic
 * stays single-sourced.
 */
async function githubFetchFileBodyAtCommit<T>(
  token: string,
  repoFullName: string,
  path: string,
  commitHash: string,
  maxBytes: number,
  readBody: (response: Response, options: GitHubFileReadOptions) => Promise<T>
): Promise<T> {
  const encodedPath = encodeGitHubPath(path);
  const readOptions: GitHubFileReadOptions = { repoFullName, path, commitHash, maxBytes };

  const apiUrl = new URL(`https://api.github.com/repos/${repoFullName}/contents/${encodedPath}`);
  apiUrl.searchParams.set('ref', commitHash);

  const res = await fetch(apiUrl.toString(), {
    headers: {
      accept: 'application/vnd.github.raw',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });

  if (res.status === 404) {
    throw new GitHubFileNotFoundError({ repoFullName, path, commitHash });
  }

  if (res.status === 401) {
    throw new GitHubAuthError();
  }

  if (res.ok) {
    return await readBody(res, readOptions);
  }

  const body = await res.text();
  if (res.status === 403 && body.toLowerCase().includes('too large')) {
    const rawUrl = `https://raw.githubusercontent.com/${repoFullName}/${encodeURIComponent(
      commitHash
    )}/${encodedPath}`;
    const rawRes = await fetch(rawUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (rawRes.status === 404) {
      throw new GitHubFileNotFoundError({ repoFullName, path, commitHash });
    }
    if (rawRes.ok) {
      return await readBody(rawRes, readOptions);
    }
    const rawBody = await rawRes.text();
    throw new Error(`GitHub raw fetch error: ${rawRes.status} ${rawBody}`);
  }

  throw new Error(`GitHub contents API error: ${res.status} ${body}`);
}

export async function githubFetchFileAtCommit(
  token: string,
  repoFullName: string,
  path: string,
  commitHash: string,
  options?: { maxBytes?: number }
): Promise<string> {
  return await githubFetchFileBodyAtCommit(
    token,
    repoFullName,
    path,
    commitHash,
    options?.maxBytes ?? DEFAULT_GITHUB_FILE_READ_MAX_BYTES,
    readGitHubFileTextWithLimit
  );
}

/**
 * Like {@link githubFetchFileAtCommit} but returns the raw bytes, for binary
 * files such as images that must not be UTF-8 decoded.
 */
export async function githubFetchFileBytesAtCommit(
  token: string,
  repoFullName: string,
  path: string,
  commitHash: string,
  options?: { maxBytes?: number }
): Promise<Uint8Array> {
  return await githubFetchFileBodyAtCommit(
    token,
    repoFullName,
    path,
    commitHash,
    options?.maxBytes ?? DEFAULT_GITHUB_FILE_READ_MAX_BYTES,
    readGitHubFileBytesWithLimit
  );
}

/**
 * List all branches in a repository, plus its default branch.
 */
export async function githubFetchBranches(
  token: string,
  repoFullName: string
): Promise<GitHubBranchesResult> {
  const repoMeta = await fetchGithubJson(
    `https://api.github.com/repos/${repoFullName}`,
    token,
    GithubRepoDefaultBranchSchema
  );
  const defaultBranch = repoMeta.default_branch;

  const branches = new Set<string>();
  let nextUrl: string | null = `https://api.github.com/repos/${repoFullName}/branches?per_page=100`;

  while (nextUrl) {
    const res = await fetch(nextUrl, { headers: authHeaders(token) });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) {
        throw new GitHubAuthError();
      }
      throw new Error(`GitHub API error: ${res.status} ${text}`);
    }
    const page = GithubBranchListSchema.parse(JSON.parse(text) as unknown);
    for (const item of page) {
      const name = item.name.trim();
      if (!name) continue;
      branches.add(name);
    }
    nextUrl = parseNextLink(res.headers.get('link'));
  }

  const sortedBranches = Array.from(branches).sort((a, b) => a.localeCompare(b));

  // Only include defaultBranch if the repo actually has branches.
  if (sortedBranches.length > 0 && !sortedBranches.includes(defaultBranch)) {
    sortedBranches.push(defaultBranch);
    sortedBranches.sort((a, b) => a.localeCompare(b));
  }

  return {
    defaultBranch: sortedBranches.length > 0 ? defaultBranch : '',
    branches: sortedBranches,
  };
}

export async function githubFetchDefaultBranch(
  token: string,
  repoFullName: string
): Promise<string> {
  const repoMeta = await fetchGithubJson(
    `https://api.github.com/repos/${repoFullName}`,
    token,
    GithubRepoDefaultBranchSchema
  );
  return repoMeta.default_branch;
}

export async function githubFetchDefaultBranchHead(
  token: string,
  repoFullName: string
): Promise<GitHubDefaultBranchHeadResult> {
  const repoMeta = await fetchGithubJson(
    `https://api.github.com/repos/${repoFullName}`,
    token,
    GithubRepoDefaultBranchSchema
  );
  const defaultBranch = repoMeta.default_branch;

  try {
    const ref = await fetchGithubJson(
      `https://api.github.com/repos/${repoFullName}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
      token,
      GithubRefSchema
    );
    return { defaultBranch, headSha: ref.object.sha };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('409')) {
      return { defaultBranch, headSha: '' };
    }
    throw error;
  }
}

export async function githubFetchTreeLevel(
  token: string,
  repoFullName: string,
  treeShaOrRef: string
): Promise<GitHubTreeLevelResult> {
  const tree = await fetchGithubJson(
    `https://api.github.com/repos/${repoFullName}/git/trees/${encodeURIComponent(treeShaOrRef)}`,
    token,
    GithubTreeSchema
  );

  return {
    entries: tree.tree
      .filter((entry) => entry.path.trim().length > 0 && entry.type && entry.sha)
      .map((entry) => ({
        path: entry.path,
        type: entry.type as string,
        sha: entry.sha as string,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      }))
      .sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === 'tree' ? -1 : 1;
        }
        return left.path.localeCompare(right.path);
      }),
    truncated: tree.truncated ?? false,
  };
}

export async function githubFetchProjectSkillsAtCommit(
  token: string,
  repoFullName: string,
  commitHash: string,
  skillDirs: readonly string[]
): Promise<ProjectSkillsResult & { treeTruncated: boolean }> {
  const normalizedSkillDirs = [
    ...new Set(skillDirs.map((skillDir) => normalizeGitHubSkillDir(skillDir))),
  ].sort((left, right) => left.localeCompare(right));
  if (!commitHash) {
    return { groups: [], contentFingerprint: '', treeTruncated: false };
  }

  const tree = await fetchGithubJson(
    `https://api.github.com/repos/${repoFullName}/git/trees/${encodeURIComponent(commitHash)}?recursive=1`,
    token,
    GithubTreeSchema
  );

  const groups: ProjectSkillGroup[] = [];
  if (tree.truncated === true) {
    for (const skillDir of normalizedSkillDirs) {
      try {
        const group = await scanGitHubContentsProjectSkillGroup({
          token,
          repoFullName,
          commitHash,
          skillDir,
        });
        if (group) {
          groups.push(group);
        }
      } catch (error) {
        groups.push({
          scope: 'project',
          dir: skillDir,
          skills: [],
          truncated: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } else {
    const treeByPath = new Map<string, GitHubTreeEntry>();
    for (const entry of tree.tree) {
      const pathValue = normalizeGitHubRepoPath(entry.path);
      if (!pathValue || !entry.type) {
        continue;
      }
      treeByPath.set(pathValue, { ...entry, path: pathValue });
    }

    for (const skillDir of normalizedSkillDirs) {
      try {
        const group = await scanGitHubTreeProjectSkillGroup({
          token,
          repoFullName,
          commitHash,
          treeByPath,
          skillDir,
        });
        if (group) {
          groups.push(group);
        }
      } catch (error) {
        groups.push({
          scope: 'project',
          dir: skillDir,
          skills: [],
          truncated: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  groups.sort((left, right) => left.dir.localeCompare(right.dir));
  return {
    groups: applyProjectSkillsResultBudget(groups),
    contentFingerprint: commitHash,
    treeTruncated: tree.truncated ?? false,
  };
}

/**
 * List all file paths in a repository's default branch (recursive git tree).
 */
export async function githubFetchFilePaths(
  token: string,
  repoFullName: string,
  branch?: string
): Promise<GitHubFilePathsResult> {
  const repoMeta = await fetchGithubJson(
    `https://api.github.com/repos/${repoFullName}`,
    token,
    GithubRepoDefaultBranchSchema
  );
  const defaultBranch = repoMeta.default_branch;
  const selectedBranch = branch?.trim() || defaultBranch;

  // Empty repos return 409 when accessing git refs
  let ref;
  try {
    ref = await fetchGithubJson(
      `https://api.github.com/repos/${repoFullName}/git/ref/heads/${encodeURIComponent(selectedBranch)}`,
      token,
      GithubRefSchema
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('409')) {
      return { defaultBranch, headSha: '', paths: [], truncated: false };
    }
    throw error;
  }

  const headSha = ref.object.sha;

  const tree = await fetchGithubJson(
    `https://api.github.com/repos/${repoFullName}/git/trees/${encodeURIComponent(selectedBranch)}?recursive=1`,
    token,
    GithubTreeSchema
  );

  const paths = tree.tree
    .filter((entry) => entry.type === 'blob' && entry.path.trim().length > 0)
    .map((entry) => entry.path)
    .sort((a, b) => a.localeCompare(b));

  return {
    defaultBranch,
    headSha,
    paths,
    truncated: tree.truncated ?? false,
  };
}

/**
 * Fetch open issues and PRs for #mention autocomplete.
 * Pulls 2 pages of 100, normalizes, dedupes, and returns the top 200.
 */
export async function githubFetchIssuesAndPRs(
  token: string,
  repoFullName: string
): Promise<GitHubIssueOrPR[]> {
  const CACHE_MAX_ITEMS = 200;

  // The two pages are independent, and the dedupe/sort below does not care what
  // order they arrive in — so serializing them only doubled the latency the
  // mention menu waits through.
  const pages = await Promise.all(
    [1, 2].map((page) => {
      const url = new URL(`https://api.github.com/repos/${repoFullName}/issues`);
      url.searchParams.set('state', 'open');
      url.searchParams.set('per_page', '100');
      url.searchParams.set('sort', 'updated');
      url.searchParams.set('direction', 'desc');
      url.searchParams.set('page', String(page));
      return fetchGithubJson(url.toString(), token, GithubMentionIssuesResponseSchema);
    })
  );

  const all: GitHubIssueOrPR[] = [];
  for (const pageItems of pages) {
    for (const item of pageItems) {
      if (item.state !== 'open') continue;
      const type: 'issue' | 'pr' = item.pull_request ? 'pr' : 'issue';
      all.push({
        number: item.number,
        url: item.html_url,
        title: item.title,
        type,
        updatedAtMs: parseGithubUpdatedAtMs(item.updated_at),
      });
    }
  }

  // Dedupe and sort
  const deduped = new Map<string, GitHubIssueOrPR>();
  for (const item of all) {
    const key = `${item.type}:${item.number}`;
    const existing = deduped.get(key);
    if (!existing || item.updatedAtMs > existing.updatedAtMs) {
      deduped.set(key, item);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => {
      if (a.updatedAtMs !== b.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
      if (a.type !== b.type) return a.type === 'issue' ? -1 : 1;
      return b.number - a.number;
    })
    .slice(0, CACHE_MAX_ITEMS);
}

/**
 * Fetch the current PR head SHA. Used when old session metadata does not yet
 * include `headCommitSha`.
 */
export async function githubFetchPullRequestHeadSha(
  token: string,
  repoFullName: string,
  prNumber: number
): Promise<string> {
  const pr = await fetchGithubJson(
    `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
    token,
    GithubPullRequestHeadSchema
  );
  return pr.head.sha;
}

/**
 * Fetch PR review comments, group replies into review threads, and cap the
 * result at the most recent 300 API items.
 */
export async function githubFetchPRReviewComments(
  token: string,
  repoFullName: string,
  prNumber: number,
  options?: GitHubReadRequestOptions
): Promise<GitHubReviewThread[]> {
  const all: GitHubReviewComment[] = [];
  let nextUrl: string | null =
    `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/comments?per_page=100`;

  while (nextUrl && all.length < 300) {
    const res = await fetch(nextUrl, { headers: authHeaders(token), cache: options?.cache });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) {
        throw new GitHubAuthError();
      }
      throw new Error(`GitHub API error: ${res.status} ${text}`);
    }
    const page = GithubReviewCommentsResponseSchema.parse(JSON.parse(text) as unknown);
    all.push(...page);
    nextUrl = parseNextLink(res.headers.get('link'));
  }

  const recent = all
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(Math.max(0, all.length - 300));
  return groupGitHubReviewComments(recent);
}

/**
 * Create a line-anchored review comment. GitHub validates the body against a
 * oneOf schema whose `line` variant rejects `subject_type`, so it is omitted.
 */
export async function githubCreatePRReviewComment(
  token: string,
  repoFullName: string,
  prNumber: number,
  input: GitHubCreateReviewCommentInput
): Promise<GitHubReviewComment> {
  const payload: Record<string, unknown> = {
    body: input.body,
    commit_id: input.commitId,
    path: input.path,
    line: input.line,
    side: input.side,
  };
  if (input.startLine !== undefined && input.startLine !== null) {
    payload.start_line = input.startLine;
  }
  if (input.startSide !== undefined && input.startSide !== null) {
    payload.start_side = input.startSide;
  }

  return requestGithubJson(
    `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/comments`,
    token,
    GithubReviewCommentSchema,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
}

export async function githubReplyPRReviewComment(
  token: string,
  repoFullName: string,
  prNumber: number,
  commentId: number,
  body: string
): Promise<GitHubReviewComment> {
  return requestGithubJson(
    `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/comments/${commentId}/replies`,
    token,
    GithubReviewCommentSchema,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    }
  );
}

/**
 * Fetch PR review submissions — the top-level review bodies (and their
 * approved/changes_requested/commented state) written when a reviewer submits
 * a review. These are separate from the line-anchored review comments that
 * `githubFetchPRReviewComments` handles. Paginates up to 200 most recent
 * submitted reviews; pending reviews (not yet submitted) are dropped.
 */
export async function githubFetchPullRequestReviews(
  token: string,
  repoFullName: string,
  prNumber: number,
  options?: GitHubReadRequestOptions
): Promise<GitHubReview[]> {
  const all: GitHubReview[] = [];
  let nextUrl: string | null =
    `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/reviews?per_page=100`;

  while (nextUrl && all.length < 200) {
    const res = await fetch(nextUrl, { headers: authHeaders(token), cache: options?.cache });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) {
        throw new GitHubAuthError();
      }
      throw new Error(`GitHub API error: ${res.status} ${text}`);
    }
    const page = GithubReviewsResponseSchema.parse(JSON.parse(text) as unknown);
    all.push(...page);
    nextUrl = parseNextLink(res.headers.get('link'));
  }

  const submitted = all
    .filter((review) => review.submittedAt !== null)
    .sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''));
  return submitted.slice(Math.max(0, submitted.length - 200));
}

// ============================================================================
// Pull Request details / issue comments / check runs
// ============================================================================

const MERGEABLE_STATES = new Set<GitHubMergeableState>([
  'clean',
  'dirty',
  'blocked',
  'behind',
  'unstable',
  'has_hooks',
  'draft',
  'unknown',
]);

function normalizeMergeableState(value: string | null | undefined): GitHubMergeableState {
  if (!value) return 'unknown';
  return MERGEABLE_STATES.has(value as GitHubMergeableState)
    ? (value as GitHubMergeableState)
    : 'unknown';
}

const GithubPullRequestDetailsSchema = z
  .object({
    number: z.number(),
    node_id: z.string(),
    title: z.string(),
    body: z.string().nullable().optional(),
    state: z.string(),
    merged: z.boolean().optional(),
    draft: z.boolean().optional(),
    html_url: z.string(),
    base: z.object({ ref: z.string() }).passthrough(),
    head: z.object({ ref: z.string(), sha: z.string() }).passthrough(),
    user: GithubUserSchema.nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    merged_at: z.string().nullable().optional(),
    closed_at: z.string().nullable().optional(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
    changed_files: z.number().optional(),
    commits: z.number().optional(),
    mergeable: z.boolean().nullable().optional(),
    mergeable_state: z.string().nullable().optional(),
  })
  .passthrough()
  .transform(
    (item): GitHubPullRequestDetails => ({
      number: item.number,
      nodeId: item.node_id,
      title: item.title,
      body: item.body ?? '',
      state: (item.state === 'closed' ? 'closed' : 'open') as GitHubPullRequestState,
      merged: item.merged ?? false,
      draft: item.draft ?? false,
      htmlUrl: item.html_url,
      baseRef: item.base.ref,
      headRef: item.head.ref,
      headSha: item.head.sha,
      user: item.user,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      mergedAt: item.merged_at ?? null,
      closedAt: item.closed_at ?? null,
      additions: item.additions ?? 0,
      deletions: item.deletions ?? 0,
      changedFiles: item.changed_files ?? 0,
      commits: item.commits ?? 0,
      mergeable: item.mergeable ?? null,
      mergeableState: normalizeMergeableState(item.mergeable_state),
    })
  );

const GithubIssueCommentSchema = z
  .object({
    id: z.number(),
    node_id: z.string(),
    body: z.string(),
    user: GithubUserSchema.nullable(),
    author_association: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    html_url: z.string(),
    issue_url: z.string(),
    reactions: GithubReactionRollupSchema.optional(),
  })
  .passthrough()
  .transform(
    (item): GitHubIssueComment => ({
      id: item.id,
      nodeId: item.node_id,
      body: item.body,
      user: item.user,
      authorAssociation: normalizeAuthorAssociation(item.author_association),
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      htmlUrl: item.html_url,
      issueUrl: item.issue_url,
      reactions: item.reactions,
    })
  );

const GithubIssueCommentsResponseSchema = z.array(GithubIssueCommentSchema);

const CHECK_RUN_STATUSES = new Set<GitHubCheckRunStatus>(['queued', 'in_progress', 'completed']);

function normalizeCheckRunStatus(value: string): GitHubCheckRunStatus {
  return CHECK_RUN_STATUSES.has(value as GitHubCheckRunStatus)
    ? (value as GitHubCheckRunStatus)
    : 'queued';
}

const CHECK_RUN_CONCLUSIONS = new Set<Exclude<GitHubCheckRunConclusion, null>>([
  'success',
  'failure',
  'neutral',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
  'skipped',
]);

function normalizeCheckRunConclusion(value: string | null | undefined): GitHubCheckRunConclusion {
  if (!value) return null;
  return CHECK_RUN_CONCLUSIONS.has(value as Exclude<GitHubCheckRunConclusion, null>)
    ? (value as GitHubCheckRunConclusion)
    : null;
}

const GithubCheckRunSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable().optional(),
    html_url: z.string().nullable().optional(),
    started_at: z.string().nullable().optional(),
    completed_at: z.string().nullable().optional(),
    app: z.object({ name: z.string().optional() }).passthrough().nullable().optional(),
  })
  .passthrough()
  .transform(
    (item): GitHubCheckRun => ({
      id: item.id,
      name: item.name,
      status: normalizeCheckRunStatus(item.status),
      conclusion: normalizeCheckRunConclusion(item.conclusion),
      htmlUrl: item.html_url ?? null,
      startedAt: item.started_at ?? null,
      completedAt: item.completed_at ?? null,
      appName: item.app?.name ?? null,
    })
  );

const GithubCheckRunsResponseSchema = z
  .object({
    total_count: z.number().optional(),
    check_runs: z.array(GithubCheckRunSchema),
  })
  .passthrough();

/**
 * Fetch the full Pull Request payload (title/body/branches/diff stats/etc.).
 */
export async function githubFetchPullRequestDetails(
  token: string,
  repoFullName: string,
  prNumber: number,
  options?: GitHubReadRequestOptions
): Promise<GitHubPullRequestDetails> {
  return fetchGithubJson(
    `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
    token,
    GithubPullRequestDetailsSchema,
    options
  );
}

/**
 * Fetch the general PR conversation comments (not code-line review comments).
 * Paginates up to 200 most recent items.
 */
export async function githubFetchPRIssueComments(
  token: string,
  repoFullName: string,
  prNumber: number,
  options?: GitHubReadRequestOptions
): Promise<GitHubIssueComment[]> {
  const all: GitHubIssueComment[] = [];
  let nextUrl: string | null =
    `https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments?per_page=100`;

  while (nextUrl && all.length < 200) {
    const res = await fetch(nextUrl, { headers: authHeaders(token), cache: options?.cache });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) {
        throw new GitHubAuthError();
      }
      throw new Error(`GitHub API error: ${res.status} ${text}`);
    }
    const page = GithubIssueCommentsResponseSchema.parse(JSON.parse(text) as unknown);
    all.push(...page);
    nextUrl = parseNextLink(res.headers.get('link'));
  }

  return all
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(Math.max(0, all.length - 200));
}

/**
 * Post a new general PR comment.
 */
export async function githubCreatePRIssueComment(
  token: string,
  repoFullName: string,
  prNumber: number,
  body: string
): Promise<GitHubIssueComment> {
  return requestGithubJson(
    `https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments`,
    token,
    GithubIssueCommentSchema,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    }
  );
}

function summarizeCheckRuns(runs: GitHubCheckRun[]): GitHubCheckRunsSummary {
  if (runs.length === 0) {
    return { status: 'none', conclusion: null, total: 0, runs };
  }
  const hasInProgress = runs.some((run) => run.status === 'in_progress');
  const hasQueued = runs.some((run) => run.status === 'queued');
  const status: GitHubCheckRunStatus | 'none' = hasInProgress
    ? 'in_progress'
    : hasQueued
      ? 'queued'
      : 'completed';

  let conclusion: GitHubCheckRunConclusion = null;
  if (status === 'completed') {
    if (runs.some((run) => run.conclusion === 'failure' || run.conclusion === 'timed_out')) {
      conclusion = 'failure';
    } else if (runs.some((run) => run.conclusion === 'action_required')) {
      conclusion = 'action_required';
    } else if (runs.some((run) => run.conclusion === 'cancelled')) {
      conclusion = 'cancelled';
    } else if (runs.every((run) => run.conclusion === 'success' || run.conclusion === 'skipped')) {
      conclusion = 'success';
    } else {
      conclusion = 'neutral';
    }
  }

  return { status, conclusion, total: runs.length, runs };
}

const GithubMergeResponseSchema = z
  .object({ sha: z.string(), merged: z.boolean().optional(), message: z.string().optional() })
  .passthrough();

export interface GitHubMergeResult {
  sha: string;
  merged: boolean;
  message: string;
}

export class GitHubMergeError extends Error {
  readonly status: number;

  constructor(options: { status: number; message: string }) {
    super(options.message);
    this.name = 'GitHubMergeError';
    this.status = options.status;
  }
}

/**
 * Check whether a branch exists in a repo. Returns false on 404, true on
 * 200. Any other status surfaces as an error so the UI can choose not to
 * present stale "Delete branch" affordances.
 */
export async function githubBranchExists(
  token: string,
  repoFullName: string,
  branchName: string
): Promise<boolean> {
  const encoded = encodeGitHubPath(branchName);
  const url = `https://api.github.com/repos/${repoFullName}/branches/${encoded}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  const text = await res.text();
  if (res.status === 401) {
    throw new GitHubAuthError();
  }
  throw new Error(`GitHub API error: ${res.status} ${text}`);
}

/**
 * Delete a branch (git ref). Used after merging a PR to clean up its head
 * branch. Throws on 422 when the branch is protected / the default branch.
 * Silently succeeds if the ref is already gone (GitHub returns 422 with
 * "Reference does not exist" which we swallow).
 */
export async function githubDeleteBranch(
  token: string,
  repoFullName: string,
  branchName: string
): Promise<void> {
  const encoded = encodeGitHubPath(branchName);
  const url = `https://api.github.com/repos/${repoFullName}/git/refs/heads/${encoded}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (res.status === 204) return;
  const text = await res.text();
  if (res.status === 401) {
    throw new GitHubAuthError();
  }
  if (res.status === 422 && /reference does not exist/i.test(text)) {
    return;
  }
  throw new Error(`GitHub API error: ${res.status} ${text}`);
}

/**
 * Close or reopen a pull request by patching its `state`. Returns the
 * updated PR details. Closing a merged PR is a no-op on GitHub's side;
 * reopening only works on PRs whose branch still has diverging commits.
 */
export async function githubSetPullRequestState(
  token: string,
  repoFullName: string,
  prNumber: number,
  state: 'open' | 'closed'
): Promise<GitHubPullRequestDetails> {
  return requestGithubJson(
    `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
    token,
    GithubPullRequestDetailsSchema,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state }),
    }
  );
}

/**
 * Convert a draft pull request to "ready for review". GitHub's REST API does
 * not expose this transition (PATCH /pulls/{n} ignores the `draft` field), so
 * we use the GraphQL `markPullRequestReadyForReview` mutation. The PR's
 * GraphQL global node id (`pullRequest.nodeId`) is required.
 */
export async function githubMarkPullRequestReadyForReview(
  token: string,
  pullRequestNodeId: string
): Promise<void> {
  const query = `mutation MarkReady($id: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $id }) {
      pullRequest { id isDraft }
    }
  }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { id: pullRequestNodeId } }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) throw new GitHubAuthError();
    throw new Error(`GitHub API error: ${res.status} ${text}`);
  }
  // GraphQL returns 200 even for application errors — surface them explicitly
  // so the UI can show why marking-ready failed (e.g. PR no longer in draft).
  const parsed = z
    .object({
      errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
    })
    .passthrough()
    .parse(JSON.parse(text) as unknown);
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((e) => e.message).join('; '));
  }
}

/**
 * Merge a pull request with the requested method. Throws `GitHubMergeError`
 * with the GitHub-provided message on 4xx responses so the UI can surface the
 * reason (conflicts, method disabled, required reviews missing, ...).
 */
export async function githubMergePullRequest(
  token: string,
  repoFullName: string,
  prNumber: number,
  input: {
    method: GitHubMergeMethod;
    commitTitle?: string;
    commitMessage?: string;
    sha?: string;
  }
): Promise<GitHubMergeResult> {
  const payload: Record<string, unknown> = { merge_method: input.method };
  if (input.commitTitle) payload.commit_title = input.commitTitle;
  if (input.commitMessage) payload.commit_message = input.commitMessage;
  if (input.sha) payload.sha = input.sha;

  const res = await fetch(`https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/merge`, {
    method: 'PUT',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) throw new GitHubAuthError();
    let message = `GitHub merge failed: ${res.status}`;
    try {
      const body = JSON.parse(text) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      if (text.trim()) message = text;
    }
    throw new GitHubMergeError({ status: res.status, message });
  }
  const parsed = GithubMergeResponseSchema.parse(JSON.parse(text) as unknown);
  return {
    sha: parsed.sha,
    merged: parsed.merged ?? true,
    message: parsed.message ?? 'Pull Request successfully merged',
  };
}

/**
 * Fetch check runs for a given commit (typically the PR head SHA).
 *
 * Throws `GitHubPermissionError` when the token lacks the `checks:read` scope
 * (returned as 403 `Resource not accessible by integration`)
 * or when GitHub returns a gateway-level 503 for the check-runs endpoint —
 * both map to the "please re-authorize" UX.
 */
export async function githubFetchCheckRuns(
  token: string,
  repoFullName: string,
  ref: string,
  options?: GitHubReadRequestOptions
): Promise<GitHubCheckRunsSummary> {
  const url = `https://api.github.com/repos/${repoFullName}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`;
  const res = await fetch(url, { headers: authHeaders(token), cache: options?.cache });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) {
      throw new GitHubAuthError();
    }
    if (res.status === 403 || res.status === 503) {
      throw new GitHubPermissionError({
        resource: 'check-runs',
        status: res.status,
        message: text.includes('Resource not accessible')
          ? 'The GitHub App installation does not have permission to read check runs.'
          : undefined,
      });
    }
    throw new Error(`GitHub API error: ${res.status} ${text}`);
  }
  const payload = GithubCheckRunsResponseSchema.parse(JSON.parse(text) as unknown);
  const runs = [...payload.check_runs].sort((a, b) => a.name.localeCompare(b.name));
  return summarizeCheckRuns(runs);
}
