import { randomUUID } from 'node:crypto';
import {
  inspectLocalCliHost,
  requestLocalCliHostUpgrade,
  type LocalCliHostRecord,
} from '@lody/shared/node/local-cli-host-lease';
import { createInterface } from 'node:readline/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { runCommandTextLegacy, terminatePidLegacy } from '@lody/shared/node/process';
import { toShared } from '@/platform/process-options';
import { readPidFileRecord, stopDaemonProcess } from './daemon-shared';
import { Command } from 'commander';
import { registerDaemonAutostart, runInstallCommand } from './daemon-autostart';
import { AuthClient, performLoginWithAuthCredential } from '@/lib/auth';
import { getCliPlatformKind } from '@/lib/cli-platform';
import { getLogger } from '@/utils/logger';
import { ensureDaemonBackendAuth } from './daemon-auth-preflight';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  getSeaContext,
  installFixedServiceEntry,
  managedDaemonRoot,
  publishManagedInstallation,
  readManagedOperation,
  writeManagedRecord,
} from '@/lib/managed-daemon-release';
import { installCommandShim } from '@/lib/command-shim';

/** An expected installer outcome the owner can act on; printed without a stack or crash report. */
export class InstallActionRequiredError extends Error {
  override name = 'InstallActionRequiredError';
}

/** Explicit local migration boundary. Never rewrite arbitrary user-owned services. */
export const daemonInstallCommand = new Command('install')
  .description('Install this SEA as the fixed managed daemon service entry')
  .option('--auth <credential>', 'Connect using a machine pairing token or CLI API key')
  .option('--start', 'Start the installed fixed entry and wait for daemon readiness')
  .option('--autostart', 'Register this fixed entry for the next login or boot')
  .option('--replace', 'Stop a running Lody (daemon, desktop app or terminal) without asking')
  .option('--no-modify-path', 'Install the lody command without changing PATH or shell profiles')
  .action(async (options: InstallOptions & { modifyPath?: boolean }) => {
    try {
      await installManagedDaemon({
        ...options,
        noModifyPath: options.modifyPath === false,
      });
    } catch (error) {
      if (!(error instanceof InstallActionRequiredError)) throw error;
      console.error(error.message);
      process.exitCode = 1;
    }
  });

type InstallOptions = {
  auth?: string;
  start?: boolean;
  autostart?: boolean;
  replace?: boolean;
  noModifyPath?: boolean;
};

/** Owner interaction and process control; replaceable in tests. */
export type InstallHostPorts = {
  interactive: boolean;
  confirm: (question: string) => Promise<boolean>;
  /** True when this profile's daemon PID record identifies `host`, so it can be stopped. */
  ownsDaemon: (host: LocalCliHostRecord) => boolean;
  stopDaemon: typeof stopDaemonProcess;
  /** SIGTERM, then SIGKILL after the daemon drain budget; resolves once it is gone. */
  terminate: (pid: number) => Promise<void>;
  /** The process runs as this OS user, so ending it cannot reach another account. */
  ownedByCurrentUser: (pid: number) => Promise<boolean>;
};

// The daemon Supervisor drains its Worker for 30 seconds, then confirms exit within 5.
const TERMINATION_POLICY = { graceMs: 36_000, killWaitMs: 5_000 };

const defaultHostPorts: InstallHostPorts = {
  interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
  confirm: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Without a listener, Ctrl+C would only pause the stream and leave the question pending.
    const cancel = new AbortController();
    rl.once('SIGINT', () => cancel.abort());
    try {
      const answer = await rl.question(`${question} [Y/n] `, { signal: cancel.signal });
      return ['', 'y', 'yes'].includes(answer.trim().toLowerCase());
    } catch {
      return false;
    } finally {
      rl.close();
    }
  },
  ownsDaemon: (host) => {
    const record = readPidFileRecord();
    return (
      host.mode === 'daemon' && record?.pid === host.pid && record.instanceId === host.instanceId
    );
  },
  stopDaemon: stopDaemonProcess,
  terminate: (pid) => terminatePidLegacy(pid, TERMINATION_POLICY, toShared()),
  ownedByCurrentUser: async (pid) => {
    // Windows Host endpoints are per-user named pipes.
    const uid = process.getuid?.();
    if (uid === undefined) return true;
    try {
      if (process.platform === 'linux') return statSync(`/proc/${pid}`).uid === uid;
      const result = await runCommandTextLegacy(
        { command: 'ps', args: ['-o', 'uid=', '-p', String(pid)], timeout: 5000, check: 'exit-0' },
        toShared()
      );
      return result.stdout.trim() === String(uid);
    } catch {
      return false;
    }
  },
};

function describeHost(host: LocalCliHostRecord): { name: string; howToStop: string } {
  switch (host.mode) {
    case 'electron':
      return { name: 'Lody desktop app', howToStop: 'quit it' };
    case 'foreground':
      return { name: 'Lody (`lody start`)', howToStop: 'press Ctrl+C in its terminal' };
    default:
      return { name: 'Lody daemon', howToStop: 'run `lody daemon stop`' };
  }
}

const sameHost = (a: LocalCliHostRecord | null, b: LocalCliHostRecord) =>
  a?.pid === b.pid && a.instanceId === b.instanceId;

/**
 * Only one Host may run per user. After the owner agrees (or passes `--replace`),
 * this profile's own daemon is stopped through its authenticated control channel;
 * any other Host, or a daemon that did not stop, is terminated by pid. The pid is
 * re-read from the live Host right before signalling and must belong to this OS user.
 */
async function releaseExistingHost(
  host: LocalCliHostRecord,
  options: InstallOptions,
  ports: InstallHostPorts
): Promise<void> {
  const { name, howToStop } = describeHost(host);
  const running = `${name} is running (PID ${host.pid}).`;
  const manual = `To stop it yourself, ${howToStop}, then rerun the installer.`;
  const agreed =
    options.replace ||
    (ports.interactive && (await ports.confirm(`${running} Stop it and continue?`)));
  if (!agreed)
    throw new InstallActionRequiredError(
      ports.interactive
        ? `Cancelled. ${manual}`
        : `${running} Rerun with --replace (PowerShell: -Replace) to stop it. ${manual}`
    );
  console.log(`Stopping ${name}...`);
  if (ports.ownsDaemon(host)) await ports.stopDaemon();
  if (sameHost(await inspectLocalCliHost(), host)) {
    if (!(await ports.ownedByCurrentUser(host.pid)))
      throw new InstallActionRequiredError(
        `${running} It belongs to another OS user and was not stopped.`
      );
    try {
      await ports.terminate(host.pid);
    } catch {
      throw new InstallActionRequiredError(`Could not stop ${name}. ${manual}`);
    }
  }
  const restarted = await inspectLocalCliHost();
  if (restarted)
    throw new InstallActionRequiredError(
      sameHost(restarted, host)
        ? `Could not stop ${name}. ${manual}`
        : `Lody restarted (PID ${restarted.pid}), probably from a system service. Stop that service, then rerun the installer.`
    );
}

export async function installManagedDaemon(
  options: InstallOptions,
  ports: InstallHostPorts = defaultHostPorts
): Promise<void> {
  const context = getSeaContext();
  if (!context)
    throw new Error('Run the downloaded SEA installer; npm keeps its JavaScript entry.');
  if (options.auth && getCliPlatformKind() !== 'cloud')
    throw new Error('--auth is unavailable in the local product');
  if (options.auth !== undefined && !options.auth.trim())
    throw new Error('Missing --auth credential');
  const host = await inspectLocalCliHost();
  if (host) await releaseExistingHost(host, options, ports);
  {
    const service = await installFixedServiceEntry(context.capsulePath);
    await writeManagedRecord(path.join(managedDaemonRoot(), 'selected.json'), {
      format: 1,
      digest: null,
    });
    await publishManagedInstallation(context.metadata.product, service);
    console.log(`Installed Lody ${context.metadata.version}: ${service}`);
    try {
      const shim = await installCommandShim(service, { noModifyPath: options.noModifyPath });
      if (shim.status === 'installed') {
        console.log(`Installed command shim: ${shim.path}`);
        if (shim.pathOnPath) console.log("Run 'lody --help' to get started.");
        else if (shim.pathModified)
          console.log(
            process.platform === 'win32'
              ? 'Open a new terminal to use `lody`.'
              : 'Open a new terminal (or run `exec $SHELL`) to use `lody`.'
          );
        else if (process.platform === 'win32')
          console.log(`Manually add ${shim.binDir} to your user PATH.`);
        else console.log(`Add this line to your shell profile: export PATH="${shim.binDir}:$PATH"`);
      }
    } catch (error) {
      console.warn(`Could not install the lody command shim or update PATH: ${String(error)}`);
    }
    if (options.auth || (options.start && getCliPlatformKind() === 'cloud')) {
      const logger = getLogger('daemon-install');
      const authClient = new AuthClient(logger);
      if (options.auth) {
        const login = await performLoginWithAuthCredential(authClient, logger, {
          credential: options.auth,
        });
        if (!login.success)
          throw new InstallActionRequiredError(
            `Installed, but pairing failed: ${login.error}\nCreate a new pairing command in Lody and run it.`
          );
      } else {
        const preflight = await ensureDaemonBackendAuth({ authClient, logger });
        if (preflight.status === 'failed')
          throw new InstallActionRequiredError(
            `Installed, but sign-in failed: ${preflight.message}`
          );
      }
    }
    if (options.autostart) {
      try {
        console.log(await registerDaemonAutostart({ service, dataDir: getLodyDataDir() }));
      } catch {
        console.warn(
          'Automatic startup could not be registered. The daemon can still run now; configure your user service with the installed fixed entry for future boots.'
        );
      }
    }
    if (options.start)
      await runInstallCommand(service, ['daemon', 'start', '--skip-auth-check'], 240000);
    else console.log(`Start this fixed entry with: "${service}" daemon start`);
    if (!options.autostart)
      console.log(
        'Use the installed absolute executable with daemon-runner in your user service; preserve LODY_DATA_DIR.'
      );
  }
}

export const daemonUpdateStatusCommand = new Command('update-status')
  .description('Read the durable managed daemon update outcome')
  .option('--request-id <id>', 'Read one accepted operation, including older outcomes')
  .action(async (options: { requestId?: string }) => {
    console.log(JSON.stringify(await readManagedOperation(options.requestId)));
  });

export const daemonUpgradeCommand = new Command('upgrade')
  .description('Prepare a checksummed managed daemon update; wait for idle by default')
  .option('--target-version <version>', 'Exact version or latest', 'latest')
  .option('--channel <channel>', 'stable, next or nightly', 'stable')
  .option('--immediate', 'Interrupt running tasks after preparation')
  .option('--allow-channel-change', 'Confirm switching the installed channel')
  .option('--allow-downgrade', 'Confirm installing an older compatible version')
  .action(
    async (options: {
      targetVersion: string;
      channel: string;
      immediate?: boolean;
      allowChannelChange?: boolean;
      allowDowngrade?: boolean;
    }) => {
      const record = readPidFileRecord();
      if (!record) throw new Error('Managed daemon is not running');
      const { ManagedDaemonUpgradeOptionsSchema } = await import('@lody/shared');
      const upgrade = ManagedDaemonUpgradeOptionsSchema.parse({
        protocol: 1,
        channel: options.channel,
        switchPolicy: options.immediate ? 'immediate' : 'when-idle',
        confirmChannelChange: !!options.allowChannelChange,
        confirmDowngrade: !!options.allowDowngrade,
      });
      const requestId = randomUUID();
      const result = await requestLocalCliHostUpgrade({
        instanceId: record.instanceId,
        token: record.controlToken,
        expectedPid: record.pid,
        expectedMode: 'daemon',
        requestId,
        targetVersion:
          options.targetVersion === 'latest' && options.channel !== 'stable'
            ? options.channel
            : options.targetVersion,
        upgrade,
        timeoutMs: 11 * 60_000,
      });
      if (!result.ok)
        throw new Error(`Update outcome may be unconfirmed (${requestId}): ${result.error}`);
      console.log(
        `Update prepared and queued: ${requestId}. Use daemon update-status --request-id ${requestId} to observe the actual outcome.`
      );
    }
  );
