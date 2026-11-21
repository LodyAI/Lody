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
      summary: 'Run long commands, register background conditions, and manage Session settings.',
      description: [
        'Register a durable JavaScript condition for a Session (defaults to this Session). Pass sessionId to target another owned Session on this machine. The Host keeps checking after the Agent exits or the daemon restarts.',
        'The lody-automations skill on this MCP server (skill://lody-automations/SKILL.md) documents the workflow, ctx resources, examples and Session settings.',
        'Use list/show/activities to inspect work, cancel to stop it, and settings/configure for built-in Session behavior.',
        'Use `run` for long commands such as builds and test suites: Lody owns the process, so it survives this Session being reclaimed while idle, and its exit resumes the Session with the exit code, log path and output tail. The result arrives as a new turn.',
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
