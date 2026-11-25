import { Command } from 'commander';
import {
  restoreLocalMachineId,
  type RestoreLocalMachineIdResult,
} from '@/lib/machine-identity-restore';

function printHumanRestoreResult(result: RestoreLocalMachineIdResult): void {
  if (!result.changed) {
    console.log(`Local machine ID is already ${result.targetMachineId}. No changes were made.`);
    return;
  }

  console.log(`Restored local machine ID to ${result.targetMachineId}`);
  if (result.previousMachineId && result.previousMachineId !== result.targetMachineId) {
    console.log(`  Previous machine-id: ${result.previousMachineId}`);
  }
  if (
    result.previousCredentialMachineId &&
    result.previousCredentialMachineId !== result.targetMachineId
  ) {
    console.log(`  Previous credentials machineId: ${result.previousCredentialMachineId}`);
  }
  console.log(
    `  credentials.json updated: ${result.credentialsUpdated ? 'yes' : 'no (not present)'}`
  );
  console.log(`  backup anchor updated: ${result.anchorUpdated ? 'yes' : 'no'}`);
  if (result.backupDir) {
    console.log(`  Backup saved to: ${result.backupDir}`);
  }
  console.log(
    'Restart Lody (desktop app or `lody daemon start`) to reconnect with the restored identity.'
  );
}

export const machineRestoreIdCommand = new Command('restore-id')
  .description('Restore a previous local machine ID offline after reinstall or state loss')
  .argument('<machineId>', 'Target machine ID to restore locally')
  .option('--json', 'Print JSON output')
  .action(async (machineId: string, options: { json?: boolean }) => {
    try {
      const result = await restoreLocalMachineId(machineId);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printHumanRestoreResult(result);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error: message }, null, 2));
      } else {
        console.error(message);
      }
      process.exitCode = 1;
    }
  });
