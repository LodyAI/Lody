import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isLoroRepoDocDeleted, type SessionMeta, type WorkspaceId } from '@lody/shared';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { buildSessionArtifacts, toExportSessionSummary } from './formatters';
import { mapWithConcurrency } from './concurrency';
import { downloadSessionAttachment } from './image-downloader';
import { buildTranscriptMarkdown } from './markdown';
import { prepareExportOutputDir } from './output-dir';
import { encodeExportPathSegment, joinExportPath } from './path-utils';
import { fetchWorkspaceUsageBundle } from './workspace-usage';
import {
  buildTaskIndexExportEntry,
  formatTaskMarkdown,
  sortTasksByCreatedAt,
  type TaskIndexExportEntry,
} from './task-export';
import type { ExportManifest, ExportSessionSummary } from './types';
import { listWorkspaceTaskIds, readTask } from '@/lib/task-doc';
import { formatErrorMessage } from '@/utils/format-error';
import { getScheduleRegistryFlockDocId, ScheduleRepository } from '@lody/shared';
import { listWorkspaceScheduleIds } from '../schedules/schedule-documents';

type WorkspaceDescriptor = {
  id: string;
  slug: string | null;
  name: string;
};

export type ExportWorkspaceDataOptions = {
  manager: LoroDocumentManager;
  workspace: WorkspaceDescriptor;
  cliToken: string;
  outputDir: string;
  downloadImages?: boolean;
};

type SessionIndexEntry = ExportSessionSummary & {
  relativePath: string;
};

type RepoWithMetaFlock = {
  metaFlock: {
    exportJson(from: undefined, pruneTombstonesBefore: number): unknown;
  };
};

const SESSION_EXPORT_CONCURRENCY = 4;
const ATTACHMENT_EXPORT_CONCURRENCY = 4;

function sortSessionsByCreatedAt(sessions: SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.id.localeCompare(right.id);
  });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, 'utf8');
}

async function writeRepoMetaJson(manager: LoroDocumentManager, outputDir: string): Promise<void> {
  const meta = (manager.repo as unknown as RepoWithMetaFlock).metaFlock;
  const exported = await Promise.resolve(meta.exportJson(undefined, Date.now()));
  await writeJson(path.join(outputDir, 'meta.json'), exported);
}

async function loadSessionMetas(manager: LoroDocumentManager): Promise<SessionMeta[]> {
  const scanner = manager.repo.getMeta();
  if (!scanner) {
    return [];
  }

  const roomIds = new Set<string>();
  const rows = await scanner.scan({ prefix: ['m'] });
  for (const row of rows) {
    const key = row.key;
    if (!Array.isArray(key) || key.length < 2) {
      continue;
    }
    const roomId = key[1];
    if (typeof roomId === 'string' && roomId.startsWith('session-')) {
      roomIds.add(roomId);
    }
  }

  const metas = await Promise.all(
    [...roomIds].map(async (roomId) => {
      const record = await manager.repo.getDocMeta(roomId);
      if (!record?.meta || isLoroRepoDocDeleted(record)) {
        return null;
      }
      return record.meta as SessionMeta;
    })
  );

  return metas.filter((meta): meta is SessionMeta => meta !== null);
}

async function exportSession(args: {
  manager: LoroDocumentManager;
  workspaceId: WorkspaceId;
  session: SessionMeta;
  cliToken: string;
  outputDir: string;
  downloadImages: boolean;
  warnings: string[];
}): Promise<SessionIndexEntry> {
  const sessionDirName = encodeExportPathSegment(args.session.id, 'session');
  const sessionDir = joinExportPath(args.outputDir, 'sessions', sessionDirName);
  const summary = toExportSessionSummary(args.session, args.workspaceId);
  const history = await args.manager.getSessionHistorySnapshot(args.session.id);
  const artifacts = buildSessionArtifacts(history);

  let attachments = artifacts.attachments;
  if (args.downloadImages) {
    attachments = await mapWithConcurrency(
      attachments,
      ATTACHMENT_EXPORT_CONCURRENCY,
      async (attachment) => {
        const downloaded = await downloadSessionAttachment({
          workspaceId: args.workspaceId,
          sessionId: args.session.id,
          authToken: args.cliToken,
          sessionDir,
          attachment,
        });
        if (downloaded.warning) {
          args.warnings.push(
            `Session ${args.session.id}: failed to download image ${attachment.imageId}: ${downloaded.warning}`
          );
        }
        return downloaded.attachment;
      }
    );
  } else {
    attachments = attachments.map((attachment) => ({
      ...attachment,
      relativePath: null,
    }));
  }

  await writeJson(path.join(sessionDir, 'transcript.json'), {
    session: summary,
    turns: artifacts.transcript,
  });
  await writeText(
    path.join(sessionDir, 'transcript.md'),
    buildTranscriptMarkdown({
      session: summary,
      turns: artifacts.transcript,
      attachments,
    })
  );
  await writeJson(path.join(sessionDir, 'artifacts', 'attachments', 'index.json'), attachments);

  return {
    ...summary,
    relativePath: path.posix.join('sessions', sessionDirName),
  };
}

async function exportTasks(input: {
  manager: LoroDocumentManager;
  workspaceId: WorkspaceId;
  outputDir: string;
  warnings: string[];
}): Promise<TaskIndexExportEntry[]> {
  let taskIds: readonly string[];
  try {
    taskIds = await listWorkspaceTaskIds(input.manager, input.workspaceId);
  } catch (error) {
    // A workspace that never created a task has no index document.
    input.warnings.push(`Task export skipped: ${formatErrorMessage(error)}`);
    return [];
  }

  const snapshots = await mapWithConcurrency(taskIds, SESSION_EXPORT_CONCURRENCY, async (taskId) =>
    readTask(input.manager, taskId as Parameters<typeof readTask>[1]).catch((error: unknown) => {
      input.warnings.push(`Task ${taskId} export failed: ${formatErrorMessage(error)}`);
      return null;
    })
  );

  const index: TaskIndexExportEntry[] = [];
  for (const snapshot of sortTasksByCreatedAt(snapshots.filter((entry) => entry !== null))) {
    const taskDir = path.join(
      input.outputDir,
      'tasks',
      encodeExportPathSegment(snapshot.meta.taskId, 'task')
    );
    await writeJson(path.join(taskDir, 'task.json'), snapshot);
    await writeText(path.join(taskDir, 'task.md'), formatTaskMarkdown(snapshot));
    index.push(buildTaskIndexExportEntry(snapshot));
  }
  return index;
}

export async function exportWorkspaceData(
  options: ExportWorkspaceDataOptions
): Promise<{ manifest: ExportManifest; sessionIndex: SessionIndexEntry[]; warnings: string[] }> {
  const downloadImages = options.downloadImages !== false;
  const warnings: string[] = [];
  await prepareExportOutputDir(options.outputDir);
  await writeRepoMetaJson(options.manager, options.outputDir);

  const allSessions = await loadSessionMetas(options.manager);
  const selectedSessions = sortSessionsByCreatedAt(allSessions);
  const sessionIndex = await mapWithConcurrency(
    selectedSessions,
    SESSION_EXPORT_CONCURRENCY,
    async (session) =>
      exportSession({
        manager: options.manager,
        workspaceId: options.workspace.id as WorkspaceId,
        session,
        cliToken: options.cliToken,
        outputDir: options.outputDir,
        downloadImages,
        warnings,
      })
  );

  await writeJson(path.join(options.outputDir, 'sessions', 'index.json'), sessionIndex);

  const taskIndex = await exportTasks({
    manager: options.manager,
    workspaceId: options.workspace.id as WorkspaceId,
    outputDir: options.outputDir,
    warnings,
  });
  await writeJson(path.join(options.outputDir, 'tasks', 'index.json'), taskIndex);
  const scheduleRepository = new ScheduleRepository(
    options.manager.repo,
    options.workspace.id as WorkspaceId
  );
  const scheduleIds = await listWorkspaceScheduleIds(
    options.manager,
    options.workspace.id as WorkspaceId
  );
  const scheduleIndex: { scheduleId: string; title: string }[] = [];
  for (const id of scheduleIds) {
    const document = await scheduleRepository.read(id);
    if (!document) {
      warnings.push(`Schedule ${id} is unavailable in the local replica.`);
      continue;
    }
    const directory = path.join(
      options.outputDir,
      'schedules',
      encodeExportPathSegment(id, 'schedule')
    );
    await writeJson(path.join(directory, 'schedule.json'), document);
    await writeText(
      path.join(directory, 'schedule.md'),
      `# ${document.definition.title}\n\n${document.prompt}\n`
    );
    scheduleIndex.push({ scheduleId: id, title: document.definition.title });
  }
  await writeJson(path.join(options.outputDir, 'schedules', 'index.json'), scheduleIndex);
  const scheduleRegistry = await options.manager.repo.openFlockDoc(
    getScheduleRegistryFlockDocId(options.workspace.id as WorkspaceId)
  );
  await writeJson(path.join(options.outputDir, 'schedules', 'registry.json'), [
    ...scheduleRegistry.flock.scan(),
  ]);

  let usageExported = false;
  try {
    const usageBundle = await fetchWorkspaceUsageBundle({
      workspaceId: options.workspace.id,
      cliToken: options.cliToken,
    });
    await writeJson(
      path.join(options.outputDir, 'usage', 'workspace-summary.json'),
      usageBundle.summary
    );
    await writeJson(
      path.join(options.outputDir, 'usage', 'workspace-timeline.json'),
      usageBundle.timelines
    );
    usageExported = true;
  } catch (error) {
    warnings.push(`Workspace usage export failed: ${formatErrorMessage(error)}`);
  }

  const manifest: ExportManifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: {
      id: options.workspace.id,
      slug: options.workspace.slug,
      name: options.workspace.name,
    },
    outputDir: options.outputDir,
    sessionCount: sessionIndex.length,
    taskCount: taskIndex.length,
    scheduleCount: scheduleIndex.length,
    usageExported,
  };

  await writeJson(path.join(options.outputDir, 'manifest.json'), manifest);
  return { manifest, sessionIndex, warnings };
}
