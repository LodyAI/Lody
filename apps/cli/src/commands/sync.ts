import { Command } from 'commander';
import {
  getMachineFlockDocId,
  getTaskIndexFlockDocId,
  getTaskRoomId,
  getScheduleRoomId,
  getScheduleRegistryFlockDocId,
  isMachineDocRoomId,
  type MachineMeta,
  type TaskId,
  type WorkspaceId,
} from '@lody/shared';
import { listWorkspaceTaskIds } from '@/lib/task-doc';
import { listWorkspaceScheduleIds } from '@/lib/schedules/schedule-documents';
import {
  getAuthContextOrThrow,
  listAliveDocMetas,
  listAliveRoomIds,
  printJson,
  resolveStructuredOutputMode,
  resolveWorkspaceOrThrow,
  runOneShotCommand,
  withWorkspaceManager,
  type AuthContext,
  type CommonCommandOptions,
} from '@/lib/command-runtime';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { mapWithConcurrency } from '@/lib/session-export/concurrency';
import { formatErrorMessage } from '@/utils/format-error';
import { listWorkspacesForToken, type WorkspaceSummary } from '@/lib/workspace';

type SyncOptions = CommonCommandOptions & {
  allWorkspace?: boolean;
  concurrency?: number;
};

export type WorkspaceSyncKind = 'meta' | 'doc' | 'flock';

export type WorkspaceSyncProgressEvent = {
  type: 'progress';
  workspaceId: string;
  kind: WorkspaceSyncKind;
  id: string;
  total: number;
  completed: number;
  failed: number;
  remaining: number;
  ok: boolean;
  error?: string;
};

export type WorkspaceSyncFailure = {
  workspaceId: string;
  kind: WorkspaceSyncKind;
  id: string;
  error: string;
};

export type WorkspaceSyncSummary = {
  workspaceId: string;
  totals: Record<WorkspaceSyncKind, number>;
  completed: Record<WorkspaceSyncKind, number>;
  failed: Record<WorkspaceSyncKind, number>;
  failures: WorkspaceSyncFailure[];
};

export type SyncSummary = {
  ok: boolean;
  workspaces: WorkspaceSyncSummary[];
  total: number;
  completed: number;
  failed: number;
  failures: WorkspaceSyncFailure[];
};

const DEFAULT_SYNC_CONCURRENCY = 4;

function parsePositiveIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  return parsed;
}

export function createWorkspaceSummary(workspaceId: string): WorkspaceSyncSummary {
  return {
    workspaceId,
    totals: { meta: 0, doc: 0, flock: 0 },
    completed: { meta: 0, doc: 0, flock: 0 },
    failed: { meta: 0, doc: 0, flock: 0 },
    failures: [],
  };
}

export function mergeSummaries(workspaces: WorkspaceSyncSummary[]): SyncSummary {
  const failures = workspaces.flatMap((workspace) => workspace.failures);
  let total = 0;
  let completed = 0;
  let failed = 0;
  for (const workspace of workspaces) {
    for (const kind of ['meta', 'doc', 'flock'] satisfies WorkspaceSyncKind[]) {
      total += workspace.totals[kind];
      completed += workspace.completed[kind];
      failed += workspace.failed[kind];
    }
  }
  return {
    ok: failures.length === 0,
    workspaces,
    total,
    completed,
    failed,
    failures,
  };
}

function buildProgressEvent(input: {
  workspaceId: string;
  kind: WorkspaceSyncKind;
  id: string;
  total: number;
  completed: number;
  failed: number;
  ok: boolean;
  error?: string;
}): WorkspaceSyncProgressEvent {
  return {
    type: 'progress',
    workspaceId: input.workspaceId,
    kind: input.kind,
    id: input.id,
    total: input.total,
    completed: input.completed,
    failed: input.failed,
    remaining: Math.max(0, input.total - input.completed - input.failed),
    ok: input.ok,
    ...(input.error ? { error: input.error } : {}),
  };
}

function printHumanProgress(event: WorkspaceSyncProgressEvent): void {
  const status = event.ok ? 'synced' : 'failed';
  const failedText = event.failed > 0 ? `, failed ${event.failed}` : '';
  console.log(
    `[${event.workspaceId}] ${event.kind} ${event.id}: ${status} (${event.completed}/${event.total}${failedText})`
  );
  if (event.error) {
    console.log(`  ${event.error}`);
  }
}

function emitProgress(
  event: WorkspaceSyncProgressEvent,
  outputMode: 'human' | 'json' | 'jsonl'
): void {
  if (outputMode === 'jsonl') {
    printJson(event);
    return;
  }
  if (outputMode === 'human') {
    printHumanProgress(event);
  }
}

function recordSyncResult(args: {
  summary: WorkspaceSyncSummary;
  kind: WorkspaceSyncKind;
  id: string;
  ok: boolean;
  error?: string;
  outputMode: 'human' | 'json' | 'jsonl';
}): void {
  if (args.ok) {
    args.summary.completed[args.kind] += 1;
  } else {
    args.summary.failed[args.kind] += 1;
    args.summary.failures.push({
      workspaceId: args.summary.workspaceId,
      kind: args.kind,
      id: args.id,
      error: args.error ?? 'Sync failed.',
    });
  }

  emitProgress(
    buildProgressEvent({
      workspaceId: args.summary.workspaceId,
      kind: args.kind,
      id: args.id,
      total: args.summary.totals[args.kind],
      completed: args.summary.completed[args.kind],
      failed: args.summary.failed[args.kind],
      ok: args.ok,
      error: args.error,
    }),
    args.outputMode
  );
}

export async function syncItems(input: {
  summary: WorkspaceSyncSummary;
  kind: WorkspaceSyncKind;
  ids: string[];
  concurrency: number;
  outputMode: 'human' | 'json' | 'jsonl';
  syncOne: (id: string) => Promise<void>;
}): Promise<void> {
  input.summary.totals[input.kind] = input.ids.length;
  await mapWithConcurrency(input.ids, input.concurrency, async (id) => {
    try {
      await input.syncOne(id);
      recordSyncResult({
        summary: input.summary,
        kind: input.kind,
        id,
        ok: true,
        outputMode: input.outputMode,
      });
    } catch (error) {
      recordSyncResult({
        summary: input.summary,
        kind: input.kind,
        id,
        ok: false,
        error: formatErrorMessage(error),
        outputMode: input.outputMode,
      });
    }
  });
}

/**
 * Flock documents `lody sync` pulls: one per machine, plus the workspace task
 * index.
 *
 * Both halves of a task are pulled explicitly: the index here, and the task rooms
 * in the doc sweep. Neither comes for free — task rooms are absent from workspace
 * meta, so the meta-driven room scan never lists them, and the index is a Flock
 * doc that the room sweep does not cover. Code Collab file-index Flocks stay
 * excluded by design.
 */
async function listSyncableFlockDocIds(
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId
): Promise<string[]> {
  const machines = await listAliveDocMetas<MachineMeta>(manager, isMachineDocRoomId);
  return [
    ...machines.map((entry) => getMachineFlockDocId(workspaceId, entry.meta.id)),
    getTaskIndexFlockDocId(workspaceId),
    getScheduleRegistryFlockDocId(workspaceId),
  ].sort((left, right) => left.localeCompare(right));
}

/**
 * Documents `lody sync` pulls.
 *
 * Task rooms normally come from loro-repo's `e/<docId>` existence index. The
 * Task Index remains a compatibility and repair source for older or interrupted
 * writes, so merge both enumerations without syncing a room twice.
 */
export function buildSyncDocIds(
  aliveRoomIds: readonly string[],
  taskIds: readonly TaskId[],
  scheduleIds: readonly string[] = []
): string[] {
  return [
    ...new Set([
      ...aliveRoomIds,
      ...taskIds.map((taskId) => getTaskRoomId(taskId)),
      ...scheduleIds.map(getScheduleRoomId),
    ]),
  ].sort((left, right) => left.localeCompare(right));
}

async function syncWorkspace(input: {
  auth: AuthContext;
  workspace: WorkspaceSummary;
  concurrency: number;
  outputMode: 'human' | 'json' | 'jsonl';
}): Promise<WorkspaceSyncSummary> {
  const workspaceId = input.workspace.id as WorkspaceId;
  const summary = createWorkspaceSummary(input.workspace.id);

  await withWorkspaceManager(input.auth, input.workspace, 'sync', async (manager) => {
    summary.totals.meta = 1;
    try {
      await manager.syncMetaOrThrow({ reason: `sync:${workspaceId}:meta` });
      recordSyncResult({
        summary,
        kind: 'meta',
        id: 'meta',
        ok: true,
        outputMode: input.outputMode,
      });
    } catch (error) {
      recordSyncResult({
        summary,
        kind: 'meta',
        id: 'meta',
        ok: false,
        error: formatErrorMessage(error),
        outputMode: input.outputMode,
      });
      return;
    }

    const taskIds = await listWorkspaceTaskIds(manager, workspaceId).catch(() => []);
    await manager.syncFlockDocOrThrow(getScheduleRegistryFlockDocId(workspaceId), {
      reason: 'sync:schedules:registry',
    });
    const scheduleIds = await listWorkspaceScheduleIds(manager, workspaceId);
    const docIds = buildSyncDocIds(
      await listAliveRoomIds(manager, () => true),
      taskIds,
      scheduleIds
    );
    const flockDocIds = await listSyncableFlockDocIds(manager, workspaceId);

    await syncItems({
      summary,
      kind: 'doc',
      ids: docIds,
      concurrency: input.concurrency,
      outputMode: input.outputMode,
      syncOne: async (id) => {
        await manager.syncDocOrThrow(id, { reason: `sync:${workspaceId}:doc:${id}` });
      },
    });
    await syncItems({
      summary,
      kind: 'flock',
      ids: flockDocIds,
      concurrency: input.concurrency,
      outputMode: input.outputMode,
      syncOne: async (id) => {
        await manager.syncFlockDocOrThrow(id, { reason: `sync:${workspaceId}:flock:${id}` });
      },
    });
  });

  return summary;
}

function printHumanSummary(summary: SyncSummary): void {
  console.log(
    `Finished sync: ${summary.completed}/${summary.total} item(s) synced, ${summary.failed} failed.`
  );
  if (summary.failures.length > 0) {
    console.log('Failures:');
    for (const failure of summary.failures) {
      console.log(`- [${failure.workspaceId}] ${failure.kind} ${failure.id}: ${failure.error}`);
    }
  }
}

function createAlreadyPrintedError(): Error {
  return Object.assign(new Error('Sync completed with failures.'), {
    suppressCommandErrorOutput: true,
    exitCode: 1,
  });
}

export const syncCommand = new Command('sync')
  .description('Sync workspace Loro data to the local cache')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--all-workspace', 'Sync all accessible workspaces')
  .option(
    '--concurrency <count>',
    'Maximum number of documents to sync concurrently',
    parsePositiveIntOption,
    DEFAULT_SYNC_CONCURRENCY
  )
  .option('--json', 'Print final JSON summary')
  .option('--jsonl', 'Print JSON Lines progress events and final summary')
  .option('--debug', 'Enable debug output')
  .action(async (options: SyncOptions) => {
    await runOneShotCommand('sync', options, async () => {
      const outputMode = resolveStructuredOutputMode(options);
      const auth = getAuthContextOrThrow('sync');
      if (options.allWorkspace && options.workspace) {
        throw new Error('Pass either --workspace or --all-workspace, not both.');
      }

      const workspaces = options.allWorkspace
        ? await listWorkspacesForToken(auth.token)
        : [await resolveWorkspaceOrThrow(auth, options.workspace)];
      const workspaceSummaries: WorkspaceSyncSummary[] = [];
      for (const workspace of workspaces) {
        workspaceSummaries.push(
          await syncWorkspace({
            auth,
            workspace,
            concurrency: options.concurrency ?? DEFAULT_SYNC_CONCURRENCY,
            outputMode,
          })
        );
      }

      const summary = mergeSummaries(workspaceSummaries);
      if (outputMode === 'jsonl') {
        printJson({ type: 'summary', ...summary });
      } else if (outputMode === 'json') {
        printJson(summary);
      } else {
        printHumanSummary(summary);
      }

      if (!summary.ok) {
        throw createAlreadyPrintedError();
      }
    });
  });
