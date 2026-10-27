import path from 'node:path';
import { Command } from 'commander';
import { getSessionRoomId, type WorkspaceId } from '@lody/shared';
import { getScheduleRegistryFlockDocId, getScheduleRoomId } from '@lody/shared';
import { listWorkspaceScheduleIds } from '@/lib/schedules/schedule-documents';
import {
  getAuthContextOrThrow,
  listAliveSessionMetas,
  resolveWorkspaceOrThrow,
  runOneShotCommand,
  syncDocForRead,
  syncWorkspaceMetaForRead,
  withWorkspaceManager,
  type CommonCommandOptions,
} from '@/lib/command-runtime';
import { exportWorkspaceData } from '@/lib/session-export';
import { mapWithConcurrency } from '@/lib/session-export/concurrency';
import { listWorkspacesForToken, type WorkspaceSummary } from '@/lib/workspace';
import { workspaceSupports } from '@lody/shared/workspace-streams-content';

type ExportOptions = Pick<CommonCommandOptions, 'workspace' | 'debug'> & {
  images?: boolean;
  allWorkspace?: boolean;
  offline?: boolean;
};

const EXPORT_SYNC_CONCURRENCY = 4;

function buildDefaultOutputDir(): string {
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  return path.resolve(process.cwd(), `lody-export-${timestamp}`);
}

function toWorkspaceDirName(workspace: WorkspaceSummary): string {
  const candidate = (workspace.slug?.trim() || workspace.id).trim();
  return candidate.replace(/[\\/]/g, '_');
}

async function syncWorkspaceSessionsForExport(
  manager: Parameters<typeof exportWorkspaceData>[0]['manager'],
  workspace: WorkspaceSummary
): Promise<void> {
  await syncWorkspaceMetaForRead(manager, `export:${workspace.id}:meta`);
  const sessions = await listAliveSessionMetas(manager);
  await mapWithConcurrency(sessions, EXPORT_SYNC_CONCURRENCY, async (entry) => {
    await syncDocForRead(
      manager,
      getSessionRoomId(entry.meta.id),
      `export:${workspace.id}:${entry.meta.id}`
    );
  });

  // This reconciles visible index rows with repo existence, repairing a missing
  // projection row without reviving an explicit index tombstone.
  const workspaceId = workspace.id as WorkspaceId;
  await manager.syncFlockDocOrThrow(getScheduleRegistryFlockDocId(workspaceId), {
    reason: 'export:schedules:registry',
  });
  await mapWithConcurrency(
    await listWorkspaceScheduleIds(manager, workspaceId),
    EXPORT_SYNC_CONCURRENCY,
    async (id) => {
      await syncDocForRead(manager, getScheduleRoomId(id), `export:schedule:${id}`);
    }
  );
}

export const exportCommand = new Command('export')
  .description('Export user-facing workspace session data')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--all-workspace', 'Export all accessible workspaces')
  .option('--no-images', 'Skip downloading image binaries')
  .option('--offline', 'Read the local cache without syncing first')
  .option('--debug', 'Enable debug output')
  .argument('[outputDir]', 'Output directory for export files')
  .action(async (outputDirArg: string | undefined, options: ExportOptions) => {
    await runOneShotCommand('export', options, async () => {
      const auth = getAuthContextOrThrow('export');
      const outputDir = path.resolve(outputDirArg ?? buildDefaultOutputDir());
      if (options.allWorkspace && options.workspace) {
        throw new Error('Pass either --workspace or --all-workspace, not both.');
      }

      const requested = options.allWorkspace
        ? await listWorkspacesForToken(auth.token)
        : [await resolveWorkspaceOrThrow(auth, options.workspace)];
      // A plaintext export of an encrypted workspace is a restricted feature until its
      // E2EE milestone; never decrypt to disk here.
      const exportable = (workspace: WorkspaceSummary) =>
        workspaceSupports(
          { mode: workspace.contentMode === 'e2ee' ? 'protected' : 'plaintext' },
          'export'
        );
      if (!options.allWorkspace && requested.some((workspace) => !exportable(workspace)))
        throw new Error('Export is not available for end-to-end encrypted workspaces.');
      const workspaces = requested.filter(exportable);
      for (const skipped of requested.filter((workspace) => !exportable(workspace)))
        console.log(
          `Skipped end-to-end encrypted workspace ${skipped.name}: export is not available.`
        );

      let totalSessions = 0;
      const warnings: string[] = [];
      for (const workspace of workspaces) {
        const workspaceOutputDir = path.join(outputDir, toWorkspaceDirName(workspace));
        const result = await withWorkspaceManager(auth, workspace, 'export', async (manager) => {
          if (options.offline !== true) {
            await syncWorkspaceSessionsForExport(manager, workspace);
          }
          return await exportWorkspaceData({
            manager,
            workspace,
            cliToken: auth.token,
            outputDir: workspaceOutputDir,
            downloadImages: options.images,
          });
        });
        totalSessions += result.manifest.sessionCount;
        warnings.push(
          ...result.warnings.map((warning) => `[${toWorkspaceDirName(workspace)}] ${warning}`)
        );
        console.log(
          `Exported ${result.manifest.sessionCount} session(s) from ${workspace.name} to ${workspaceOutputDir}`
        );
      }

      console.log(
        `Finished exporting ${totalSessions} session(s) across ${workspaces.length} workspace(s) to ${outputDir}`
      );
      if (warnings.length > 0) {
        console.warn(`Warnings: ${warnings.length}`);
        for (const warning of warnings) {
          console.warn(`- ${warning}`);
        }
      }
    });
  });
