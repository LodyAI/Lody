/**
 * C2 throwaway directory install: copy the public package, rewrite catalog:
 * versions, pnpm-install into an independent consumer, then import only
 * `@lody/e2ee-core` and `@lody/e2ee-core/ledger` twice and drive verify/extend.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const catalog = {
  '@loro-dev/streams-client': '0.7.0',
  '@loro-dev/streams-crdt': '0.15.1',
} as const;

const root = process.env.THROWAY_DIR?.trim()
  ? process.env.THROWAY_DIR
  : mkdtempSync(join(tmpdir(), 'lody-e2ee-throwaway-'));
const packed = join(root, 'packed-e2ee-core');
const consumer = join(root, 'consumer');
rmSync(packed, { recursive: true, force: true });
rmSync(consumer, { recursive: true, force: true });
mkdirSync(packed, { recursive: true });
mkdirSync(consumer, { recursive: true });

cpSync(join(pkgRoot, 'src'), join(packed, 'src'), { recursive: true });
cpSync(join(pkgRoot, 'package.json'), join(packed, 'package.json'));
cpSync(join(pkgRoot, 'tsconfig.json'), join(packed, 'tsconfig.json'));
const manifest = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8')) as {
  private?: boolean;
  scripts?: unknown;
  devDependencies?: unknown;
  dependencies: Record<string, string>;
};
delete manifest.private;
delete manifest.scripts;
delete manifest.devDependencies;
for (const [name, version] of Object.entries(manifest.dependencies)) {
  if (version === 'catalog:') {
    const pinned = catalog[name as keyof typeof catalog];
    if (!pinned) throw new Error(`unmapped-catalog:${name}`);
    manifest.dependencies[name] = pinned;
  }
}
writeFileSync(join(packed, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

writeFileSync(
  join(consumer, 'package.json'),
  `${JSON.stringify(
    {
      name: 'e2ee-throwaway-consumer',
      private: true,
      type: 'module',
      dependencies: {
        '@lody/e2ee-core': `file:${packed}`,
      },
    },
    null,
    2
  )}\n`
);

writeFileSync(
  join(consumer, 'consumer.ts'),
  `import { Ledger as LedgerA } from '@lody/e2ee-core';
import { Ledger as LedgerB } from '@lody/e2ee-core';
import {
  commitEpochKey,
  encodeGenesisBody,
  encodeSignedRecord,
  hashRecord,
  possessionSigningBytes,
  signingBytesForBody,
} from '@lody/e2ee-core/ledger';

async function ed25519() {
  const pair = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const x = (await crypto.subtle.generateKey('X25519', false, ['deriveBits'])) as CryptoKeyPair;
  const enc = new Uint8Array(await crypto.subtle.exportKey('raw', x.publicKey));
  return {
    publicKey,
    enc,
    async sign(bytes: Uint8Array) {
      const message = new Uint8Array(bytes.byteLength);
      message.set(bytes);
      return new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, message));
    },
  };
}

function random(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

const owner = await ed25519();
const secret = random(32);
const body = encodeGenesisBody({
  signer: owner.publicKey,
  userId: random(32),
  membershipId: random(16),
  encryptionPublicKey: owner.enc,
  epochCommitment: await commitEpochKey(new Uint8Array(32), 0, secret),
});
const genesis = encodeSignedRecord(body, await owner.sign(signingBytesForBody(body)));
const anchor = await hashRecord(genesis);
if (LedgerA !== LedgerB) throw new Error('double-import-identity');
const first = await LedgerA.verify({ anchor, records: [genesis] });
if (first.length !== 1) throw new Error('verify-length');
const extra = await ed25519();
const proposal = first.prepare(
  {
    type: 'admitDevice',
    kind: 'personal',
    signingPublicKey: extra.publicKey,
    encryptionPublicKey: extra.enc,
    canManage: false,
    possessionSignature: await extra.sign(
      possessionSigningBytes({
        genesis: anchor,
        signingPublicKey: extra.publicKey,
        encryptionPublicKey: extra.enc,
        kind: 'personal',
        canManage: false,
      })
    ),
  },
  owner.publicKey
);
const suffix = encodeSignedRecord(proposal.bodyBytes, await owner.sign(proposal.signingBytes));
const extended = await first.extend([suffix]);
const again = await LedgerB.verify({ anchor, records: [genesis, suffix] });
if (extended.length !== 2 || again.length !== 2) throw new Error('extend-length');
if (extended.head.some((byte, i) => byte !== again.head[i])) throw new Error('extend-head');
process.stdout.write(
  JSON.stringify(
    {
      imports: ['@lody/e2ee-core', '@lody/e2ee-core', '@lody/e2ee-core/ledger'],
      sameExport: LedgerA === LedgerB,
      verifyLength: first.length,
      extendLength: extended.length,
      fromZeroMatchesExtend: true,
      resolved: '@lody/e2ee-core@file:packed',
    },
    null,
    2
  ) + '\\n'
);
`
);

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
  }
  return result;
}

run('pnpm', ['install'], consumer);
const tsx = join(pkgRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ran = run(process.execPath, [tsx, join(consumer, 'consumer.ts')], consumer);
process.stdout.write(
  `${JSON.stringify({ throwaway: root, consumer, packed, output: ran.stdout }, null, 2)}\n`
);
