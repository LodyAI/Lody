import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  actionToolInputSchema,
  defineToolAction,
  runToolAction,
  type LodyToolAction,
  type LodyToolServer,
} from './tool-help';
import { z } from 'zod';
import {
  ScheduleProposalDestinationSchema,
  ScheduleProposalRuleSchema,
  ScheduleProposalTargetSchema,
  type ScheduleCommand,
} from '@lody/shared';

type Dependencies = { execute: (command: ScheduleCommand) => Promise<unknown> };
const id = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-zA-Z0-9_-]+$/);

// The HTTP host creates a server per request. Share only immutable schemas;
// each registration below still binds that server's own dependencies.
const listInputSchema = z
  .object({
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();
const getInputSchema = z.object({ scheduleId: id }).strict();
/** Read one by scheduleId or list a page; each mode keeps its own bounds and defaults. */
const scheduleReadInputSchema = z
  .object({
    scheduleId: id.optional().describe('Read one Schedule.'),
    query: listInputSchema.shape.query,
    // Absence must survive to get-mode validation, which rejects list fields.
    limit: listInputSchema.shape.limit.unwrap().optional(),
    offset: listInputSchema.shape.offset,
  })
  .strict()
  .superRefine((value, ctx) => {
    const parsed = (value.scheduleId === undefined ? listInputSchema : getInputSchema).safeParse(
      value
    );
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  });
const pauseInputSchema = z.object({ scheduleId: id, requestId: id }).strict();
const proposeInputSchema = z
  .object({
    requestId: id,
    title: z.string().trim().min(1).max(200),
    prompt: z.string().min(1).max(32768),
    rule: ScheduleProposalRuleSchema,
    destination: ScheduleProposalDestinationSchema.optional(),
    target: ScheduleProposalTargetSchema.optional(),
  })
  .strict();

const scheduleCall =
  (deps: Dependencies) =>
  async (command: ScheduleCommand): Promise<CallToolResult> => {
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

/** The read-only `schedules` action of `lody_catalog`: list, or one Schedule by id. */
export function scheduleCatalogAction(deps: Dependencies): LodyToolAction {
  const call = scheduleCall(deps);
  return defineToolAction({
    summary: 'Scheduled tasks in this workspace, or one Schedule with its upcoming run times.',
    description:
      'Without scheduleId: list scheduled-task summaries in the current workspace (query, limit default 30, offset); execution belongs to the owner machine. With scheduleId alone: read a Schedule, its prompt, recent configuration activity and next five times. Ordinary Sessions own execution results.',
    inputSchema: scheduleReadInputSchema,
    run: (args) =>
      args.scheduleId === undefined
        ? call({ action: 'list', ...listInputSchema.parse(args) })
        : call({ action: 'show', ...getInputSchema.parse(args) }),
  });
}

export const SCHEDULE_TOOL_NAME = 'lody_schedule';

/** `lody_schedule` changes Schedules; reads are the read-only `lody_catalog` `schedules` action. */
export function registerScheduleTool(server: LodyToolServer, deps: Dependencies): void {
  const call = scheduleCall(deps);
  const actions = {
    propose: defineToolAction({
      summary:
        'Propose scheduled work for user confirmation; it is created only when the user clicks Create.',
      description: [
        'Propose a scheduled task from what the user described. This writes a card into the',
        'current chat with a Create button; the user creates the schedule by pressing it — do not',
        'promise it is scheduled until they do. Never call this while the description is still',
        'vague: before proposing you must know (1) what the agent should do on each run, written',
        'as the full prompt it will receive with no reference to this conversation, (2) when —',
        'one of the named rules below, or manual for run-on-demand, and (3) optionally where the',
        'result goes. If any of these is missing or ambiguous, ask the user a short question',
        'instead of guessing. Rule shapes: manual; minutes {every}; hours {every} (any whole number up to 2147483647);',
        'a step that divides the hour (minutes) or the day (hours) runs on the clock (every 15',
        'minutes = :00 :15 :30 :45), any other step runs every N from when the user clicks',
        'Create, so express whole hours as hours; daily /',
        'weekdays {hour, minute}; weekly {weekdays: 0-6 with 0=Sunday, hour, minute}; monthly',
        '{days: 1-31, hour, minute}; once {at: RFC3339}. Times are in the user’s own time zone',
        'unless they named one. The Agent, permission mode, machine and project default to this',
        'conversation’s; set `target` only when the user explicitly named a different Agent Role,',
        'Agent, machine or project (resolve names to ids with lody_session_create_options).',
        'Destination: new_session (a fresh chat per run, default), own_session (one chat this task',
        'keeps continuing), or existing_session {sessionId}. Reuse requestId when retrying.',
      ].join(' '),
      inputSchema: proposeInputSchema,
      run: (args) => call({ action: 'propose', ...args }),
    }),
    pause: defineToolAction({
      summary: 'Pause future runs of one owned Schedule; already accepted Sessions continue.',
      description:
        'Pause a Schedule owned by the authenticated user. Already accepted Sessions continue. Reuse requestId when retrying. Resume requires a human.',
      inputSchema: pauseInputSchema,
      run: (args) => call({ action: 'pause', ...args }),
    }),
  };
  server.registerTool(
    SCHEDULE_TOOL_NAME,
    {
      summary:
        'Propose scheduled work for user confirmation, or pause an owned Schedule. Read Schedules with lody_catalog.',
      title: 'Change Lody Schedules',
      description:
        'Actions: propose (writes a confirmation card; nothing is scheduled until the user clicks Create) and pause. Read Schedules with lody_catalog action schedules.',
      inputSchema: actionToolInputSchema(actions, 'propose or pause.'),
      actions,
    },
    (input) => runToolAction(actions, input)
  );
}
