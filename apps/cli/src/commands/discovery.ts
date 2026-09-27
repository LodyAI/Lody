import { Command } from 'commander';
import type { WorkspaceId } from '@lody/shared';
import { createResourceDiscovery } from '@/lib/resource-discovery-runtime';
import type { DiscoveryResource, DiscoveryRow } from '@/lib/resource-discovery';
import { DiscoveryQuerySchema, type DiscoveryQuery } from '@/lib/discovery-query';
import {
  getAuthContextOrThrow,
  resolveWorkspaceOrThrow,
  withWorkspaceManager,
  runOneShotCommand,
  printJson,
} from '@/lib/command-runtime';
import { getCliPlatformKind } from '@/lib/cli-platform';
import { renderTerminalTable } from '@/lib/terminal-table';

export type DiscoveryCommandOptions = {
  workspace?: string;
  machine?: string;
  query?: string;
  limit?: number;
  cursor?: string;
  kind?: 'local' | 'github';
  onlineStatus?: 'online' | 'offline' | 'unknown';
  allPages?: boolean;
  offline?: boolean;
  json?: boolean;
  debug?: boolean;
};

export function addDiscoveryOptions(command: Command): Command {
  return command
    .option('--query <text>', 'Filter by id, name, description or project path')
    .option('--limit <count>', 'Page size (1-100, default 20)', Number)
    .option('--cursor <cursor>', 'Continue the previous page with the same filters')
    .option('--all-pages', 'Read every page');
}

export async function runDiscoveryList(
  resource: DiscoveryResource,
  options: DiscoveryCommandOptions
): Promise<void> {
  await runOneShotCommand('discovery', options, async () => {
    // The legacy workspace runtime is cloud-only. Fail before authentication or cloud I/O.
    if (getCliPlatformKind() === 'local')
      throw new Error(
        'Workspace catalog discovery is unavailable on the local platform. Use local project list without catalog filters.'
      );
    const auth = getAuthContextOrThrow('discovery');
    const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);
    await withWorkspaceManager(auth, workspace, 'discovery', async (manager) => {
      const discovery = await createResourceDiscovery({
        manager,
        auth,
        workspaceId: workspace.id as WorkspaceId,
        offline: options.offline,
      });
      const machineId = options.machine
        ? await discovery.resolveMachine(options.machine)
        : undefined;
      const query: DiscoveryQuery = DiscoveryQuerySchema.parse({
        query: options.query,
        limit: options.limit,
        cursor: options.cursor,
        ...(machineId ? { machineId } : {}),
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.onlineStatus ? { onlineStatus: options.onlineStatus } : {}),
      });
      let page = await discovery.list(resource, query);
      const items: DiscoveryRow[] = [...page.items];
      while (options.allPages && page.nextCursor) {
        page = await discovery.list(resource, { ...query, cursor: page.nextCursor });
        items.push(...page.items);
      }
      const legacyKey = {
        machine: 'machines',
        project: 'projects',
        agent_config: 'agentConfigs',
        agent_role: 'roles',
        mcp: 'servers',
      }[resource];
      if (options.json) printJson({ ...page, items, [legacyKey]: items });
      else {
        console.log(
          renderTerminalTable(
            [
              { header: 'ID' },
              { header: 'Name' },
              { header: 'Machine / Kind' },
              { header: 'Availability' },
            ],
            items.map((row) => [
              row.id,
              row.name,
              row.machineId ?? String(row.kind ?? row.transport ?? '-'),
              row.availability?.reason ?? row.availability?.state ?? '-',
            ])
          )
        );
        if (page.nextCursor) console.log(`Next page: --cursor ${page.nextCursor}`);
      }
    });
  });
}

export function discoveryListCommand(resource: DiscoveryResource): Command {
  const command = addDiscoveryOptions(
    new Command('list')
      .description(`List readable ${resource} resources`)
      .option('--workspace <selector>', 'Workspace id, slug or name')
      .option('--offline', 'Read cached catalogs; authorization still requires connectivity')
      .option('--json', 'Print JSON')
      .option('--debug', 'Enable debug output')
  );
  if (['project', 'agent_config', 'agent_role'].includes(resource))
    command.option('--machine <selector>', 'Machine id or name');
  if (resource === 'project') command.option('--kind <kind>', 'local or github');
  if (resource === 'machine')
    command.option('--online-status <state>', 'online, offline or unknown');
  return command.action((options: DiscoveryCommandOptions) => runDiscoveryList(resource, options));
}

export function discoveryGetCommand(resource: 'agent_config' | 'agent_role'): Command {
  return new Command('get')
    .description(`Read one ${resource} by stable id`)
    .argument('<id>')
    .option('--workspace <selector>', 'Workspace id, slug or name')
    .option('--json', 'Print JSON')
    .option('--offline', 'Read cached catalogs; authorization still requires connectivity')
    .action(async (id: string, options: DiscoveryCommandOptions) =>
      runOneShotCommand('discovery', options, async () => {
        if (getCliPlatformKind() === 'local')
          throw new Error('Workspace catalog discovery is unavailable on the local platform.');
        const auth = getAuthContextOrThrow('discovery');
        const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);
        await withWorkspaceManager(auth, workspace, 'discovery', async (manager) => {
          const discovery = await createResourceDiscovery({
            manager,
            auth,
            workspaceId: workspace.id as WorkspaceId,
            offline: options.offline,
          });
          printJson(await discovery.get(resource, id));
        });
      })
    );
}

export const agentRoleCommand = new Command('agent-role')
  .description('Inspect Agent Roles')
  .addCommand(discoveryListCommand('agent_role'))
  .addCommand(discoveryGetCommand('agent_role'));
