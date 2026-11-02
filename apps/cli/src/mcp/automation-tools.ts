import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { automationCommandSchema, type AutomationCommand } from '@lody/shared/automations';

export function registerAutomationTools(
  server: McpServer,
  execute: (command: AutomationCommand) => Promise<unknown>
): void {
  server.registerTool(
    'lody_automation',
    {
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
