/**
 * Race two shipped LedgerClients through a Loro sqlite-riverrun /append-cas
 * stream. Requires LORO_STREAMS_URL of an existing octet-stream.
 * Not production JWT/CAS.
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

async function admit(anchor: Uint8Array, membershipId: Uint8Array) {
  const extra = await ed25519();
  return {
    type: 'admitDevice' as const,
    kind: 'personal' as const,
    signingPublicKey: extra.publicKey,
    encryptionPublicKey: extra.enc,
    possessionSignature: await extra.sign(
      possessionSigningBytes({
        genesis: anchor,
        targetMembershipId: membershipId,
        signingPublicKey: extra.publicKey,
        encryptionPublicKey: extra.enc,
        kind: 'personal',
      })
    ),
  };
}

async function main() {
  if (!url) {
    process.stdout.write('{"error":"LORO_STREAMS_URL unset"}\n');
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
  const ledger = await Ledger.verify({
    anchor: await hashRecord(genesis),
    records: [genesis],
  });
  const first = ledger.prepare(
    await admit(await hashRecord(genesis), ledger.state.owner),
    owner.publicKey
  );
  const second = ledger.prepare(
    await admit(await hashRecord(genesis), ledger.state.owner),
    owner.publicKey
  );
  const recA = encodeSignedRecord(first.bodyBytes, await owner.sign(first.signingBytes));
  const recB = encodeSignedRecord(second.bodyBytes, await owner.sign(second.signingBytes));
  const sdk = () =>
    new StreamsLedgerStream(
      new StreamsClient({
        url,
        fetch: globalThis.fetch.bind(globalThis),
        retry: { maxAttempts: 0 },
      })
    );
  const leader = await LedgerClient.open(genesis, new MemoryLedgerStore(), sdk());
  const follower = await LedgerClient.open(genesis, new MemoryLedgerStore(), sdk());
  const [a, b] = await Promise.all([leader.submit(recA), follower.submit(recB)]);
  const statuses = [a.status, b.status].sort();
  const winner = a.status === 'committed' ? leader : follower;
  const loser = a.status === 'committed' ? follower : leader;
  const winnerView = await winner.read();
  const loserView = await loser.read();
  const head = await fetch(url, { method: 'HEAD' });
  const report = {
    statuses,
    equalHeads: Buffer.from(winnerView.head).equals(Buffer.from(loserView.head)),
    winnerLength: winnerView.length,
    loserLength: loserView.length,
    streamExtensions: head.headers.get('Stream-Extensions'),
    nextOffset: head.headers.get('Stream-Next-Offset'),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!(statuses.includes('committed') && statuses.includes('conflict') && report.equalHeads)) {
    process.exit(2);
  }
}

await main();
