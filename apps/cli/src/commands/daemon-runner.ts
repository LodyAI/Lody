import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { version } from '@/pkg';
import {
  appendOutputTail,
  CliSupervisor,
  fetchCliRuntimeState,
  isV8OutOfMemoryExit,
  type LaunchHandle,
  type CliRunResult,
  type SupervisorState,
} from '@lody/cli-supervisor';
import {
  LOCAL_CLI_SUPERVISOR_CONTRACT_VERSION,
  LODY_SUPERVISOR_CONTRACT_ENV,
  LODY_SUPERVISOR_INSTANCE_ID_ENV,
  LODY_SUPERVISOR_PID_ENV,
  LODY_SUPERVISOR_TOKEN_ENV,
} from '@lody/shared/node/local-cli-supervisor';
import {
  acquireLocalCliHostLease,
  type LocalCliHostLease,
} from '@lody/shared/node/local-cli-host-lease';
import { createHybridLogger, getLogger } from '../utils/logger';
import {
  DAEMON_WORKER_MAX_OLD_SPACE_MB,
  DAEMON_RUNNER_READY_FD_ENV,
  removePidFile,
  reportDaemonRunnerLaunchOutcome,
  resolveLodyBin,
  spawnDaemonRunnerAndAwaitReady,
  writePidFile,
  type DaemonPidRecord,
} from './daemon-shared';
import { normalizeCurrentProcessResourceProfile } from '@/utils/process-resource-profile';
import { flushTelemetry } from '@/instrument';
import { captureSupervisorEvent } from './analytics-events';
import { getRuntimeDiagnostics } from '@/utils/runtime-diagnostics';
import {
  EXIT_CODE_REMOTE_RESTART,
  EXIT_CODE_REMOTE_UPGRADE,
  EXIT_CODE_AUTH_FAILURE,
  EXIT_CODE_RETRYABLE_STARTUP,
  EXIT_CODE_SUPERVISOR_CONTRACT_MISMATCH,
  LODY_DAEMON_SUPERVISED_ENV,
  runDaemonUpgradeFromIntent,
} from '@/lib/machine-lifecycle';
import {
  describeDaemonWorkerStartupFailure,
  isDaemonWorkerReady,
  isRetryableDaemonWorkerStartupExit,
} from './daemon-runner-startup';

function launchLodyStart(
  passthroughArgs: string[],
  identity: { instanceId: string; token: string }
): LaunchHandle {
  const bin = resolveLodyBin();
  const args = [
    `--max-old-space-size=${DAEMON_WORKER_MAX_OLD_SPACE_MB}`,
    bin,
    'start',
    ...passthroughArgs,
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [LODY_DAEMON_SUPERVISED_ENV]: '1',
    [LODY_SUPERVISOR_CONTRACT_ENV]: LOCAL_CLI_SUPERVISOR_CONTRACT_VERSION,
    [LODY_SUPERVISOR_PID_ENV]: String(process.pid),
    [LODY_SUPERVISOR_INSTANCE_ID_ENV]: identity.instanceId,
    [LODY_SUPERVISOR_TOKEN_ENV]: identity.token,
  };
  delete env.LODY_ELECTRON_BOOTSTRAP;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env[DAEMON_RUNNER_READY_FD_ENV];
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env,
    windowsHide: true,
  });

  const result = new Promise<CliRunResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let processError: Error | null = null;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendOutputTail(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendOutputTail(stderr, chunk);
    });

    child.once('error', (error) => {
      processError = error;
    });
    child.once('close', (code, signal) => {
      if (processError) {
        reject(processError);
        return;
      }
      const exitResult: CliRunResult = {
        code,
        signal: signal ?? null,
        stdout,
        stderr,
      };
      exitResult.terminationKind = isV8OutOfMemoryExit(exitResult)
        ? 'v8_oom'
        : signal
          ? 'signal'
          : 'exit';
      resolve(exitResult);
    });
  });

  return {
    child,
    result,
    requestShutdown: async () => {
      if (!child.connected) throw new Error('Worker supervisor IPC channel is not connected');
      await new Promise<void>((resolve, reject) => {
        child.send(
          {
            type: 'lody/supervisor-shutdown',
            instanceId: identity.instanceId,
            token: identity.token,
          },
          (error) => (error ? reject(error) : resolve())
        );
      });
    },
  };
}

/**
 * Internal command: daemon watchdog process.
 * Not intended to be called directly by users — use `lody daemon start` instead.
 */
export const daemonRunnerCommand = new Command('daemon-runner')
  .description('(internal) daemon watchdog process')
  .allowUnknownOption(true)
  .helpOption(false)
  .action(async (_options: unknown, cmd: Command) => {
    createHybridLogger({ level: 'info' });
    const logger = getLogger('daemon-runner');
    const supervisorIdentity = {
      instanceId: randomUUID(),
      token: `${randomUUID()}${randomUUID()}`,
    };
    let launchOutcomePending = process.env[DAEMON_RUNNER_READY_FD_ENV] !== undefined;
    const reportLaunchOutcome = (
      outcome: Parameters<typeof reportDaemonRunnerLaunchOutcome>[0]
    ): void => {
      if (!launchOutcomePending) return;
      launchOutcomePending = false;
      reportDaemonRunnerLaunchOutcome(outcome);
    };
    let hostShutdownRequested = false;
    let hostShutdownHandler: (() => void) | null = null;
    const requestHostShutdown = () => {
      if (hostShutdownRequested) return;
      hostShutdownRequested = true;
      hostShutdownHandler?.();
    };

    // The OS-backed Host lease is the canonical ownership boundary. The PID
    // record is only published after this runner is eligible to spawn Workers.
    const initialLease = await acquireLocalCliHostLease({
      instanceId: supervisorIdentity.instanceId,
      mode: 'daemon',
      shutdownControl: {
        token: supervisorIdentity.token,
        onRequest: () => requestHostShutdown(),
      },
    });
    if (initialLease.status === 'occupied') {
      const owner = initialLease.record
        ? `${initialLease.record.mode} process ${initialLease.record.pid}`
        : 'another local CLI host';
      logger.error(`Cannot start daemon: ${owner} already owns the local agent runtime.`);
      reportLaunchOutcome({
        status: 'occupied',
        ...(initialLease.record
          ? { ownerMode: initialLease.record.mode, ownerPid: initialLease.record.pid }
          : {}),
      });
      await flushTelemetry();
      process.exit(1);
    }
    let hostLease: LocalCliHostLease | null = initialLease.lease;
    let pidRecord: DaemonPidRecord;
    try {
      pidRecord = writePidFile(
        process.pid,
        supervisorIdentity.instanceId,
        supervisorIdentity.token
      );
    } catch (error) {
      await hostLease.close();
      hostLease = null;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to claim daemon ownership: ${message}`);
      reportLaunchOutcome({ status: 'error', message });
      await flushTelemetry();
      process.exit(1);
    }
    logger.info(`Daemon watchdog started (PID ${process.pid})`);

    await normalizeCurrentProcessResourceProfile(logger);
    for (const diagnostic of getRuntimeDiagnostics(version)) {
      logger.info(diagnostic);
    }

    // Everything after `daemon-runner` is passthrough to `lody start`
    const passthroughArgs = cmd.args;

    // Track supervisor transitions so crash/restart/circuit-breaker analytics
    // fire once per edge instead of on every state publish. The supervisor
    // republishes state on each probe tick, so edge-detection here is required.
    let lastExitAtMs: number | undefined;
    let lastRetryAttempt = 0;
    let fatalReported = false;
    const reportSupervisorAnalytics = (state: SupervisorState): void => {
      // A new process exit timestamp means the worker crashed/exited.
      if (state.lastExitAtMs !== undefined && state.lastExitAtMs !== lastExitAtMs) {
        lastExitAtMs = state.lastExitAtMs;
        if (
          state.lastExitCode !== EXIT_CODE_REMOTE_RESTART &&
          state.lastExitCode !== EXIT_CODE_REMOTE_UPGRADE
        ) {
          captureSupervisorEvent('worker_crashed', {
            exit_code: state.lastExitCode ?? null,
            crash_count_consecutive: state.retryAttempt ?? 0,
            backoff_delay_ms: state.retryInMs ?? null,
            phase: state.phase,
          });
        }
      }
      // A higher retry attempt means a restart is being scheduled/attempted.
      if (typeof state.retryAttempt === 'number' && state.retryAttempt > lastRetryAttempt) {
        lastRetryAttempt = state.retryAttempt;
        captureSupervisorEvent('worker_restart_attempt', {
          restart_attempt: state.retryAttempt,
          backoff_delay_ms: state.retryInMs ?? null,
        });
      }
      // Fatal phase = circuit breaker, but only the crash-loop variant. The
      // supervisor also goes fatal on ownership conflicts and auth failures;
      // those are not circuit-breaker
      // trips, so key on the failure-window message the supervisor emits.
      if (state.phase === 'fatal' && !fatalReported) {
        fatalReported = true;
        const isCrashLoop = (state.message ?? '').includes('times within');
        if (isCrashLoop) {
          captureSupervisorEvent('circuit_breaker_tripped', {
            last_exit_code: state.lastExitCode ?? null,
            crash_count_consecutive: state.retryAttempt ?? lastRetryAttempt,
          });
        }
      }
    };

    let terminating = false;
    let pendingUpgradeHandoff = false;
    const finish = async (code: number) => {
      if (terminating) return;
      terminating = true;
      removePidFile(pidRecord);
      const lease = hostLease;
      hostLease = null;
      await lease?.close();
      await flushTelemetry();
      process.exit(code);
    };

    // After a successful remote upgrade the Worker is stopped, the Host lease
    // is already released, and this (old-code) watchdog replaces itself with a
    // detached runner from the new install. Falling back to in-place restart
    // keeps the machine online when the replacement cannot claim ownership.
    async function performUpgradeHandoff(): Promise<void> {
      pendingUpgradeHandoff = false;
      logger.info('Handing the daemon watchdog off to the upgraded CLI...');
      try {
        const handoff = await spawnDaemonRunnerAndAwaitReady(passthroughArgs);
        if (handoff.status === 'ready') {
          logger.info(`Upgraded daemon watchdog is running (PID ${handoff.pid}).`);
          // The replacement overwrote the PID record; the conditional
          // removePidFile inside finish() will leave it in place.
          await finish(0);
          return;
        }
        logger.error(
          `Watchdog handoff failed (${handoff.status}); restarting on the current version.`
        );
      } catch (error) {
        logger.error(
          `Watchdog handoff failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      const reacquired = await acquireLocalCliHostLease({
        instanceId: supervisorIdentity.instanceId,
        mode: 'daemon',
        shutdownControl: {
          token: supervisorIdentity.token,
          onRequest: () => requestHostShutdown(),
        },
      });
      if (reacquired.status === 'occupied') {
        logger.error(
          'Another local CLI host claimed ownership during the failed handoff; exiting.'
        );
        await finish(1);
        return;
      }
      hostLease = reacquired.lease;
      pidRecord = writePidFile(
        process.pid,
        supervisorIdentity.instanceId,
        supervisorIdentity.token
      );
      await supervisor.start();
    }

    const supervisor = new CliSupervisor({
      prepareLaunch: async (signal) => {
        if (signal.aborted) throw new DOMException('Worker launch canceled', 'AbortError');
        return {
          spawn: () => launchLodyStart(passthroughArgs, supervisorIdentity),
        };
      },
      fetchRuntimeState: async ({ timeoutMs }) => await fetchCliRuntimeState({ timeoutMs }),
      existingRuntimePolicy: 'reject',
      ownership: {
        acquire: async (signal) => {
          if (hostLease) return { status: 'acquired' };
          const result = await acquireLocalCliHostLease({
            instanceId: supervisorIdentity.instanceId,
            mode: 'daemon',
            signal,
            shutdownControl: {
              token: supervisorIdentity.token,
              onRequest: () => requestHostShutdown(),
            },
          });
          if (result.status === 'occupied') {
            return {
              status: 'occupied',
              owner: result.record ?? undefined,
              description: result.record
                ? `Local CLI host is owned by ${result.record.mode} process ${result.record.pid}`
                : 'Another local CLI host owns the runtime',
            };
          }
          hostLease = result.lease;
          return { status: 'acquired' };
        },
        release: async () => {
          const lease = hostLease;
          hostLease = null;
          await lease?.close();
        },
      },
      decideExit: async (result, signal) => {
        // A retryable startup exit is not the launch outcome yet. Keep the
        // foreground handshake open while the supervisor retries; only a
        // non-retryable initial exit is reported as the startup failure.
        if (launchOutcomePending && !isRetryableDaemonWorkerStartupExit(result)) {
          const message = describeDaemonWorkerStartupFailure(result);
          reportLaunchOutcome({ status: 'error', message });
          return {
            action: 'fatal',
            message: `Initial daemon worker startup failed: ${message}`,
          };
        }
        if (result.code === 0) {
          return { action: 'stop', message: 'Worker exited cleanly' };
        }
        if (result.code === EXIT_CODE_REMOTE_RESTART) {
          logger.info('Worker requested remote restart; respawning.');
          return { action: 'restart', message: 'Remote restart requested' };
        }
        if (result.code === EXIT_CODE_REMOTE_UPGRADE) {
          logger.info('Worker requested remote upgrade; installing before handoff.');
          const upgraded = await runDaemonUpgradeFromIntent({ logger, signal });
          if (upgraded) {
            // Stop cleanly so the Host lease is released, then hand the
            // watchdog role to the freshly installed CLI in onTerminal. This
            // is what upgrades the watchdog code itself, not just the Worker.
            pendingUpgradeHandoff = true;
            return { action: 'stop', message: 'Remote upgrade installed; handing off watchdog' };
          }
          logger.warn('Upgrade did not complete; respawning the current version.');
          return { action: 'restart', message: 'Remote upgrade failed; restarted current version' };
        }
        if (result.code === EXIT_CODE_AUTH_FAILURE) {
          return {
            action: 'fatal',
            message: 'Worker authentication failed; run `lody login` before restarting the daemon',
          };
        }
        if (result.code === EXIT_CODE_SUPERVISOR_CONTRACT_MISMATCH) {
          return {
            action: 'fatal',
            message:
              'Worker rejected this watchdog supervisor contract; run `lody daemon restart` with the updated CLI',
          };
        }
        if (result.code === EXIT_CODE_RETRYABLE_STARTUP) {
          return {
            action: 'retry',
            countFailure: false,
            message: 'Worker startup dependency is temporarily unavailable',
          };
        }
        if (isV8OutOfMemoryExit(result)) {
          return {
            action: 'retry',
            countFailure: true,
            failureClass: 'v8_oom',
            message: 'Worker exhausted its V8 heap',
          };
        }
        return {
          action: 'retry',
          countFailure: true,
          message: `Worker crashed with exit code ${result.code ?? 'signal'}`,
        };
      },
      onStateChange: (state) => {
        reportSupervisorAnalytics(state);
        if (launchOutcomePending && isDaemonWorkerReady(state)) {
          reportLaunchOutcome({
            status: 'ready',
            pid: process.pid,
            instanceId: supervisorIdentity.instanceId,
          });
        }
        if (state.phase === 'fatal') {
          logger.error(`Fatal: ${state.message ?? 'unknown'}`);
        } else if (state.message) {
          logger.debug(`[${state.phase}] ${state.message}`);
        }
      },
      onTerminal: (termination) => {
        if (pendingUpgradeHandoff && termination.reason === 'clean_exit') {
          void performUpgradeHandoff();
          return;
        }
        void finish(termination.reason === 'clean_exit' ? 0 : 1);
      },
    });

    const shutdown = async (signal?: string) => {
      logger.info(signal ? `Received ${signal}, shutting down...` : 'Shutting down...');
      try {
        await supervisor.stop();
      } catch (error) {
        logger.error(
          `Worker termination failed during shutdown: ${error instanceof Error ? error.message : String(error)}`
        );
        await finish(1);
        return;
      }
      await finish(0);
    };
    hostShutdownHandler = () => void shutdown('Host control request');
    if (hostShutdownRequested) hostShutdownHandler();

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    if (process.platform !== 'win32') {
      process.on('SIGHUP', () => void shutdown('SIGHUP'));
    }

    await supervisor.start();

    // Keep process alive
    await new Promise<void>(() => {});
  });
