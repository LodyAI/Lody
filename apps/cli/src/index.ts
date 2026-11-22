#!/usr/bin/env node
// MUST stay the first import: it exits with a readable message on the runtimes where
// the SQLite binding cannot load — Node-API < 10 segfaults rather than throwing, and
// 32-bit ARM has no prebuild. See utils/sqlite-runtime-support.ts.
import './utils/sqlite-runtime-support';
import { releaseScopedMallocArenaLimit } from './utils/malloc-arena';

releaseScopedMallocArenaLimit();

const { forwardToSelectedManagedInstallation } = await import('./lib/managed-daemon-forwarding');
if (await forwardToSelectedManagedInstallation()) process.exit(process.exitCode ?? 0);

import './instrument';
import {
  configureManagedProcessObservation,
  getManagedWorkerLaunchContext,
} from './lib/managed-process-observation';
import { Command } from 'commander';
import { Cause, Effect, Layer } from 'effect';
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime';
import {
  LoginShellCacheLive,
  LoginShellCacheReporter,
  loginShellEnvLayer,
  recoverLoginShellCacheShutdown,
} from '@lody/shared/node/login-shell-env';
import {
  bindLoginShellCacheLegacy,
  closeLoginShellApplicationLegacy,
} from './agent/login-shell-env';
import { toShared } from './platform/process-options';
import { version } from '@/pkg';
import { loadEnv } from './utils/const';
import { getLogger } from './utils/logger';
import { registerProcessErrorHandlers, reportError } from './utils/telemetry';
import { installCliHttpGlobalDispatcher } from './utils/http-transport';
import { applyDefaultDnsResultOrder } from './utils/dns-result-order';

// Internal MCP processes use the same runtime and cleanup policy without retaining
// the daemon, interactive commands and their unrelated implementation modules.
configureManagedProcessObservation(getManagedWorkerLaunchContext().protocol);

const registerUserCommands =
  process.argv[2] === '__internal'
    ? undefined
    : (await import('./commands/register')).registerCommands;

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
const application =
  process.argv[2] === 'daemon-runner'
    ? makeApplicationRuntime(shellCache, {
        recover: recoverLoginShellCacheShutdown,
        project: (cause) => Cause.squash(cause),
      })
    : (await import('./cli-presence-application')).makeCliPresenceApplication(
        shellCache,
        cliLogger
      );
bindLoginShellCacheLegacy(application);

const program = new Command();

program
  .name('lody')
  .description('Lody Agent CLI tool for managing remote command execution')
  .version(version, '-v, --version', 'display version number')
  .enablePositionalOptions();

if (registerUserCommands) {
  registerUserCommands(program);
} else {
  program.addCommand((await import('./commands/internal')).internalCommand);
}
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
