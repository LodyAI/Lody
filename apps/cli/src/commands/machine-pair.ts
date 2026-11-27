import { Command } from 'commander';
import { getCliPlatformKind } from '@/lib/cli-platform';
import { getOrCreateMachineId } from '@/lib/machine-identity';
import { getLogger } from '@/utils/logger';
function formatMachinePairingError(code: string): string {
  switch (code) {
    case 'e2ee_waiting_for_key':
      return 'This machine is approved, but no desktop has delivered the current workspace key yet. Open the encrypted workspace on an approved desktop, then retry the same command.';
    case 'e2ee_pairing_claimed_by_another_machine':
      return 'This pairing command was already used by another machine. Cancel it in the Lody app if it is still shown, then create a new command there. Retrying this command will not help.';
    case 'e2ee_pairing_expired_create_new_command':
      return 'This pairing command has expired. Create a new pairing command in the Lody app and run it here.';
    case 'e2ee_pairing_cancelled_create_new_command':
      return 'This pairing command was cancelled in the Lody app. Create a new pairing command there and run it here.';
    case 'e2ee_pairing_conflict_create_new_command':
    case 'e2ee_pairing_conflict':
      return 'This pairing command conflicted with another pairing session. Create a new pairing command in the Lody app and run it here.';
    case 'e2ee_pairing_superseded_create_new_command':
      return 'This pairing command was superseded by a newer pairing attempt on this machine. Create a new pairing command in the Lody app and run it here.';
    case 'e2ee_pairing_invalid_command':
      return 'This pairing command is invalid or corrupted. Copy a fresh pairing command from the Lody app and run it again.';
    case 'e2ee_binding_conflict':
      return 'This workspace has a conflicting local encryption binding on this machine. Check that you selected the right workspace or reset its local binding, then create a new pairing command in the Lody app.';
    case 'e2ee_member_removed':
      return 'This account was removed from the encrypted workspace. Ask a workspace owner to re-invite you before pairing this machine.';
    default:
      return 'Pairing has not completed due to a temporary connection or service error. Retry the same command to resume.';
  }
}

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
    let result: Awaited<
      ReturnType<(typeof import('@/lib/e2ee/remote-pairing'))['pairRemoteMachineLegacy']>
    >;
    try {
      const { pairRemoteMachineLegacy, decodeRemoteMachineOffer } =
        await import('@/lib/e2ee/remote-pairing');
      const offer = decodeRemoteMachineOffer(args.offer);
      const { createCloudE2eePort, createCloudRemoteMachinePairingClaim } =
        await import('@/lib/cloud-cli-port');
      const logger = getLogger('e2ee-machine-pairing');
      let displayed = '';
      result = await pairRemoteMachineLegacy({
        encodedOffer: args.offer,
        machineId: getOrCreateMachineId(),
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
    } catch (error) {
      // Never print SDK errors, the command, credentials, or public proof blobs.
      const code = error instanceof Error ? error.message : '';
      console.error(formatMachinePairingError(code));
      process.exitCode = 1;
      return;
    } finally {
      process.removeListener('SIGINT', abort);
    }
    const { startCommand } = await import('./start');
    await startCommand.parseAsync(['--paired-workspace', result.reference], { from: 'user' });
  });
