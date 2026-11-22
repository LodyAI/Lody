import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const javaHome = process.env.JAVA_HOME;
const javac = javaHome ? join(javaHome, 'bin/javac') : 'javac';
const java = javaHome ? join(javaHome, 'bin/java') : 'java';
if (spawnSync(javac, ['-version'], { stdio: 'ignore' }).status !== 0) {
  if (process.env.LODY_REQUIRE_ANDROID_KEK_TESTS === '1') throw new Error('JDK required');
  console.log('Android custody JVM tests require a JDK; skipped on this machine.');
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
  // Lossless projection only: all expected AAD/blob bytes come from the frozen JSON.
  const b = shared.binding;
  writeFileSync(
    join(temporary, 'shared-vectors.tsv'),
    shared.vectors
      .map((v) =>
        [
          b.accountId,
          b.workspaceId,
          b.genesisHex,
          b.deviceHex,
          b.installationId,
          v.purpose,
          v.nonceHex,
          v.plaintextHex,
          v.aadHex,
          shared.kekHex,
          v.blobHex,
        ].join('\t')
      )
      .join('\n')
  );
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
  const output = join(temporary, 'java-wrapped.bin');
  writeFileSync(
    join(temporary, 'probe.bin'),
    Buffer.from(
      await seal(Buffer.from('lody.mobile.kek.installation.v1'), 'installation-probe'),
      'base64'
    )
  );
  writeFileSync(
    join(temporary, 'wrapped.bin'),
    Buffer.from(await seal(keyBytes, 'installed-epoch-key'), 'base64')
  );
  const core = file('../android/app/src/main/java/ai/lody/mobile/LodyKekCustody.java');
  run(javac, [
    '-d',
    temporary,
    core,
    file('../android/app/src/main/java/ai/lody/mobile/LodyKekCallQueue.java'),
    file('../tests/AndroidKekCustodyTests.java'),
  ]);
  run(java, ['-cp', temporary, 'ai.lody.android.AndroidKekCustodyTests', temporary]);
  const wrapped = readFileSync(output);
  assert.equal(wrapped[0], 1);
  assert.equal(wrapped.length, keyBytes.length + 29);
  const opened = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: wrapped.subarray(1, 13), additionalData: aad('installed-epoch-key') },
    key,
    wrapped.subarray(13)
  );
  assert.deepEqual(Buffer.from(opened), keyBytes);
  console.log('Java <=> JS WebCrypto AES-GCM interoperability passed.');
  // Optional compile probes require official API 24 and current API jars.
  for (const jar of (process.argv.includes('--unit-only')
    ? []
    : [process.env.ANDROID_API24_JAR, process.env.ANDROID_CURRENT_JAR]
  ).filter(Boolean)) {
    run(javac, [
      '-cp',
      jar,
      '-d',
      temporary,
      core,
      file('../android/app/src/main/java/ai/lody/mobile/LodyAndroidKekStorage.java'),
    ]);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
