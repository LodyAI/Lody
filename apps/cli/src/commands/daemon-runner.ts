import fs from 'node:fs/promises';
import { isDaemonVersionDowngrade, type ManagedDaemonUpgradeOptions } from '@lody/shared';
import {
  getCliNodeExecutable,
  getSeaContext,
  readSelectedInstallation,
  prepareManagedRelease,
  checkInstallationFiles,
  installationForRelease,
  installFixedServiceEntry,
  managedDaemonRoot,
  npmMigrationTrust,
  publishManagedInstallation,
  verifyDaemonRelease,
  type ReleaseTrust,
  readManagedOperation,
  saveManagedOperation,
  writeManagedRecord,
  type ManagedInstallation,
} from '@/lib/managed-daemon-release';
import { ManagedPrepareRequestSchema } from '@/lib/managed-daemon-ipc';
import { canRelayNpmInstallation, relayToManagedService } from '@/lib/managed-daemon-migration';
import { getCliPlatformKind } from '@/lib/cli-platform';
import path from 'node:path';
import { runCommandTextLegacy } from '@lody/shared/node/process';
import { z } from 'zod';
import { toShared } from '@/platform/process-options';
import { Command } from 'commander';
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
import { startProcessLegacy, type ProcessHandleLegacy } from '@lody/shared/node/process';

import {
  EXIT_CODE_REMOTE_RESTART,
  EXIT_CODE_REMOTE_UPGRADE,
  EXIT_CODE_AUTH_FAILURE,
  EXIT_CODE_RETRYABLE_STARTUP,
  EXIT_CODE_SUPERVISOR_CONTRACT_MISMATCH,
  LODY_DAEMON_SUPERVISED_ENV,
} from '@/lib/machine-lifecycle';
import {
  describeDaemonWorkerStartupFailure,
  isDaemonWorkerReady,
  isRetryableDaemonWorkerStartupExit,
  startManagedWorkerReadinessDeadline,
} from './daemon-runner-startup';

function launchLodyStart(
  passthroughArgs: string[],
  identity: { instanceId: string; token: string },
  managed?: {
    installation: ManagedInstallation;
    prepare: (
      requestId: string,
      target: string,
      upgrade?: ManagedDaemonUpgradeOptions
    ) => Promise<string>;
    drained: () => void;
    terminationFailed: () => void;
    candidate: boolean;
  }
): LaunchHandle & Pick<ProcessHandleLegacy, 'terminate'> {
  const bin = managed?.installation.bin ?? resolveLodyBin();
  const args = [
    `--max-old-space-size=${DAEMON_WORKER_MAX_OLD_SPACE_MB}`,
    bin,
    'start',
    ...passthroughArgs,
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [LODY_DAEMON_SUPERVISED_ENV]: '1',
    ...(managed
      ? {
          LODY_MANAGED_DAEMON_PROTOCOL: '1',
          ...(managed.candidate ? { LODY_MANAGED_CANDIDATE: '1' } : {}),
        }
      : {}),
    [LODY_SUPERVISOR_CONTRACT_ENV]: LOCAL_CLI_SUPERVISOR_CONTRACT_VERSION,
    [LODY_SUPERVISOR_PID_ENV]: String(process.pid),
    [LODY_SUPERVISOR_INSTANCE_ID_ENV]: identity.instanceId,
    [LODY_SUPERVISOR_TOKEN_ENV]: identity.token,
  };
  delete env.LODY_ELECTRON_BOOTSTRAP;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env[DAEMON_RUNNER_READY_FD_ENV];
  // The Worker stays in the watchdog's process group: the Supervisor owns its
  // shutdown through `requestShutdown` and signals to the exact child.
  const handle = startProcessLegacy(
    {
      command: managed?.installation.node ?? getCliNodeExecutable(),
      args,
      options: {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env,
        windowsHide: true,
      },
      processGroup: managed !== undefined,
    },
    toShared()
  );

  const { child } = handle;
  if (managed)
    child.on('message', (message: unknown) => {
      const cancel = z
        .object({
          type: z.literal('lody/managed-cancel'),
          requestId: z.string(),
          supervisorToken: z.string(),
        })
        .strict()
        .safeParse(message);
      if (cancel.success && cancel.data.supervisorToken === identity.token)
        void readManagedOperation()
          .then(async (operation) => {
            if (operation?.requestId === cancel.data.requestId && operation.phase === 'waiting')
              await saveManagedOperation({ ...operation, phase: 'failed' });
          })
          .catch(() => {});
      const receipt = z
        .object({ type: z.literal('lody/managed-drained'), instanceId: z.string() })
        .strict()
        .safeParse(message);
      if (receipt.success && receipt.data.instanceId === identity.instanceId) managed.drained();
      const request = ManagedPrepareRequestSchema.safeParse(message);
      if (!request.success || request.data.supervisorToken !== identity.token) return;
      void managed.prepare(request.data.requestId, request.data.target, request.data.upgrade).then(
        (version) => {
          if (child.connected)
            child.send(
              {
                type: 'lody/managed-prepared',
                requestId: request.data.requestId,
                ok: true,
                version,
              },
              () => {}
            );
        },
        (error) => {
          if (child.connected)
            child.send(
              {
                type: 'lody/managed-prepared',
                requestId: request.data.requestId,
                ok: false,
                error: error instanceof Error ? error.message : 'Preparation failed',
              },
              () => {}
            );
        }
      );
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
      if (managed) {
        void handle.terminate({ graceMs: 2000, killWaitMs: 5000 }).then(
          () => complete(code, signal),
          (error) => {
            managed.terminationFailed();
            reject(error);
          }
        );
      } else complete(code, signal);
    });
    const complete = (code: number | null, signal: NodeJS.Signals | null) => {
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
    };
  });

  return {
    child,
    result,
    terminate: (policy) => handle.terminate(policy),
    processGroup: managed !== undefined,
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
    const sea = getSeaContext();
    // A POSIX npm installation speaks the managed Worker protocol so a remote
    // update can relay it to the managed service. Windows lacks containment.
    const npmMigration = !sea && canRelayNpmInstallation(process.env, process.platform);
    const npmProduct = getCliPlatformKind() === 'cloud' ? 'lody-cloud' : 'lody-oss';
    const releaseTrust = (upgrade?: ManagedDaemonUpgradeOptions): ReleaseTrust =>
      sea ?? npmMigrationTrust(npmProduct, upgrade?.channel ?? 'stable');
    let installation: ManagedInstallation | undefined = sea
      ? await readSelectedInstallation(sea)
      : npmMigration
        ? { version, bin: resolveLodyBin(), node: getCliNodeExecutable() }
        : undefined;
    let previousInstallation = installation;
    let drainConfirmed = false;
    let observing = false;
    let rollingBack = false;
    let committing = false;
    let commitTask: Promise<void> | undefined;
    let candidateDeadline: ReturnType<typeof startManagedWorkerReadinessDeadline> | undefined;
    let deadlineTask: Promise<void> | undefined;
    let managedChild: LaunchHandle['child'] | undefined;
    let preparing: Promise<string> | null = null;
    let preparationId: string | null = null;
    let preparationIntent: string | null = null;
    const preparationAbort = new AbortController();
    let localUpgrade:
      | ((request: {
          requestId: string;
          targetVersion: string;
          upgrade: ManagedDaemonUpgradeOptions;
        }) => Promise<void>)
      | undefined;
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
        ...(sea
          ? {
              onUpgrade: (request: {
                requestId: string;
                targetVersion: string;
                upgrade: ManagedDaemonUpgradeOptions;
              }) =>
                localUpgrade
                  ? localUpgrade(request)
                  : Promise.reject(new Error('Managed service is not ready')),
            }
          : {}),
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

    const prepare = async (
      requestId: string,
      target: string,
      upgrade?: ManagedDaemonUpgradeOptions
    ): Promise<string> => {
      if ((!sea && !npmMigration) || !installation || process.platform === 'win32')
        throw new Error('Managed update is unsupported on this installation');
      if (committing) throw new Error('An update commit is still in progress');
      const intent = JSON.stringify({ target, upgrade });
      if (preparing) {
        if (requestId !== preparationId) throw new Error('Another machine update is pending');
        if (intent !== preparationIntent)
          throw new Error('Update operation ID is bound to a different intent');
        return preparing;
      }
      preparationId = requestId;
      preparationIntent = intent;
      preparing = (async () => {
        const prior = await readManagedOperation(requestId);
        if (
          prior &&
          (prior.requestedTarget !== target ||
            JSON.stringify(prior.upgrade) !== JSON.stringify(upgrade))
        )
          throw new Error('Update operation ID is bound to a different intent');
        if (prior && ['applied', 'rolled-back', 'failed', 'blocked'].includes(prior.phase))
          throw new Error(
            'This update operation already has a durable outcome; query it instead of replaying'
          );
        const existing = await readManagedOperation();
        if (existing && !['applied', 'rolled-back', 'failed'].includes(existing.phase)) {
          if (existing.requestId === requestId && existing.phase === 'waiting')
            return existing.targetVersion;
          throw new Error('A durable machine update is pending; inspect daemon update status');
        }
        const preparationChild = managedChild;
        const preparationSignal = AbortSignal.any([
          preparationAbort.signal,
          AbortSignal.timeout(8 * 60_000),
        ]);
        const expiresAtMs = Date.now() + 24 * 60 * 60_000;
        const ownerState = await fetchCliRuntimeState({ timeoutMs: 1500 });
        if (
          !ownerState?.machineId ||
          ownerState.pid !== managedChild?.pid ||
          ownerState.supervisor?.instanceId !== supervisorIdentity.instanceId
        )
          throw new Error('Current daemon ownership could not be confirmed before preparation');
        const machineId = ownerState.machineId;
        const result = await prepareManagedRelease(releaseTrust(upgrade), target, {
          baseUrl: process.env.LODY_RUNTIME_BASE_URL,
          signal: preparationSignal,
          onResolved: async (release) => {
            // These options were bound into the requester proof before preparation.
            if (upgrade && upgrade.channel !== release.channel)
              throw new Error('Authorized channel differs from release');
            if (
              release.channel !==
                (installation?.channel ?? sea?.metadata.channel ?? release.channel) &&
              !upgrade?.confirmChannelChange
            )
              throw new Error('Channel change requires explicit confirmation');
            if (
              installation &&
              isDaemonVersionDowngrade(installation.version, release.version) &&
              !upgrade?.confirmDowngrade
            )
              throw new Error('Downgrade requires explicit confirmation and compatible data');
            await saveManagedOperation({
              format: 1,
              requestId,
              machineId,
              serviceInstanceId: supervisorIdentity.instanceId,
              targetVersion: release.version,
              releaseDigest: release.capsule.contentSha256,
              previousVersion: installation?.version ?? version,
              requestedTarget: target,
              upgrade,
              expiresAtMs,
              phase: 'preparing',
            });
          },
        });
        const extracted = await runCommandTextLegacy(
          {
            command: result.capsule,
            args: ['__sea-extract'],
            timeout: 60000,
            maxOutputBytes: 65536,
            abandonPolicy: { graceMs: 2000, killWaitMs: 5000 },
            check: 'exit-0',
            env: process.env,
          },
          toShared({ signal: preparationSignal })
        );
        const details = z
          .object({
            releaseDir: z.string(),
            metadata: z.object({
              product: z.string(),
              version: z.string(),
              platform: z.string(),
              payloadSha256: z.string(),
              node: z.object({ sha256: z.string() }),
            }),
          })
          .parse(JSON.parse(extracted.stdout));
        const expected = installationForRelease(result.release);
        if (
          details.releaseDir !== path.dirname(expected.bin) ||
          details.metadata.product !== result.release.product ||
          details.metadata.version !== result.release.version ||
          details.metadata.platform !== result.release.platform ||
          details.metadata.payloadSha256 !== result.release.payloadSha256 ||
          details.metadata.node.sha256 !== result.release.node.contentSha256
        )
          throw new Error('Extracted release identity mismatch');
        await checkInstallationFiles(result.release);
        await runCommandTextLegacy(
          {
            command: result.capsule,
            args: ['__sea-native-probe'],
            timeout: 30000,
            maxOutputBytes: 8192,
            abandonPolicy: { graceMs: 2000, killWaitMs: 5000 },
            check: 'exit-0',
            env: process.env,
          },
          toShared({ signal: preparationSignal })
        );
        const probeDirectory = await fs.mkdtemp(path.join(managedDaemonRoot(), 'probe-'));
        try {
          const probeEnv = { ...process.env, LODY_DATA_DIR: probeDirectory };
          const nodeProbe = await runCommandTextLegacy(
            {
              command: expected.node,
              args: ['--version'],
              timeout: 5000,
              maxOutputBytes: 8192,
              abandonPolicy: { graceMs: 2000, killWaitMs: 5000 },
              check: 'exit-0',
              env: probeEnv,
            },
            toShared({ signal: preparationSignal })
          );
          if (nodeProbe.stdout.trim() !== `v${result.release.nodeVersion}`)
            throw new Error('Managed Node version mismatch');
          const cliProbe = await runCommandTextLegacy(
            {
              command: expected.node,
              args: [expected.bin, '--version'],
              timeout: 30000,
              maxOutputBytes: 8192,
              abandonPolicy: { graceMs: 2000, killWaitMs: 5000 },
              check: 'exit-0',
              env: probeEnv,
            },
            toShared({ signal: preparationSignal })
          );
          if (cliProbe.stdout.trim() !== result.release.version)
            throw new Error('Bundled CLI version mismatch');
          await runCommandTextLegacy(
            {
              command: expected.node,
              args: [path.join(path.dirname(expected.bin), '__managed-probe.mjs')],
              timeout: 30000,
              maxOutputBytes: 8192,
              abandonPolicy: { graceMs: 2000, killWaitMs: 5000 },
              check: 'exit-0',
              env: probeEnv,
            },
            toShared({ signal: preparationSignal })
          );
        } finally {
          await fs.rm(probeDirectory, { recursive: true, force: true });
        }
        preparationSignal.throwIfAborted();
        if (
          !preparationChild ||
          managedChild !== preparationChild ||
          preparationChild.exitCode !== null ||
          preparationChild.signalCode !== null
        )
          throw new Error(
            'Preparing Worker exited; the old operation cannot switch a replacement Worker'
          );
        await saveManagedOperation({
          format: 1,
          requestId,
          machineId,
          serviceInstanceId: supervisorIdentity.instanceId,
          targetVersion: result.release.version,
          releaseDigest: result.release.capsule.contentSha256,
          previousVersion: installation?.version ?? version,
          requestedTarget: target,
          upgrade,
          expiresAtMs,
          phase: 'waiting',
        });
        return result.release.version;
      })();
      try {
        return await preparing;
      } catch (error) {
        const operation = await readManagedOperation(requestId);
        if (operation?.phase === 'preparing')
          await saveManagedOperation({ ...operation, phase: 'failed' });
        throw error;
      } finally {
        preparing = null;
        preparationId = null;
        preparationIntent = null;
      }
    };
    localUpgrade = async (request) => {
      await prepare(request.requestId, request.targetVersion, request.upgrade);
      if (!managedChild?.connected)
        throw new Error('Managed Worker is unavailable; prepared update was not applied');
      const child = managedChild;
      await new Promise<void>((resolve, reject) =>
        child.send(
          {
            type: 'lody/managed-local-upgrade',
            token: supervisorIdentity.token,
            requestId: request.requestId,
            upgrade: request.upgrade,
          },
          (error) => (error ? reject(error) : resolve())
        )
      );
    };
    const previousOperation = sea || npmMigration ? await readManagedOperation() : null;
    if (previousOperation && ['preparing', 'waiting', 'prepared'].includes(previousOperation.phase))
      await saveManagedOperation({ ...previousOperation, phase: 'failed' });
    if (
      sea &&
      previousOperation &&
      ['switching', 'observing', 'rollback-stop', 'blocked'].includes(previousOperation.phase)
    ) {
      await saveManagedOperation({ ...previousOperation, phase: 'blocked' });
      logger.error(
        'Interrupted managed update: descendant ownership needs explicit recovery; no replacement was started.'
      );
      hostShutdownHandler = () =>
        logger.error(
          'Recovery remains blocked; disable autostart and follow the documented local reboot-and-archive recovery before reinstalling.'
        );
      return;
    }
    /** npm → managed relay after an authorized, drained remote update. See managed-daemon-migration.ts. */
    const relayNpmInstallation = async (): Promise<{
      action: 'stop' | 'restart' | 'fatal';
      message: string;
    }> => {
      const operation = await readManagedOperation();
      if (
        operation?.phase === 'waiting' &&
        operation.expiresAtMs !== undefined &&
        Date.now() >= operation.expiresAtMs
      ) {
        await saveManagedOperation({ ...operation, phase: 'failed' });
        return { action: 'restart', message: 'Prepared update expired; npm daemon keeps running' };
      }
      if (!operation || operation.phase !== 'waiting' || !drainConfirmed) {
        if (operation) await saveManagedOperation({ ...operation, phase: 'failed' });
        return {
          action: 'restart',
          message: 'Update has no confirmed drain; npm daemon keeps running',
        };
      }
      const releaseDir = path.join(managedDaemonRoot(), 'releases', operation.releaseDigest);
      let targetVersion: string;
      try {
        const release = verifyDaemonRelease(
          await fs.readFile(path.join(releaseDir, 'manifest.json'), 'utf8'),
          releaseTrust(operation.upgrade).metadata
        );
        await checkInstallationFiles(release);
        targetVersion = release.version;
      } catch (error) {
        await saveManagedOperation({ ...operation, phase: 'failed' });
        return {
          action: 'restart',
          message: `Prepared release is unusable; npm daemon keeps running: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const outcome = await relayToManagedService({
        installFixedEntry: () =>
          installFixedServiceEntry(
            path.join(releaseDir, process.platform === 'win32' ? 'daemon.exe' : 'daemon')
          ),
        selectRelease: () =>
          writeManagedRecord(path.join(managedDaemonRoot(), 'selected.json'), {
            format: 1,
            digest: operation.releaseDigest,
          }),
        recordPhase: (phase) => saveManagedOperation({ ...operation, phase }),
        releaseOwnership: async () => {
          removePidFile(pidRecord);
          const lease = hostLease;
          hostLease = null;
          await lease?.close();
        },
        reclaimOwnership: async () => {
          const result = await acquireLocalCliHostLease({
            instanceId: supervisorIdentity.instanceId,
            mode: 'daemon',
            shutdownControl: {
              token: supervisorIdentity.token,
              onRequest: () => requestHostShutdown(),
            },
          });
          if (result.status === 'occupied') return false;
          hostLease = result.lease;
          pidRecord = writePidFile(
            process.pid,
            supervisorIdentity.instanceId,
            supervisorIdentity.token
          );
          return true;
        },
        launch: (service) =>
          spawnDaemonRunnerAndAwaitReady(passthroughArgs, {
            service,
            expectedVersion: targetVersion,
          }),
        publish: (service) => publishManagedInstallation(npmProduct, service),
      });
      if (outcome.kind === 'migrated') {
        logger.info(`Relayed to managed daemon ${targetVersion}; npm watchdog exiting.`);
        return { action: 'stop', message: 'Migrated to the managed daemon service' };
      }
      if (outcome.kind === 'restored') {
        logger.error(`Managed migration failed; npm daemon keeps running: ${outcome.reason}`);
        return { action: 'restart', message: `Managed migration failed: ${outcome.reason}` };
      }
      logger.error(`Managed migration blocked: ${outcome.reason}`);
      return { action: 'fatal', message: `Managed migration blocked: ${outcome.reason}` };
    };
    const supervisor = new CliSupervisor({
      prepareLaunch: async (signal) => {
        if (signal.aborted) throw new DOMException('Worker launch canceled', 'AbortError');
        return {
          spawn: () => {
            drainConfirmed = false;
            const handle = launchLodyStart(
              passthroughArgs,
              supervisorIdentity,
              installation
                ? {
                    installation,
                    prepare,
                    drained: () => {
                      if (managedChild === handle.child) drainConfirmed = true;
                    },
                    terminationFailed: () => {
                      if (managedChild === handle.child) drainConfirmed = false;
                    },
                    candidate: observing || rollingBack,
                  }
                : undefined
            );
            managedChild = handle.child;
            candidateDeadline?.clear();
            candidateDeadline = undefined;
            deadlineTask = undefined;
            if (sea && (observing || rollingBack)) {
              const deadline = startManagedWorkerReadinessDeadline({
                timeoutMs: 3 * 60_000,
                shutdownGraceMs: 8_000,
                requestShutdown: () => handle.requestShutdown?.(),
                terminate: () => handle.terminate({ graceMs: 0, killWaitMs: 5_000 }),
                onExpired: () => {
                  logger.error('Managed Worker readiness timed out; stopping the exact candidate.');
                  deadlineTask = (async () => {
                    await commitTask?.catch(() => {});
                    const operation = await readManagedOperation();
                    if (operation && managedChild === handle.child)
                      await saveManagedOperation({ ...operation, phase: 'blocked' });
                  })();
                  void deadlineTask.catch((error) =>
                    logger.error('Could not persist readiness timeout', error)
                  );
                },
                onTerminationFailure: (error) => {
                  if (managedChild === handle.child) drainConfirmed = false;
                  logger.error(
                    'Candidate termination is unconfirmed; recovery remains blocked',
                    error
                  );
                },
              });
              candidateDeadline = deadline;
              void handle.result.then(
                () => deadline.clear(),
                () => deadline.clear()
              );
            }
            return handle;
          },
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
          if (sea) return; // Fixed entry owns the lease across Worker replacement.
          const lease = hostLease;
          hostLease = null;
          await lease?.close();
        },
      },
      decideExit: async (result) => {
        await commitTask?.catch(() => {});
        await deadlineTask?.catch(() => {});
        if (sea && rollingBack) {
          const operation = await readManagedOperation();
          if (operation) await saveManagedOperation({ ...operation, phase: 'blocked' });
          return { action: 'fatal', message: 'Retained release failed; recovery blocked' };
        }
        if (sea && observing) {
          const operation = await readManagedOperation();
          if (!operation) return { action: 'fatal', message: 'Managed update record missing' };
          if (!drainConfirmed) {
            await saveManagedOperation({ ...operation, phase: 'blocked' });
            return {
              action: 'fatal',
              message: 'Candidate termination or persistence was not confirmed; recovery blocked',
            };
          }
          await saveManagedOperation({ ...operation, phase: 'rollback-stop' });
          installation = previousInstallation;
          observing = false;
          rollingBack = true;
          return { action: 'restart', message: 'Candidate failed; restoring retained release' };
        }
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
        if ((sea || npmMigration) && result.code !== EXIT_CODE_REMOTE_UPGRADE) {
          const pending = await readManagedOperation();
          if (pending && ['preparing', 'waiting'].includes(pending.phase))
            await saveManagedOperation({ ...pending, phase: 'failed' });
        }
        if (result.code === 0) {
          return { action: 'stop', message: 'Worker exited cleanly' };
        }
        if (result.code === EXIT_CODE_REMOTE_RESTART) {
          logger.info('Worker requested remote restart; respawning.');
          return { action: 'restart', message: 'Remote restart requested' };
        }
        if (result.code === EXIT_CODE_REMOTE_UPGRADE) {
          if (sea) {
            const operation = await readManagedOperation();
            if (
              operation?.phase === 'waiting' &&
              operation.expiresAtMs !== undefined &&
              Date.now() >= operation.expiresAtMs &&
              drainConfirmed
            ) {
              await saveManagedOperation({ ...operation, phase: 'failed' });
              return {
                action: 'restart',
                message: 'Prepared update expired; restarting the unchanged release',
              };
            }
            if (!operation || operation.phase !== 'waiting' || !drainConfirmed) {
              if (operation) await saveManagedOperation({ ...operation, phase: 'blocked' });
              return {
                action: 'fatal',
                message: 'Managed update has no confirmed drain; replacement blocked',
              };
            }
            const envelope = await (
              await import('node:fs/promises')
            ).readFile(
              path.join(managedDaemonRoot(), 'releases', operation.releaseDigest, 'manifest.json'),
              'utf8'
            );
            const { verifyDaemonRelease } = await import('@/lib/managed-daemon-release');
            const release = verifyDaemonRelease(envelope, sea.metadata);
            await checkInstallationFiles(release);
            previousInstallation = installation;
            await saveManagedOperation({ ...operation, phase: 'switching' });
            installation = installationForRelease(release);
            observing = true;
            await saveManagedOperation({ ...operation, phase: 'observing' });
            return {
              action: 'restart',
              message: 'Starting prepared managed release under the fixed service',
            };
          }
          if (npmMigration) return await relayNpmInstallation();
          return {
            action: 'restart',
            message:
              'This legacy installation requires explicit managed migration; no npm update was run',
          };
        }
        if (result.code === EXIT_CODE_AUTH_FAILURE) {
          return {
            action: 'fatal',
            message:
              'Worker authentication or identity recovery was rejected; inspect daemon logs before restarting. Run `lody login` only if credentials were rejected.',
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
        if (
          sea &&
          !committing &&
          !candidateDeadline?.expired &&
          isDaemonWorkerReady(state) &&
          (observing || rollingBack)
        ) {
          const expected = installation;
          if (
            !expected ||
            state.runtime?.cliVersion !== expected.version ||
            state.runtime.pid !== managedChild?.pid
          )
            return;
          const wasRollback = rollingBack;
          committing = true;
          const committingChild = managedChild;
          commitTask = (async () => {
            const ensureCandidateAlive = () => {
              if (
                candidateDeadline?.expired ||
                managedChild !== committingChild ||
                !committingChild ||
                committingChild.exitCode !== null ||
                committingChild.signalCode !== null
              )
                throw new Error('Candidate exited before update commit');
            };
            ensureCandidateAlive();
            const operation = await readManagedOperation();
            if (
              !operation ||
              state.runtime?.machineId !== operation.machineId ||
              operation.serviceInstanceId !== supervisorIdentity.instanceId
            )
              throw new Error('Managed operation identity mismatch');
            ensureCandidateAlive();
            await writeManagedRecord(path.join(managedDaemonRoot(), 'selected.json'), {
              format: 1,
              digest: wasRollback ? (expected.releaseDigest ?? null) : operation.releaseDigest,
            });
            ensureCandidateAlive();
            await saveManagedOperation({
              ...operation,
              phase: wasRollback ? 'rolled-back' : 'applied',
            });
            ensureCandidateAlive();
            candidateDeadline?.clear();
            observing = false;
            rollingBack = false;
            if (managedChild?.connected)
              managedChild.send(
                { type: 'lody/managed-resume', token: supervisorIdentity.token },
                (error) => {
                  if (error) logger.error('Could not resume committed daemon', error);
                }
              );
          })()
            .catch((error) => {
              logger.error('Managed result persistence failed; outcome remains unconfirmed', error);
              throw error;
            })
            .finally(() => {
              committing = false;
            });
          void commitTask.catch(() => {});
        }
        if (launchOutcomePending && isDaemonWorkerReady(state)) {
          reportLaunchOutcome({
            status: 'ready',
            pid: process.pid,
            instanceId: supervisorIdentity.instanceId,
            cliVersion: installation?.version ?? version,
          });
        }
        if (state.phase === 'fatal') {
          logger.error(`Fatal: ${state.message ?? 'unknown'}`);
        } else if (state.message) {
          logger.debug(`[${state.phase}] ${state.message}`);
        }
      },
      onTerminal: (termination) => {
        if (sea && termination.reason !== 'clean_exit') {
          logger.error(
            'Managed service retained ownership after failure; inspect update status before recovery.'
          );
          return;
        }
        void finish(termination.reason === 'clean_exit' ? 0 : 1);
      },
    });

    const shutdown = async (signal?: string) => {
      logger.info(signal ? `Received ${signal}, shutting down...` : 'Shutting down...');
      preparationAbort.abort();
      candidateDeadline?.clear();
      try {
        await supervisor.stop();
      } catch (error) {
        logger.error(
          `Worker termination failed during shutdown: ${error instanceof Error ? error.message : String(error)}`
        );
        if (sea) return; // Retain the root and lease when termination is unconfirmed.
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
