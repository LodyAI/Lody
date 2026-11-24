import type { LodyToolServer } from './tool-help';
import { z } from 'zod';
import { automationCommandSchema, type AutomationCommand } from '@lody/shared/automations';

export function registerAutomationTools(
  server: LodyToolServer,
  execute: (command: AutomationCommand) => Promise<unknown>
): void {
  server.registerTool(
    'lody_automation',
    {
      summary:
        'Run commands beyond the current turn, register background conditions, and manage Session settings.',
      description: [
        'Register a durable JavaScript condition for a Session (defaults to this Session). Pass sessionId to target another owned Session on this machine. The Host keeps checking after the Agent exits or the daemon restarts.',
        'The lody-automations skill on this MCP server (skill://lody-automations/SKILL.md) documents the workflow, ctx resources, examples and Session settings.',
        'Use list/show/activities to inspect work, cancel to stop it, and settings/configure for built-in Session behavior.',
        'Use `run` only when a command must continue after the current turn ends and its exit should resume the Session; ordinary commands, builds and tests stay in the current turn. Lody owns the background process and delivers the exit code, log path and output tail in a new turn.',
        'Register conditions only for future behavior requested by the user. Agent continuation uses existing Session permissions and queue.',
      ].join(' '),
      inputSchema: z.object({ command: automationCommandSchema }).strict(),
    },
    async ({ command }) => {
      try {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(await execute(command)) }],
        };
      } catch (cause) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: cause instanceof Error ? cause.message : 'Automation request failed',
              }),
            },
          ],
        };
      }
    }
  );
}
