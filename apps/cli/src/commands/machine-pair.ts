import { Command } from 'commander';
import { getCliPlatformKind } from '@/lib/cli-platform';
import { getOrCreateStableMachineIdAsync } from '@/utils/const';
import { getLogger } from '@/utils/logger';
/** Keep custody/core outside the ordinary CLI entry graph. */
export const machinePairCommand = new Command('pair')
  .description('Pair this machine with one encrypted workspace using a desktop command')
  .requiredOption('--offer <command>', 'Signed, expiring desktop pairing offer')
  .action(async (args: { offer: string }) => {
    if (getCliPlatformKind() !== 'cloud')
      throw new Error('Remote pairing requires the Lody Cloud CLI.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort);
    try {
      const { pairRemoteMachineLegacy, decodeRemoteMachineOffer } =
        await import('@/lib/e2ee/remote-pairing');
      const offer = decodeRemoteMachineOffer(args.offer);
      const { createCloudE2eePort, createCloudRemoteMachinePairingClaim } =
        await import('@/lib/cloud-cli-port');
      const logger = getLogger('e2ee-machine-pairing');
      let displayed = '';
      const result = await pairRemoteMachineLegacy({
        encodedOffer: args.offer,
        machineId: await getOrCreateStableMachineIdAsync(),
        cloud: createCloudE2eePort({ authBaseUrl: offer.deploymentUrl, logger }),
        signal: controller.signal,
        claim: createCloudRemoteMachinePairingClaim({ ingressUrl: offer.ingressUrl, logger }),
        show: (value) => {
          const location =
            [value.location?.city, value.location?.country].filter(Boolean).join(', ') || 'Unknown';
          const line = `Workspace: ${offer.workspaceId}\nSummary: ${value.summary}\nKey protection: ${value.protection}\nLocation (estimated; VPN may differ): ${location}\nPairing: ${value.status}`;
          if (line !== displayed) {
            console.log(line);
            displayed = line;
          }
        },
      });
      console.log(
        `Paired. Current workspace key installed: ${result.workspaceId}\nResume with: lody start --paired-workspace ${result.reference}`
      );
      process.removeListener('SIGINT', abort);
      const { startCommand } = await import('./start');
      await startCommand.parseAsync(['--paired-workspace', result.reference], { from: 'user' });
    } catch {
      // Never print SDK errors, the command, credentials, or public proof blobs.
      console.error(
        'Pairing has not completed. Retry the same command to resume. If the desktop reports cancellation or expiry, create a new command there.'
      );
      process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', abort);
    }
  });
