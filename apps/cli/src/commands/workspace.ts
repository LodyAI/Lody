import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import { makeLocalControlClientAuto } from '@lody/shared/node/local-ipc';
import { Command } from 'commander';
import {
  getAuthContextOrThrow,
  printJson,
  runOneShotCommand,
  type CommonCommandOptions,
} from '@/lib/command-runtime';
import { renderTerminalTable } from '@/lib/terminal-table';
import { listWorkspacesForToken, type WorkspaceSummary } from '@/lib/workspace';

type WorkspaceListOptions = Pick<CommonCommandOptions, 'json' | 'debug'>;

export function sortWorkspaceSummaries(workspaces: WorkspaceSummary[]): WorkspaceSummary[] {
  return [...workspaces].sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }

    const leftSlug = left.slug?.trim() ?? '';
    const rightSlug = right.slug?.trim() ?? '';
    const slugCompare = leftSlug.localeCompare(rightSlug);
    if (slugCompare !== 0) {
      return slugCompare;
    }

    return left.id.localeCompare(right.id);
  });
}

export const workspaceCommand = new Command('workspace')
  .description('Manage workspaces')
  .addCommand(
    new Command('list')
      .description('List accessible workspaces')
      .option('--json', 'Print JSON output')
      .option('--debug', 'Enable debug output')
      .action(async (options: WorkspaceListOptions) => {
        await runOneShotCommand('workspace', options, async () => {
          const auth = getAuthContextOrThrow('workspace');
          const workspaces = sortWorkspaceSummaries(await listWorkspacesForToken(auth.token));
          if (options.json) {
            printJson({
              ok: true,
              workspaces: workspaces.map((workspace) => ({
                id: workspace.id,
                name: workspace.name,
                slug: workspace.slug,
              })),
            });
            return;
          }

          if (workspaces.length === 0) {
            console.log('No workspaces found.');
            return;
          }

          console.log(
            renderTerminalTable(
              [{ header: 'ID' }, { header: 'Name' }, { header: 'Slug' }],
              workspaces.map((workspace) => [workspace.id, workspace.name, workspace.slug])
            )
          );
        });
      })
  );

workspaceCommand.addCommand(
  new Command('reset-identity')
    .description(
      'Archive this machine identity and require fresh approved pairing for one encrypted workspace'
    )
    .argument('<workspace-id>')
    .requiredOption(
      '--confirm',
      'Confirm archival; another authorized device must approve the new identity'
    )
    .option('--reset-id <uuid>', 'Reuse this ID when retrying an uncertain reset result')
    .option('--json', 'Print JSON output')
    .action(
      async (
        workspaceId: string,
        options: { confirm: boolean; json?: boolean; resetId?: string }
      ) => {
        await runOneShotCommand('workspace-reset-identity', options, async () => {
          if (options.confirm !== true) throw new Error('Explicit --confirm is required');
          const auth = getAuthContextOrThrow('workspace-reset-identity');
          const resetId = options.resetId ?? randomUUID();
          console.error(`Reset ID: ${resetId}. Reuse --reset-id if the reply is lost.`);
          const result = await Effect.runPromise(
            makeLocalControlClientAuto().e2eeReset({
              machineId: auth.machineId,
              accountId: auth.userId,
              workspaceId,
              resetId,
            })
          );
          if (options.json) printJson(result);
          else
            console.log(
              `Old identity archived at ${result.archive ?? '(already empty)'}. Open this workspace in Lody and pair again; another authorized device must approve.`
            );
        });
      }
    )
);
