import { Command } from 'commander';
import type { SessionId, WorkspaceId } from '@lody/shared';
import {
  getAuthContextOrThrow,
  resolveWorkspaceOrThrow,
  runOneShotCommand,
  printJson,
} from '@/lib/command-runtime';
import { getCliPlatformKind } from '@/lib/cli-platform';
import {
  getLodyOperationStorePath,
  LodyOperationStore,
  OperationListQuerySchema,
  runWithOperationStoreBusyRetry,
  type OperationListQuery,
} from '@/orchestration/operation-store';
import { renderTerminalTable } from '@/lib/terminal-table';

type Options = OperationListQuery & {
  workspace?: string;
  session?: string;
  json?: boolean;
  debug?: boolean;
};
export const operationCommand = new Command('operation')
  .description('Inspect Operations on this machine')
  .addCommand(
    new Command('list')
      .description('List Operations owned by a requester Session and the authenticated user')
      .option('--workspace <selector>', 'Workspace id, slug or name')
      .option('--session <id>', 'Requester session id (defaults to LODY_SESSION_ID)')
      .option('--state <state>', 'active or finished')
      .option('--limit <count>', 'Page size (1-100, default 20)', Number)
      .option('--cursor <cursor>', 'Next page cursor')
      .option('--json', 'Print JSON')
      .option('--debug', 'Enable debug output')
      .action(async (options: Options) =>
        runOneShotCommand('operation', options, async () => {
          if (getCliPlatformKind() === 'local')
            throw new Error('Workspace Operation discovery is unavailable on the local platform.');
          const sessionId = options.session?.trim() || process.env.LODY_SESSION_ID?.trim();
          if (!sessionId) throw new Error('Pass --session or set LODY_SESSION_ID.');
          const query = OperationListQuerySchema.parse({
            state: options.state,
            limit: options.limit,
            cursor: options.cursor,
          });
          const auth = getAuthContextOrThrow('operation');
          const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);
          const store = new LodyOperationStore(
            getLodyOperationStorePath(auth.machineId),
            undefined,
            { maintenance: false }
          );
          try {
            const page = await runWithOperationStoreBusyRetry(() =>
              store.listForRequester(
                {
                  workspaceId: workspace.id as WorkspaceId,
                  requesterSessionId: sessionId as SessionId,
                  requesterUserId: auth.userId,
                },
                query
              )
            );
            if (options.json) printJson(page);
            else {
              console.log(
                renderTerminalTable(
                  [{ header: 'ID' }, { header: 'Kind' }, { header: 'State' }, { header: 'Items' }],
                  page.items.map((row) => [row.operationId, row.kind, row.state, row.itemCount])
                )
              );
              if (page.nextCursor) console.log(`Next page: --cursor ${page.nextCursor}`);
            }
          } finally {
            store.close();
          }
        })
      )
  );
