import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import {
  AgentRoleProposalCommandSchema,
  SessionToolResultSchema,
  type SessionId,
} from '@lody/shared';
import { makeLocalControlClientAuto } from '@lody/shared/node/local-ipc';
import { makeLocalWorkspaceCatalog } from '@/lib/local-workspace-catalog';
import { getCliPlatformKind } from '@/lib/cli-platform';
import {
  classifyLocalDaemonIpcError,
  getAuthContextOrThrow,
  resolveWorkspaceOrThrow,
  printJson,
  runOneShotCommand,
} from '@/lib/command-runtime';

type Options = {
  file?: string;
  name?: string;
  description?: string;
  promptPrefix?: string;
  machineId?: string;
  agentConfigId?: string;
  session?: string;
  workspace?: string;
  requestId?: string;
  json?: boolean;
  debug?: boolean;
};

export function agentRoleWriteCommand(action: 'create' | 'update'): Command {
  const command = new Command(action)
    .description(`Propose an Agent Role ${action}; save the review card in Lody to apply it`)
    .option(
      '--file <path>',
      action === 'create'
        ? 'JSON: name, description, promptPrefix, machineId, agentConfigId'
        : 'JSON patch: name, description, promptPrefix; empty strings clear optional fields'
    )
    .option('--name <name>', 'Role name')
    .option('--description <text>', 'Role description; empty string clears it')
    .option('--prompt-prefix <text>', 'Role instructions; empty string clears them')
    .option('--session <id>', 'Conversation for the proposal (defaults to LODY_SESSION_ID)')
    .option('-w, --workspace <selector>', 'Workspace id or slug')
    .option('--request-id <id>', 'Reuse this id when retrying')
    .option('--json', 'Output JSON')
    .option('--debug', 'Debug logging');
  if (action === 'create') {
    command
      .option('--machine-id <id>', 'Machine hosting the Agent config')
      .option('--agent-config-id <id>', 'Agent config to bind');
  } else {
    command.argument('<role-id>');
  }
  command.action(async (...values: unknown[]) => {
    const options = values[action === 'update' ? 1 : 0] as Options;
    await runOneShotCommand('agent-role', options, async () => {
      const sessionId = options.session?.trim() || process.env.LODY_SESSION_ID?.trim();
      if (!sessionId)
        throw new Error(
          'Pass --session or set LODY_SESSION_ID; a proposal needs an active conversation'
        );
      const fields = Object.fromEntries(
        (['name', 'description', 'promptPrefix', 'machineId', 'agentConfigId'] as const)
          .filter((key) => options[key] !== undefined)
          .map((key) => [key, options[key]])
      );
      if (options.file !== undefined && Object.keys(fields).length > 0)
        throw new Error('Use either --file or direct Role field options, not both');
      const data: unknown =
        options.file !== undefined ? JSON.parse(await readFile(options.file, 'utf8')) : fields;
      const requestId = options.requestId ?? randomUUID();
      const input = AgentRoleProposalCommandSchema.parse(
        action === 'create'
          ? { ...(typeof data === 'object' && data !== null ? data : {}), action, requestId }
          : { action, requestId, roleId: values[0], patch: data }
      );
      const { action: _, ...args } = input;
      const name = `lody_agent_role_${action}`;
      let machineId: string;
      let workspaceId: string;
      if (getCliPlatformKind() === 'local') {
        const catalog = await Effect.runPromise(makeLocalWorkspaceCatalog().read());
        const selector = options.workspace ?? process.env.LODY_WORKSPACE_ID;
        const candidates = catalog.workspaces.filter(
          (row) =>
            row.state === 'active' &&
            (!selector || [row.workspaceId, row.slug, row.name].includes(selector))
        );
        const workspace = candidates.length === 1 ? candidates[0] : undefined;
        if (!workspace || !catalog.machine)
          throw new Error('Choose an active workspace with --workspace; start the daemon first');
        machineId = catalog.machine.machineId;
        workspaceId = workspace.workspaceId;
      } else {
        const auth = getAuthContextOrThrow('agent-role');
        const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);
        machineId = auth.machineId;
        workspaceId = workspace.id;
      }
      const response = await Effect.runPromise(
        makeLocalControlClientAuto()
          .machineRpc({
            method: 'session/call-tool',
            machineId,
            workspaceId,
            ownerSessionId: sessionId,
            params: { sessionId: sessionId as SessionId, name, arguments: args },
          })
          .pipe(Effect.result)
      );
      if (response._tag === 'Failure') throw classifyLocalDaemonIpcError(response.failure);
      if (!response.success.ok) throw new Error(response.success.error);
      const result = SessionToolResultSchema.parse(response.success.result);
      if (result.isError)
        throw new Error(
          result.content
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join('\n')
        );
      const text = result.content.find((item) => item.type === 'text');
      printJson({ requestId, ...(text?.type === 'text' ? JSON.parse(text.text) : {}) });
    });
  });
  return command;
}
