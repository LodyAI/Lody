import { resolve } from 'node:path';
import { Command } from 'commander';

/** Keep custody and SQLite outside the ordinary CLI startup graph. */
export const e2eeCommand = new Command('e2ee')
  .description('Local encrypted-workspace maintenance')
  .addCommand(
    new Command('journal').description('Manage the local execution log').addCommand(
      new Command('reset')
        .description('Archive and reset the local execution log; stop its execution owners first')
        .requiredOption(
          '--file <path>',
          'Exact execution journal path for this account and machine'
        )
        .option('--json', 'Print JSON output')
        .action(async (options: { file: string; json?: boolean }) => {
          const { runOneShotCommand, printJson } = await import('@/lib/command-runtime');
          await runOneShotCommand(
            'e2ee-journal',
            options,
            async () => {
              const { RealtimeJournal } = await import('@/lib/e2ee/realtime-journal');
              const filename = resolve(options.file);
              const journal = new RealtimeJournal(filename, Date.now);
              try {
                const result = journal.reset();
                if (options.json === true)
                  printJson({ ok: true, journalPath: filename, ...result });
                else {
                  console.log(
                    `Local execution log reset. Evidence retained at ${result.archivePath}`
                  );
                  console.log('Requests with unknown results will not be executed again.');
                }
              } finally {
                journal.retryCleanup();
              }
            },
            { localOnly: true }
          );
        })
    )
  );
