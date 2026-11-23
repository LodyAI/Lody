import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Result } from 'effect';
import { startDevServer } from '@loro-dev/sqlite-riverrun';
import { StreamsClient } from '@loro-dev/streams-client';
import { Bytes } from '@lody/e2ee-core';
import { encodeCbor, type CborValue } from '@lody/e2ee-core/protocol';
import { hashRecordBytes, verifyLedger } from '@lody/e2ee-core/protocol';
import { frameLedgerRecord } from '@lody/e2ee-core/protocol';
import { expect } from 'vitest';
const ok = Result.getOrThrow;
/** Synthetic account and signing seed, real Ed25519 and public protocol codec. */
export function history(syntheticSigningSeed = 51) {
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, syntheticSigningSeed),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = new Uint8Array(
    createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)
  );
  const owner = {
    publicKey: ok(Bytes.signingPublicKey(publicKey)),
    sign: (message: Uint8Array) =>
      Effect.sync(() => ok(Bytes.signature(new Uint8Array(sign(null, message, key))))),
  };
  const signed = (body: readonly CborValue[]) =>
    ok(
      encodeCbor([
        body,
        new Uint8Array(
          sign(null, Buffer.concat([Buffer.from('lody-e2ee/sig/v1\0'), ok(encodeCbor(body))]), key)
        ),
      ])
    );
  const genesis = signed([
    1,
    publicKey,
    new Uint8Array(32).fill(52),
    new Uint8Array(16).fill(53),
    new Uint8Array(32).fill(54),
    new Uint8Array(32).fill(55),
  ]);
  const anchor = ok(Bytes.genesisHash(hashRecordBytes(genesis).toBytes()));
  const rotate = signed([
    hashRecordBytes(genesis).toBytes(),
    publicKey,
    [7, 1, new Uint8Array(32).fill(56), new Uint8Array(72).fill(57)],
  ]);
  const records = [genesis, rotate];
  const checkpoint = { head: hashRecordBytes(rotate), length: 2 };
  const view = ok(verifyLedger({ anchor, records, checkpoint }));
  return {
    genesis,
    anchor,
    rotate,
    records,
    checkpoint,
    view,
    owner,
    membership: ok(Bytes.membershipId(new Uint8Array(16).fill(53))),
  };
}
export async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'public-e2ee-lab-ledger-'));
  const server = await startDevServer({
    host: '127.0.0.1',
    port: 0,
    dbPath: join(dir, 'remote.sqlite'),
    protocol: 'http1',
  });
  const f = history();
  try {
    expect((await fetch(`${server.baseUrl}/ds/synthetic`, { method: 'PUT' })).ok).toBe(true);
    const sdk = new StreamsClient({
      url: `${server.baseUrl}/ds/synthetic/control`,
      retry: { maxAttempts: 1 },
    });
    expect((await sdk.create({ contentType: 'application/octet-stream' })).ok).toBe(true);
    for (const record of f.records)
      expect(
        (
          await sdk.append({
            part: { contentType: 'application/octet-stream', body: ok(frameLedgerRecord(record)) },
          })
        ).ok
      ).toBe(true);
    return {
      ...f,
      dir,
      server,
      sdk,
      path: join(dir, 'client.sqlite'),
      close: async () => {
        await server.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
export function options(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: 'create' | 'open',
  stream = f.sdk
) {
  return {
    path: f.path,
    mode,
    genesis: f.anchor,
    genesisRecord: f.genesis,
    expected: mode === 'create' ? { head: hashRecordBytes(f.genesis), length: 1 } : f.checkpoint,
    budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
    stream,
  };
}
