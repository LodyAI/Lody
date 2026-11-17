import { randomUUID } from 'node:crypto';
import { requestLocalCliHostUpgrade } from '@lody/shared/node/local-cli-host-lease';
import { readPidFileRecord } from './daemon-shared';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { registerDaemonAutostart, runInstallCommand } from './daemon-autostart';
import { AuthClient, performLoginWithAuthCredential } from '@/lib/auth';
import { getCliPlatformKind } from '@/lib/cli-platform';
import { getLogger } from '@/utils/logger';
import { ensureDaemonBackendAuth } from './daemon-auth-preflight';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { inspectLocalCliHost } from '@lody/shared/node/local-cli-host-lease';
import {
  getSeaContext,
  installFixedServiceEntry,
  publishManagedInstallation,
  readManagedOperation,
} from '@/lib/managed-daemon-release';

/** Explicit local migration boundary. Never rewrite arbitrary user-owned services. */
export const daemonInstallCommand = new Command('install')
  .description('Install this SEA as the fixed managed daemon service entry')
  .option('--auth <credential>', 'Connect using a machine pairing token or CLI API key')
  .option('--start', 'Start the installed fixed entry and wait for daemon readiness')
  .option('--autostart', 'Register this fixed entry for the next login or boot')
  .action(installManagedDaemon);

export async function installManagedDaemon(options: {
  auth?: string;
  start?: boolean;
  autostart?: boolean;
}): Promise<void> {
  const context = getSeaContext();
  if (!context)
    throw new Error('Run the downloaded SEA installer; npm keeps its JavaScript entry.');
  if (options.auth && getCliPlatformKind() !== 'cloud')
    throw new Error('--auth is unavailable in the local product');
  if (options.auth !== undefined && !options.auth.trim())
    throw new Error('Missing --auth credential');
  const host = await inspectLocalCliHost();
  if (host)
    throw new Error(
      'Stop the existing local host and its service before installing the managed daemon.'
    );
  {
    const service = await installFixedServiceEntry(context.capsulePath);
    await publishManagedInstallation(context.metadata.product, service);
    console.log(`Installed fixed entry: ${service}`);
    if (options.auth || (options.start && getCliPlatformKind() === 'cloud')) {
      const logger = getLogger('daemon-install');
      const authClient = new AuthClient(logger);
      if (options.auth) {
        const login = await performLoginWithAuthCredential(authClient, logger, {
          credential: options.auth,
        });
        if (!login.success) throw new Error(login.error);
      } else {
        const preflight = await ensureDaemonBackendAuth({ authClient, logger });
        if (preflight.status === 'failed') throw new Error(preflight.message);
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
