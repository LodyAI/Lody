import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLabBackend } from './backend';

const dataDir = process.argv.includes('--data-dir')
  ? process.argv[process.argv.indexOf('--data-dir') + 1]
  : mkdtempSync(join(tmpdir(), 'e2ee-lab-'));
const testMode = process.argv.includes('--test');

if (!dataDir) {
  console.error('usage: tsx src/cli.ts [--data-dir DIR] [--test]');
  process.exit(1);
}

const host = await startLabBackend({
  dataDir,
  host: '127.0.0.1',
  port: 0,
  testMode,
});
writeFileSync(join(dataDir, 'pid'), `${process.pid}\n`);
console.log(`e2ee-lab listening ${host.baseUrl}`);
process.on('SIGTERM', () => {
  void host.close().then(() => process.exit(0));
});
