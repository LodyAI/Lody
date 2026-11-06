import { randomUUID } from 'node:crypto';
import { requestLocalCliHostUpgrade } from '@lody/shared/node/local-cli-host-lease';
import { readPidFileRecord } from './daemon-shared';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { inspectLocalCliHost } from '@lody/shared/node/local-cli-host-lease';
import {
  getSeaContext,
  managedDaemonRoot,
  readManagedOperation,
  writeManagedRecord,
} from '@/lib/managed-daemon-release';

/** Explicit local migration boundary. Never rewrite arbitrary user-owned services. */
export const daemonInstallCommand = new Command('install')
  .description('Install this SEA as the fixed managed daemon service entry')
  .action(async () => {
    const context = getSeaContext();
    if (!context)
      throw new Error('Run the downloaded SEA installer; npm keeps its JavaScript entry.');
    const host = await inspectLocalCliHost();
    if (host)
      throw new Error(
        'Stop the existing local host and its service before installing the managed daemon.'
      );
    const root = managedDaemonRoot();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const lockPath = path.join(root, 'install.lock');
    const lock = await fs.open(lockPath, 'wx', 0o600);
    try {
      const service = path.join(root, process.platform === 'win32' ? 'service.exe' : 'service');
      // The fixed service itself is upgraded only through this explicit command.
      const tmp = service + '.installing';
      await fs.copyFile(context.capsulePath, tmp);
      await fs.chmod(tmp, 0o700);
      const fd = await fs.open(tmp, 'r+');
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }
      await fs.rename(tmp, service);
      await writeManagedRecord(path.join(root, 'installation.json'), {
        format: 1,
        product: context.metadata.product,
        serviceProtocol: 1,
        service,
      });
      console.log(`Installed fixed entry: ${service}`);
      console.log(
        `Use this absolute executable with "daemon-runner" in your user service; preserve your existing daemon options and LODY_DATA_DIR.`
      );
      console.log(
        'Remove the old autostart registration before enabling this entry. Installation does not start a second daemon.'
      );
    } finally {
      await lock.close();
      await fs.rm(lockPath);
    }
  });
export const daemonUpdateStatusCommand = new Command('update-status')
  .description('Read the durable managed daemon update outcome')
  .option('--request-id <id>', 'Read one accepted operation, including older outcomes')
  .action(async (options: { requestId?: string }) => {
    console.log(JSON.stringify(await readManagedOperation(options.requestId)));
  });

export const daemonUpgradeCommand = new Command('upgrade')
  .description('Prepare a signed managed daemon update; wait for idle by default')
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
