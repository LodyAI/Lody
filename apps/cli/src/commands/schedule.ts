import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ScheduleCommandSchema } from '@lody/shared';
import { printJson, runOneShotCommand, type CommonCommandOptions } from '@/lib/command-runtime';
import { sendScheduleCommand } from '@/lib/schedules/schedule-command-client';

type Options = CommonCommandOptions & {
  file?: string;
  requestId?: string;
  query?: string;
  limit?: string;
  offset?: string;
};
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
    command.requiredOption(
      '--file <path>',
      'JSON draft: title, prompt, machineId, trigger, agent, project and policies'
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
        ...(options.file ? { draft: JSON.parse(await readFile(options.file, 'utf8')) } : {}),
      });
      printJson(await sendScheduleCommand(input, { workspace: options.workspace }));
    });
  });
  scheduleCommand.addCommand(command);
}
