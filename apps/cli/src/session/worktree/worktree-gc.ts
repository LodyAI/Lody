import { toShared } from '@/platform/process-options';
import fs from 'fs';
import path from 'path';

import type { RepoId, SessionId, SessionMeta } from '@lody/shared';

import { runCommandTextLegacy } from '@lody/shared/node/process';

import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';

import { getWorktreeManager } from './worktree-manager';

const GIT_PROBE_TIMEOUT_MS = 30_000;

/**
 * What the workspace knows about the root Session that owns a managed workdir.
 *
 * `unknown` is not evidence of anything: the same data directory serves every
 * workspace this machine joins, so a directory this workspace has never heard
 * of may belong to a live Session elsewhere. Only `archived` and `deleted`
 * make a directory eligible for removal.
 */
export type WorktreeOwnerState =
  | { kind: 'unknown' }
  | { kind: 'active' }
  | { kind: 'archived'; meta: SessionMeta }
  | { kind: 'deleted'; meta: SessionMeta | undefined };

export type WorktreeGcDeps = {
  /** `<data>/repos`; every Lody-created worktree lives at `<reposDir>/<repoId>/worktrees/<sessionId>`. */
  reposDir: string;
  /** `<data>/chats`; no-project workdirs are named after their root Session. */
  chatsDir: string;
  logger: Logger;
  /**
   * Whether workspace metadata is complete enough to trust an `archived` or
   * `deleted` answer. Before the first full sync a not-yet-seen Session and a
   * deleted one look alike, so the sweep does nothing.
   */
  hasCompleteMetadata: () => boolean;
  readOwnerState: (sessionId: SessionId) => Promise<WorktreeOwnerState>;
  /** The Session's process is still being released; leave its directory for the next sweep. */
  isRuntimeActive: (sessionId: SessionId) => boolean;
  /**
   * User-configured cleanup hook, run once before the directory goes away.
   * Failures are the callee's to report; a rejection here is logged and does
   * not keep the directory.
   */
  runCleanupScript: (input: {
    sessionId: SessionId;
    meta: SessionMeta | undefined;
    worktreePath: string;
  }) => Promise<void>;
  /**
   * Called after an archived Session's worktree is removed when the branch git
   * reports differs from `meta.branchName` (renamed in a terminal, never
   * written back). Restore reads `branchName`, so the real name must be kept.
   */
  recordArchivedBranch: (sessionId: SessionId, branchName: string) => Promise<void>;
  archiveProjectGroup?: (input: { sessionId: SessionId; worktreePath: string }) => Promise<void>;
  now?: () => number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
};

export type WorktreeGcSweepResult = {
  /** Directories inspected. */
  scanned: number;
  /** Directories removed by this sweep. */
  removed: SessionId[];
  /** Directories whose cleanup failed and will be retried with backoff. */
  failed: SessionId[];
};

const DEFAULT_RETRY_BASE_DELAY_MS = 30_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60 * 60_000;
const SAFE_SESSION_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

type RepoSource =
  | { kind: 'github' }
  | { kind: 'local-shared'; originalRootPath: string; sourceGitDir?: string };

/**
 * Reconciles the Lody-managed worktree tree against Session state: a directory
 * whose root Session is archived or deleted is removed, after a backup commit,
 * with its branch preserved. There is no request and no acknowledgement; the
 * directory's existence is the only evidence that work remains, so every sweep
 * is safe to repeat. Chat workdirs are also reconciled, but archive removes only
 * empty directories because they have no Git backup.
 */
export class WorktreeGarbageCollector {
  private readonly deps: WorktreeGcDeps;
  private readonly inFlight = new Set<string>();
  private readonly retryState = new Map<string, { attempt: number; notBeforeMs: number }>();
  private sweepPromise: Promise<WorktreeGcSweepResult> | null = null;
  private rerunRequested = false;

  constructor(deps: WorktreeGcDeps) {
    this.deps = deps;
  }

  /**
   * Runs a sweep, coalescing concurrent requests: a request that arrives while a
   * sweep is running schedules exactly one follow-up sweep after it finishes.
   */
  schedule(): Promise<WorktreeGcSweepResult> {
    if (this.sweepPromise) {
      this.rerunRequested = true;
      return this.sweepPromise;
    }
    this.sweepPromise = this.sweep()
      .catch((error: unknown) => {
        this.deps.logger.debug(`[worktree-gc] Sweep failed: ${formatErrorMessage(error)}`);
        return { scanned: 0, removed: [], failed: [] } satisfies WorktreeGcSweepResult;
      })
      .finally(() => {
        this.sweepPromise = null;
        if (this.rerunRequested) {
          this.rerunRequested = false;
          void this.schedule();
        }
      });
    return this.sweepPromise;
  }

  async sweep(): Promise<WorktreeGcSweepResult> {
    const result: WorktreeGcSweepResult = { scanned: 0, removed: [], failed: [] };
    if (!this.deps.hasCompleteMetadata()) {
      this.deps.logger.debug('[worktree-gc] Workspace metadata incomplete; skipping sweep');
      return result;
    }

    for (const { repoId, worktreesDir } of this.listRepoWorktreeDirs()) {
      for (const sessionId of this.listSessionDirs(worktreesDir)) {
        result.scanned += 1;
        const worktreePath = path.join(worktreesDir, sessionId);
        if (this.inFlight.has(sessionId) || !this.isRetryDue(sessionId)) continue;

        const state = await this.deps.readOwnerState(sessionId);
        if (state.kind !== 'archived' && state.kind !== 'deleted') continue;
        if (this.deps.isRuntimeActive(sessionId)) {
          this.deps.logger.debug(
            `[worktree-gc] ${sessionId} runtime still releasing; deferring worktree removal`
          );
          continue;
        }

        this.inFlight.add(sessionId);
        try {
          const branchName = await this.remove({
            repoId,
            sessionId,
            worktreePath,
            meta: state.meta,
          });
          if (
            state.kind === 'archived' &&
            branchName &&
            branchName !== state.meta.branchName?.trim()
          ) {
            await this.deps.recordArchivedBranch(sessionId, branchName);
          }
          this.retryState.delete(sessionId);
          result.removed.push(sessionId);
          this.deps.logger.info(
            `[worktree-gc] Removed ${state.kind} session worktree ${worktreePath} (branch preserved)`
          );
        } catch (error) {
          this.scheduleRetry(sessionId);
          result.failed.push(sessionId);
          this.deps.logger.warn(
            `[worktree-gc] Failed to remove worktree ${worktreePath}; will retry: ${formatErrorMessage(error)}`
          );
        } finally {
          this.inFlight.delete(sessionId);
        }
      }
    }
    // Keep the existing worktree sweep ahead of chat filesystem I/O.
    await this.sweepChatWorkdirs(result);
    return result;
  }

  private async sweepChatWorkdirs(result: WorktreeGcSweepResult): Promise<void> {
    const { chatsDir } = this.deps;
    if (!this.isRetryDue(chatsDir)) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(chatsDir, { withFileTypes: true });
      this.retryState.delete(chatsDir);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      this.scheduleRetry(chatsDir);
      this.deps.logger.warn(
        `[worktree-gc] Failed to read chat workdirs ${chatsDir}; will retry: ${formatErrorMessage(error)}`
      );
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_SESSION_DIR_RE.test(entry.name)) continue;
      const sessionId = entry.name as SessionId;
      result.scanned += 1;
      const workdir = path.join(chatsDir, sessionId);
      if (this.inFlight.has(workdir) || !this.isRetryDue(workdir)) continue;
      this.inFlight.add(workdir);
      try {
        const state = await this.deps.readOwnerState(sessionId);
        if (state.kind !== 'archived' && state.kind !== 'deleted') continue;
        if (this.deps.isRuntimeActive(sessionId)) {
          this.deps.logger.debug(
            `[worktree-gc] ${sessionId} runtime still releasing; deferring chat workdir removal`
          );
          continue;
        }
        if (state.kind === 'archived') {
          // rmdir checks emptiness at removal; never discard an archived chat's files.
          try {
            await fs.promises.rmdir(workdir);
          } catch (error) {
            const code = error instanceof Error && 'code' in error ? error.code : undefined;
            if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
            this.retryState.delete(workdir);
            continue;
          }
        } else {
          await fs.promises.rm(workdir, { recursive: true, force: true });
        }
        this.retryState.delete(workdir);
        result.removed.push(sessionId);
        this.deps.logger.info(`[worktree-gc] Removed ${state.kind} chat workdir ${workdir}`);
      } catch (error) {
        this.scheduleRetry(workdir);
        result.failed.push(sessionId);
        this.deps.logger.warn(
          `[worktree-gc] Failed to clean chat workdir ${workdir}; will retry: ${formatErrorMessage(error)}`
        );
      } finally {
        this.inFlight.delete(workdir);
      }
    }
  }

  /** Returns the branch the removed worktree was on, when git could tell. */
  private async remove(input: {
    repoId: RepoId;
    sessionId: SessionId;
    worktreePath: string;
    meta: SessionMeta | undefined;
  }): Promise<string | null> {
    const { repoId, sessionId, worktreePath, meta } = input;
    if (repoId.startsWith('project-')) {
      if (!meta?.projectRun || meta.projectRun.root !== repoId || !this.deps.archiveProjectGroup)
        throw new Error('Project group snapshot is unavailable; preserving its directory');
      await this.deps.archiveProjectGroup({ sessionId, worktreePath });
      return null;
    }
    // Resolve the owning repository BEFORE anything destructive. A worktree
    // whose repository cannot be found is preserved: the backup commit has
    // nowhere to go, and the directory may hold the only copy of the work.
    const source = await this.resolveRepoSource(repoId);
    if (source === null) {
      throw new Error(`Repository for ${repoId} could not be resolved; preserving ${worktreePath}`);
    }

    try {
      await this.deps.runCleanupScript({ sessionId, meta, worktreePath });
    } catch (error) {
      this.deps.logger.warn(
        `[worktree-gc] Cleanup script for ${sessionId} failed; removing worktree anyway: ${formatErrorMessage(error)}`
      );
    }

    const manager = getWorktreeManager({
      repoId,
      ...(source.kind === 'local-shared' ? { source } : {}),
      logger: this.deps.logger,
    });
    const archived = await manager.archiveWorktree(sessionId);
    return archived.branchName;
  }

  /**
   * Ownership comes from git, not from the presence of `<root>/.git`: a
   * registered local project may be a subdirectory of a repository, and its
   * `.git` lives at the repository root.
   */
  private async resolveRepoSource(repoId: RepoId): Promise<RepoSource | null> {
    const repoDir = path.join(this.deps.reposDir, repoId);
    const metaPath = path.join(repoDir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      let parsed: { kind?: unknown; originalRootPath?: unknown; sourceGitDir?: unknown };
      try {
        parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as typeof parsed;
      } catch (error) {
        this.deps.logger.debug(
          `[worktree-gc] Unreadable ${metaPath}: ${formatErrorMessage(error)}`
        );
        return null;
      }
      if (parsed.kind !== 'local' || typeof parsed.originalRootPath !== 'string') {
        return null;
      }
      if (!(await this.isInsideGitWorkTree(parsed.originalRootPath))) {
        return null;
      }
      return {
        kind: 'local-shared',
        originalRootPath: parsed.originalRootPath,
        ...(typeof parsed.sourceGitDir === 'string' ? { sourceGitDir: parsed.sourceGitDir } : {}),
      };
    }
    if (fs.existsSync(path.join(repoDir, 'bare.git'))) {
      return { kind: 'github' };
    }
    return null;
  }

  private async isInsideGitWorkTree(dir: string): Promise<boolean> {
    if (!fs.existsSync(dir)) return false;
    try {
      const { stdout } = await runCommandTextLegacy(
        {
          command: 'git',
          args: ['rev-parse', '--is-inside-work-tree'],
          cwd: dir,
          timeout: GIT_PROBE_TIMEOUT_MS,
          check: 'exit-0',
        },
        toShared()
      );
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  private listRepoWorktreeDirs(): Array<{ repoId: RepoId; worktreesDir: string }> {
    let repoEntries: fs.Dirent[];
    try {
      repoEntries = fs.readdirSync(this.deps.reposDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const dirs: Array<{ repoId: RepoId; worktreesDir: string }> = [];
    for (const entry of repoEntries) {
      if (!entry.isDirectory()) continue;
      const worktreesDir = path.join(this.deps.reposDir, entry.name, 'worktrees');
      if (!fs.existsSync(worktreesDir)) continue;
      dirs.push({ repoId: entry.name as RepoId, worktreesDir });
    }
    return dirs;
  }

  private listSessionDirs(worktreesDir: string): SessionId[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && SAFE_SESSION_DIR_RE.test(entry.name))
      .map((entry) => entry.name as SessionId);
  }

  private isRetryDue(key: string): boolean {
    const retry = this.retryState.get(key);
    return !retry || retry.notBeforeMs <= this.now();
  }

  private scheduleRetry(key: string): void {
    const attempt = (this.retryState.get(key)?.attempt ?? 0) + 1;
    const base = this.deps.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const max = this.deps.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    const delayMs = Math.min(base * 2 ** (attempt - 1), max);
    this.retryState.set(key, { attempt, notBeforeMs: this.now() + delayMs });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
