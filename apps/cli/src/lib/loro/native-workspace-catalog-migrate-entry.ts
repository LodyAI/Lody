import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_WF_MIGRATION_STDIN_LIMIT } from '@lody/shared/native-workspace-catalog-migration';
import { migrateLocalWorkspaceCatalogLegacy } from './native-workspace-catalog-migrate';

try {
  if (process.argv.length !== 2) throw new Error('Unexpected migration arguments');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > NATIVE_WF_MIGRATION_STDIN_LIMIT) throw new Error('Migration input exceeds budget');
    chunks.push(bytes);
  }
  const receipt = await migrateLocalWorkspaceCatalogLegacy(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
    {
      hostEntry: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'native-repo-independent-host.js'
      ),
      executable: process.execPath,
    }
  );
  process.stdout.write(JSON.stringify(receipt) + '\n');
} catch {
  // Payloads can contain write-only MCP secrets. Never print input or SDK causes.
  process.stderr.write('Local workspace catalog migration failed\n');
  process.exitCode = 70;
}
