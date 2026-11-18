import { nativeMachineCatalogMigrationInputSchema } from '@lody/shared/native-machine-catalog-migration';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  migrateLocalMachineCatalogLegacy,
  inspectLegacyMachineCatalogOwners,
} from './native-machine-catalog-migrate';
const limit = 24 * 1024 * 1024;
try {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('MF migration input exceeds budget');
    chunks.push(Buffer.from(chunk));
  }
  const input = nativeMachineCatalogMigrationInputSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  );
  if (
    process.argv.length > 3 ||
    (process.argv[2] && process.argv[2] !== '--inspect-local-machine-catalog')
  )
    throw new Error('Unsupported helper mode');
  if (process.argv[2] === '--inspect-local-machine-catalog') {
    process.stdout.write(
      JSON.stringify({ otherMachineOwners: inspectLegacyMachineCatalogOwners(input) })
    );
  } else {
    const directory = dirname(fileURLToPath(import.meta.url));
    const receipt = await migrateLocalMachineCatalogLegacy(input, {
      executable: process.execPath,
      hostEntry: join(directory, 'native-repo-independent-host.js'),
    });
    process.stdout.write(JSON.stringify(receipt));
  }
} catch {
  process.stderr.write('native_machine_catalog_migration_failed\n');
  process.exitCode = 1;
}
