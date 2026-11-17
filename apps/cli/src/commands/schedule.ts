import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ScheduleCommandSchema, getDeviceTimeZone } from '@lody/shared';
import { printJson, runOneShotCommand, type CommonCommandOptions } from '@/lib/command-runtime';
import {
  parseScheduleEvery,
  scheduleEveryTrigger,
  scheduleShowTrigger,
  sendScheduleCommand,
} from '@/lib/schedules/schedule-command-client';

type Options = CommonCommandOptions & {
  file?: string;
  requestId?: string;
  query?: string;
  limit?: string;
  offset?: string;
  every?: string;
  timeZone?: string;
};

/** Read the draft file, filling `trigger` from `--every` when given. */
async function readDraft(
  options: Options,
  action: 'create' | 'edit',
  scheduleId: string
): Promise<unknown> {
  const draft: unknown = JSON.parse(await readFile(options.file!, 'utf8'));
  if (options.every === undefined) {
    if (options.timeZone !== undefined) throw new Error('--time-zone applies only with --every');
    return draft;
  }
  if (!draft || typeof draft !== 'object' || Array.isArray(draft))
    throw new Error('The draft file must contain a JSON object');
  if ('trigger' in draft) throw new Error('Remove "trigger" from the draft file, or omit --every');
  const step = parseScheduleEvery(options.every);
  const previous =
    action === 'edit'
      ? scheduleShowTrigger(
          await sendScheduleCommand(ScheduleCommandSchema.parse({ action: 'show', scheduleId }), {
            workspace: options.workspace,
          })
        )
      : undefined;
  return {
    ...draft,
    trigger: scheduleEveryTrigger(step, {
      timeZone: options.timeZone ?? getDeviceTimeZone(process.env.TZ),
      now: Date.now(),
      previous,
    }),
  };
}
export const scheduleCommand = new Command('schedule').description(
  'Manage scheduled tasks. The target machine daemon owns execution.'
);
for (const action of [
  'list',
  'show',
  'create',
  'edit',
  'pause',
  'resume',
  'run',
  'delete',
] as const) {
  const command = new Command(action)
    .option('-w, --workspace <workspace>', 'Workspace id or slug')
    .option('--json', 'Output JSON')
    .option('--debug', 'Debug logging');
  if (action === 'list')
    command
      .option('--query <text>', 'Filter schedule titles')
      .option('--limit <count>', 'Maximum results (1–100)', '30')
      .option('--offset <count>', 'Result offset', '0');
  const hasId = action !== 'list' && action !== 'create';
  if (hasId) command.argument('<schedule-id>');
  if (action === 'create' || action === 'edit')
    command
      .requiredOption(
        '--file <path>',
        'JSON draft: title, prompt, machineId, trigger, agent, project and policies'
      )
      .option(
        '--every <step>',
        'Repeat every N minutes or hours (N up to 2147483647), e.g. 90m or 5h; replaces the draft trigger. ' +
          'Steps dividing the hour/day run on the clock; others run every N from now'
      )
      .option(
        '--time-zone <zone>',
        'IANA zone that clock-aligned --every steps follow (default: this device); ' +
          'use the target machine’s zone'
      );
  if (['create', 'edit', 'pause', 'resume', 'run'].includes(action))
    command.option('--request-id <id>', 'Stable idempotency key; reuse on retry');
  command.action(async (...values: unknown[]) => {
    const options = values[hasId ? 1 : 0] as Options;
    await runOneShotCommand('schedule', options, async () => {
      const requestId = options.requestId ?? randomUUID();
      const scheduleId = hasId ? (values[0] as string) : requestId;
      const input = ScheduleCommandSchema.parse({
        action,
        ...(action === 'list'
          ? { query: options.query, limit: Number(options.limit), offset: Number(options.offset) }
          : {}),
        ...(action !== 'list' ? { scheduleId } : {}),
        ...(['create', 'edit', 'pause', 'resume', 'run'].includes(action) ? { requestId } : {}),
        ...(options.file && (action === 'create' || action === 'edit')
          ? { draft: await readDraft(options, action, scheduleId) }
          : {}),
      });
      printJson(await sendScheduleCommand(input, { workspace: options.workspace }));
    });
  });
  scheduleCommand.addCommand(command);
}
