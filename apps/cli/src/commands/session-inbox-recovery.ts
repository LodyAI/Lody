import { Command } from 'commander';
import { Effect } from 'effect';
import { quoteInboxRecoveryArgument } from '@/orchestration/inbox/admission-failure';
import { recoverBlockedInboxExecution } from '@/orchestration/inbox/operator-recovery';
import { makeInboxOperatorRecovery } from '@/orchestration/platform/operator-recovery';

/** Offline local-account maintenance, without cloud access or an Agent/MCP recovery tool. */
export const createSessionInboxRecoveryCommand = () =>
  new Command('recover-inbox')
    .description(
      'Inspect blocked Inbox ownership offline; recover only after all old resources are released'
    )
    .argument('<sessionId>', 'Blocked Session ID')
    .requiredOption('--machine <machineId>', 'Local machine ID owning the SQLite store')
    .requiredOption('--workspace <workspaceId>', 'Exact workspace ID')
    .option('--execution <executionId>', 'Exact blocked execution ID from inspection')
    .option('--snapshot <token>', 'Exact inspection snapshot token (required with --execution)')
    .option(
      '--orphan <token>',
      'Recover missing active execution ownership using its inspection snapshot token'
    )
    .option(
      '--confirm-resources-released',
      'Attest that ALL old resources, including unrecorded processes and requests, are released'
    )
    .addHelpText(
      'after',
      '\nFirst quit Lody Desktop and stop its daemon on the owning machine. Run without recovery flags to inspect only.\nA missing execution ID or dead daemon is NOT proof of resource release. Windows recovery remains manual.\nRecovery preserves history and saved results, retires uncertain old requests without replay, and leaves the Inbox paused.\nFresh human or Agent-chat input clears that pause after restart.\n'
    )
    .action(
      async (
        sessionId: string,
        options: {
          machine: string;
          workspace: string;
          execution?: string;
          snapshot?: string;
          orphan?: string;
          confirmResourcesReleased?: boolean;
        }
      ) => {
        if (options.execution && options.orphan)
          throw new Error('Choose either --execution with --snapshot, or --orphan, not both');
        if (options.snapshot && !options.execution)
          throw new Error(
            '--snapshot requires --execution; use --orphan for missing active execution ownership'
          );
        if (options.execution && !options.snapshot)
          throw new Error(
            '--execution requires the exact --snapshot token from a fresh inspection'
          );
        const recover = options.execution !== undefined || options.orphan !== undefined;
        if (options.confirmResourcesReleased && !recover)
          throw new Error(
            '--confirm-resources-released requires --execution with --snapshot, or --orphan'
          );
        if (recover && !options.confirmResourcesReleased)
          throw new Error(
            'Recovery requires --confirm-resources-released after checking ALL old resources'
          );
        if (process.env.LODY_SESSION_ID)
          throw new Error(
            'Inbox recovery is a local operator action; run it outside an Agent session'
          );
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const ports = yield* makeInboxOperatorRecovery(options.machine, options.workspace, {
                inspectOnly: !recover,
              });
              if (recover) {
                const result = yield* recoverBlockedInboxExecution(
                  ports,
                  sessionId,
                  options.execution ?? null,
                  options.confirmResourcesReleased === true,
                  options.orphan ?? options.snapshot
                );
                console.log(JSON.stringify(result, null, 2));
                return;
              }
              const records = (yield* ports.blocked).filter(
                (record) => record.scope.sessionId === sessionId
              );
              const quote = (value: string) => quoteInboxRecoveryArgument(value, process.platform);
              console.log(
                JSON.stringify(
                  {
                    machineId: options.machine,
                    workspaceId: options.workspace,
                    sessionId,
                    blocked: records.length > 0,
                    shell: process.platform === 'win32' ? 'PowerShell' : 'POSIX shell',
                    guidance: records.length
                      ? [
                          'Keep Lody Desktop and the daemon stopped on this machine.',
                          'Independently verify ALL old processes and requests are released, including unrecorded descendants. Missing ownership or dead root PIDs is not proof.',
                          'Only after verification, run the matching recovery command below. A changed snapshot requires another inspection.',
                          'Recovery does not replay unknown old requests. History, queued input and held results are preserved; restart and send fresh human or Agent-chat input to clear the pause.',
                        ]
                      : [
                          'No blocked Inbox ownership was found for this exact machine/workspace/session. No recovery was performed.',
                        ],
                    records: records.map((record) => ({
                      ...record,
                      recoveryCommand:
                        record.reason === 'ambiguous_ownership'
                          ? null
                          : `lody session recover-inbox --machine ${quote(options.machine)} --workspace ${quote(options.workspace)} ${
                              record.executionId === null
                                ? `--orphan ${quote(record.snapshotToken)}`
                                : `--execution ${quote(record.executionId)} --snapshot ${quote(record.snapshotToken)}`
                            } --confirm-resources-released -- ${quote(sessionId)}`,
                    })),
                  },
                  null,
                  2
                )
              );
            })
          )
        );
      }
    );

export const sessionInboxRecoveryCommand = createSessionInboxRecoveryCommand();
