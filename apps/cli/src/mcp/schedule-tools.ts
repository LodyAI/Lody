import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  ScheduleProposalDestinationSchema,
  ScheduleProposalRuleSchema,
  ScheduleProposalTargetSchema,
  type ScheduleCommand,
} from '@lody/shared';

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
      description: [
        'Propose a scheduled task from what the user described. This writes a card into the',
        'current chat with a Create button; the user creates the schedule by pressing it — do not',
        'promise it is scheduled until they do. Never call this while the description is still',
        'vague: before proposing you must know (1) what the agent should do on each run, written',
        'as the full prompt it will receive with no reference to this conversation, (2) when —',
        'one of the named rules below, or manual for run-on-demand, and (3) optionally where the',
        'result goes. If any of these is missing or ambiguous, ask the user a short question',
        'instead of guessing. Rule shapes: manual; minutes {every}; hours {every}; daily /',
        'weekdays {hour, minute}; weekly {weekdays: 0-6 with 0=Sunday, hour, minute}; monthly',
        '{days: 1-31, hour, minute}; once {at: RFC3339}. Times are in the user’s own time zone',
        'unless they named one. The Agent, permission mode, machine and project default to this',
        'conversation’s; set `target` only when the user explicitly named a different Agent Role,',
        'Agent, machine or project (resolve names to ids with lody_session_create_options).',
        'Destination: new_session (a fresh chat per run, default), own_session (one chat this task',
        'keeps continuing), or existing_session {sessionId}. Reuse requestId when retrying.',
      ].join(' '),
      inputSchema: z
        .object({
          requestId: id,
          title: z.string().trim().min(1).max(200),
          prompt: z.string().min(1).max(32768),
          rule: ScheduleProposalRuleSchema,
          destination: ScheduleProposalDestinationSchema.optional(),
          target: ScheduleProposalTargetSchema.optional(),
        })
        .strict(),
    },
    (args) => call({ action: 'propose', ...args })
  );
}
