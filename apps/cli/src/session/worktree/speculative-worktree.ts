import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { MachineId, RepoId, SessionId, WorkspaceId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import {
  getWorktreeManager,
  type GitCredentialBrokerAuth,
  type WorktreeInfo,
  type WorktreeManager,
  type WorktreeManagerConfig,
  type WorktreeManagerSource,
} from './worktree-manager';
import { formatErrorMessage } from '@/utils/format-error';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

const SPECULATIVE_WORKTREE_MARKER_VERSION = 1;
const SPECULATIVE_WORKTREE_STALE_MS = 10 * 60_000;

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

const SpeculativeWorktreeMarkerSchema = z
  .object({
    version: z.literal(SPECULATIVE_WORKTREE_MARKER_VERSION),
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

type SpeculativeWorktreeMarker = z.infer<typeof SpeculativeWorktreeMarkerSchema>;

function getMarkerRoot(): string {
  return path.join(getLodyDataDir(), 'session-preparations', 'worktrees');
}

function getMarkerPath(sessionId: SessionId): string {
  const key = createHash('sha256').update(sessionId).digest('hex');
  return path.join(getMarkerRoot(), `${key}.json`);
}

async function readMarker(sessionId: SessionId): Promise<SpeculativeWorktreeMarker | null> {
  try {
    const parsed = SpeculativeWorktreeMarkerSchema.safeParse(
      JSON.parse(await readFile(getMarkerPath(sessionId), 'utf8')) as unknown
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeMarker(marker: SpeculativeWorktreeMarker): Promise<void> {
  const markerPath = getMarkerPath(marker.sessionId as SessionId);
  await mkdir(path.dirname(markerPath), { recursive: true });
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, markerPath);
}

async function deleteMarker(sessionId: SessionId): Promise<void> {
  await rm(getMarkerPath(sessionId), { force: true });
}

/**
 * Serializes marker read-check-act sequences per session within this process.
 *
 * Every mutation in this module is a read-check-act on the same marker file, and
 * two flows for one session legitimately overlap: a superseded preparation's
 * dispose racing its replacement's materialization, or a durable claim racing
 * the stale-marker sweep. Unserialized, the stale dispose can read the marker
 * before the replacement rewrites it and then delete the worktree the
 * replacement just materialized — the prepared session later starts against a
 * path that no longer exists on disk. Cross-process writers are not serialized
 * here; the durable adopter's on-disk existence check and the sweep's staleness
 * window bound that boundary.
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

function buildManagerConfig(
  marker: SpeculativeWorktreeMarker,
  logger: Logger
): WorktreeManagerConfig {
  return {
    repoId: marker.repoId as RepoId,
    source: marker.source as WorktreeManagerSource,
    logger,
  };
}

async function disposeMarker(marker: SpeculativeWorktreeMarker, logger: Logger): Promise<void> {
  if (marker.ownsWorktree) {
    const manager = getWorktreeManager(buildManagerConfig(marker, logger));
    await manager.removeWorktree(
      marker.sessionId as SessionId,
      true,
      undefined,
      marker.baseBranch ? { baseBranchName: marker.baseBranch } : undefined
    );
  }
  await deleteMarker(marker.sessionId as SessionId);
}

async function disposePreparedMarker(
  marker: SpeculativeWorktreeMarker,
  manager: WorktreeManager
): Promise<void> {
  if (marker.ownsWorktree) {
    await manager.removeWorktree(
      marker.sessionId as SessionId,
      true,
      undefined,
      marker.baseBranch ? { baseBranchName: marker.baseBranch } : undefined
    );
  }
  await deleteMarker(marker.sessionId as SessionId);
}

export type PreparedWorktree = {
  info: WorktreeInfo;
  claim(): Promise<void>;
  dispose(): Promise<void>;
};

export type SpeculativeWorktreeTarget = {
  repoId: RepoId;
  source: WorktreeManagerSource;
  baseBranch?: string;
};

function buildTarget(args: {
  managerConfig: Omit<WorktreeManagerConfig, 'logger'>;
  baseBranch?: string;
}): SpeculativeWorktreeTarget {
  return {
    repoId: args.managerConfig.repoId,
    source: args.managerConfig.source ?? {
      kind: 'github',
      repoUrl: args.managerConfig.repoUrl,
    },
    ...(args.baseBranch ? { baseBranch: args.baseBranch } : {}),
  };
}

function markerMatchesTarget(
  marker: SpeculativeWorktreeMarker,
  target: SpeculativeWorktreeTarget
): boolean {
  return (
    marker.repoId === target.repoId &&
    marker.baseBranch === target.baseBranch &&
    isDeepStrictEqual(marker.source, target.source)
  );
}

export async function materializeSpeculativeWorktree(args: {
  preparationId: string;
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  manager: WorktreeManager;
  managerConfig: Omit<WorktreeManagerConfig, 'logger'>;
  baseBranch?: string;
  restoreBranchName?: string;
  /**
   * Resolves the credential broker of the workspace this preparation belongs to.
   * Host git must not fall back to the process-global broker pointer, which in a
   * multi-workspace fleet belongs to whichever workspace started its broker last.
   *
   * Lazy so a preparation that is never started does not start a broker.
   */
  resolveBrokerAuth?: () => Promise<GitCredentialBrokerAuth | undefined>;
  logger: Logger;
}): Promise<PreparedWorktree> {
  const target = buildTarget(args);
  // The whole materialization holds the session marker lock, so a superseded
  // preparation's late dispose is ordered strictly before or after it — it can
  // no longer read the old marker, lose the race to this rewrite, and then
  // delete the worktree this call just materialized.
  const info = await withSessionMarkerLock(args.sessionId, async () => {
    let previousMarker = await readMarker(args.sessionId);
    if (
      previousMarker &&
      previousMarker.workspaceId === args.workspaceId &&
      previousMarker.machineId === args.machineId &&
      !markerMatchesTarget(previousMarker, target)
    ) {
      await disposeMarker(previousMarker, args.logger);
      previousMarker = null;
    }
    const worktreeAlreadyExisted = args.manager.hasWorktree(args.sessionId);
    const ownsWorktree =
      previousMarker?.workspaceId === args.workspaceId &&
      previousMarker.machineId === args.machineId &&
      markerMatchesTarget(previousMarker, target)
        ? previousMarker.ownsWorktree
        : !worktreeAlreadyExisted;
    const marker: SpeculativeWorktreeMarker = {
      version: SPECULATIVE_WORKTREE_MARKER_VERSION,
      preparationId: args.preparationId,
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      machineId: args.machineId,
      repoId: target.repoId,
      source: target.source,
      ...(target.baseBranch ? { baseBranch: target.baseBranch } : {}),
      ownsWorktree,
      phase: 'speculative',
      createdAtMs: Date.now(),
    };
    await writeMarker(marker);

    try {
      await args.manager.ensureRepo({ brokerAuth: await args.resolveBrokerAuth?.() });
      return await args.manager.createWorktree(
        args.sessionId,
        args.baseBranch,
        args.restoreBranchName
      );
    } catch (error) {
      const current = await readMarker(args.sessionId);
      if (current?.preparationId === args.preparationId) {
        await disposePreparedMarker(current, args.manager).catch((cleanupError: unknown) => {
          args.logger.debug(
            `[${args.sessionId}] Failed to clean speculative worktree after materialization error: ${formatErrorMessage(
              cleanupError
            )}`
          );
        });
      }
      throw error;
    }
  });

  let claimed = false;
  let disposed = false;
  return {
    info,
    claim: async () => {
      if (claimed || disposed) return;
      claimed = true;
    },
    dispose: async () => {
      if (claimed || disposed) return;
      disposed = true;
      await withSessionMarkerLock(args.sessionId, async () => {
        const current = await readMarker(args.sessionId);
        if (current?.preparationId !== args.preparationId) return;
        await disposePreparedMarker(current, args.manager);
      });
    },
  };
}

/**
 * How a durable session's claim of a speculative worktree resolved.
 *
 * - `claimed`: the marker matched the durable target and setup is still pending.
 * - `no-marker`: nothing to claim (never prepared, already completed, or a
 *   foreign workspace/machine marker that is not ours to touch).
 * - `mismatch`: the marker was built for a DIFFERENT target and was disposed —
 *   including its worktree directory. The caller must not use a prepared
 *   worktree after this outcome; the cold path has to rebuild it.
 */
export type SpeculativeWorktreeClaimOutcome = 'claimed' | 'no-marker' | 'mismatch';

/**
 * Marks the worktree as durably owned while preserving the fact that setup has
 * not completed. A retry must not skip setup merely because the directory now
 * exists.
 */
export async function claimSpeculativeWorktreeForDurableSession(args: {
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  target: SpeculativeWorktreeTarget;
  logger: Logger;
}): Promise<SpeculativeWorktreeClaimOutcome> {
  return await withSessionMarkerLock(args.sessionId, async () => {
    const marker = await readMarker(args.sessionId);
    if (!marker || marker.workspaceId !== args.workspaceId || marker.machineId !== args.machineId) {
      return 'no-marker';
    }
    if (!markerMatchesTarget(marker, args.target)) {
      await disposeMarker(marker, args.logger);
      return 'mismatch';
    }
    if (marker.phase !== 'durable-pending-setup') {
      await writeMarker({
        ...marker,
        phase: 'durable-pending-setup',
      });
    }
    return 'claimed';
  });
}

export async function completeSpeculativeWorktreeSetup(args: {
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  target: SpeculativeWorktreeTarget;
}): Promise<void> {
  await withSessionMarkerLock(args.sessionId, async () => {
    const marker = await readMarker(args.sessionId);
    if (
      marker?.phase === 'durable-pending-setup' &&
      marker.workspaceId === args.workspaceId &&
      marker.machineId === args.machineId &&
      markerMatchesTarget(marker, args.target)
    ) {
      await deleteMarker(args.sessionId);
    }
  });
}

export async function recoverStaleSpeculativeWorktrees(args: {
  workspaceId: WorkspaceId;
  machineId: MachineId;
  logger: Logger;
  isDurableSession: (sessionId: SessionId) => Promise<boolean>;
  isActiveSession?: (sessionId: SessionId) => boolean;
  nowMs?: number;
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  let entries: string[];
  try {
    entries = await readdir(getMarkerRoot());
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const markerPath = path.join(getMarkerRoot(), entry);
      const parsed = SpeculativeWorktreeMarkerSchema.safeParse(
        JSON.parse(await readFile(markerPath, 'utf8')) as unknown
      );
      if (!parsed.success) continue;
      const candidate = parsed.data;
      if (candidate.workspaceId !== args.workspaceId || candidate.machineId !== args.machineId) {
        continue;
      }
      const sessionId = candidate.sessionId as SessionId;
      if (args.isActiveSession?.(sessionId)) continue;
      if (nowMs - candidate.createdAtMs < SPECULATIVE_WORKTREE_STALE_MS) continue;
      if (await args.isDurableSession(sessionId)) {
        continue;
      }
      await withSessionMarkerLock(sessionId, async () => {
        // Re-read under the lock: while this sweep waited, a new preparation or
        // a durable claim may have rewritten the marker. Disposing from the
        // stale directory-listing snapshot would delete a live worktree.
        const marker = await readMarker(sessionId);
        if (
          !marker ||
          marker.preparationId !== candidate.preparationId ||
          marker.workspaceId !== args.workspaceId ||
          marker.machineId !== args.machineId
        ) {
          return;
        }
        if (args.isActiveSession?.(sessionId)) return;
        if (nowMs - marker.createdAtMs < SPECULATIVE_WORKTREE_STALE_MS) return;
        await disposeMarker(marker, args.logger);
      });
    } catch (error) {
      args.logger.debug(
        `Failed to recover stale speculative worktree marker ${entry}: ${formatErrorMessage(error)}`
      );
    }
  }
}
