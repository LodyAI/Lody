import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ScheduleTriggerSchema, type ScheduleCommand } from '@lody/shared';

type Dependencies = { enabled: boolean; execute: (command: ScheduleCommand) => Promise<unknown> };
const id = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-zA-Z0-9_-]+$/);
export function registerScheduleTools(server: McpServer, deps: Dependencies): void {
  if (!deps.enabled) return;
  const call = async (command: ScheduleCommand) => {
    try {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(await deps.execute(command)) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : 'Schedule request failed',
            }),
          },
        ],
      };
    }
  };
  server.registerTool(
    'lody_schedule_list',
    {
      description:
        'List scheduled-task summaries in the current workspace. Use get for details; execution belongs to the owner machine.',
      inputSchema: z
        .object({
          query: z.string().max(200).optional(),
          limit: z.number().int().min(1).max(100).default(30),
          offset: z.number().int().min(0).max(100_000).optional(),
        })
        .strict(),
    },
    (args) => call({ action: 'list', ...args })
  );
  server.registerTool(
    'lody_schedule_get',
    {
      description:
        'Read a Schedule, its prompt, recent configuration activity and next five times. Ordinary Sessions own execution results.',
      inputSchema: z.object({ scheduleId: id }).strict(),
    },
    (args) => call({ action: 'show', ...args })
  );
  server.registerTool(
    'lody_schedule_pause',
    {
      description:
        'Pause a Schedule owned by the authenticated user. Already accepted Sessions continue. Reuse requestId when retrying. Resume requires a human.',
      inputSchema: z.object({ scheduleId: id, requestId: id }).strict(),
    },
    (args) => call({ action: 'pause', ...args })
  );
  server.registerTool(
    'lody_schedule_propose',
    {
      description:
        'Write a durable scheduled-task proposal for human review. Does not create or enable automation. The human chooses the machine, Agent, permission and Project in Schedules before saving. Reuse requestId on retry.',
      inputSchema: z
        .object({
          requestId: id,
          title: z.string().trim().min(1).max(200),
          prompt: z.string().min(1).max(32768),
          trigger: ScheduleTriggerSchema,
        })
        .strict(),
    },
    (args) => call({ action: 'propose', ...args })
  );
}
