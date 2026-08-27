import {
  deleteMachineFlockRowFromFlock,
  getMachineFlockDocId,
  getMachineFlockLocalProjects,
  getMachineRoomId,
  getServerNow,
  machineFlockKeys,
  readMachineFlockRowsFromFlock,
  type LocalProjectId,
  type LocalProjectMeta,
  type MachineDeleteLocalProjectCommand,
  type MachineId,
  type SessionMeta,
  type WorkspaceId,
  writeMachineFlockRowToFlock,
} from '@lody/shared';
import type { MachineLegacyMetaFields } from '@lody/shared';
import type { LoroRepo } from 'loro-repo';

import { readTimeoutEnv, withTimeout } from './loro/timeout-utils';

export type MachineFlockSyncScheduler = {
  markMachineFlockDocDirty: (machineId: MachineId, options?: { reason?: string }) => void;
};

export function shouldApplyMachineDeleteLocalProjectCommand(
  project: Pick<LocalProjectMeta, 'createdAtMs'>,
  command: Pick<MachineDeleteLocalProjectCommand, 'requestedAt'>
): boolean {
  return project.createdAtMs <= command.requestedAt;
}

export function shouldArchiveSessionForLocalProjectRemoval(
  session: Pick<SessionMeta, 'isArchived' | 'machineId' | 'project'>,
  target: { machineId: MachineId; localProjectId: LocalProjectId }
): boolean {
  return (
    session.isArchived !== true &&
    session.machineId === target.machineId &&
    session.project?.kind === 'local' &&
    session.project.localProjectId === target.localProjectId
  );
}

function readLegacyMachineLocalProjects(
  machineMeta: MachineLegacyMetaFields | undefined
): Record<LocalProjectId, LocalProjectMeta> {
  const localProjects = machineMeta?.localProjects;
  if (!localProjects || typeof localProjects !== 'object') {
    return {};
  }
  return localProjects;
}

export async function readMachineLocalProjects(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  machineId: MachineId
): Promise<Record<LocalProjectId, LocalProjectMeta>> {
  const machineRoomId = getMachineRoomId(machineId);
  const [machineMetaDoc, flockHandle] = await Promise.all([
    repo.getDocMeta(machineRoomId),
    repo.openFlockDoc(getMachineFlockDocId(workspaceId, machineId)),
  ]);
  const legacyLocalProjects = readLegacyMachineLocalProjects(
    machineMetaDoc?.meta as MachineLegacyMetaFields | undefined
  );
  const flockLocalProjects = getMachineFlockLocalProjects(
    readMachineFlockRowsFromFlock(flockHandle.flock, { families: ['localProject'] })
  );
  return {
    ...legacyLocalProjects,
    ...flockLocalProjects,
  };
}

export async function upsertMachineLocalProject(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  machineId: MachineId,
  project: LocalProjectMeta,
  nowMs = getServerNow(),
  options: { sync?: MachineFlockSyncScheduler; reason?: string } = {}
): Promise<void> {
  const handle = await repo.openFlockDoc(getMachineFlockDocId(workspaceId, machineId));
  const changed = writeMachineFlockRowToFlock(
    handle.flock,
    {
      key: machineFlockKeys.localProject(project.id),
      value: project,
    },
    nowMs
  );
  if (!changed) {
    return;
  }
  await repo.flush();
  if (options.sync) {
    options.sync.markMachineFlockDocDirty(machineId, {
      reason: options.reason ?? 'local-project-upsert',
    });
  } else {
    await handle.syncOnce().catch(() => undefined);
  }
}

export async function removeMachineLocalProject(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  machineId: MachineId,
  localProjectId: LocalProjectId,
  nowMs = getServerNow(),
  options: { sync?: MachineFlockSyncScheduler; reason?: string } = {}
): Promise<void> {
  const handle = await repo.openFlockDoc(getMachineFlockDocId(workspaceId, machineId));
  const changed = deleteMachineFlockRowFromFlock(
    handle.flock,
    machineFlockKeys.localProject(localProjectId),
    nowMs
  );
  if (changed) {
    await repo.flush();
    if (options.sync) {
      options.sync.markMachineFlockDocDirty(machineId, {
        reason: options.reason ?? 'local-project-remove',
      });
    } else {
      await handle.syncOnce().catch(() => undefined);
    }
  }

  const machineRoomId = getMachineRoomId(machineId);
  const current = await repo.getDocMeta(machineRoomId);
  const legacyLocalProjects = readLegacyMachineLocalProjects(
    current?.meta as MachineLegacyMetaFields | undefined
  );
  if (!(localProjectId in legacyLocalProjects)) {
    return;
  }
  await repo.upsertDocMeta(machineRoomId, {
    localProjects: undefined,
  } as Parameters<LoroRepo['upsertDocMeta']>[1]);
}

export async function resolveWorkspaceLocalProjectRootPath(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  machineId: MachineId,
  localProjectId: LocalProjectId
): Promise<string | null> {
  const localProject = await resolveWorkspaceLocalProject(
    repo,
    workspaceId,
    machineId,
    localProjectId
  );
  const rootPath = localProject?.rootPath;
  if (typeof rootPath !== 'string') {
    return null;
  }
  const trimmed = rootPath.trim();
  return trimmed || null;
}

export async function resolveWorkspaceLocalProject(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  machineId: MachineId,
  localProjectId: LocalProjectId
): Promise<LocalProjectMeta | null> {
  const localProjects = await readMachineLocalProjects(repo, workspaceId, machineId);
  return localProjects[localProjectId] ?? null;
}

export type ResolveLocalProjectRootPathRetryOptions = {
  /**
   * Machine Flock pull, awaited (bounded by `syncTimeoutMs`) after each miss so
   * a row that only exists remotely (e.g. a session dispatch that lands before
   * the first Flock sync after a cold start) can arrive. Rejections and
   * timeouts are swallowed — the next read is the verdict.
   *
   * Note this is not state-free: the coordinator's `syncNow` dedupes onto any
   * in-flight sync, and a failed attempt marks the coordinator dirty and arms
   * its own retry loop. For a machine that is a pure flock reader that dirty
   * flag is load-bearing — it is what keeps the room's rejoin loop alive.
   */
  requestSync?: () => Promise<unknown>;
  /** Total reads including the first. Default: LODY_LOCAL_PROJECT_RESOLVE_MAX_ATTEMPTS or 4. */
  maxAttempts?: number;
  /** Wait between attempts. Default: LODY_LOCAL_PROJECT_RESOLVE_RETRY_DELAY_MS or 400. */
  retryDelayMs?: number;
  /**
   * Bound on each `requestSync` await. Needed on the caller side because the
   * coordinator dedupes onto an in-flight sync whose own timeout (default 8s)
   * may be much larger than the turn-dispatch budget. Default:
   * LODY_LOCAL_PROJECT_RESOLVE_SYNC_TIMEOUT_MS or 1500.
   */
  syncTimeoutMs?: number;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Called after each miss, before the sync wait (attempt is 1-based). */
  onRetry?: (attempt: number, maxAttempts: number) => void;
  /** Cancels retry waits without cancelling the coordinator's background sync. */
  signal?: AbortSignal;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

export async function resolveWorkspaceLocalProjectWithSyncOnMiss(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  machineId: MachineId,
  localProjectId: LocalProjectId,
  options: { requestSync?: () => Promise<boolean>; syncTimeoutMs?: number } = {}
): Promise<LocalProjectMeta | null> {
  const existing = await resolveWorkspaceLocalProject(repo, workspaceId, machineId, localProjectId);
  if (existing || !options.requestSync) return existing;
  const syncTimeoutMs =
    options.syncTimeoutMs ?? readTimeoutEnv('LODY_LOCAL_PROJECT_RESOLVE_SYNC_TIMEOUT_MS', 1_500);
  try {
    await withTimeout(
      options.requestSync(),
      syncTimeoutMs,
      `Timeout waiting for machine Flock sync (localProject=${localProjectId})`
    );
  } catch {
    // Project registration is local-first. A cloud pull can reveal an existing
    // row and avoid overwriting its display/history fields, but cloud
    // unavailability must not reject a brand-new local directory. The Machine
    // Flock coordinator owns background retry and eventual convergence.
  }
  return resolveWorkspaceLocalProject(repo, workspaceId, machineId, localProjectId);
}

/**
 * Session create/restore resolves a local project's workdir from the machine
 * Flock doc — synced CRDT state that a single point-in-time read can miss
 * transiently (cold start before the first remote sync, or a row written by a
 * previous process that has not synced down yet). Failing that read kills the
 * user's turn with a durable "session init failed" notice even though the
 * project exists, so miss paths retry briefly instead of giving up at once.
 * The happy path (row already local) still costs exactly one read.
 */
export async function resolveWorkspaceLocalProjectRootPathWithRetry(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  machineId: MachineId,
  localProjectId: LocalProjectId,
  options: ResolveLocalProjectRootPathRetryOptions = {}
): Promise<string | null> {
  const maxAttempts = Math.max(
    1,
    options.maxAttempts ?? readTimeoutEnv('LODY_LOCAL_PROJECT_RESOLVE_MAX_ATTEMPTS', 4)
  );
  const retryDelayMs =
    options.retryDelayMs ?? readTimeoutEnv('LODY_LOCAL_PROJECT_RESOLVE_RETRY_DELAY_MS', 400);
  const syncTimeoutMs =
    options.syncTimeoutMs ?? readTimeoutEnv('LODY_LOCAL_PROJECT_RESOLVE_SYNC_TIMEOUT_MS', 1_500);
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt += 1) {
    options.signal?.throwIfAborted();
    const rootPath = await resolveWorkspaceLocalProjectRootPath(
      repo,
      workspaceId,
      machineId,
      localProjectId
    );
    if (rootPath !== null) {
      return rootPath;
    }
    if (attempt >= maxAttempts) {
      return null;
    }
    options.onRetry?.(attempt, maxAttempts);
    if (options.requestSync) {
      // try/catch (not .catch) so a synchronously-throwing stub is also tolerated.
      try {
        await withAbortSignal(
          withTimeout(
            options.requestSync(),
            syncTimeoutMs,
            `Timeout waiting for machine Flock sync (localProject=${localProjectId})`
          ),
          options.signal
        );
      } catch {
        options.signal?.throwIfAborted();
        // Best-effort pull — the next read is the verdict.
      }
    }
    await withAbortSignal(sleep(retryDelayMs), options.signal);
  }
}
