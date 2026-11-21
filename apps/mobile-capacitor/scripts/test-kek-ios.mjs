import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

if (process.platform !== 'darwin') {
  console.log('iOS custody tests require macOS; skipped on this platform.');
  process.exit(0);
}
const temporary = mkdtempSync(join(tmpdir(), 'lody-kek-test-'));
const file = (path) => fileURLToPath(new URL(path, import.meta.url));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}
const coreRequire = createRequire(
  new URL('../../../packages/e2ee-core/package.json', import.meta.url)
);
const { encode } = await import(pathToFileURL(coreRequire.resolve('@ipld/dag-cbor')).href);
const fields = ['account', 'workspace', Buffer.alloc(32, 1), Buffer.alloc(32, 2), '03'.repeat(32)];
function aad(purpose) {
  const domain =
    purpose === 'installation-probe'
      ? 'lody-e2ee/client-custody/probe/v1\0'
      : 'lody-e2ee/client-custody/v1\0';
  return Buffer.from(encode([domain, 1, ...fields, purpose]));
}
try {
  // Exact copy from LodyAI/Lody e1e3b5a10f65d94655d097cd262f008a35c2688e:
  // packages/e2ee-core/test/client-custody-vector.json. Never regenerate expectations.
  const sharedBytes = readFileSync(file('../tests/fixtures/client-custody-vector.json'));
  assert.equal(
    createHash('sha256').update(sharedBytes).digest('hex'),
    'df29e783c922c419e195f53351526975f390c9ed2bf448b9089c67275e4c597c'
  );
  const shared = JSON.parse(sharedBytes);
  assert.equal(shared.version, 1);
  assert.deepEqual(
    shared.vectors.map((vector) => vector.purpose),
    [
      'signing-private-key',
      'encryption-private-key',
      'device-credential',
      'installed-epoch-key',
      'rotation-candidate',
    ]
  );
  writeFileSync(join(temporary, 'client-custody-vector.json'), sharedBytes);
  const aadCases = [
    'a'.repeat(23),
    'a'.repeat(24),
    'a'.repeat(255),
    'a'.repeat(256),
    '语'.repeat(85),
  ];
  writeFileSync(
    join(temporary, 'aad-cases.tsv'),
    aadCases
      .map((account) =>
        [
          account,
          '工作区',
          Buffer.from(
            encode([
              'lody-e2ee/client-custody/v1\0',
              1,
              account,
              '工作区',
              ...fields.slice(2),
              'rotation-candidate',
            ])
          ).toString('hex'),
        ].join('\t')
      )
      .join('\n')
  );
  // Public synthetic fixture key only; never reads the user's Keychain.
  const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  async function seal(bytes, purpose) {
    const nonce = webcrypto.getRandomValues(new Uint8Array(12));
    const sealed = await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad(purpose) },
      key,
      bytes
    );
    return Buffer.concat([Buffer.from([1]), nonce, Buffer.from(sealed)]).toString('base64');
  }
  const fixture = join(temporary, 'fixture.json');
  const output = join(temporary, 'swift-wrapped.bin');
  writeFileSync(
    fixture,
    JSON.stringify({
      key: keyBytes.toString('base64'),
      probe: await seal(Buffer.from('lody.mobile.kek.installation.v1'), 'installation-probe'),
      wrapped: await seal(keyBytes, 'installed-epoch-key'),
    })
  );
  const binary = join(temporary, 'kek-tests');
  run('xcrun', [
    'swiftc',
    '-module-cache-path',
    join(temporary, 'modules'),
    file('../ios/App/App/LodyKekCustody.swift'),
    file('../ios/App/App/LodyKekCallQueue.swift'),
    file('../tests/KekCustodyTests.swift'),
    '-o',
    binary,
  ]);
  run(binary, [fixture, output]);
  const wrapped = readFileSync(output);
  assert.equal(wrapped[0], 1);
  assert.equal(wrapped.length, keyBytes.length + 29);
  const opened = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: wrapped.subarray(1, 13), additionalData: aad('installed-epoch-key') },
    key,
    wrapped.subarray(13)
  );
  assert.deepEqual(Buffer.from(opened), keyBytes);
  console.log('CryptoKit <=> JS WebCrypto AES-GCM interoperability passed.');
  if (!process.argv.includes('--unit-only'))
    run('xcrun', [
      'swiftc',
      '-typecheck',
      '-module-cache-path',
      join(temporary, 'modules'),
      file('../ios/App/App/LodyKekCustody.swift'),
      file('../ios/App/App/LodyKeychainKekStorage.swift'),
    ]);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
