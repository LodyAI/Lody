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
      summary: 'Register or manage user-requested background conditions and Session settings.',
      description: [
        'Register a durable JavaScript condition for this Session. The Host keeps checking after the Agent exits or the daemon restarts.',
        'The lody-automations skill on this MCP server (skill://lody-automations/SKILL.md) documents the workflow, ctx resources, examples and Session settings.',
        'Use list/show/activities to inspect work, cancel to stop it, and settings/configure for built-in Session behavior.',
        'Use only for future behavior requested by the user. Agent continuation uses existing Session permissions and queue.',
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
