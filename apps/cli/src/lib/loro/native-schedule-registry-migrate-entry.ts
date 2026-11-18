import { nativeScheduleRegistryMigrationInputSchema } from '@lody/shared/native-schedule-registry-migration';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrateLocalScheduleRegistryLegacy } from './native-schedule-registry-migrate';
try {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 24 * 1024 * 1024) throw new Error('SR migration input exceeds budget');
    chunks.push(Buffer.from(chunk));
  }
  const input = nativeScheduleRegistryMigrationInputSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  );
  const receipt = await migrateLocalScheduleRegistryLegacy(input, {
    executable: process.execPath,
    hostEntry: join(dirname(fileURLToPath(import.meta.url)), 'native-repo-independent-host.js'),
  });
  process.stdout.write(JSON.stringify(receipt));
} catch {
  process.stderr.write('native_schedule_registry_migration_failed\n');
  process.exitCode = 1;
}
