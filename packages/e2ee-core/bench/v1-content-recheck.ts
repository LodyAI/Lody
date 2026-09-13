/**
 * Narrow re-check of content/recovery surface for public-e2ee freeze SHA
 * 194b4ad81b94ba25befa866d5abfa027774db3118692c0738b0342ab62f832fb
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ContentCipher,
  Ledger,
  createRecoveryFile,
  openRecoveryBackup,
  sealRecoveryBackup,
} from '@lody/e2ee-core';
import {
  commitEpochKey,
  encodeGenesisBody,
  encodeSignedRecord,
  hashRecord,
  signingBytesForBody,
} from '@lody/e2ee-core/ledger';
import { createStreamsContentProvider } from '@lody/e2ee-core/streams-content';
import type { PayloadProtectionContext } from '@loro-dev/streams-crdt';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXPECTED_LEDGER = 'aba164b356cbaece6a3076a945a61076d3db3ab806573968afa1322347db919b';
const EXPECTED_PUBLIC = '194b4ad81b94ba25befa866d5abfa027774db3118692c0738b0342ab62f832fb';

function shaFiles(paths: string[]): string {
  const h = createHash('sha256');
  for (const p of paths) h.update(readFileSync(p));
  return h.digest('hex');
}

const ledgerFiles = readdirSync(join(ROOT, 'src/ledger'))
  .filter((n) => n.endsWith('.ts'))
  .sort()
  .map((n) => join(ROOT, 'src/ledger', n));
const publicFiles = [
  ...ledgerFiles,
  join(ROOT, 'src/streams-content.ts'),
  join(ROOT, 'src/content.ts'),
  join(ROOT, 'src/recovery-file.ts'),
  join(ROOT, 'src/streams.ts'),
];

const ledgerSha = shaFiles(ledgerFiles);
const publicSha = shaFiles(publicFiles);
if (ledgerSha !== EXPECTED_LEDGER) throw new Error(`ledger-sha-mismatch:${ledgerSha}`);
if (publicSha !== EXPECTED_PUBLIC) throw new Error(`public-sha-mismatch:${publicSha}`);

const held: string[] = [];
const landed: string[] = [];
function hold(name: string) {
  held.push(name);
}
function land(name: string) {
  landed.push(name);
}

async function ed25519() {
  const pair = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    publicKey,
    async sign(bytes: Uint8Array) {
      const message = new Uint8Array(bytes.byteLength);
      message.set(bytes);
      return new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, message));
    },
  };
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

async function main() {
  const owner = await ed25519();
  const k0 = random(32);
  const body = encodeGenesisBody({
    signer: owner.publicKey,
    userId: random(32),
    membershipId: random(16),
    encryptionPublicKey: random(32),
    epochCommitment: await commitEpochKey(new Uint8Array(32), 0, k0),
  });
  const genesis = encodeSignedRecord(body, await owner.sign(signingBytesForBody(body)));
  const anchor = await hashRecord(genesis);
  await Ledger.verify({ anchor, records: [genesis] });

  const pair = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const signingPublic = hex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const author = { actor: 'owner', memberInstance: 'm0', device: 'd0' };
  const provider = createStreamsContentProvider({
    cipher: new ContentCipher({
      authorize(header) {
        if (header.actor !== author.actor) throw new Error('unauthorized');
        return signingPublic;
      },
    }),
    genesis: hex(anchor),
    resource: 'doc-1',
    model: 'loro',
    writeEpoch: 0,
    author,
    signingKey: pair.privateKey,
    readKey: (epoch) => (epoch === 0 ? k0 : undefined),
  });

  const snapshot = {
    protocol: 'loro-streams-crdt-payload-protection',
    version: 2,
    kind: 'snapshot',
  } as PayloadProtectionContext;
  try {
    await provider.seal({
      plaintext: new Uint8Array([1]),
      context: snapshot,
      additionalData: () => {
        throw new Error('must-not-request-aad');
      },
    });
    land('snapshot-seal-accepted');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/snapshot-evidence-required/.test(message) && !/must-not-request-aad/.test(message)) {
      hold('snapshot-seal-fail-closed');
    } else land(`snapshot-seal:${message}`);
  }
  try {
    await provider.open({
      sealed: new Uint8Array([1]),
      header: new Uint8Array([1]),
      context: snapshot,
      additionalData: new Uint8Array([1]),
    });
    land('snapshot-open-accepted');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/snapshot-evidence-required/.test(message)) hold('snapshot-open-fail-closed');
    else land(`snapshot-open:${message}`);
  }

  const update = {
    protocol: 'loro-streams-crdt-payload-protection',
    version: 2,
    kind: 'update_batch',
  } as PayloadProtectionContext;
  const aad = new Uint8Array([7, 7, 7, 7]);
  const sealed = await provider.seal({
    plaintext: new TextEncoder().encode('secret-doc'),
    context: update,
    additionalData: () => aad,
  });
  const opened = await provider.open({
    sealed: sealed.sealed,
    header: sealed.header,
    context: update,
    additionalData: aad,
  });
  if (new TextDecoder().decode(opened) === 'secret-doc') hold('honest-content-open');
  else land('honest-content-mismatch');

  const wrong = createStreamsContentProvider({
    cipher: new ContentCipher({
      authorize() {
        return signingPublic;
      },
    }),
    genesis: hex(anchor),
    resource: 'doc-OTHER',
    model: 'loro',
    writeEpoch: 0,
    author,
    signingKey: pair.privateKey,
    readKey: () => k0,
  });
  try {
    const plain = await wrong.open({
      sealed: sealed.sealed,
      header: sealed.header,
      context: update,
      additionalData: aad,
    });
    if (new TextDecoder().decode(plain).includes('secret-doc')) land('wrong-resource-leaked');
    else hold('wrong-resource-no-secret');
  } catch {
    hold('wrong-resource-rejected');
  }

  const wrongKey = createStreamsContentProvider({
    cipher: new ContentCipher({
      authorize() {
        return signingPublic;
      },
    }),
    genesis: hex(anchor),
    resource: 'doc-1',
    model: 'loro',
    writeEpoch: 0,
    author,
    signingKey: pair.privateKey,
    readKey: () => random(32),
  });
  try {
    const plain = await wrongKey.open({
      sealed: sealed.sealed,
      header: sealed.header,
      context: update,
      additionalData: aad,
    });
    if (new TextDecoder().decode(plain).includes('secret-doc')) land('wrong-key-leaked');
    else hold('wrong-key-no-secret');
  } catch {
    hold('wrong-key-rejected');
  }

  const file = createRecoveryFile();
  const context = { identity: hex(random(32)), revision: 1 };
  const wrapped = sealRecoveryBackup(file, context, k0);
  const openedBackup = openRecoveryBackup(file, context, wrapped);
  if (Buffer.from(openedBackup).equals(Buffer.from(k0))) hold('recovery-honest');
  else land('recovery-honest-mismatch');
  const other = createRecoveryFile();
  try {
    openRecoveryBackup(other, context, wrapped);
    land('recovery-wrong-file-opened');
  } catch {
    hold('recovery-wrong-file-rejected');
  }
  try {
    openRecoveryBackup(file, { identity: hex(random(32)), revision: 1 }, wrapped);
    land('recovery-wrong-identity-opened');
  } catch {
    hold('recovery-wrong-identity-rejected');
  }

  const report = {
    ledgerSha,
    publicSha,
    match: true,
    landed,
    held,
    landedCount: landed.length,
    heldCount: held.length,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (landed.length > 0) process.exit(2);
}

await main();
