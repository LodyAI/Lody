/**
 * L7 production CAS probe on shipped APIs.
 * Requires LORO_STREAMS_URL. Does not invent a backend or treat local TCP as production.
 */
import { StreamsClient } from '@loro-dev/streams-client';
import { Ledger } from '@lody/e2ee-core';
import {
  LedgerClient,
  MemoryLedgerStore,
  commitEpochKey,
  encodeGenesisBody,
  encodeSignedRecord,
  hashRecord,
  possessionSigningBytes,
  signingBytesForBody,
} from '@lody/e2ee-core/ledger';
import { StreamsLedgerStream } from '@lody/e2ee-core/streams';

const url = process.env.LORO_STREAMS_URL?.trim() ?? '';
const token = process.env.LORO_STREAMS_TOKEN?.trim() ?? '';

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

function random(n: number) {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function main() {
  if (!url || url.includes('invalid') || url.includes('example.test')) {
    const report = {
      productionAtomicCas: false,
      LORO_STREAMS_URL: url || 'unset',
      reason: 'no production/authorized Streams URL in LORO_STREAMS_URL',
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(2);
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
  const extra = await ed25519();
  const ledger = await Ledger.verify({
    anchor: await hashRecord(genesis),
    records: [genesis],
  });
  const proposal = ledger.prepare(
    {
      type: 'admitDevice',
      kind: 'personal',
      signingPublicKey: extra.publicKey,
      encryptionPublicKey: extra.enc,
      canManage: false,
      possessionSignature: await extra.sign(
        possessionSigningBytes({
          genesis: await hashRecord(genesis),
          targetMembershipId: ledger.state.owner,
          signingPublicKey: extra.publicKey,
          encryptionPublicKey: extra.enc,
          kind: 'personal',
          canManage: false,
        })
      ),
    },
    owner.publicKey
  );
  const record = encodeSignedRecord(proposal.bodyBytes, await owner.sign(proposal.signingBytes));
  const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3_000) }).catch(
    (error) =>
      ({
        status: 0,
        headers: new Headers(),
        error,
      }) as Response & { error?: unknown }
  );
  const extensions = head.headers.get('Stream-Extensions');
  const sdk = () =>
    new StreamsLedgerStream(
      new StreamsClient({
        url,
        fetch: globalThis.fetch.bind(globalThis),
        retry: { maxAttempts: 0 },
        ...(token ? { auth: async () => token } : {}),
      })
    );
  try {
    const leader = await LedgerClient.open(genesis, new MemoryLedgerStore(), sdk());
    const follower = await LedgerClient.open(genesis, new MemoryLedgerStore(), sdk());
    const a = await leader.submit(record);
    const b = await follower.submit(record);
    const statuses = [a.status, b.status].sort();
    const casOk = statuses.includes('committed') && (extensions ?? '').includes('append-cas');
    const loopback = /127\.0\.0\.1|localhost/i.test(url);
    const report = {
      atomicCas: casOk,
      productionAtomicCas: casOk && !loopback,
      loopback,
      LORO_STREAMS_URL: url,
      headStatus: head.status,
      streamExtensions: extensions,
      statuses,
      leaderLength: (await leader.read()).length,
      followerLength: (await follower.read()).length,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!casOk) process.exit(2);
  } catch (error) {
    const report = {
      productionAtomicCas: false,
      LORO_STREAMS_URL: url,
      headStatus: head.status,
      streamExtensions: extensions,
      error: error instanceof Error ? `${error.name}:${error.message}` : String(error),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(2);
  }
}

await main();
