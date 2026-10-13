#!/usr/bin/env node
// MUST stay the first import: it exits with a readable message on the runtimes where
// the SQLite binding cannot load — Node-API < 10 segfaults rather than throwing, and
// 32-bit ARM has no prebuild. See utils/sqlite-runtime-support.ts.
import './utils/sqlite-runtime-support';
import './instrument';
import { Command } from 'commander';
import { Cause, Effect, Layer } from 'effect';
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime';
import {
  LoginShellCacheLive,
  LoginShellCacheReporter,
  loginShellEnvLayer,
} from '@lody/shared/node/login-shell-env';
import {
  bindLoginShellCacheLegacy,
  closeLoginShellApplicationLegacy,
} from './agent/login-shell-env';
import { toShared } from './platform/process-options';
import { presencePlatformLayer } from './platform/presence';
import { WorkspacePresenceOwnersLive } from './lib/loro/workspace-presence';
import {
  bindWorkspacePresenceApplicationLegacy,
  recoverCliPresenceApplicationShutdown,
  WorkspacePresenceLegacyFailure,
} from './lib/loro/presence-legacy';
import { version } from '@/pkg';
import { startCommand } from './commands/start';

import { appCommand } from './commands/app';
import { loginCommand } from './commands/login';
import { logoutCommand } from './commands/logout';
import { projectCommand } from './commands/project';
import { sessionCommand } from './commands/session';
import { scheduleCommand } from './commands/schedule';
import { syncCommand } from './commands/sync';
import { workspaceCommand } from './commands/workspace';
import { agentConfigCommand } from './commands/agent-config';
import { machineCommand } from './commands/machine';
import { exportCommand } from './commands/export';
import { reviewCommand } from './commands/review';
import { githubCommand } from './commands/github';
import { daemonCommand } from './commands/daemon';
import { daemonRunnerCommand } from './commands/daemon-runner';
import { internalCommand } from './commands/internal';
import { feedbackCommand } from './commands/feedback';
import { mcpCommand } from './commands/mcp';
import { agentRoleCommand } from './commands/discovery';
import { operationCommand } from './commands/operation';
import { loadEnv } from './utils/const';
import { getLogger } from './utils/logger';
import { registerProcessErrorHandlers, reportError } from './utils/telemetry';
import { installCliHttpGlobalDispatcher } from './utils/http-transport';
import { applyDefaultDnsResultOrder } from './utils/dns-result-order';

const cliLogger = getLogger('cli');

// Public commands consume only explicit process environment. Do not discover
// deployment presets from a caller's working directory.
loadEnv();
applyDefaultDnsResultOrder({ logger: getLogger('dns') });
installCliHttpGlobalDispatcher({ logger: getLogger('http-transport') });

const shellCache = LoginShellCacheLive.pipe(
  Layer.provide(
    Layer.merge(
      loginShellEnvLayer(toShared()),
      Layer.succeed(LoginShellCacheReporter, (cause) =>
        Effect.sync(() => {
          const error = Cause.squash(cause);
          cliLogger.error('Login-shell probe failed; retaining its failure for launchers', {
            errorName: error instanceof Error ? error.name : 'unknown',
          });
        })
      )
    )
  )
);
const application = makeApplicationRuntime(
  Layer.merge(
    shellCache,
    WorkspacePresenceOwnersLive.pipe(Layer.provide(presencePlatformLayer(cliLogger)))
  ),
  {
    recover: recoverCliPresenceApplicationShutdown,
    project: (cause) => new WorkspacePresenceLegacyFailure(cause),
  }
);
bindLoginShellCacheLegacy(application);
bindWorkspacePresenceApplicationLegacy(application);

const program = new Command();

program
  .name('lody')
  .description('Lody Agent CLI tool for managing remote command execution')
  .version(version, '-v, --version', 'display version number')
  .enablePositionalOptions();

// Add commands
program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(startCommand);
program.addCommand(appCommand);
program.addCommand(projectCommand);
program.addCommand(sessionCommand);
program.addCommand(scheduleCommand);
program.addCommand(syncCommand);
program.addCommand(workspaceCommand);
program.addCommand(agentConfigCommand);
program.addCommand(mcpCommand);
program.addCommand(agentRoleCommand);
program.addCommand(operationCommand);
program.addCommand(machineCommand);
program.addCommand(exportCommand);
program.addCommand(reviewCommand);
program.addCommand(githubCommand);
program.addCommand(daemonCommand);
program.addCommand(daemonRunnerCommand);
program.addCommand(internalCommand);
program.addCommand(feedbackCommand);
// Configure commander to show help when no arguments provided
program.configureHelp({
  sortSubcommands: true,
  subcommandTerm: (cmd) => cmd.name() + ' ' + cmd.usage(),
});

registerProcessErrorHandlers();

export default program;

void (async () => {
  try {
    const userArgs = process.argv.slice(2);

    // Handle case where no command is provided
    if (!userArgs.length) {
      program.outputHelp();
      await closeLoginShellApplicationLegacy();
      process.exit(0);
    }

    // Parse command line arguments. Use parseAsync so async command actions are awaited.
    await program.parseAsync(userArgs, { from: 'user' });
    await closeLoginShellApplicationLegacy();
  } catch (error) {
    let failure = error;
    try {
      await closeLoginShellApplicationLegacy();
    } catch (cleanupError) {
      failure = new AggregateError(
        [error, cleanupError],
        'CLI failed and application cleanup failed'
      );
    }
    // Handle Commander errors gracefully
    if (error instanceof Error && error.name === 'CommanderError') {
      // Commander errors are usually from help or invalid commands
      // Let them display normally and exit
      process.exit(1);
    } else {
      await reportError('cli', failure, {
        message: 'CLI runtime error',
        logger: cliLogger,
        fatal: true,
      }).finally(() => process.exit(1));
    }
  }
})();
