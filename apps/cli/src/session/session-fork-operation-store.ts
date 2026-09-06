import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  AccountProfileIdSchema,
  AgentConfigCliTypeSchema,
  ProjectRefSchema,
  type SessionId,
} from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

/**
 * Machine-local discovery index for in-flight worktree-fork operations.
 *
 * A preparing fork target deliberately publishes no Session meta until its final
 * commit (half-finished sessions must stay invisible), so the repo meta index
 * cannot answer "which forks were interrupted by a restart". Without this store
 * the only way to find them is opening every historical Session Doc — each open
 * joins the doc's room and pulls its stream, which stalls startup and hammers
 * the Streams backend once a workspace accumulates thousands of sessions
 * (see ../lib/loro/AGENTS.md).
 *
 * This deliberately does NOT reuse the speculative-worktree marker/sweep
 * (worktree/speculative-worktree.ts): that sweep only disposes after a 10-minute
 * staleness window, while fork compensation must run at startup, before any
 * same-target retry can arrive — a retry that adopts a crashed saga's worktree
 * would inherit a stale captured HEAD. The three disciplines that make the
 * sweep race-safe ARE replicated here:
 *
 * 1. `withForkOperationLock` serializes accept/saga-finalize/recovery per
 *    target session, and recovery RE-READS the marker inside the lock — acting
 *    on the directory-listing snapshot would roll back a fork that a retry just
 *    restarted.
 * 2. Process liveness comes from the service's in-memory active-operation set,
 *    not timestamps — clock skew or a NaN `createdAt` can never make a live
 *    operation look interrupted (or hide an interrupted one forever).
 * 3. Terminal state is judged from the target doc itself, with the same
 *    criteria the client's PendingWorktreeForkObserver uses (a failed receipt,
 *    or a cleared flag plus the cloned history's origin notice) — never from
 *    the meta record, whose write is not flush-atomic with the doc's. The saga
 *    commits doc writes first and publishes meta last so a durable
 *    `acpSessionId` implies the doc writes are durable too. A crash in that
 *    gap (doc landed, meta missing) is repaired by republishing meta from the
 *    marker — which is why the marker carries `title`, `branchName` (recorded
 *    by the saga once git answers), and the cleanup payload.
 *
 * The cleanup payload mirrors everything `SessionManager.cleanupForkWorktree`
 * needs, so recovery never opens the SOURCE doc either.
 *
 * Write lifecycle (fail-closed): the accept path records a marker BEFORE it
 * persists the target doc's `forkOperation`, so any durable preparing operation
 * always has a marker; the saga clears the marker after its final
 * commit/rollback persists.
 *
 * Known boundary: markers from another workspace or a former machine identity
 * are skipped (never deleted) — a workspace deletion or machine-id change
 * leaves the file behind. They are tiny and bounded by fork count; reclaiming
 * them safely needs owner confirmation we don't have locally.
 *
 * Storage follows the speculative-worktree marker conventions: one JSON file
 * per target session under `~/.lody/session-fork-operations/` (dir 0o700),
 * atomic tmp+rename writes (0o600), strict schema, unreadable entries skipped.
 */

const SESSION_FORK_OPERATION_MARKER_VERSION = 1;

const SessionForkOperationCleanupSchema = z
  .object({
    project: ProjectRefSchema,
    repoFullName: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    workdir: z.string().min(1).optional(),
    requesterUserId: z.string().min(1),
    agentConfigId: z.string().min(1),
    cliType: AgentConfigCliTypeSchema,
    agentType: z.string().min(1),
  })
  .strict();

const WorktreeForkOperationMarkerSchema = z
  .object({
    kind: z.literal('new-worktree').optional(),
    version: z.literal(SESSION_FORK_OPERATION_MARKER_VERSION),
    workspaceId: z.string().min(1),
    machineId: z.string().min(1),
    targetSessionId: z.string().min(1),
    operationId: z.string().min(1),
    /** Diagnostic only — never a liveness input (see header). */
    createdAt: z.string().min(1),
    /** Target session title, for republishing meta after a mid-commit crash. */
    title: z.string().min(1),
    /**
     * The worktree's real branch name, recorded by the saga once git answers.
     * Absent on markers whose saga never reached the commit block.
     */
    branchName: z.string().min(1).optional(),
    cleanup: SessionForkOperationCleanupSchema,
  })
  .strict();

const SameWorktreeForkOperationMarkerSchema = z
  .object({
    kind: z.literal('same-worktree'),
    version: z.literal(SESSION_FORK_OPERATION_MARKER_VERSION),
    workspaceId: z.string().min(1),
    machineId: z.string().min(1),
    targetSessionId: z.string().min(1),
    operationId: z.string().min(1),
    createdAt: z.string().min(1),
    title: z.string().min(1),
    accountProfileId: AccountProfileIdSchema,
  })
  .strict();
const SessionForkOperationMarkerSchema = z.union([
  WorktreeForkOperationMarkerSchema,
  SameWorktreeForkOperationMarkerSchema,
]);

export type SessionForkOperationCleanup = z.infer<typeof SessionForkOperationCleanupSchema>;
export type SessionForkOperationMarker = z.infer<typeof SessionForkOperationMarkerSchema>;
export type SameWorktreeForkOperationMarker = z.infer<typeof SameWorktreeForkOperationMarkerSchema>;

export type SessionForkOperationStore = {
  record(marker: SessionForkOperationMarker): Promise<void>;
  read(
    targetSessionId: SessionId,
    kind?: 'same-worktree'
  ): Promise<SessionForkOperationMarker | null>;
  clear(targetSessionId: SessionId, kind?: 'same-worktree'): Promise<void>;
  list(): Promise<SessionForkOperationMarker[]>;
};

function getStoreRoot(kind?: 'same-worktree'): string {
  return path.join(
    kind === 'same-worktree' ? getLodyDataDir() : path.join(os.homedir(), '.lody'),
    'session-fork-operations'
  );
}

function getMarkerPath(targetSessionId: SessionId, kind?: 'same-worktree'): string {
  const key = createHash('sha256').update(targetSessionId).digest('hex');
  return path.join(getStoreRoot(kind), `${key}.json`);
}

function readMarkerFile(markerPath: string): Promise<SessionForkOperationMarker | null> {
  return readFile(markerPath, 'utf8')
    .then((content) => {
      const parsed = SessionForkOperationMarkerSchema.safeParse(JSON.parse(content) as unknown);
      return parsed.success ? parsed.data : null;
    })
    .catch(() => null);
}

export function createFileSessionForkOperationStore(): SessionForkOperationStore {
  return {
    async record(marker) {
      const markerPath = getMarkerPath(
        marker.targetSessionId as SessionId,
        marker.kind === 'same-worktree' ? marker.kind : undefined
      );
      await mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, markerPath);
    },

    async read(targetSessionId, kind) {
      const marker = await readMarkerFile(getMarkerPath(targetSessionId, kind));
      if (marker && (marker.kind === 'same-worktree') !== (kind === 'same-worktree')) return null;
      return marker;
    },

    async clear(targetSessionId, kind) {
      const marker = await readMarkerFile(getMarkerPath(targetSessionId, kind));
      if (marker && (marker.kind === 'same-worktree') !== (kind === 'same-worktree')) return;
      await rm(getMarkerPath(targetSessionId, kind), { force: true });
    },

    async list() {
      const markers: SessionForkOperationMarker[] = [];
      const legacyRoot = getStoreRoot();
      const installationRoot = getStoreRoot('same-worktree');
      for (const root of new Set([legacyRoot, installationRoot])) {
        const entries = await readdir(root).catch(() => []);
        for (const entry of entries) {
          if (!entry.endsWith('.json')) continue;
          const marker = await readMarkerFile(path.join(root, entry));
          if (
            marker &&
            (marker.kind === 'same-worktree' ? root === installationRoot : root === legacyRoot)
          )
            markers.push(marker);
        }
      }
      return markers;
    },
  };
}

/**
 * Serializes marker read-check-act sequences per fork target within this
 * process (same pattern as `withSessionMarkerLock` for speculative worktrees).
 * Accept, saga finalize, and startup recovery all mutate the same marker/doc
 * pair for a target; the lock plus an under-lock re-read is what keeps a
 * same-target retry from being rolled back as "interrupted".
 */
const forkOperationLocks = new Map<string, Promise<unknown>>();

export async function withForkOperationLock<T>(
  targetSessionId: SessionId,
  fn: () => Promise<T>
): Promise<T> {
  const previous = forkOperationLocks.get(targetSessionId) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  forkOperationLocks.set(targetSessionId, tail);
  try {
    return await run;
  } finally {
    if (forkOperationLocks.get(targetSessionId) === tail) {
      forkOperationLocks.delete(targetSessionId);
    }
  }
}
