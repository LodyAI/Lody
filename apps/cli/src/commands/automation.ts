import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { automationCommandSchema } from '@lody/shared/automations';
import { printJson, runOneShotCommand, type CommonCommandOptions } from '@/lib/command-runtime';
import { sendAutomationCommand } from '@/automations/control/client';

export const automationCommand = new Command('automation').description(
  'Wait for a JavaScript condition and continue the registering Session.'
);
for (const action of [
  'register',
  'list',
  'show',
  'cancel',
  'activities',
  'settings',
  'configure',
] as const) {
  const command = new Command(action)
    .option('-w, --workspace <workspace>', 'Workspace id or slug')
    .option('--session <id>', 'Session id (defaults to LODY_SESSION_ID)')
    .option('--json', 'Output JSON')
    .option('--debug', 'Debug logging');
  const hasId = ['show', 'cancel'].includes(action);
  if (hasId) command.argument('<id>');
  if (action === 'register')
    command
      .requiredOption('--file <path>', 'JavaScript condition function')
      .option('--reason <text>', 'Why this Session is waiting')
      .option('--interval <ms>', 'Check interval in milliseconds', '30000')
      .option('--expires-at <time>', 'Absolute expiry as an ISO date or epoch milliseconds');
  if (action === 'configure')
    command.requiredOption('--file <path>', 'JSON Session feature settings');
  if (action === 'activities')
    command
      .option('--limit <count>', 'Maximum activities (1–100)', '50')
      .option('--before <cursor>', 'JSON nextCursor from the previous page');
  command.action(async (...values: unknown[]) => {
    const options = values[hasId ? 1 : 0] as CommonCommandOptions & {
      file?: string;
      session?: string;
      reason?: string;
      interval?: string;
      expiresAt?: string;
      limit?: string;
      before?: string;
    };
    await runOneShotCommand('automation', options, async () => {
      const sessionId = options.session ?? process.env.LODY_SESSION_ID;
      const file = options.file ? await readFile(options.file, 'utf8') : undefined;
      const input = automationCommandSchema.parse({
        type: action,
        ...(hasId ? { id: values[0] } : sessionId ? { sessionId } : {}),
        ...(action === 'register'
          ? {
              program: file,
              reason: options.reason,
              intervalMs: Number(options.interval),
              ...(options.expiresAt
                ? {
                    expiresAt: /^\d+$/.test(options.expiresAt)
                      ? Number(options.expiresAt)
                      : Date.parse(options.expiresAt),
                  }
                : {}),
            }
          : {}),
        ...(action === 'configure' && file ? { settings: JSON.parse(file) } : {}),
        ...(action === 'activities'
          ? {
              limit: Number(options.limit),
              ...(options.before ? { before: JSON.parse(options.before) } : {}),
            }
          : {}),
      });
      printJson(await sendAutomationCommand(input, options.workspace));
    });
  });
  automationCommand.addCommand(command);
}
