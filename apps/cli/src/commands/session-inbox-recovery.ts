import { Command } from 'commander';
import { Effect } from 'effect';
import { recoverBlockedInboxExecution } from '@/orchestration/inbox/operator-recovery';
import { makeInboxOperatorRecovery } from '@/orchestration/platform/operator-recovery';

/** Offline local-account maintenance, without cloud access or an Agent/MCP recovery tool. */
export const sessionInboxRecoveryCommand = new Command('recover-inbox')
  .description(
    'Inspect a blocked local execution; recover only after all its resources are released'
  )
  .argument('<sessionId>', 'Blocked Session ID')
  .requiredOption('--machine <machineId>', 'Local machine ID owning the SQLite store')
  .requiredOption('--workspace <workspaceId>', 'Exact workspace ID')
  .option('--execution <executionId>', 'Exact blocked execution ID to recover')
  .option(
    '--confirm-resources-released',
    'Attest that ALL old resources, including unrecorded processes, are released'
  )
  .action(
    async (
      sessionId: string,
      options: {
        machine: string;
        workspace: string;
        execution?: string;
        confirmResourcesReleased?: boolean;
      }
    ) => {
      if (options.confirmResourcesReleased && !options.execution)
        throw new Error('--confirm-resources-released requires an exact --execution ID');
      if (options.execution && !options.confirmResourcesReleased)
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
            const ports = yield* makeInboxOperatorRecovery(options.machine, options.workspace);
            const result = options.execution
              ? yield* recoverBlockedInboxExecution(
                  ports,
                  sessionId,
                  options.execution,
                  options.confirmResourcesReleased === true
                )
              : (yield* ports.blocked).filter((record) => record.scope.sessionId === sessionId);
            console.log(JSON.stringify(result, null, 2));
          })
        )
      );
    }
  );
