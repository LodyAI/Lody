/**
 * Review round 2 (R2-C): rotation lifecycle beyond round 1 and recovery-device R
 * key receipt. Real Ed25519/HPKE, real node keyring/candidate files, shared
 * in-memory CAS stream. No sleeps.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Effect, Result, Layer } from 'effect';
import {
  Bytes,
  JournalStore,
  KeyOutbox,
  LedgerClient as NativeLedgerClient,
} from '@lody/e2ee-core/effect';
import {
  cryptoEntropyLayer,
  deviceSignerLayer,
  hpkeSenderLayer,
  keyDeliveryRemoteLayer,
  ledgerTransportLayer,
  signatureVerifierLayer,
} from '@lody/e2ee-core/effect/platform';
import { nodeEpochFilesLayer } from '@lody/e2ee-core/effect/platform-node';
import { MemoryLedgerStore, MemoryLedgerStream } from '../src/ledger/submit';
import { MemoryLedgerKeyOutbox } from '../src/ledger/delivery';
import {
  admitDeviceOp,
  append,
  ed25519,
  hex,
  signGenesis,
  type DeviceKeys,
} from './ledger-fixtures';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const value = <A, E>(parsed: Result.Result<A, E>) =>
  Result.getOrThrowWith(parsed, (error) => error);

async function setup() {
  const a = await ed25519(); // Owner personal device (genesis)
  const b = await ed25519(); // Owner's second personal device (also manages)
  const r = await ed25519(); // Owner's recovery device R
  const created = await signGenesis(a);
  const admitB = await append(
    created.ledger,
    a,
    await admitDeviceOp(created.anchor, created.membershipId, b, 'personal')
  );
  const admitR = await append(
    admitB.ledger,
    a,
    await admitDeviceOp(created.anchor, created.membershipId, r, 'recovery')
  );
  const stream = new MemoryLedgerStream();
  stream.records = [created.record, admitB.record, admitR.record];
  const genesis = value(Bytes.genesisHash(created.anchor));
  const client = (keys: DeviceKeys) =>
    Effect.runPromise(
      NativeLedgerClient.importGenesis({ anchor: genesis, genesisRecord: created.record }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(JournalStore, new MemoryLedgerStore()),
            ledgerTransportLayer(stream),
            deviceSignerLayer(value(Bytes.signingPublicKey(keys.publicKey)), keys.sign),
            signatureVerifierLayer
          )
        )
      )
    );
  const files = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), `r2c-rot-${name}-`));
    dirs.push(dir);
    const keyringPath = join(dir, 'epochs.json');
    writeFileSync(keyringPath, `${JSON.stringify([[0, hex(created.secret)]])}\n`);
    return Layer.merge(
      nodeEpochFilesLayer({
        genesis,
        candidatePath: join(dir, 'epoch-candidate.json'),
        keyringPath,
      }),
      cryptoEntropyLayer
    );
  };
  return { a, b, r, created, stream, client, files };
}

describe('R2-C rotation lifecycle', () => {
  it('another manager can still rotate after the rotator is lost before delivering K1', async () => {
    const s = await setup();
    const clientA = await s.client(s.a);
    const clientB = await s.client(s.b);
    const filesA = s.files('a');
    const filesB = s.files('b');
    const first = await Effect.runPromise(clientA.rotateEpoch().pipe(Effect.provide(filesA)));
    expect(first).toMatchObject({ _tag: 'Committed', epoch: 1 });
    // Device A dies (disk loss) before sendCurrentEpochKey reaches anyone. K1 now
    // exists nowhere else. B is an honest current Owner device holding K0.
    const second = await Effect.runPromise(
      Effect.result(clientB.rotateEpoch().pipe(Effect.provide(filesB)))
    );
    const outcome = Result.isSuccess(second)
      ? second.success._tag
      : `${second.failure._tag}:${(second.failure as { reason?: string }).reason}`;
    // Availability expectation: the Org is not permanently frozen at an epoch
    // whose key nobody holds (no content seal, no further rotation possible).
    expect(outcome).toBe('Committed');
  });

  it('a revoked recovery device R is refused as a key recipient (SAFE)', async () => {
    const s = await setup();
    const clientA = await s.client(s.a);
    const revoked = await Effect.runPromise(
      clientA.execute({
        _tag: 'RevokeDevice',
        target: value(Bytes.signingPublicKey(s.r.publicKey)),
      })
    );
    expect(revoked._tag).toBe('Committed');
    const frames = new Map<string, Uint8Array>();
    const outcome = await Effect.runPromise(
      Effect.result(
        clientA
          .sendEpochKey(
            value(Bytes.signingPublicKey(s.r.publicKey)),
            value(Bytes.epochKey(s.created.secret))
          )
          .pipe(
            Effect.provide(
              Layer.mergeAll(
                hpkeSenderLayer().pipe(Layer.provide(cryptoEntropyLayer)),
                signatureVerifierLayer,
                Layer.succeed(KeyOutbox, new MemoryLedgerKeyOutbox()),
                keyDeliveryRemoteLayer({
                  async put(id, bytes) {
                    frames.set(id, bytes);
                  },
                  async read(id) {
                    return frames.get(id) ?? null;
                  },
                })
              )
            )
          )
      )
    );
    expect(Result.isFailure(outcome)).toBe(true);
    expect(frames.size).toBe(0);
  });
});
