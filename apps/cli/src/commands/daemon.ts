import { Command } from 'commander';
import chalk from 'chalk';
import { fetchCliRuntimeState } from '@lody/cli-supervisor';
import {
  inspectLocalCliHost,
  requestLocalCliHostShutdown,
  type LocalCliHostRecord,
} from '@lody/shared/node/local-cli-host-lease';
import { version } from '@/pkg';
import { LODY_LOG_DIR, readPidFileRecord, spawnDaemonRunnerAndAwaitReady } from './daemon-shared';
import { flushTelemetry } from '@/instrument';
import { captureDaemonEvent } from './analytics-events';
import { fetchLocalProbeHealth } from '@/lib/local-probe-health';
import { AuthClient, performLoginWithAuthCredential } from '@/lib/auth';
import { getCliPlatformKind } from '@/lib/cli-platform';
import { createHybridLogger, getLogger } from '@/utils/logger';
import { ensureDaemonBackendAuth, type DaemonAuthPreflightOutcome } from './daemon-auth-preflight';
import { buildDaemonStartPassthroughArgs, type DaemonStartOptions } from './daemon-start-options';
import { formatDaemonBackendStatus, formatDaemonConnectivityStatus } from './daemon-status-format';
import { readLatestLogTail } from '@/utils/log-files';

async function exitDaemonCommand(code: number): Promise<void> {
  process.exitCode = code;
  // Flush buffered analytics before the one-shot daemon command exits.
  await flushTelemetry();
  process.exit(code);
}

type StopResult =
  | { status: 'not_running' }
  | { status: 'stale_pid_file'; pid: number }
  | { status: 'stopped'; pid: number; attempts: number }
  | { status: 'timeout'; pid: number; attempts: number }
  | { status: 'host_mismatch'; pid: number; host: LocalCliHostRecord }
  | { status: 'control_error'; pid: number; errorMessage: string };

// The live Host endpoint is the only stop authority. The PID record supplies
// the control token; PID liveness is never consulted and no signal is sent.
async function stopDaemonProcess(): Promise<StopResult> {
  const pidRecord = readPidFileRecord();
  if (!pidRecord) return { status: 'not_running' };
  const pid = pidRecord.pid;

  const host = await inspectLocalCliHost(undefined, 500);
  if (!host) {
    return { status: 'stale_pid_file', pid };
  }
  if (host.mode !== 'daemon' || host.pid !== pid || host.instanceId !== pidRecord.instanceId) {
    return { status: 'host_mismatch', pid, host };
  }

  const requested = await requestLocalCliHostShutdown({
    instanceId: pidRecord.instanceId,
    token: pidRecord.controlToken,
    expectedPid: pid,
    expectedMode: 'daemon',
  });
  if (!requested.ok) {
    return { status: 'control_error', pid, errorMessage: requested.error };
  }

  // The daemon Supervisor gives the Worker 30 seconds to drain before force
  // killing it, then waits up to 5 seconds for confirmed exit.
  const maxAttempts = 80;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const currentHost = await inspectLocalCliHost(undefined, 500);
    if (!currentHost || currentHost.instanceId !== pidRecord.instanceId) {
      return { status: 'stopped', pid, attempts: attempt };
    }
  }
  return { status: 'timeout', pid, attempts: maxAttempts };
}

type StartResult =
  | { status: 'started'; pid: number }
  | { status: 'missing_child_pid' }
  | { status: 'ownership_conflict'; pid: number; ownerMode?: string | undefined }
  | { status: 'startup_error'; pid: number; message: string }
  | { status: 'runner_exited'; pid: number }
  | { status: 'startup_timeout'; pid: number };

type StartReadinessResult =
  | { status: 'ready' }
  | { status: 'host_running'; host: LocalCliHostRecord }
  | { status: 'probe_running'; existingPid: number; phase: string };

async function checkDaemonStartReadiness(): Promise<StartReadinessResult> {
  const existingHost = await inspectLocalCliHost();
  if (existingHost) return { status: 'host_running', host: existingHost };

  const existingState = await fetchCliRuntimeState({ timeoutMs: 1000 });
  if (existingState) {
    return {
      status: 'probe_running',
      existingPid: existingState.pid,
      phase: existingState.phase,
    };
  }

  return { status: 'ready' };
}

async function startDaemonProcess(passthroughArgs: string[]): Promise<StartResult> {
  const result = await spawnDaemonRunnerAndAwaitReady(passthroughArgs);
  switch (result.status) {
    case 'ready':
      return { status: 'started', pid: result.pid };
    case 'occupied':
      return {
        status: 'ownership_conflict',
        pid: result.ownerPid ?? result.runnerPid,
        ownerMode: result.ownerMode,
      };
    case 'error':
      return { status: 'startup_error', pid: result.runnerPid, message: result.message };
    case 'missing_child_pid':
      return { status: 'missing_child_pid' };
    case 'runner_exited':
      return { status: 'runner_exited', pid: result.runnerPid };
    case 'timeout':
      return { status: 'startup_timeout', pid: result.runnerPid };
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

function daemonAuthFailureHint(
  reason: Exclude<DaemonAuthPreflightOutcome, { status: 'authenticated' }>['reason']
): string {
  switch (reason) {
    case 'backend_unreachable':
      return `Retry once the connection is back, or start anyway with ${chalk.yellow('--skip-auth-check')}.`;
    case 'login_required_non_interactive':
      // No terminal is attached, so device authorization would block for
      // minutes with nobody to open the link.
      return `Run ${chalk.yellow('lody login')} from a terminal, or pass ${chalk.yellow('--auth <cli_token>')}.`;
    case 'login_failed':
      return `Run ${chalk.yellow('lody login')} and retry.`;
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

function printStartTips(): void {
  console.log(`Use ${chalk.yellow('lody daemon status')} to check status`);
  console.log(`Use ${chalk.yellow('lody daemon stop')} to stop`);
  console.log(`Use ${chalk.yellow('lody daemon logs')} to view logs`);
}

// Prints the user-facing message for a blocked start (pid-file or probe already
// running) and exits non-zero. Returns true when it handled a blocked state, so
// the caller can bail; false means the daemon is clear to start.
async function reportDaemonStartBlocked(
  readiness: StartReadinessResult,
  opts: { restart: boolean }
): Promise<boolean> {
  if (readiness.status === 'host_running') {
    const subject = opts.restart ? 'Another daemon' : 'Daemon';
    console.log(
      `${subject} cannot start because the local agent Host is owned by ${readiness.host.mode} process ${readiness.host.pid}.`
    );
    await exitDaemonCommand(1);
    return true;
  }
  if (readiness.status === 'probe_running') {
    console.log(
      `A lody instance is already running on the probe port (PID ${readiness.existingPid}).`
    );
    console.log(`Stop it first, or use ${chalk.yellow('lody daemon status')} to check its state.`);
    await exitDaemonCommand(1);
    return true;
  }
  return false;
}

export const daemonCommand = new Command('daemon')
  .description('Run lody as a background daemon service')
  .addCommand(
    new Command('start')
      .description('Start lody daemon in the background')
      .option('--auth <credential>', 'Connect with a CLI API key or machine connection token')
      .option('--machine-name <name>', 'Machine name to register (defaults to hostname)')
      .option(
        '--skip-auth-check',
        'Skip the backend connectivity and sign-in check before entering daemon mode'
      )
      .allowUnknownOption(true)
      .action(async (options: DaemonStartOptions, cmd: Command) => {
        const readiness = await checkDaemonStartReadiness();
        if (await reportDaemonStartBlocked(readiness, { restart: false })) {
          return;
        }

        const passthroughArgs = buildDaemonStartPassthroughArgs(options, cmd.args);
        const platformKind = getCliPlatformKind();

        if (platformKind === 'local' && options.auth) {
          console.error('--auth is not available on the local platform.');
          await exitDaemonCommand(1);
          return;
        }

        // The daemon runner is detached, so a credential problem discovered
        // inside it is invisible. Resolve authentication in this foreground
        // process first — including the interactive device-authorization flow.
        if (platformKind === 'cloud' && (options.auth || !options.skipAuthCheck)) {
          createHybridLogger({ level: 'info' });
          const logger = getLogger('daemon');
          const authClient = new AuthClient(logger);

          if (options.auth) {
            const loginResult = await performLoginWithAuthCredential(authClient, logger, {
              credential: options.auth,
              machineName: options.machineName,
            });
            if (!loginResult.success) {
              captureDaemonEvent('daemon_start_failed', { reason_code: 'auth_credential' });
              console.error(loginResult.error);
              await exitDaemonCommand(1);
              return;
            }
          } else {
            const preflight = await ensureDaemonBackendAuth({
              authClient,
              logger,
              machineName: options.machineName,
            });
            if (preflight.status === 'failed') {
              captureDaemonEvent('daemon_start_failed', { reason_code: preflight.reason });
              console.error(preflight.message);
              console.error(daemonAuthFailureHint(preflight.reason));
              await exitDaemonCommand(1);
              return;
            }
          }
        }

        captureDaemonEvent('daemon_start_requested');
        const result = await startDaemonProcess(passthroughArgs);
        if (result.status === 'missing_child_pid') {
          captureDaemonEvent('daemon_start_failed', { reason_code: 'missing_child_pid' });
          console.error('Failed to start daemon process');
          await exitDaemonCommand(1);
          return;
        }
        if (result.status === 'ownership_conflict') {
          captureDaemonEvent('daemon_start_failed', { reason_code: 'ownership_conflict' });
          console.error(
            `Another local agent Host won the startup race (${result.ownerMode ?? 'unknown'} process ${result.pid}).`
          );
          await exitDaemonCommand(1);
          return;
        }
        if (result.status === 'startup_error') {
          captureDaemonEvent('daemon_start_failed', { reason_code: 'startup_error' });
          console.error(`Daemon startup (runner PID ${result.pid}) failed: ${result.message}`);
          await exitDaemonCommand(1);
          return;
        }
        if (result.status === 'runner_exited') {
          captureDaemonEvent('daemon_start_failed', { reason_code: 'runner_exited' });
          console.error(`Daemon runner (PID ${result.pid}) exited before its worker became ready.`);
          await exitDaemonCommand(1);
          return;
        }
        if (result.status === 'startup_timeout') {
          captureDaemonEvent('daemon_start_failed', { reason_code: 'startup_timeout' });
          console.error(`Daemon worker (PID ${result.pid}) did not become ready in time.`);
          await exitDaemonCommand(1);
          return;
        }

        captureDaemonEvent('daemon_start_succeeded');
        console.log(`Daemon started (PID ${result.pid})`);
        printStartTips();
        await exitDaemonCommand(0);
        return;
      })
  )
  .addCommand(
    new Command('stop').description('Stop the running lody daemon').action(async () => {
      captureDaemonEvent('daemon_stop_requested');
      const result = await stopDaemonProcess();
      captureDaemonEvent('daemon_stop_result', { result: result.status });
      if (result.status === 'not_running') {
        console.log('No daemon PID file found. Daemon is not running.');
        await exitDaemonCommand(0);
        return;
      }
      if (result.status === 'stale_pid_file') {
        console.log(`Daemon ownership is absent; ignoring stale PID record ${result.pid}.`);
        await exitDaemonCommand(0);
        return;
      }
      if (result.status === 'stopped') {
        console.log(`Daemon (PID ${result.pid}) accepted the authenticated shutdown request.`);
        console.log('Daemon stopped successfully.');
        await exitDaemonCommand(0);
        return;
      }
      if (result.status === 'timeout') {
        console.log(
          `Daemon (PID ${result.pid}) is still running. You may need to kill it manually: ${chalk.yellow(`kill -9 ${result.pid}`)}`
        );
        await exitDaemonCommand(1);
        return;
      }
      if (result.status === 'host_mismatch') {
        console.error(
          `Refusing to stop: the local agent Host is owned by ${result.host.mode} process ${result.host.pid}, not the recorded daemon (PID ${result.pid}).`
        );
        await exitDaemonCommand(1);
        return;
      }
      console.error(`Failed to stop daemon: ${result.errorMessage}`);
      await exitDaemonCommand(1);
      return;
    })
  )
  .addCommand(
    new Command('status').description('Show daemon status').action(async () => {
      const host = await inspectLocalCliHost();
      const runtimeState = await fetchCliRuntimeState();
      const runtimeBelongsToDaemon =
        host?.mode === 'daemon' &&
        runtimeState?.supervisor?.instanceId === host.instanceId &&
        runtimeState.supervisor.pid === host.pid &&
        runtimeState.supervisor.launchMode === 'daemon';
      if (host?.mode === 'daemon') {
        captureDaemonEvent('daemon_status_checked', {
          daemon_status: 'running',
          phase: runtimeBelongsToDaemon ? runtimeState.phase : 'starting',
          connectivity: runtimeBelongsToDaemon ? runtimeState.connectivity : undefined,
          active_session_count: runtimeBelongsToDaemon
            ? runtimeState.activeSessionCount
            : undefined,
        });
        console.log(chalk.green('● Daemon is running'));
        console.log(`  PID:          ${host.pid}`);
        console.log(`  Phase:        ${runtimeBelongsToDaemon ? runtimeState.phase : 'starting'}`);
        if (runtimeBelongsToDaemon && runtimeState.startupStage) {
          console.log(`  Stage:        ${runtimeState.startupStage}`);
        }
        if (runtimeBelongsToDaemon && runtimeState.connectivity) {
          console.log(
            `  Connectivity: ${formatDaemonConnectivityStatus(runtimeState.connectivity)}`
          );
        }
        if (runtimeBelongsToDaemon && getCliPlatformKind() === 'cloud') {
          for (const line of formatDaemonBackendStatus(runtimeState)) {
            console.log(line);
          }
        }
        if (runtimeBelongsToDaemon && runtimeState.machineId) {
          console.log(`  Machine ID:   ${runtimeState.machineId}`);
        }
        if (runtimeBelongsToDaemon && runtimeState.activeSessionCount !== undefined) {
          console.log(`  Sessions:     ${runtimeState.activeSessionCount}`);
        }
        if (runtimeBelongsToDaemon && runtimeState.connectedRoomCount !== undefined) {
          console.log(`  Rooms:        ${runtimeState.connectedRoomCount}`);
        }
        if (runtimeBelongsToDaemon && runtimeState.issues.length > 0) {
          console.log(`  Issues:`);
          for (const issue of runtimeState.issues) {
            console.log(`    - [${issue.severity}] ${issue.message}`);
          }
        }
        await exitDaemonCommand(0);
        return;
      }

      if (host) {
        captureDaemonEvent('daemon_status_checked', { daemon_status: 'not_running' });
        console.log(chalk.red('● Daemon is not running'));
        console.log(`  Local agent Host: ${host.mode} process ${host.pid}`);
        await exitDaemonCommand(1);
        return;
      }

      if (runtimeState) {
        captureDaemonEvent('daemon_status_checked', { daemon_status: 'orphan_runtime' });
        console.log(chalk.yellow('● Daemon Host is absent, but an orphan runtime is responding'));
        console.log(`  Runtime PID: ${runtimeState.pid}`);
        await exitDaemonCommand(1);
        return;
      }

      const pidRecord = readPidFileRecord();
      const pid = pidRecord?.pid ?? null;
      if (pid) {
        captureDaemonEvent('daemon_status_checked', { daemon_status: 'stale_pid' });
        console.log(chalk.red('● Daemon is not running (stale PID file)'));
      } else {
        captureDaemonEvent('daemon_status_checked', { daemon_status: 'not_running' });
        console.log(chalk.red('● Daemon is not running'));
      }
      await exitDaemonCommand(1);
      return;
    })
  )
  .addCommand(
    new Command('logs')
      .description('Show daemon logs')
      .option('-n, --lines <count>', 'number of lines to show', '50')
      .action(async (options: { lines: string }) => {
        const lineCount = parseInt(options.lines, 10) || 50;

        try {
          const tail = await readLatestLogTail(LODY_LOG_DIR, lineCount);
          if (!tail) {
            console.log(`No log files found in ${LODY_LOG_DIR}`);
            await exitDaemonCommand(1);
            return;
          }
          console.log(
            chalk.dim(`--- ${LODY_LOG_DIR}/${tail.files.join(', ')} (last ${lineCount} lines) ---`)
          );
          console.log(tail.text);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Failed to read log file: ${message}`);
          await exitDaemonCommand(1);
          return;
        }
        await exitDaemonCommand(0);
        return;
      })
  )
  .addCommand(
    new Command('restart')
      .description('Restart the lody daemon (stop if running, then start)')
      .allowUnknownOption(true)
      .action(async (_options: unknown, cmd: Command) => {
        const passthroughArgs = cmd.args;

        captureDaemonEvent('daemon_restart_requested');
        const runningProbeHealth = await fetchLocalProbeHealth();
        const versionMismatchHealth =
          runningProbeHealth && runningProbeHealth.cliVersion !== version
            ? runningProbeHealth
            : null;
        if (versionMismatchHealth) {
          console.log(
            `Running daemon uses lody v${versionMismatchHealth.cliVersion}; current CLI is v${version}. Restarting with current CLI.`
          );
        }

        const stopResult = await stopDaemonProcess();
        captureDaemonEvent('daemon_stop_result', { result: stopResult.status, via: 'restart' });
        if (stopResult.status === 'not_running') {
          console.log('No daemon was running.');
        } else if (stopResult.status === 'stale_pid_file') {
          console.log(`Daemon ownership was absent; ignored stale PID record ${stopResult.pid}.`);
        } else if (stopResult.status === 'stopped') {
          console.log(
            `Daemon (PID ${stopResult.pid}) accepted the authenticated shutdown request.`
          );
          console.log('Daemon stopped successfully.');
        } else if (stopResult.status === 'timeout') {
          console.log(
            `Daemon (PID ${stopResult.pid}) is still running. You may need to kill it manually: ${chalk.yellow(`kill -9 ${stopResult.pid}`)}`
          );
          await exitDaemonCommand(1);
          return;
        } else if (stopResult.status === 'host_mismatch') {
          console.error(
            `Refusing to stop: the local agent Host is owned by ${stopResult.host.mode} process ${stopResult.host.pid}, not the recorded daemon (PID ${stopResult.pid}).`
          );
          await exitDaemonCommand(1);
          return;
        } else {
          console.error(`Failed to stop daemon: ${stopResult.errorMessage}`);
          await exitDaemonCommand(1);
          return;
        }

        console.log('Starting daemon...');
        const readiness = await checkDaemonStartReadiness();
        if (await reportDaemonStartBlocked(readiness, { restart: true })) {
          return;
        }

        captureDaemonEvent('daemon_start_requested', { via: 'restart' });
        const startResult = await startDaemonProcess(passthroughArgs);
        if (startResult.status === 'missing_child_pid') {
          captureDaemonEvent('daemon_start_failed', {
            reason_code: 'missing_child_pid',
            via: 'restart',
          });
          console.error('Failed to start daemon process');
          await exitDaemonCommand(1);
          return;
        }
        if (startResult.status === 'ownership_conflict') {
          console.error(
            `Another local agent Host won the startup race (${startResult.ownerMode ?? 'unknown'} process ${startResult.pid}).`
          );
          await exitDaemonCommand(1);
          return;
        }
        if (startResult.status === 'startup_error') {
          console.error(
            `Daemon startup (runner PID ${startResult.pid}) failed: ${startResult.message}`
          );
          await exitDaemonCommand(1);
          return;
        }
        if (startResult.status === 'runner_exited') {
          console.error(
            `Daemon runner (PID ${startResult.pid}) exited before its worker became ready.`
          );
          await exitDaemonCommand(1);
          return;
        }
        if (startResult.status === 'startup_timeout') {
          console.error(`Daemon worker (PID ${startResult.pid}) did not become ready in time.`);
          await exitDaemonCommand(1);
          return;
        }

        captureDaemonEvent('daemon_start_succeeded', { via: 'restart' });
        console.log(`Daemon started (PID ${startResult.pid})`);
        printStartTips();
        await exitDaemonCommand(0);
        return;
      })
  );
