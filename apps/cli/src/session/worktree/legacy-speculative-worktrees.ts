import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { MachineId, RepoId, SessionId, WorkspaceId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import {
  getWorktreeManager,
  type WorktreeManager,
  type WorktreeManagerConfig,
  type WorktreeManagerSource,
} from './worktree-manager';
import { formatErrorMessage } from '@/utils/format-error';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

/**
 * Markers left by draft session preparation, which daemons before its removal
 * used to materialize a worktree while the user was still typing. Nothing writes
 * these markers any more, so every marker present belongs to an older process.
 * Two things still read them:
 *
 * - Session creation claims the marker for its own Session. A worktree built
 *   for a different repo or base branch is rebuilt, and a matching one still
 *   runs setup, which a preparation never ran.
 * - A sweep removes orphans whose Session never became durable. Worktree GC
 *   cannot, because it never acts on a Session it does not know.
 *
 * Delete this module once no supported daemon can have written a marker.
 */
const WorktreeManagerSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github'), repoUrl: z.string().optional() }).strict(),
  z
    .object({
      kind: z.literal('local-shared'),
      sourceGitDir: z.string().optional(),
      originalRootPath: z.string(),
    })
    .strict(),
]);

const LegacySpeculativeWorktreeMarkerSchema = z
  .object({
    version: z.literal(1),
    preparationId: z.string().min(1),
    sessionId: z.string().min(1),
    workspaceId: z.string().min(1),
    machineId: z.string().min(1),
    repoId: z.string().min(1),
    source: WorktreeManagerSourceSchema,
    baseBranch: z.string().optional(),
    ownsWorktree: z.boolean(),
    phase: z.enum(['speculative', 'durable-pending-setup']),
    createdAtMs: z.number().finite(),
  })
  .strict();

type LegacySpeculativeWorktreeMarker = z.infer<typeof LegacySpeculativeWorktreeMarkerSchema>;

/** The worktree a durable Session expects, compared against a marker's target. */
export type LegacySpeculativeWorktreeTarget = {
  repoId: RepoId;
  source: WorktreeManagerSource;
  baseBranch?: string;
};

type GetManager = (config: WorktreeManagerConfig) => WorktreeManager;

export function getLegacySpeculativeWorktreeMarkerRoot(): string {
  return path.join(getLodyDataDir(), 'session-preparations', 'worktrees');
}

export function getLegacySpeculativeWorktreeMarkerPath(sessionId: SessionId): string {
  const key = createHash('sha256').update(sessionId).digest('hex');
  return path.join(getLegacySpeculativeWorktreeMarkerRoot(), `${key}.json`);
}

async function readMarker(sessionId: SessionId): Promise<LegacySpeculativeWorktreeMarker | null> {
  try {
    const parsed = LegacySpeculativeWorktreeMarkerSchema.safeParse(
      JSON.parse(
        await readFile(getLegacySpeculativeWorktreeMarkerPath(sessionId), 'utf8')
      ) as unknown
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readMarkerFile(markerPath: string): Promise<LegacySpeculativeWorktreeMarker | null> {
  try {
    const parsed = LegacySpeculativeWorktreeMarkerSchema.safeParse(
      JSON.parse(await readFile(markerPath, 'utf8')) as unknown
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeMarker(marker: LegacySpeculativeWorktreeMarker): Promise<void> {
  const markerPath = getLegacySpeculativeWorktreeMarkerPath(marker.sessionId as SessionId);
  await mkdir(path.dirname(markerPath), { recursive: true });
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, markerPath);
}

async function deleteMarker(sessionId: SessionId): Promise<void> {
  await rm(getLegacySpeculativeWorktreeMarkerPath(sessionId), { force: true });
}

/**
 * Serializes marker read-check-act sequences per session within this process.
 * Session creation's claim and the orphan sweep act on the same marker and the
 * same worktree: unserialized, a sweep that checked before a create began could
 * delete the worktree that create had just adopted.
 */
const sessionMarkerLocks = new Map<string, Promise<unknown>>();

async function withSessionMarkerLock<T>(sessionId: SessionId, fn: () => Promise<T>): Promise<T> {
  const previous = sessionMarkerLocks.get(sessionId) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  sessionMarkerLocks.set(sessionId, tail);
  try {
    return await run;
  } finally {
    if (sessionMarkerLocks.get(sessionId) === tail) {
      sessionMarkerLocks.delete(sessionId);
    }
  }
}

function belongsTo(
  marker: LegacySpeculativeWorktreeMarker,
  scope: { workspaceId: WorkspaceId; machineId: MachineId }
): boolean {
  return marker.workspaceId === scope.workspaceId && marker.machineId === scope.machineId;
}

function markerMatchesTarget(
  marker: LegacySpeculativeWorktreeMarker,
  target: LegacySpeculativeWorktreeTarget
): boolean {
  return (
    marker.repoId === target.repoId &&
    marker.baseBranch === target.baseBranch &&
    isDeepStrictEqual(marker.source, target.source)
  );
}

async function disposeMarker(
  marker: LegacySpeculativeWorktreeMarker,
  logger: Logger,
  getManager: GetManager = getWorktreeManager
): Promise<void> {
  if (marker.ownsWorktree) {
    const manager = getManager({
      repoId: marker.repoId as RepoId,
      source: marker.source as WorktreeManagerSource,
      logger,
    });
    await manager.removeWorktree(
      marker.sessionId as SessionId,
      true,
      undefined,
      marker.baseBranch ? { baseBranchName: marker.baseBranch } : undefined
    );
  }
  await deleteMarker(marker.sessionId as SessionId);
}

/**
 * How Session creation's claim of a legacy marker resolved.
 *
 * - `setup-pending`: the worktree belongs to this Session. Reuse it, but run
 *   setup even on resume, because setup never completed for it.
 * - `no-marker`: nothing to claim, including another workspace's marker.
 * - `mismatch`: an unadopted worktree was built for a different target and has
 *   been disposed together with the marker; creation must build a fresh one.
 */
export type LegacySpeculativeWorktreeClaim = 'setup-pending' | 'no-marker' | 'mismatch';

/**
 * Runs before Session creation reuses or creates the Session's worktree.
 *
 * Only a worktree no Session ever adopted may be destroyed for a target
 * mismatch. Once a Session has adopted it (`durable-pending-setup`), or records a
 * branch to restore, the worktree and its branch are that Session's: removing
 * them for a drifted base-branch spelling would delete the branch resume needs
 * and leave the Session permanently unresumable. Adopting promotes the marker
 * before creation records the branch, so a retry cannot destroy it either.
 */
export async function claimLegacySpeculativeWorktree(args: {
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  target: LegacySpeculativeWorktreeTarget;
  restoreBranchName?: string;
  logger: Logger;
  getManager?: GetManager;
}): Promise<LegacySpeculativeWorktreeClaim> {
  return await withSessionMarkerLock(args.sessionId, async () => {
    const marker = await readMarker(args.sessionId);
    if (!marker || !belongsTo(marker, args)) return 'no-marker';
    const adopted =
      marker.phase === 'durable-pending-setup' || Boolean(args.restoreBranchName?.trim());
    if (!adopted && !markerMatchesTarget(marker, args.target)) {
      await disposeMarker(marker, args.logger, args.getManager);
      return 'mismatch';
    }
    if (marker.phase !== 'durable-pending-setup') {
      await writeMarker({ ...marker, phase: 'durable-pending-setup' });
    }
    return 'setup-pending';
  });
}

/** Drops this Session's claimed marker once setup has completed for it. */
export async function completeLegacySpeculativeWorktreeSetup(args: {
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  machineId: MachineId;
}): Promise<void> {
  await withSessionMarkerLock(args.sessionId, async () => {
    const marker = await readMarker(args.sessionId);
    if (marker && belongsTo(marker, args)) {
      await deleteMarker(args.sessionId);
    }
  });
}

/**
 * Removes this workspace's orphaned markers together with the worktrees they
 * created. A marker whose Session is durable or being created is left for that
 * Session's claim, which knows whether setup still has to run.
 */
export async function recoverLegacySpeculativeWorktrees(args: {
  workspaceId: WorkspaceId;
  machineId: MachineId;
  logger: Logger;
  isDurableSession: (sessionId: SessionId) => Promise<boolean>;
  isActiveSession?: (sessionId: SessionId) => boolean;
  getManager?: GetManager;
}): Promise<void> {
  const root = getLegacySpeculativeWorktreeMarkerRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const candidate = await readMarkerFile(path.join(root, entry));
      if (!candidate || !belongsTo(candidate, args)) continue;
      const sessionId = candidate.sessionId as SessionId;
      await withSessionMarkerLock(sessionId, async () => {
        // Re-read and re-check under the lock: a create that began while this
        // sweep waited has claimed or is about to claim this marker.
        const marker = await readMarker(sessionId);
        if (!marker || marker.preparationId !== candidate.preparationId) return;
        if (args.isActiveSession?.(sessionId)) return;
        if (await args.isDurableSession(sessionId)) return;
        if (args.isActiveSession?.(sessionId)) return;
        await disposeMarker(marker, args.logger, args.getManager);
      });
    } catch (error) {
      args.logger.debug(
        `Failed to recover legacy speculative worktree marker ${entry}: ${formatErrorMessage(error)}`
      );
    }
  }
}
