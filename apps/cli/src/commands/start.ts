import { Command } from 'commander';
import chalk from 'chalk';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { version } from '@/pkg';
import { Logger, createHybridLogger, getLogger } from '../utils/logger';
import { registerProcessCleanup, reportError, unregisterProcessCleanup } from '../utils/telemetry';
import {
  AuthClient,
  isMachinePairingCredential,
  performLogin,
  performLoginWithAuthCredential,
} from '@/lib/auth';
import { LodyFleet, syncCliServerTime } from '@/lib/lody-fleet';
import { CliType, MachineId } from '@lody/shared';
import { checkClaude, checkCodex } from '@/utils';
import { CliAvailability, resolveCliTypesSelection } from './start-options';
import { CliRuntimeStateReporter } from '@/lib/cli-runtime-state';
import { formatErrorMessage } from '@/utils/format-error';
import { createStartShutdownController } from './start-shutdown';
import {
  LODY_AUTH_SITE_URL,
  LODY_AUTH_URL,
  LODY_SERVER_URL,
  SITE_URL,
  getOrCreateStableMachineIdAsync,
} from '@/utils/const';
import {
  applyLocalPlatformEnv,
  getCliPlatformKind,
  loadOrCreateLocalIdentity,
} from '@/lib/cli-platform';
import { normalizeCurrentProcessResourceProfile } from '@/utils/process-resource-profile';
import { startEventLoopLagMonitor } from '@/utils/event-loop-lag-monitor';
import { flushTelemetry } from '@/instrument';
import { getRuntimeDiagnostics } from '@/utils/runtime-diagnostics';
import {
  EXIT_CODE_AUTH_FAILURE,
  EXIT_CODE_RETRYABLE_STARTUP,
  EXIT_CODE_SUPERVISOR_CONTRACT_MISMATCH,
  type MachineProcessLifecycleAction,
  resolveMachineLifecycleCapability,
} from '@/lib/machine-lifecycle';
import {
  type LocalSupervisorIdentity,
  registerLocalSupervisorControl,
  resolveLocalSupervisorIdentity,
  scrubLocalSupervisorCapabilityEnv,
  toRuntimeSupervisorIdentity,
} from '@/lib/local-supervisor-control';
import {
  acquireLocalCliHostLease,
  type LocalCliHostLease,
} from '@lody/shared/node/local-cli-host-lease';
import { traceAsync } from '@/utils/trace-span';
import {
  captureAgentServiceEvent,
  captureCliActivePing,
  captureCliActiveUser,
  ACTIVE_PING_MIN_INTERVAL_MS,
} from './analytics-events';
import {
  resolveBootstrapLoginFailure,
  resolveRejectedCredentialRecovery,
  type RejectedCredentialRecovery,
} from './start-auth-recovery';
import { consumeElectronBootstrapCredentials } from '../electron-bootstrap-env';
import { createLocalCloudPort, type CloudPort, type PlatformKind } from '@lody/platform';
import { createCloudCliPort } from '@/lib/cloud-cli-port';
import { configureManagedAgentRuntimeManager } from '@/agent/managed-agent-runtime';
import { configureManagedRuntimeUpdateCoordinator } from '@/agent/managed-runtime-update-coordinator';

type StartAuthMethod =
  | 'api_key'
  | 'machine_pairing'
  | 'device_auth'
  | 'electron_session'
  | 'existing_credentials'
  | 'local_platform';

interface StartOptions {
  cliTypes: CliType[];
  debug?: boolean;
  machineName?: string;
  heartbeatLog?: boolean;
  auth?: string;
}

const EXIT_CODE_ALREADY_RUNNING = 3;

function logCliDetectionResults(logger: Logger, availability: CliAvailability): void {
  logger.debug('Local agent auth detection results:');
  logger.debug(`kimi: ${availability.kimi || 'not found'}`);
  logger.debug(`grok: ${availability.grok || 'not found'}`);
  logger.debug(`claude: ${availability.claude || 'not found'}`);
  logger.debug(`codex: ${availability.codex || 'not found'}`);
}

/**
 * 统一的 start 命令
 */
export const startCommand = new Command('start')
  .description('Start agent service in native mode')
  .option('--machine-name <name>', 'Machine name to register (defaults to hostname)')
  .option(
    '--cli-types <types...>',
    'Specify CLI types to register: `kimi`, `grok`, `claude`, or `codex`',
    (value, previous: string[]) => {
      if (!previous) {
        return [value as CliType];
      }
      return previous.concat(value as CliType);
    }
  )
  .option('--debug', 'enable debug output')
  .option('--heartbeat-log', 'output current timestamp every 5 seconds')
  .option('--auth <credential>', 'Connect with a CLI API key or machine connection token')
  .action(async (options: StartOptions) => {
    createHybridLogger({ level: options.debug ? 'debug' : 'info' });
    const logger = getLogger('start');
    const commandActionStartedAt = Date.now();
    logger.debug(
      `[startup] Start action entered processUptimeMs=${Math.round(process.uptime() * 1_000)}`
    );
    const identityResolution = resolveLocalSupervisorIdentity();
    if (identityResolution.status === 'invalid') {
      logger.error(
        `Refusing supervised start: ${identityResolution.reason}. Restart the supervising host with a matching lody release.`
      );
      process.exit(EXIT_CODE_SUPERVISOR_CONTRACT_MISMATCH);
    }
    const supervisorIdentity =
      identityResolution.status === 'supervised' ? identityResolution.identity : null;
    const machineLifecycleCapability = resolveMachineLifecycleCapability(
      supervisorIdentity?.launchMode
    );
    const unregisterStartupSupervisorControl = registerLocalSupervisorControl({
      identity: supervisorIdentity,
      logger,
      shutdown: () => process.exit(0),
    });
    scrubLocalSupervisorCapabilityEnv();
    await traceAsync(logger, 'startup.process_resource_profile', undefined, async () =>
      normalizeCurrentProcessResourceProfile(logger)
    );
    for (const diagnostic of getRuntimeDiagnostics(version)) {
      logger.info(diagnostic);
    }

    if (options.heartbeatLog) {
      logger.info('Heartbeat log mode enabled. Press Ctrl+C to stop.');
      const interval = setInterval(() => {
        logger.info(`heartbeat: ${new Date().toISOString()}`);
      }, 5000);

      const stopHeartbeat = () => {
        clearInterval(interval);
        process.exit(0);
      };
      process.on('SIGINT', stopHeartbeat);
      process.on('SIGTERM', stopHeartbeat);

      await new Promise<void>(() => {});
      return;
    }

    let foregroundHostLease: LocalCliHostLease | null = null;
    if (!supervisorIdentity) {
      const leaseResult = await acquireLocalCliHostLease({
        instanceId: randomUUID(),
        mode: 'foreground',
      });
      if (leaseResult.status === 'occupied') {
        const owner = leaseResult.record
          ? `${leaseResult.record.mode} process ${leaseResult.record.pid}`
          : 'another local CLI host';
        logger.error(`Cannot start: ${owner} already owns the local agent runtime.`);
        process.exit(EXIT_CODE_ALREADY_RUNNING);
      }
      foregroundHostLease = leaseResult.lease;
    }

    let platformKind: ReturnType<typeof getCliPlatformKind>;
    try {
      platformKind = getCliPlatformKind();
    } catch (error) {
      logger.error(formatErrorMessage(error));
      process.exit(1);
    }
    if (platformKind === 'local') {
      // Zero-cloud-I/O invariant (specs/platform-providers.md): blank the
      // cloud endpoints before anything reads them.
      applyLocalPlatformEnv();
      logger.info('Starting in local platform mode (no account, no cloud services).');
    }

    const startupTimeSync =
      platformKind !== 'local' && LODY_SERVER_URL
        ? syncCliServerTime(logger, LODY_SERVER_URL)
        : undefined;

    const machineNameOverride = options.machineName?.trim();
    const defaultMachineName = machineNameOverride || os.hostname();
    const authClient = platformKind === 'cloud' ? new AuthClient(logger) : null;
    const requireCloudAuthClient = (): AuthClient => {
      if (!authClient) {
        throw new Error('Cloud authentication is not available on the local platform');
      }
      return authClient;
    };
    const authFailureExitCode = supervisorIdentity ? EXIT_CODE_AUTH_FAILURE : 1;
    const runtimeStateReporter = new CliRuntimeStateReporter({
      supervisor: toRuntimeSupervisorIdentity(supervisorIdentity),
      trackBackendConnectionAge: platformKind === 'cloud',
    });
    runtimeStateReporter.setStartupStage('bootstrap');
    const electronManaged = supervisorIdentity?.launchMode === 'electron';
    const { sessionToken: electronSessionToken, sessionUserId: electronSessionUserId } =
      consumeElectronBootstrapCredentials(process.env);
    const providedAuth = options.auth?.trim();

    const cliDetectionStartedAt = Date.now();
    const cliAvailability = {
      kimi: 'managed-runtime',
      grok: 'managed-runtime',
      claude: checkClaude(),
      codex: checkCodex(),
    };
    logger.debug(
      `[startup] CLI credential detection durationMs=${Date.now() - cliDetectionStartedAt}`
    );
    logCliDetectionResults(logger, cliAvailability);
    captureAgentServiceEvent('agent_service_cli_detection', {
      kimi_available: true,
      grok_available: true,
      claude_available: Boolean(cliAvailability.claude),
      codex_available: Boolean(cliAvailability.codex),
    });

    // Electron can persist the browser session token before the host-managed
    // user id is hydrated. Resolve the user from Better Auth directly so we
    // still detect stale CLI credentials during first-login bootstrap.
    const electronSessionUser =
      platformKind !== 'local' && electronSessionToken && !electronSessionUserId
        ? await traceAsync(
            logger,
            'startup.electron_session_user',
            undefined,
            async () =>
              await requireCloudAuthClient().getSessionUserFromSessionToken(electronSessionToken)
          )
        : null;
    const resolvedElectronSessionUserId = electronSessionUserId || electronSessionUser?.id || null;

    const cliSelection = resolveCliTypesSelection({
      requestedCliTypes: options.cliTypes,
      availability: cliAvailability,
    });

    if (cliSelection.invalid.length > 0) {
      logger.error(
        `Unknown CLI types: ${cliSelection.invalid.join(', ')}. Supported values: kimi, grok, claude, codex.`
      );
      process.exit(1);
    }

    if (cliSelection.missing.length > 0) {
      logger.warn(
        `Builtin agent configs remain available, but local auth files are missing for: ${cliSelection.missing.join(
          ', '
        )}.`
      );
    }
    options.cliTypes = cliSelection.cliTypes;

    const completeBootstrapLogin = async () => {
      if (!electronSessionToken) {
        return null;
      }

      logger.debug('Found Electron session token, bootstrapping CLI credentials...');
      const loginResult = await traceAsync(
        logger,
        'startup.electron_bootstrap_login',
        undefined,
        async () =>
          await requireCloudAuthClient().bootstrapFromSessionToken(
            electronSessionToken,
            defaultMachineName
          )
      );
      if (!loginResult.success) {
        const recovery = resolveBootstrapLoginFailure({
          electronManaged,
          authFailureExitCode,
        });
        if (recovery.exitCode === EXIT_CODE_RETRYABLE_STARTUP) {
          logger.warn(
            `Electron bootstrap login failed; retrying with a fresh desktop session: ${loginResult.error}`
          );
          await flushTelemetry();
          process.exit(recovery.exitCode);
        }
        logger.error(`Electron bootstrap login failed: ${loginResult.error}`);
        process.exit(recovery.exitCode);
      }

      logger.success('Login successful via Electron session.');
      return {
        token: loginResult.token,
        userId: loginResult.user.id,
        machineId: loginResult.machine.machineId,
        machineName: loginResult.machine.machineName,
      };
    };

    runtimeStateReporter.setStartupStage('auth');

    // Restore cached identity for local-first startup. The workspace
    // subscription is the single remote authentication/authorization check.
    let token: string;
    let userId: string;
    let machineId: string;
    let machineName: string;
    let authMethod: StartAuthMethod = 'existing_credentials';
    const existingAuth = authClient?.getAuthInfo() ?? null;

    if (options.auth !== undefined && !providedAuth) {
      logger.error('Missing credential for --auth.');
      process.exit(1);
    }
    if (platformKind === 'local' && options.auth !== undefined) {
      logger.error('--auth is not available on the local platform.');
      process.exit(1);
    }

    if (platformKind === 'local') {
      // No account exists on the local platform: author everything under the
      // persisted synthetic identity. The empty token is safe because every
      // cloud endpoint env was blanked above, so token consumers are inert.
      const localIdentity = await loadOrCreateLocalIdentity(logger);
      token = '';
      userId = localIdentity.userId;
      machineId = await getOrCreateStableMachineIdAsync();
      machineName = defaultMachineName;
      authMethod = 'local_platform';
    } else if (providedAuth) {
      const loginResult = await performLoginWithAuthCredential(requireCloudAuthClient(), logger, {
        credential: providedAuth,
        machineName: defaultMachineName,
      });
      if (!loginResult.success) {
        logger.error(`Login failed: ${loginResult.error}`);
        process.exit(authFailureExitCode);
      }

      token = loginResult.token;
      userId = loginResult.user.id;
      machineId = loginResult.machine.machineId;
      machineName = loginResult.machine.machineName;
      authMethod = isMachinePairingCredential(providedAuth) ? 'machine_pairing' : 'api_key';
      logger.success('Login successful via --auth.');
    } else if (existingAuth) {
      const cachedElectronUserMismatch =
        !!electronSessionToken &&
        resolvedElectronSessionUserId !== null &&
        existingAuth.user.id !== resolvedElectronSessionUserId;

      if (!cachedElectronUserMismatch) {
        logger.debug('Found existing authentication; restoring cached local identity');
        token = existingAuth.token;
        userId = existingAuth.user.id;
        machineId = existingAuth.machine.machineId;
        machineName = defaultMachineName;
        authMethod = 'existing_credentials';
      } else {
        logger.warn(
          'Existing CLI credentials belong to a different account than the desktop session — re-authenticating.'
        );
        const bootstrap = await completeBootstrapLogin();
        if (bootstrap) {
          token = bootstrap.token;
          userId = bootstrap.userId;
          machineId = bootstrap.machineId;
          machineName = bootstrap.machineName;
          authMethod = 'electron_session';
        } else {
          logger.error('Electron account mismatch could not be repaired.');
          process.exit(authFailureExitCode);
        }
      }
    } else {
      const bootstrap = await completeBootstrapLogin();
      if (bootstrap) {
        token = bootstrap.token;
        userId = bootstrap.userId;
        machineId = bootstrap.machineId;
        machineName = bootstrap.machineName;
        authMethod = 'electron_session';
      } else if (electronManaged) {
        logger.info(
          'Electron session is not ready yet (no CLI credentials and no desktop session token). Exiting so the desktop app can retry.'
        );
        process.exit(EXIT_CODE_RETRYABLE_STARTUP);
      } else {
        if (supervisorIdentity?.launchMode === 'daemon') {
          logger.error('Daemon credentials are missing. Run `lody login` before starting it.');
          process.exit(EXIT_CODE_AUTH_FAILURE);
        }
        logger.debug('No existing authentication found, initiating login...');
        const loginResult = await performLogin(requireCloudAuthClient(), logger, {
          machineName: defaultMachineName,
        });
        if (!loginResult.success) {
          logger.error(`Login failed: ${loginResult.error}`);
          process.exit(authFailureExitCode);
        }
        token = loginResult.token;
        userId = loginResult.user.id;
        machineId = loginResult.machine.machineId;
        machineName = loginResult.machine.machineName;
        authMethod = 'device_auth';
        logger.success('Login successful!');
      }
    }

    runtimeStateReporter.setMachineId(machineId as MachineId);
    logger.debug(
      `[startup] Authentication ready method=${authMethod} actionDurationMs=${
        Date.now() - commandActionStartedAt
      }`
    );

    const recoverRejectedCredential = async (): Promise<RejectedCredentialRecovery> => {
      const cleanup = requireCloudAuthClient().clearRejectedToken(token);
      const recovery = resolveRejectedCredentialRecovery({
        cleanup,
        electronManaged,
        authFailureExitCode,
      });

      if (cleanup === 'not_current') {
        logger.info('Rejected CLI credential was already rotated; restarting with the new value.');
      } else if (cleanup === 'failed') {
        logger.error('Failed to clear the rejected CLI credential; automatic recovery is unsafe.');
      } else if (recovery.exitCode === EXIT_CODE_RETRYABLE_STARTUP) {
        logger.warn(
          'Rejected CLI credential cleared; restarting so Electron can provide a fresh session and request a replacement.'
        );
      }

      return recovery;
    };

    try {
      await startAgentService(
        options,
        token,
        userId,
        machineName,
        machineId,
        cliSelection.configuredCliTypes,
        logger,
        runtimeStateReporter,
        authMethod,
        startupTimeSync,
        recoverRejectedCredential,
        foregroundHostLease,
        supervisorIdentity,
        machineLifecycleCapability,
        unregisterStartupSupervisorControl,
        platformKind
      );
    } catch (error) {
      captureAgentServiceEvent('agent_service_startup_failed', {
        failure_stage: runtimeStateReporter.snapshot().startupStage ?? 'unknown',
      });
      runtimeStateReporter.upsertIssue({
        code: 'service_start_failed',
        severity: 'fatal',
        recoverable: false,
        message: formatErrorMessage(error),
      });
      await reportError('start', error, {
        message: 'Service error',
        logger,
      });
      await flushTelemetry();
      process.exit(1);
    }
  });

/**
 * 启动代理服务（前台模式）
 */
async function startAgentService(
  options: StartOptions,
  token: string,
  userId: string,
  machineName: string,
  machineId: string,
  builtinAgentConfigCliTypes: CliType[],
  logger: Logger,
  runtimeStateReporter: CliRuntimeStateReporter,
  authMethod: StartAuthMethod,
  startupTimeSync: Promise<void> | undefined,
  recoverRejectedCredential: () => Promise<RejectedCredentialRecovery>,
  foregroundHostLease: LocalCliHostLease | null,
  supervisorIdentity: LocalSupervisorIdentity | null,
  machineLifecycleCapability: ReturnType<typeof resolveMachineLifecycleCapability>,
  unregisterStartupSupervisorControl: () => void,
  platformKind: PlatformKind
): Promise<void> {
  // The startup listener protects authentication/bootstrap. From this point to
  // the graceful controller registration below there is no async yield.
  unregisterStartupSupervisorControl();
  logger.info(`Starting agent service...`);

  // `app/active` distinct_id is the machine_id (non-PII) for cross-client DAU.
  const serviceStartMs = Date.now();
  let activePingTimer: ReturnType<typeof setInterval> | null = null;
  const stopActivePing = () => {
    if (activePingTimer) {
      clearInterval(activePingTimer);
      activePingTimer = null;
    }
  };

  const startupStartMs = Date.now();
  logger.debug('Initializing workspace fleet...');
  runtimeStateReporter.setStartupStage('fleet-start');

  // Set lazily below so the fleet can reference a handler that calls
  // `shutdownController.shutdown()`, which has to be created after the
  // fleet itself. Guarded by `fatalAuthTriggered` so concurrent workers
  // (multiple workspaces hitting 403 at once) only trigger shutdown once.
  let fatalAuthTriggered = false;
  let triggerFatalAuthShutdown: ((error: Error) => void) | null = null;
  let processLifecycleTriggered = false;
  let triggerProcessLifecycleAction: ((action: MachineProcessLifecycleAction) => void) | null =
    null;

  let cloudPort: CloudPort;
  if (platformKind === 'local') {
    cloudPort = createLocalCloudPort({
      identity: { userId },
      workspaces: [],
      runtimeArtifactsBaseUrl: process.env.LODY_RUNTIME_BASE_URL,
    });
  } else {
    if (!LODY_AUTH_URL) {
      throw new Error('Cloud platform startup requires LODY_AUTH_URL');
    }
    if (!LODY_SERVER_URL) {
      throw new Error('Cloud platform startup requires LODY_SERVER_URL');
    }
    cloudPort = createCloudCliPort({
      identity: { userId },
      token,
      authBaseUrl: LODY_AUTH_URL,
      authSiteUrl: LODY_AUTH_SITE_URL,
      serverBaseUrl: LODY_SERVER_URL,
      previewGatewayUrl: process.env.LODY_PREVIEW_GATEWAY_URL,
      runtimeArtifactsBaseUrl: process.env.LODY_RUNTIME_BASE_URL,
      logger,
    });
  }

  const managedRuntimeManager = configureManagedAgentRuntimeManager({
    runtimeBaseUrl: cloudPort.runtimeArtifacts.baseUrl,
  });

  let fleet: LodyFleet;
  const managedRuntimeUpdates = configureManagedRuntimeUpdateCoordinator({
    manager: managedRuntimeManager,
    logger,
  });
  try {
    await managedRuntimeManager.prepareCache();
    await managedRuntimeUpdates.start();
    fleet = new LodyFleet({
      logger,
      builtinAgentConfigCliTypes,
      cliToken: token,
      userId,
      machineId: machineId as MachineId,
      machineName,
      runtimeStateReporter,
      cloudPort,
      startupTimeSync,
      machineLifecycleCapability,
      onFatalAuthFailure: (error) => triggerFatalAuthShutdown?.(error),
      onProcessLifecycleAction: (action) => triggerProcessLifecycleAction?.(action),
    });
  } catch (error) {
    await managedRuntimeUpdates.shutdown();
    await cloudPort.dispose();
    throw error;
  }
  const eventLoopLagMonitor = startEventLoopLagMonitor(logger, { label: 'lody start' });
  const closeForegroundHostLease = async () => {
    const lease = foregroundHostLease;
    foregroundHostLease = null;
    await lease?.close();
  };
  registerProcessCleanup(async () => {
    eventLoopLagMonitor.stop();
    await managedRuntimeUpdates.shutdown();
    await fleet.shutdown();
    await closeForegroundHostLease();
  });
  const shutdownSignals: NodeJS.Signals[] =
    process.platform === 'win32'
      ? ['SIGINT', 'SIGTERM', 'SIGBREAK']
      : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
  let unregisterSupervisorControl = () => {};

  const shutdownController = createStartShutdownController({
    signals: shutdownSignals,
    logger,
    shutdown: async () => {
      unregisterSupervisorControl();
      unregisterProcessCleanup();
      stopActivePing();
      eventLoopLagMonitor.stop();
      await managedRuntimeUpdates.shutdown();
      await fleet.shutdown();
      await closeForegroundHostLease();
    },
    flushTelemetry: async () => {
      captureAgentServiceEvent('agent_service_shutdown', {
        uptime_ms: Date.now() - serviceStartMs,
        auth_method: authMethod,
      });
      await flushTelemetry();
    },
    exit: (code) => process.exit(code),
  });
  shutdownController.register();
  unregisterSupervisorControl = registerLocalSupervisorControl({
    identity: supervisorIdentity,
    logger,
    shutdown: (reason) => {
      void shutdownController.shutdown({ reason });
    },
  });

  triggerFatalAuthShutdown = (error) => {
    if (fatalAuthTriggered) return;
    fatalAuthTriggered = true;
    captureAgentServiceEvent('agent_service_fatal_auth_failure');
    logger.error('Remote authentication rejected the CLI credential.', error);
    runtimeStateReporter.upsertIssue({
      code: 'auth_token_invalid',
      severity: 'fatal',
      recoverable: false,
      message: 'CLI token is invalid or has been revoked.',
    });
    void recoverRejectedCredential()
      .catch((recoveryError: unknown): RejectedCredentialRecovery => {
        logger.error(
          `Failed to recover rejected CLI credential: ${formatErrorMessage(recoveryError)}`
        );
        return {
          exitCode: supervisorIdentity ? EXIT_CODE_AUTH_FAILURE : 1,
          reason: 'credential recovery failed',
        };
      })
      .then(async (recovery) => {
        await shutdownController.shutdown(recovery);
      });
  };

  triggerProcessLifecycleAction = (action) => {
    if (processLifecycleTriggered || fatalAuthTriggered) return;
    processLifecycleTriggered = true;
    logger.info(
      `Machine lifecycle ${action.action} requested; shutting down worker with exit code ${action.exitCode}.`
    );
    void shutdownController.shutdown({
      exitCode: action.exitCode,
      reason: `machine ${action.action} requested`,
    });
  };

  try {
    logger.debug('Subscribing to workspaces and connecting agent runtimes...');
    const connectStartMs = Date.now();
    await fleet.start();
    logger.debug(`Workspace fleet started (${Date.now() - connectStartMs}ms)`);
    logger.debug(`Agent startup completed in ${Date.now() - startupStartMs}ms`);

    const startupSnapshot = runtimeStateReporter.snapshot();
    captureAgentServiceEvent('agent_service_started', {
      auth_method: authMethod,
      // Best-effort: the workspace subscription may still be populating right
      // after fleet.start(); connected rooms approximate workspace count.
      workspace_count: startupSnapshot.connectedRoomCount,
      builtin_agent_config_cli_types: builtinAgentConfigCliTypes,
      startup_duration_ms: Date.now() - startupStartMs,
    });
    captureCliActiveUser({ auth_method: authMethod });

    // app/active_ping: emit while the service is doing work (>=1 active
    // session). >=60s interval (tier C), idle-stop (skipped when no active
    // session) so an idle daemon does not generate a steady ping stream.
    activePingTimer = setInterval(() => {
      const snapshot = runtimeStateReporter.snapshot();
      if ((snapshot.activeSessionCount ?? 0) <= 0) return;
      captureCliActivePing({
        active_context: 'cli_agent_service',
        active_session_count: snapshot.activeSessionCount,
        connected_room_count: snapshot.connectedRoomCount,
      });
    }, ACTIVE_PING_MIN_INTERVAL_MS);
    activePingTimer.unref?.();

    if (platformKind === 'local') {
      logger.success('✨ Local agent service is ready. Open the Lody OSS app to chat.');
    } else {
      const chatUrl = SITE_URL.replace(/\/+$/, '');
      logger.success(`✨ Happy coding! You can now chat with your agents at ${chatUrl}`);
    }
    logger.info(`Press ${chalk.yellow('Ctrl+C')} to stop`);

    // 保持进程活跃
    await new Promise<void>(() => {});
  } catch (error) {
    unregisterSupervisorControl();
    runtimeStateReporter.upsertIssue({
      code: 'agent_service_failed',
      severity: 'fatal',
      recoverable: false,
      message: formatErrorMessage(error),
    });
    shutdownController.unregister();
    unregisterProcessCleanup();
    stopActivePing();
    eventLoopLagMonitor.stop();
    await managedRuntimeUpdates.shutdown();
    await fleet.shutdown().catch((err: unknown) => {
      logger.error('Cleanup failed:', err);
    });
    await closeForegroundHostLease();
    await reportError('start:agent', error, {
      message: 'Agent service failed to start',
      logger,
    });
    throw error;
  }
}
