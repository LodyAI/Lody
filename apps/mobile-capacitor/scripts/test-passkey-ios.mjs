import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.log('Passkey Swift logic checks require macOS; skipped on this platform.');
  process.exit(0);
}
const temporary = mkdtempSync(path.join(tmpdir(), 'lody-passkey-test-'));
const source = (name) => fileURLToPath(new URL(name, import.meta.url));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result.status === 0;
}
try {
  const binary = path.join(temporary, 'passkey-tests');
  if (
    run('xcrun', [
      'swiftc',
      '-module-cache-path',
      path.join(temporary, 'modules'),
      source('../ios/App/App/LodyPasskeyCodec.swift'),
      source('../ios/App/App/LodyPasskeyCallQueue.swift'),
      source('../tests/PasskeyTests.swift'),
      '-o',
      binary,
    ])
  )
    run(binary, []);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
