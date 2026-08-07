import { RepoId, SessionId } from '@lody/shared';
import { resolveLocalProjectBranchAtRootPath } from '@lody/shared/node/local-project';
import spawn from 'cross-spawn';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@/utils/logger';
import { withFileLock } from '@/utils/file-lock';
import { redactUrlAuth } from '@/utils/github';
import {
  buildCredentialHelperValueForHost,
  ensureCredentialHelperScript,
  getCredentialHelperHostPath,
} from '@/lib/git-credential-helper-script';
import { formatErrorMessage } from '@/utils/format-error';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { mapGitSpawnError } from './git-process-error';

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LODY_LOCAL_BRANCH_PREFIX = 'lody/';
const COMMON_BASE_BRANCH_NAMES = new Set([
  'main',
  'master',
  'dev',
  'develop',
  'development',
  'trunk',
  'release',
  'staging',
  'stage',
  'prod',
  'production',
]);

function assertSafeSessionId(sessionId: SessionId): void {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) {
    throw new Error(
      `Invalid sessionId ${JSON.stringify(sessionId)}: expected /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`
    );
  }
}

function toGitPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function realpathIfExists(value: string): string {
  try {
    if (typeof fs.realpathSync.native === 'function') {
      return fs.realpathSync.native(value);
    }
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

/**
 * Storage layout (native):
 * - Host: <active installation data root>/repos/<repoId>/
 *   - bare.git/ (bare clone of the repository)
 *   - worktrees/<sessionId>/ (worktree directory for each session)
 *   - cache/{npm,pnpm,pip,...}/ (optional package manager caches)
 */

export interface WorktreeInfo {
  sessionId: SessionId;
  hostPath: string;
  branch: string;
  headSha: string | null;
  isClean: boolean;
}

export interface ArchivedWorktreeResult {
  branchName: string | null;
  backupCommitCreated: boolean;
}

export type WorktreeManagerSource =
  | { kind: 'github'; repoUrl?: string }
  | { kind: 'local-shared'; sourceGitDir?: string; originalRootPath: string };

export interface WorktreeManagerConfig {
  repoId: RepoId;
  source?: WorktreeManagerSource;
  repoUrl?: string;
  logger: Logger;
}

type RepoFetchMode = 'skip' | 'best-effort' | 'required';

export type RemoveWorktreeOptions = {
  baseBranchName?: string;
};

type ReusableBaseBranch = {
  branchName: string;
  startPoint?: string;
};

const DEFAULT_ARCHIVE_BACKUP_AUTHOR_NAME = 'Lody Archive';
const DEFAULT_ARCHIVE_BACKUP_AUTHOR_EMAIL = 'archive@lody.ai';

// Ceiling for any single git invocation. Must stay well below the file-lock
// staleness window (30 min) so a stalled git process releases the repo lock
// by failing instead of looking like a live holder.
const GIT_OPERATION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Per-repo file lock for git operations (cross-process safe)
 */
async function withRepoLock<T>(repoId: RepoId, fn: () => Promise<T>): Promise<T> {
  return withFileLock(`worktree-${repoId}`, fn, {
    timeout: 120000, // 120 seconds timeout for git operations (clone can be slow)
  });
}

const maskGitUrl = (raw?: string): string | undefined => {
  if (!raw) return raw;
  try {
    return redactUrlAuth(raw);
  } catch {
    return raw;
  }
};

const isSshGitUrl = (raw?: string): boolean =>
  !!raw && (/^git@/i.test(raw) || /^ssh:\/\//i.test(raw));

// Keep host normalization aligned with the credential helper to avoid "detected as GitHub
// here but skipped by helper" mismatches (e.g. www.github.com).
const normalizeGitHubHost = (rawHost: string): string => {
  const normalized = rawHost.trim().toLowerCase();
  if (normalized === 'www.github.com') return 'github.com';
  return normalized;
};

// Parse GitHub HTTPS remote and derive a stable owner/repo for broker lookup.
// This is only used for diagnostics; it intentionally ignores query/fragment pieces.
const parseGitHubHttpsRemote = (
  rawUrl?: string
): { host: string; normalizedHost: string; repoFullName: string } | null => {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return null;

    const host = url.hostname.toLowerCase();
    const normalizedHost = normalizeGitHubHost(host);
    if (normalizedHost !== 'github.com') return null;

    const cleanedPath = url.pathname
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '');
    const parts = cleanedPath.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1];
    if (!owner || !repo) return null;
    return { host, normalizedHost, repoFullName: `${owner}/${repo}` };
  } catch {
    return null;
  }
};

// Detect git's "prompt disabled" failure mode, which is what we want to diagnose.
// We keep this loose to catch variations across git versions.
const isTerminalPromptsDisabledErrorMessage = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('terminal prompts disabled') ||
    normalized.includes("could not read username for 'https://") ||
    normalized.includes('could not read username for "https://')
  );
};

// Clear inherited helpers before installing Lody's helper. Without the empty
// helper entry, git can fall through to host helpers such as osxkeychain, which
// may block indefinitely in non-interactive clone/fetch paths.
export const buildGitHubCredentialConfigArgs = (helperValue: string): string[] => [
  '-c',
  'credential.helper=',
  '-c',
  `credential.helper=${helperValue}`,
  '-c',
  'credential.useHttpPath=true',
];

type HelperDebugEntry = {
  ts?: string;
  pid?: number;
  event?: string;
  data?: Record<string, unknown>;
};

const parseHelperDebugEntry = (value: unknown): HelperDebugEntry | null => {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const data = obj.data;
  return {
    ts: typeof obj.ts === 'string' ? obj.ts : undefined,
    pid: typeof obj.pid === 'number' ? obj.pid : undefined,
    event: typeof obj.event === 'string' ? obj.event : undefined,
    data: data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined,
  };
};

// We only read the last helper debug entry to keep logs small while still giving
// a clear reason (e.g. missing env, unsupported host, fetch_error).
const readLastJsonLine = (filePath: string): HelperDebugEntry | null => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const last = lines[lines.length - 1];
    if (!last) return null;
    return parseHelperDebugEntry(JSON.parse(last) as unknown);
  } catch {
    return null;
  }
};

/**
 * WorktreeManager handles git worktree operations for a single repository.
 * Each session gets its own worktree directory. Most sessions also get their own branch,
 * except sessions started from an existing non-default branch reuse that branch directly.
 */
export class WorktreeManager {
  private readonly repoId: RepoId;
  private source: WorktreeManagerSource;
  private repoUrl?: string;
  private readonly logger: Logger;

  /** Base directory on host: <active installation data root>/repos */
  private readonly baseDir: string;
  /** Repo directory on host: <active installation data root>/repos/<repoId> */
  private readonly repoDir: string;
  /** Bare git directory: <active installation data root>/repos/<repoId>/bare.git */
  private readonly bareGitDir: string;
  /** Worktrees directory: <active installation data root>/repos/<repoId>/worktrees */
  private readonly worktreesDir: string;
  /** Cache directory: <active installation data root>/repos/<repoId>/cache */
  private readonly cacheDir: string;

  constructor(config: WorktreeManagerConfig) {
    this.repoId = config.repoId;
    this.source = config.source ?? { kind: 'github', repoUrl: config.repoUrl };
    this.repoUrl = this.source.kind === 'github' ? this.source.repoUrl : undefined;
    this.logger = config.logger;

    this.baseDir = path.join(getLodyDataDir(), 'repos');
    this.repoDir = path.join(this.baseDir, this.repoId);
    this.bareGitDir = path.join(this.repoDir, 'bare.git');
    this.worktreesDir = path.join(this.repoDir, 'worktrees');
    this.cacheDir = path.join(this.repoDir, 'cache');
  }

  updateRepoUrl(repoUrl?: string): void {
    if (!repoUrl) return;
    this.updateSource({ kind: 'github', repoUrl });
  }

  updateSource(source?: WorktreeManagerSource): void {
    if (!source) return;
    this.source = source;
    if (source.kind === 'local-shared') {
      this.repoUrl = undefined;
      this.logger.debug(`[${this.repoId}] Updated local shared source: ${source.originalRootPath}`);
      return;
    }
    const repoUrl = source.repoUrl;
    if (!repoUrl) return;
    if (this.repoUrl === repoUrl) return;
    this.repoUrl = repoUrl;
    this.logger.debug(`[${this.repoId}] Updated repo url: ${maskGitUrl(repoUrl)}`);
    if (isSshGitUrl(repoUrl)) {
      this.logger.debug(
        `[${this.repoId}] Repo URL uses SSH; credential.helper provides HTTPS credentials only (ensure SSH keys/agent are available)`
      );
    }
  }

  private runGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...env,
      GIT_TERMINAL_PROMPT: '0',
    };
    this.logger.debug(`[${this.repoId}] Running git ${args.join(' ')}`);
    return new Promise<string>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('git', args, {
          cwd,
          env: mergedEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        reject(mapGitSpawnError(error, cwd));
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Git has no deadline of its own for stalled network operations; without this a
      // hung fetch/clone would pin the per-repo worktree lock until the file-lock
      // staleness window frees it.
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, GIT_OPERATION_TIMEOUT_MS);
      timeoutTimer.unref();

      // Use setEncoding to handle UTF-8 multibyte boundaries correctly
      // (e.g., non-ASCII branch names, file paths, user.name)
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');

      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });

      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.on('error', (error) => {
        clearTimeout(timeoutTimer);
        reject(mapGitSpawnError(error, cwd));
      });

      child.on('close', (code) => {
        clearTimeout(timeoutTimer);
        if (timedOut) {
          reject(new Error(`git ${args.join(' ')} timed out after ${GIT_OPERATION_TIMEOUT_MS}ms`));
          return;
        }
        if (code !== 0) {
          const details = (stderr || stdout || '').trim();
          reject(new Error(details ? details : `git exited with code ${code}`));
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  private buildGitAuthArgs(): string[] {
    if (!this.repoUrl) {
      return [];
    }

    // Only enable the GitHub credential helper for GitHub HTTPS remotes.
    // For non-GitHub/local remotes, avoid touching installation-owned credential state.
    try {
      const url = new URL(this.repoUrl);
      const host = normalizeGitHubHost(url.hostname.toLowerCase());
      const isGitHubHost = host === 'github.com';
      const isHttps = url.protocol === 'https:';
      if (!isGitHubHost || !isHttps) {
        return [];
      }
    } catch {
      return [];
    }

    ensureCredentialHelperScript(this.repoId);
    const helperValue = buildCredentialHelperValueForHost(this.repoId);
    return buildGitHubCredentialConfigArgs(helperValue);
  }

  private isLocalSharedSource(): boolean {
    return this.source.kind === 'local-shared';
  }

  private getGitAdminCwd(): string {
    return this.source.kind === 'local-shared' ? this.source.originalRootPath : this.bareGitDir;
  }

  private async ensureLocalSharedRepoLocked(): Promise<void> {
    if (this.source.kind !== 'local-shared') return;

    const originalRootPath = this.source.originalRootPath;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(originalRootPath);
    } catch (error) {
      throw new Error(`[${this.repoId}] Local worktree source is missing: ${originalRootPath}`, {
        cause: error,
      });
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `[${this.repoId}] Local worktree source is not a directory: ${originalRootPath}`
      );
    }

    try {
      await this.runGit(['rev-parse', '--git-dir', '--is-inside-work-tree'], originalRootPath);
    } catch (error) {
      throw new Error(
        `[${this.repoId}] Local project is not a git repository: ${originalRootPath}`,
        { cause: error }
      );
    }

    fs.mkdirSync(this.worktreesDir, { recursive: true });
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.mkdirSync(this.repoDir, { recursive: true });
    const metaPath = path.join(this.repoDir, 'meta.json');
    if (!fs.existsSync(metaPath)) {
      fs.writeFileSync(
        metaPath,
        `${JSON.stringify(
          {
            kind: 'local',
            originalRootPath,
            ...(this.source.sourceGitDir ? { sourceGitDir: this.source.sourceGitDir } : {}),
            createdAtMs: Date.now(),
          },
          null,
          2
        )}\n`,
        'utf8'
      );
    }
  }

  // When git fails with "terminal prompts disabled" during host-side clone/fetch,
  // it usually means the helper/broker chain did not return credentials.
  // We emit a structured warning with:
  // - broker reachability/status (204 => no token)
  // - helper probe results + last debug entry
  // This keeps failures debuggable without logging sensitive tokens.
  private async diagnoseGitHubGitAuthFailure(options: {
    operation: string;
    errorMessage: string;
  }): Promise<void> {
    if (!isTerminalPromptsDisabledErrorMessage(options.errorMessage)) {
      return;
    }

    const remote = parseGitHubHttpsRemote(this.repoUrl);
    const helperPath = getCredentialHelperHostPath(this.repoId);
    const brokerUrl = process.env.LODY_GIT_CRED_BROKER_URL;
    const brokerToken = process.env.LODY_GIT_CRED_BROKER_TOKEN;

    // Write helper debug JSONL under the repo mount so it persists and is easy to retrieve.
    const debugFile = path.join(this.repoDir, `git-cred-helper-${Date.now()}-${process.pid}.jsonl`);

    const diagnostics: Record<string, unknown> = {
      repoId: this.repoId,
      operation: options.operation,
      repoUrl: maskGitUrl(this.repoUrl),
      isSshRepoUrl: isSshGitUrl(this.repoUrl),
      remoteHost: remote?.host ?? null,
      remoteHostNormalized: remote?.normalizedHost ?? null,
      repoFullName: remote?.repoFullName ?? null,
      hasBrokerUrl: !!brokerUrl,
      hasBrokerToken: !!brokerToken,
      helperPath,
      helperExists: fs.existsSync(helperPath),
      helperDebugFile: debugFile,
    };

    // Broker probe is best-effort; it helps differentiate "broker reachable but 204"
    // from "broker not reachable", without invoking git itself.
    // When the broker returns 403, it includes structured error info from the backend.
    const fetchImpl = globalThis.fetch;
    if (remote?.repoFullName && brokerUrl && brokerToken && typeof fetchImpl === 'function') {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetchImpl(`${brokerUrl}/git-credential`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${brokerToken}`,
          },
          body: JSON.stringify({ repoFullName: remote.repoFullName }),
          signal: controller.signal,
        });

        // Try to parse structured error response from broker (403 with JSON body)
        let errorInfo: { error?: string; message?: string } | null = null;
        if (res.status === 403) {
          try {
            errorInfo = (await res.json()) as { error?: string; message?: string };
          } catch {
            // Ignore JSON parse errors
          }
        } else {
          res.body?.cancel().catch(() => {});
        }

        diagnostics.brokerProbe = {
          ok: res.ok,
          status: res.status,
          ...(errorInfo?.error && { errorCode: errorInfo.error }),
          ...(errorInfo?.message && { errorMessage: errorInfo.message }),
        };
      } catch (error) {
        diagnostics.brokerProbe = {
          ok: false,
          error: formatErrorMessage(error),
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } else {
      diagnostics.brokerProbe = { ok: false, skipped: true };
    }

    if (!remote?.repoFullName) {
      this.logger.debug(
        `[${this.repoId}] Git auth failed with terminal prompts disabled, but repo URL is not a GitHub HTTPS remote`,
        diagnostics
      );
      return;
    }

    try {
      fs.mkdirSync(this.repoDir, { recursive: true });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LODY_GIT_CRED_HELPER_DEBUG: 'true',
        LODY_GIT_CRED_HELPER_DEBUG_FILE: debugFile,
      };

      const probe = await this.runCredentialHelperProbe({
        helperPath,
        host: remote.host,
        repoFullName: remote.repoFullName,
        env,
      });

      diagnostics.helperProbe = {
        exitCode: probe.exitCode,
        returnedCredentials: probe.returnedCredentials,
        stderrNonEmpty: probe.stderrNonEmpty,
        lastDebugEntry: readLastJsonLine(debugFile),
      };
    } catch (error) {
      diagnostics.helperProbe = {
        ok: false,
        error: formatErrorMessage(error),
        lastDebugEntry: readLastJsonLine(debugFile),
      };
    }

    this.logger.debug(`[${this.repoId}] GitHub HTTPS auth diagnostics`, diagnostics);
  }

  // Run the helper directly (outside of git) to isolate whether the helper
  // itself can return credentials for the given repo.
  private async runCredentialHelperProbe(options: {
    helperPath: string;
    host: string;
    repoFullName: string;
    env: NodeJS.ProcessEnv;
  }): Promise<{ exitCode: number | null; returnedCredentials: boolean; stderrNonEmpty: boolean }> {
    const input = `protocol=https\nhost=${options.host}\npath=/${options.repoFullName}.git\n\n`;
    return await new Promise((resolve, reject) => {
      const child = spawn('node', [options.helperPath, 'get'], {
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      // Use setEncoding to handle UTF-8 multibyte boundaries correctly
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');

      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.on('error', (error) => reject(error));
      child.on('close', (code) => {
        const returnedCredentials =
          stdout.includes('username=') && stdout.includes('\npassword=') && stdout.includes('\n\n');
        resolve({ exitCode: code, returnedCredentials, stderrNonEmpty: stderr.trim().length > 0 });
      });

      if (child.stdin) {
        child.stdin.write(input);
        child.stdin.end();
      }
    });
  }

  /**
   * Ensures the bare repo has a valid `origin` remote and a fetchspec that brings in branch heads.
   *
   * In a bare clone, git may fetch branch heads into `refs/heads/*` instead of remote-tracking refs.
   * We rely on `origin/<branch>` refs for base-ref selection, so we ensure a fetchspec for those.
   */
  private async ensureOriginRemoteConfigured(): Promise<void> {
    if (!this.repoUrl) return;

    try {
      await this.runGit(['remote', 'get-url', 'origin'], this.bareGitDir);
    } catch {
      await this.runGit(['remote', 'add', 'origin', this.repoUrl], this.bareGitDir);
    }

    let fetchSpec = '';
    try {
      fetchSpec = await this.runGit(
        ['config', '--get-all', 'remote.origin.fetch'],
        this.bareGitDir
      );
    } catch {
      fetchSpec = '';
    }

    const fetchSpecs = fetchSpec
      .split(/\r?\n/)
      .map((spec) => spec.trim())
      .filter(Boolean);

    const hasRemoteTrackingFetchSpec = fetchSpecs.some((spec) =>
      spec.includes('refs/remotes/origin/')
    );

    if (!hasRemoteTrackingFetchSpec) {
      await this.runGit(
        ['config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
        this.bareGitDir
      );
    }
  }

  /**
   * Git worktrees created from a bare repo write an absolute `gitdir:` pointer into `<worktree>/.git`.
   * That absolute host path can break if the repo is moved across mount points. To make the worktree
   * more portable across environments, rewrite the
   * `gitdir:` pointer to a relative path (relative to the worktree directory).
   */
  private ensureWorktreeGitdirIsRelative(sessionId: SessionId): void {
    if (this.isLocalSharedSource()) return;
    const worktreePath = this.getWorktreeHostPath(sessionId);
    const gitFilePath = path.join(worktreePath, '.git');
    if (!fs.existsSync(gitFilePath)) return;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(gitFilePath);
    } catch {
      return;
    }

    if (!stat.isFile()) {
      return;
    }

    let content = '';
    try {
      content = fs.readFileSync(gitFilePath, 'utf8');
    } catch {
      return;
    }

    const lines = content.split(/\r?\n/);
    const gitdirIndex = lines.findIndex((line) => line.trimStart().startsWith('gitdir:'));
    if (gitdirIndex === -1) return;

    const raw = lines[gitdirIndex] ?? '';
    const currentGitdir = raw.replace(/^\s*gitdir:\s*/i, '').trim();
    if (!currentGitdir) return;

    if (!path.isAbsolute(currentGitdir)) {
      return;
    }

    const worktreeName = path.basename(currentGitdir) as SessionId;
    const expectedGitdir = path.join(this.bareGitDir, 'worktrees', worktreeName);
    const relative = path.relative(worktreePath, expectedGitdir);
    lines[gitdirIndex] = `gitdir: ${toGitPath(relative)}`;
    try {
      fs.writeFileSync(gitFilePath, lines.join('\n'));
    } catch {
      // ignore
    }
  }

  /**
   * Ensures the bare repo exists and is optionally up-to-date with origin.
   *
   * - `skip`: do not fetch (used for repos without a remote).
   * - `best-effort`: fetch if possible, but do not fail callers.
   * - `required`: fetch must succeed; otherwise throw (used when cutting a new worktree).
   */
  private async ensureRepoLocked(fetchMode: RepoFetchMode = 'best-effort'): Promise<void> {
    if (this.source.kind === 'local-shared') {
      await this.ensureLocalSharedRepoLocked();
      return;
    }

    // Ensure directories exist
    fs.mkdirSync(this.worktreesDir, { recursive: true });
    fs.mkdirSync(this.cacheDir, { recursive: true });

    if (!fs.existsSync(this.bareGitDir)) {
      if (!this.repoUrl) {
        // Create an empty bare repository
        this.logger.debug(`[${this.repoId}] Creating empty bare repository`);
        fs.mkdirSync(this.bareGitDir, { recursive: true });
        await this.runGit(['init', '--bare'], this.bareGitDir);
        // Create initial commit so we have a main branch
        await this.createInitialCommit();
        return;
      }

      // Clone bare repository
      this.logger.debug(`[${this.repoId}] Cloning bare repository: ${maskGitUrl(this.repoUrl)}`);
      const cloneUrl = this.repoUrl;
      try {
        await this.runGit(
          [...this.buildGitAuthArgs(), 'clone', '--bare', cloneUrl, this.bareGitDir],
          this.baseDir
        );
      } catch (error) {
        const message = formatErrorMessage(error);
        await this.diagnoseGitHubGitAuthFailure({ operation: 'clone', errorMessage: message });
        throw new Error(`[${this.repoId}] Failed to clone bare repository: ${message}`, {
          cause: error,
        });
      }

      this.logger.debug(`[${this.repoId}] Bare repository ready: ${this.bareGitDir}`);
      await this.ensureOriginRemoteConfigured();

      // If the remote repo is empty (no commits/branches), create an initial commit
      // so that worktree creation has a valid base ref to work with.
      if (await this.isRepoEmpty()) {
        this.logger.debug(`[${this.repoId}] Remote repository is empty, creating initial commit`);
        await this.createInitialCommit();
      }
      return;
    }

    if (!this.repoUrl || fetchMode === 'skip') {
      return;
    }

    await this.ensureOriginRemoteConfigured();
    this.logger.debug(`[${this.repoId}] Fetching latest changes from origin (mode=${fetchMode})`);
    try {
      await this.runGit(
        [...this.buildGitAuthArgs(), 'fetch', 'origin', '--prune'],
        this.bareGitDir
      );
      let originHead: string | null = null;
      let originMain: string | null = null;
      let originMaster: string | null = null;
      try {
        originHead = await this.runGit(['rev-parse', 'origin/HEAD'], this.bareGitDir);
      } catch {
        originHead = null;
      }
      try {
        originMain = await this.runGit(['rev-parse', 'origin/main'], this.bareGitDir);
      } catch {
        originMain = null;
      }
      try {
        originMaster = await this.runGit(['rev-parse', 'origin/master'], this.bareGitDir);
      } catch {
        originMaster = null;
      }
      this.logger.debug(
        `[${this.repoId}] Fetch completed (origin/HEAD=${originHead ?? 'unknown'} origin/main=${
          originMain ?? 'unknown'
        } origin/master=${originMaster ?? 'unknown'})`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await this.diagnoseGitHubGitAuthFailure({ operation: 'fetch', errorMessage: message });
      if (fetchMode === 'required') {
        throw new Error(`[${this.repoId}] Failed to fetch from origin: ${message}`, {
          cause: error,
        });
      }
      this.logger.debug(`[${this.repoId}] Failed to fetch from origin: ${message}`);
    }
  }

  /**
   * Resolve host (outside-container) global git identity.
   * Prefer env vars (from session config), then `git config --global` values.
   * Returns undefined for name/email if not found.
   */
  private async resolveHostGitIdentity(): Promise<{
    name: string | undefined;
    email: string | undefined;
  }> {
    // First check env vars (injected from session config)
    // Git uses GIT_AUTHOR_* and GIT_COMMITTER_* environment variables
    const envName = process.env.GIT_AUTHOR_NAME ?? process.env.GIT_COMMITTER_NAME;
    const envEmail = process.env.GIT_AUTHOR_EMAIL ?? process.env.GIT_COMMITTER_EMAIL;

    if (envName && envEmail) {
      return { name: envName, email: envEmail };
    }

    // Fall back to host git config
    let hostName = '';
    let hostEmail = '';

    try {
      hostName = await this.runGit(['config', '--global', 'user.name'], process.cwd());
    } catch {
      hostName = '';
    }

    try {
      hostEmail = await this.runGit(['config', '--global', 'user.email'], process.cwd());
    } catch {
      hostEmail = '';
    }

    return {
      name: envName || hostName || undefined,
      email: envEmail || hostEmail || undefined,
    };
  }

  /**
   * Checks whether the bare repo has any commits at all.
   * Uses `git show-ref --heads` which lists local branch refs; exits non-zero when none exist.
   */
  private async isRepoEmpty(): Promise<boolean> {
    try {
      const refs = await this.runGit(['show-ref', '--heads'], this.bareGitDir);
      return !refs.trim();
    } catch {
      // git show-ref exits with code 1 when no refs are found
      return true;
    }
  }

  /**
   * Creates an initial empty commit on the `main` branch in the bare repo.
   * Used when the remote repo is empty (no commits/branches) so that
   * worktree creation has a valid base ref.
   */
  private async createInitialCommit(): Promise<void> {
    const tempDir = path.join(this.repoDir, '.temp-init');
    fs.mkdirSync(tempDir, { recursive: true });
    try {
      await this.runGit(['init'], tempDir);

      const { name, email } = await this.resolveHostGitIdentity();
      const commitEnv: Record<string, string | undefined> = {
        ...process.env,
      };
      const commitName = name || 'LodyAI';
      const commitEmail = email || 'agent@lody.ai';
      commitEnv.GIT_AUTHOR_NAME = commitName;
      commitEnv.GIT_COMMITTER_NAME = commitName;
      commitEnv.GIT_AUTHOR_EMAIL = commitEmail;
      commitEnv.GIT_COMMITTER_EMAIL = commitEmail;

      await this.runGit(
        ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial commit'],
        tempDir,
        commitEnv
      );
      await this.runGit(['push', this.bareGitDir, 'HEAD:main'], tempDir);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async resolveDefaultBranch(): Promise<string> {
    const cwd = this.getGitAdminCwd();
    if (this.isLocalSharedSource()) {
      try {
        const branch = await this.runGit(['branch', '--show-current'], cwd);
        return branch || 'HEAD';
      } catch {
        return 'HEAD';
      }
    }
    try {
      const head = await this.runGit(['symbolic-ref', '--short', 'HEAD'], cwd);
      return head || 'main';
    } catch {
      return 'main';
    }
  }

  private async resolveDefaultRemoteRef(): Promise<string | null> {
    if (!this.repoUrl) {
      return null;
    }

    try {
      const ref = await this.runGit(['rev-parse', '--abbrev-ref', 'origin/HEAD'], this.bareGitDir);
      if (!ref || ref === 'origin/HEAD') {
        return 'origin/HEAD';
      }
      return ref;
    } catch {
      return null;
    }
  }

  /**
   * Picks a primary base ref from the fetched remote refs.
   *
   * Preference order:
   * - `origin/main`
   * - `origin/master`
   * - `origin/HEAD` (symbolic ref if configured)
   */
  private async resolvePrimaryRemoteBaseRef(): Promise<string | null> {
    if (!this.repoUrl) {
      return null;
    }

    if (await this.hasCommitish('origin/main')) {
      return 'origin/main';
    }

    if (await this.hasCommitish('origin/master')) {
      return 'origin/master';
    }

    const originHead = await this.resolveDefaultRemoteRef();
    if (originHead && (await this.hasCommitish(originHead))) {
      return originHead;
    }

    return null;
  }

  private async hasCommitish(rev: string): Promise<boolean> {
    try {
      await this.runGit(['rev-parse', '--verify', `${rev}^{commit}`], this.getGitAdminCwd());
      return true;
    } catch {
      return false;
    }
  }

  private async resolveBaseRef(preferredBranch?: string): Promise<string> {
    if (this.source.kind === 'local-shared') {
      const preferred = preferredBranch?.trim();
      if (preferred) {
        if (preferred.startsWith('refs/heads/') || preferred.startsWith('refs/remotes/')) {
          if (await this.hasCommitish(preferred)) return preferred;
          throw new Error(`Local project branch not found: ${preferred}`);
        }
        return (await resolveLocalProjectBranchAtRootPath(this.source.originalRootPath, preferred))
          .refName;
      }
      if (await this.hasCommitish('HEAD')) return 'HEAD';
      throw new Error(`[${this.repoId}] Local repository has no commit to use as a worktree base`);
    }

    const candidates: string[] = [];

    if (preferredBranch) {
      if (this.repoUrl) {
        candidates.push(`origin/${preferredBranch}`);
      }
      candidates.push(preferredBranch);
    } else if (this.repoUrl) {
      const primary = await this.resolvePrimaryRemoteBaseRef();
      if (primary) {
        candidates.push(primary);
      }
      candidates.push('origin/main', 'origin/master');
    }

    const defaultBranch = await this.resolveDefaultBranch();
    if (this.repoUrl) {
      candidates.push(`origin/${defaultBranch}`);
      const defaultRemote = await this.resolveDefaultRemoteRef();
      if (defaultRemote) {
        candidates.push(defaultRemote);
      }
    }

    candidates.push(defaultBranch);
    candidates.push('main', 'master');

    for (const candidate of candidates) {
      if (await this.hasCommitish(candidate)) {
        return candidate;
      }
    }

    return preferredBranch ?? defaultBranch;
  }

  /**
   * Get the host path for the repository root
   */
  getRepoHostPath(): string {
    return this.repoDir;
  }

  /**
   * Get the host path for a session's worktree
   */
  getWorktreeHostPath(sessionId: SessionId): string {
    assertSafeSessionId(sessionId);
    return path.join(this.getWorktreesHostPath(), sessionId);
  }

  private getWorktreesHostPath(): string {
    return realpathIfExists(this.worktreesDir);
  }

  /**
   * Get the cache directory host path
   */
  getCacheHostPath(): string {
    return this.cacheDir;
  }

  /**
   * Ensure the base repository is cloned/fetched
   */
  async ensureRepo(): Promise<void> {
    return withRepoLock(this.repoId, async () => {
      await this.ensureRepoLocked('best-effort');
    });
  }

  private getDefaultSessionBranchName(sessionId: SessionId): string {
    if (this.isLocalSharedSource()) {
      const shortId = sessionId
        .slice(0, 12)
        .replace(/[^A-Za-z0-9_-]/g, '')
        .slice(0, 12);
      return `${LODY_LOCAL_BRANCH_PREFIX}${shortId || sessionId.slice(0, 8)}`;
    }
    return `session/${sessionId.slice(0, 8)}`;
  }

  private isLodyManagedLocalBranch(branchName: string): boolean {
    return this.normalizeBranchName(branchName).startsWith(LODY_LOCAL_BRANCH_PREFIX);
  }

  private normalizeBranchName(branchName: string): string {
    return branchName
      .trim()
      .replace(/^refs\/heads\//, '')
      .replace(/^origin\//, '');
  }

  private isCommonBaseBranchName(branchName: string): boolean {
    const normalized = this.normalizeBranchName(branchName).toLowerCase();
    if (!normalized) {
      return false;
    }
    if (COMMON_BASE_BRANCH_NAMES.has(normalized)) {
      return true;
    }
    return normalized.startsWith('release/') || normalized.startsWith('releases/');
  }

  private shouldReuseExistingBaseBranch(branchName?: string): branchName is string {
    const trimmed = branchName?.trim();
    return !!trimmed && !this.isCommonBaseBranchName(trimmed);
  }

  private async hasLocalBranch(branchName: string): Promise<boolean> {
    const sanitized = branchName.trim();
    if (!sanitized) {
      return false;
    }
    try {
      await this.runGit(['show-ref', '--verify', `refs/heads/${sanitized}`], this.getGitAdminCwd());
      return true;
    } catch {
      return false;
    }
  }

  private async resolveExistingBranchName(
    sessionId: SessionId,
    preferredBranchName?: string
  ): Promise<string | null> {
    const trimmedPreferred = preferredBranchName?.trim();
    if (trimmedPreferred && (await this.hasLocalBranch(trimmedPreferred))) {
      return trimmedPreferred;
    }

    const defaultBranchName = this.getDefaultSessionBranchName(sessionId);
    if (await this.hasLocalBranch(defaultBranchName)) {
      return defaultBranchName;
    }

    return null;
  }

  private async resolveReusableBaseBranch(baseBranch?: string): Promise<ReusableBaseBranch | null> {
    if (this.isLocalSharedSource()) {
      return null;
    }
    const trimmed = baseBranch?.trim();
    if (!this.shouldReuseExistingBaseBranch(trimmed)) {
      return null;
    }
    if (await this.hasLocalBranch(trimmed)) {
      return { branchName: trimmed };
    }
    const remoteBranch = `origin/${trimmed}`;
    if (this.repoUrl && (await this.hasCommitish(remoteBranch))) {
      return { branchName: trimmed, startPoint: remoteBranch };
    }
    return null;
  }

  private shouldPreserveRemovedBranch(
    branchName: string,
    options?: RemoveWorktreeOptions
  ): boolean {
    const baseBranchName = options?.baseBranchName?.trim();
    return (
      !!baseBranchName &&
      branchName === baseBranchName &&
      this.shouldReuseExistingBaseBranch(baseBranchName)
    );
  }

  private shouldDeleteRemovedBranch(branchName: string, options?: RemoveWorktreeOptions): boolean {
    if (this.shouldPreserveRemovedBranch(branchName, options)) {
      this.logger.debug(
        `[${this.repoId}] Preserving reused base branch after worktree removal: ${branchName}`
      );
      return false;
    }

    if (this.isLocalSharedSource() && !this.isLodyManagedLocalBranch(branchName)) {
      this.logger.warn(
        `[${this.repoId}] Preserving non-lody local branch after worktree removal: ${branchName}`
      );
      return false;
    }

    return true;
  }

  private isBranchAlreadyCheckedOutError(error: unknown): boolean {
    const message = formatErrorMessage(error).toLowerCase();
    return message.includes('is already checked out at');
  }

  private isLikelyStaleWorktreeError(error: unknown): boolean {
    const message = formatErrorMessage(error).toLowerCase();
    return (
      message.includes('missing') ||
      message.includes('locked') ||
      message.includes('administrative') ||
      message.includes('not a working tree') ||
      message.includes('already exists')
    );
  }

  private async runWorktreeAddWithPruneRetry(args: string[], cwd: string): Promise<void> {
    try {
      await this.runGit(args, cwd);
    } catch (error) {
      if (!this.isLikelyStaleWorktreeError(error)) {
        throw error;
      }
      this.logger.debug(
        `[${this.repoId}] git worktree add failed; pruning stale entries and retrying once: ${formatErrorMessage(error)}`
      );
      try {
        await this.runGit(['worktree', 'prune'], cwd);
      } catch (pruneError) {
        this.logger.debug(
          `[${this.repoId}] git worktree prune failed before retry: ${formatErrorMessage(pruneError)}`
        );
      }
      await this.runGit(args, cwd);
    }
  }

  private async resolveAvailableSessionBranchName(sessionId: SessionId): Promise<string> {
    const baseName = this.getDefaultSessionBranchName(sessionId);
    let existing: Set<string>;
    try {
      const output = await this.runGit(
        ['for-each-ref', '--format=%(refname:short)', `refs/heads/${baseName}*`],
        this.getGitAdminCwd()
      );
      existing = new Set(
        output
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      );
    } catch {
      existing = new Set();
    }

    if (!existing.has(baseName)) {
      return baseName;
    }

    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${baseName}-${index}`;
      if (!existing.has(candidate)) {
        return candidate;
      }
    }

    throw new Error(`[${this.repoId}] Unable to find available branch name for ${sessionId}`);
  }

  /**
   * Create a worktree for a session
   * Branch name: session/<shortSessionId> for common base branches; existing non-default
   * branches are reused directly.
   */
  async createWorktree(
    sessionId: SessionId,
    baseBranch?: string,
    restoreBranchName?: string
  ): Promise<WorktreeInfo> {
    return withRepoLock(this.repoId, async () => {
      assertSafeSessionId(sessionId);
      // Ensure we have latest origin refs before cutting worktrees.
      await this.ensureRepoLocked(this.repoUrl ? 'required' : 'skip');

      const worktreePath = this.getWorktreeHostPath(sessionId);
      const gitAdminCwd = this.getGitAdminCwd();

      // Check if worktree already exists
      if (fs.existsSync(worktreePath)) {
        this.ensureWorktreeGitdirIsRelative(sessionId);
        const info = await this.getWorktreeInfo(sessionId);
        this.logger.debug(
          `[${this.repoId}] Worktree already exists (sessionId=${sessionId} branch=${info.branch} head=${info.headSha ?? 'unknown'}): ${info.hostPath}`
        );
        return info;
      }

      const existingBranchName = await this.resolveExistingBranchName(sessionId, restoreBranchName);

      if (existingBranchName) {
        // Worktree missing but branch exists - create worktree from existing branch
        this.logger.debug(
          `[${this.repoId}] Creating worktree from existing branch: ${existingBranchName}`
        );
        await this.runWorktreeAddWithPruneRetry(
          ['worktree', 'add', worktreePath, existingBranchName],
          gitAdminCwd
        );
      } else {
        const branchName = await this.resolveAvailableSessionBranchName(sessionId);
        const resolvedBase = await this.resolveBaseRef(baseBranch);
        const reusableBaseBranch = await this.resolveReusableBaseBranch(baseBranch);
        if (reusableBaseBranch) {
          this.logger.debug(
            `[${this.repoId}] Creating worktree from selected branch: ${reusableBaseBranch.branchName}`
          );
          try {
            if (reusableBaseBranch.startPoint) {
              await this.runWorktreeAddWithPruneRetry(
                [
                  'worktree',
                  'add',
                  '-b',
                  reusableBaseBranch.branchName,
                  worktreePath,
                  reusableBaseBranch.startPoint,
                ],
                gitAdminCwd
              );
            } else {
              await this.runWorktreeAddWithPruneRetry(
                ['worktree', 'add', worktreePath, reusableBaseBranch.branchName],
                gitAdminCwd
              );
            }
          } catch (error) {
            if (!this.isBranchAlreadyCheckedOutError(error)) {
              throw error;
            }
            this.logger.debug(
              `[${this.repoId}] Selected branch already checked out; creating session branch instead (branch=${branchName} base=${resolvedBase})`
            );
            await this.runWorktreeAddWithPruneRetry(
              ['worktree', 'add', '-b', branchName, worktreePath, resolvedBase],
              gitAdminCwd
            );
          }
        } else {
          // Create new branch and worktree
          this.logger.debug(
            `[${this.repoId}] Creating new worktree (sessionId=${sessionId} branch=${branchName} base=${resolvedBase}): ${worktreePath}`
          );

          // Create worktree with new branch
          await this.runWorktreeAddWithPruneRetry(
            ['worktree', 'add', '-b', branchName, worktreePath, resolvedBase],
            gitAdminCwd
          );
        }
      }

      this.ensureWorktreeGitdirIsRelative(sessionId);
      const info = await this.getWorktreeInfo(sessionId);
      this.logger.debug(
        `[${this.repoId}] Worktree ready (sessionId=${sessionId} branch=${info.branch} head=${info.headSha ?? 'unknown'}): host=${info.hostPath}`
      );
      return info;
    });
  }

  /**
   * Get information about a worktree
   */
  private async getWorktreeInfo(sessionId: SessionId): Promise<WorktreeInfo> {
    assertSafeSessionId(sessionId);
    const worktreePath = this.getWorktreeHostPath(sessionId);

    // Get the actual branch name from git (handles renamed branches and short session IDs)
    const branchName =
      (await this.getCurrentBranchName(sessionId)) ?? this.getDefaultSessionBranchName(sessionId);

    let isClean = true;
    try {
      const status = await this.runGit(['status', '--porcelain'], worktreePath);
      isClean = status.trim() === '';
    } catch {
      isClean = false;
    }

    let headSha: string | null = null;
    try {
      headSha = await this.runGit(['rev-parse', 'HEAD'], worktreePath);
    } catch {
      headSha = null;
    }

    return {
      sessionId,
      hostPath: worktreePath,
      branch: branchName,
      headSha,
      isClean,
    };
  }

  /**
   * Remove a worktree for a session
   * @param force - If true, remove even if dirty
   */
  async removeWorktree(
    sessionId: SessionId,
    force: boolean = false,
    branchName?: string,
    options?: RemoveWorktreeOptions
  ): Promise<void> {
    return withRepoLock(this.repoId, async () => {
      const resolvedBranchName = await this.removeWorktreeInternal(sessionId, {
        force,
        deleteBranch: true,
        branchName,
      });
      if (resolvedBranchName) {
        if (this.shouldDeleteRemovedBranch(resolvedBranchName, options)) {
          await this.cleanupBranch(resolvedBranchName);
        }
      }
    });
  }

  /**
   * Archive a worktree for a session.
   * If the worktree has non-ignored changes, stage and commit them before removing the worktree directory.
   * The branch is preserved so the worktree can be restored later.
   */
  async archiveWorktree(sessionId: SessionId): Promise<ArchivedWorktreeResult> {
    return withRepoLock(this.repoId, async () => {
      assertSafeSessionId(sessionId);
      const worktreePath = this.getWorktreeHostPath(sessionId);
      const branchName =
        (await this.getCurrentBranchName(sessionId)) ??
        (await this.resolveExistingBranchName(sessionId));

      if (!fs.existsSync(worktreePath)) {
        this.logger.debug(`[${this.repoId}] Worktree for session ${sessionId} does not exist`);
        return {
          branchName,
          backupCommitCreated: false,
        };
      }

      let backupCommitCreated = false;
      const status = await this.runGit(['status', '--porcelain'], worktreePath);
      if (status.trim().length > 0) {
        this.logger.debug(
          `[${this.repoId}] Creating archive backup commit for session ${sessionId}`
        );
        await this.runGit(['add', '-A'], worktreePath);
        const cachedDiff = await this.runGit(['diff', '--cached', '--name-only'], worktreePath);
        if (cachedDiff.trim().length > 0) {
          const commitEnv: NodeJS.ProcessEnv = {
            GIT_AUTHOR_NAME: DEFAULT_ARCHIVE_BACKUP_AUTHOR_NAME,
            GIT_COMMITTER_NAME: DEFAULT_ARCHIVE_BACKUP_AUTHOR_NAME,
            GIT_AUTHOR_EMAIL: DEFAULT_ARCHIVE_BACKUP_AUTHOR_EMAIL,
            GIT_COMMITTER_EMAIL: DEFAULT_ARCHIVE_BACKUP_AUTHOR_EMAIL,
          };
          await this.runGit(
            [
              '-c',
              'commit.gpgsign=false',
              'commit',
              '-m',
              `chore: archive backup for session ${sessionId.slice(0, 8)}`,
            ],
            worktreePath,
            commitEnv
          );
          backupCommitCreated = true;
        }
      }

      const resolvedBranchName = await this.removeWorktreeInternal(sessionId, {
        force: true,
        deleteBranch: false,
        branchName: branchName ?? undefined,
      });
      return {
        branchName: resolvedBranchName,
        backupCommitCreated,
      };
    });
  }

  private async removeWorktreeInternal(
    sessionId: SessionId,
    options: {
      force: boolean;
      deleteBranch: boolean;
      branchName?: string;
    }
  ): Promise<string | null> {
    assertSafeSessionId(sessionId);
    const worktreePath = this.getWorktreeHostPath(sessionId);

    const preferredBranchName = options.branchName?.trim() || undefined;
    const currentBranchName = await this.getCurrentBranchName(sessionId);
    const resolvedBranchName =
      currentBranchName ??
      (preferredBranchName
        ? await this.resolveExistingBranchName(sessionId, preferredBranchName)
        : null);

    if (!fs.existsSync(worktreePath)) {
      this.logger.debug(`[${this.repoId}] Worktree for session ${sessionId} does not exist`);
      return resolvedBranchName;
    }

    if (!options.force) {
      const info = await this.getWorktreeInfo(sessionId);
      if (!info.isClean) {
        throw new Error(
          `Worktree for session ${sessionId} has uncommitted changes. Use force=true to remove anyway.`
        );
      }
    }

    const relative = path.relative(this.getWorktreesHostPath(), worktreePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Invalid worktree path: ${worktreePath}`);
    }

    this.logger.debug(
      `[${this.repoId}] Removing worktree for session ${sessionId}${options.deleteBranch ? '' : ' (preserving branch)'}`
    );

    try {
      const args = ['worktree', 'remove', worktreePath];
      if (options.force) args.splice(2, 0, '--force');
      await this.runGit(args, this.getGitAdminCwd());
    } catch {
      this.logger.debug(`[${this.repoId}] git worktree remove failed, removing directory manually`);
      fs.rmSync(worktreePath, { recursive: true, force: true });
      await this.runGit(['worktree', 'prune'], this.getGitAdminCwd());
    }

    return resolvedBranchName;
  }

  /**
   * Clean up a branch (best effort)
   */
  private async cleanupBranch(branchName: string): Promise<void> {
    if (this.isLocalSharedSource() && !this.isLodyManagedLocalBranch(branchName)) {
      return;
    }
    try {
      await this.runGit(['branch', '-D', branchName], this.getGitAdminCwd());
      this.logger.debug(`[${this.repoId}] Deleted branch: ${branchName}`);
    } catch {
      // Branch might not exist or be in use, ignore
    }
  }

  /**
   * List all worktrees for this repository
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    return withRepoLock(this.repoId, async () => {
      if (!fs.existsSync(this.worktreesDir)) {
        return [];
      }

      const entries = fs.readdirSync(this.worktreesDir, { withFileTypes: true });
      const worktrees: WorktreeInfo[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const sessionId = entry.name as SessionId;
          if (!SAFE_SESSION_ID_RE.test(sessionId)) {
            this.logger.debug(
              `[${this.repoId}] Skipping invalid worktree directory name: ${JSON.stringify(sessionId)}`
            );
            continue;
          }
          try {
            worktrees.push(await this.getWorktreeInfo(sessionId));
          } catch (error) {
            this.logger.debug(
              `[${this.repoId}] Failed to get info for worktree ${sessionId}: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        }
      }

      return worktrees;
    });
  }

  /**
   * Check if a worktree exists for a task
   */
  hasWorktree(sessionId: SessionId): boolean {
    if (!SAFE_SESSION_ID_RE.test(sessionId)) {
      return false;
    }
    return fs.existsSync(this.getWorktreeHostPath(sessionId));
  }

  /**
   * Prune orphaned worktrees and branches
   */
  async prune(): Promise<void> {
    return withRepoLock(this.repoId, async () => {
      this.logger.debug(`[${this.repoId}] Pruning orphaned worktrees`);
      await this.runGit(['worktree', 'prune'], this.getGitAdminCwd());
    });
  }

  /**
   * Rename the branch for a session's worktree.
   * This allows changing from the current branch to a meaningful name.
   *
   * @param sessionId - The session ID
   * @param newBranchName - The new branch name (e.g., "feat/add-dark-mode")
   * @returns The updated WorktreeInfo with the new branch name
   */
  async renameBranch(sessionId: SessionId, newBranchName: string): Promise<WorktreeInfo> {
    return withRepoLock(this.repoId, async () => {
      assertSafeSessionId(sessionId);

      const worktreePath = this.getWorktreeHostPath(sessionId);
      if (!fs.existsSync(worktreePath)) {
        throw new Error(`Worktree for session ${sessionId} does not exist`);
      }

      // Get the actual current branch name from git
      const currentBranch = await this.getCurrentBranchName(sessionId);
      if (!currentBranch) {
        throw new Error(`Cannot determine current branch for session ${sessionId}`);
      }

      // Validate the new branch name
      if (!newBranchName || typeof newBranchName !== 'string') {
        throw new Error('Invalid branch name');
      }

      const sanitizedName = newBranchName.trim();
      if (sanitizedName === currentBranch) {
        // Already on the same branch, just return current info
        return this.getWorktreeInfo(sessionId);
      }

      // Check if new branch name already exists
      let newBranchExists = false;
      try {
        await this.runGit(
          ['show-ref', '--verify', `refs/heads/${sanitizedName}`],
          this.getGitAdminCwd()
        );
        newBranchExists = true;
      } catch {
        newBranchExists = false;
      }

      if (newBranchExists) {
        throw new Error(`Branch '${sanitizedName}' already exists`);
      }

      this.logger.debug(
        `[${this.repoId}] Renaming branch for session ${sessionId}: ${currentBranch} -> ${sanitizedName}`
      );

      // Rename the branch in the worktree
      await this.runGit(['branch', '-m', currentBranch, sanitizedName], worktreePath);

      // Update worktree info - now we need to get the actual branch name from git
      let headSha: string | null = null;
      try {
        headSha = await this.runGit(['rev-parse', 'HEAD'], worktreePath);
      } catch {
        headSha = null;
      }

      let isClean = true;
      try {
        const status = await this.runGit(['status', '--porcelain'], worktreePath);
        isClean = status.trim() === '';
      } catch {
        isClean = false;
      }

      this.logger.debug(
        `[${this.repoId}] Branch renamed successfully for session ${sessionId}: ${sanitizedName}`
      );

      return {
        sessionId,
        hostPath: worktreePath,
        branch: sanitizedName,
        headSha,
        isClean,
      };
    });
  }

  /**
   * Get the current branch name for a session's worktree.
   * This resolves the actual branch name from git, which may differ from `session/<sessionId>`
   * if the branch was renamed.
   */
  async getCurrentBranchName(sessionId: SessionId): Promise<string | null> {
    assertSafeSessionId(sessionId);
    const worktreePath = this.getWorktreeHostPath(sessionId);

    if (!fs.existsSync(worktreePath)) {
      return null;
    }

    try {
      const branchName = await this.runGit(['branch', '--show-current'], worktreePath);
      return branchName.trim() || null;
    } catch {
      // Fallback to rev-parse
      try {
        const ref = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
        return ref.trim() || null;
      } catch {
        return null;
      }
    }
  }
}

/**
 * Cache of WorktreeManager instances per repo
 */
const worktreeManagers = new Map<RepoId, WorktreeManager>();

/**
 * Get or create a WorktreeManager for a repository
 */
export function getWorktreeManager(config: WorktreeManagerConfig): WorktreeManager {
  let manager = worktreeManagers.get(config.repoId);
  if (!manager) {
    manager = new WorktreeManager(config);
    worktreeManagers.set(config.repoId, manager);
  } else {
    manager.updateSource(config.source);
    manager.updateRepoUrl(config.repoUrl);
  }
  return manager;
}
