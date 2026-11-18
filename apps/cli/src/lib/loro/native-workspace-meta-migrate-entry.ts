import { nativeWorkspaceMetaMigrationInputSchema } from '@lody/shared/native-workspace-meta-migration';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrateLocalWorkspaceMetaLegacy } from './native-workspace-meta-migrate';
import { assertLegacyRepoExternalMetadataCapability } from './native-workspace-meta-owner';
try {
  if (
    process.argv.slice(2).length === 1 &&
    process.argv[2] === '--inspect-external-metadata-capability'
  ) {
    assertLegacyRepoExternalMetadataCapability();
    process.stdout.write(
      JSON.stringify({ capability: 'loro-external-metadata-v1', available: true })
    );
  } else {
    if (process.argv.length > 2) throw new Error('Unexpected migration arguments');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 24 * 1024 * 1024) throw new Error('Meta migration input exceeds budget');
      chunks.push(Buffer.from(chunk));
    }
    const input = nativeWorkspaceMetaMigrationInputSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    );
    const receipt = await migrateLocalWorkspaceMetaLegacy(input, {
      executable: process.execPath,
      hostEntry: join(dirname(fileURLToPath(import.meta.url)), 'native-repo-independent-host.js'),
    });
    process.stdout.write(JSON.stringify(receipt));
  }
} catch {
  process.stderr.write('native_workspace_meta_migration_failed\n');
  process.exitCode = 1;
}
