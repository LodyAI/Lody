/**
 * Review round 2 (R2-C): epoch-key delivery storage/stream lifetime and X25519 edge
 * cases. Real Ed25519/HPKE, real ledger policy, real SQLite outbox. No sleeps.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Effect, Result, Layer } from 'effect';
import {
  Bytes,
  JournalStore,
  KeyOutbox,
  EpochStream,
  epochStreamDeliveryLayer,
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
import { nodeKeyOutboxLayer } from '@lody/e2ee-core/effect/platform-node';
import { MemoryLedgerStore, MemoryLedgerStream } from '../src/ledger/submit';
import { MemoryLedgerKeyOutbox } from '../src/ledger/delivery';
import { assertEpochStreamAppend } from '../src/ledger';
import { SqliteTextStore } from '../src/node-text-store';
import { encodeKeyOutbox } from '../src/pure/key-outbox-codec';
import { keyId } from '../src/pure/identifiers';
import {
  admitDeviceOp,
  append,
  ed25519,
  random,
  signGenesis,
  type DeviceKeys,
} from './ledger-fixtures';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const value = <A, E>(parsed: Result.Result<A, E>) =>
  Result.getOrThrowWith(parsed, (error) => error);

async function org(extra: Array<{ keys: DeviceKeys; kind: 'personal' | 'machine' | 'recovery' }>) {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  let ledger = created.ledger;
  const records = [created.record];
  for (const { keys, kind } of extra) {
    const next = await append(
      ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, keys, kind)
    );
    ledger = next.ledger;
    records.push(next.record);
  }
  const genesis = value(Bytes.genesisHash(created.anchor));
  const client = (keys: DeviceKeys) => {
    const stream = new MemoryLedgerStream();
    stream.records = [...records];
    return Effect.runPromise(
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
  };
  return { owner, created, ledger, client, k0: value(Bytes.epochKey(created.secret)) };
}

const memoryRemote = () => {
  const frames = new Map<string, Uint8Array>();
  return keyDeliveryRemoteLayer({
    async put(id, bytes) {
      frames.set(id, new Uint8Array(bytes));
    },
    async read(id) {
      return frames.get(id) ?? null;
    },
  });
};
const sender = () => hpkeSenderLayer().pipe(Layer.provide(cryptoEntropyLayer));

/** Honest single-page key stream (sqlite Riverrun returns the whole stream in one page). */
function memoryEpochStream(initial: Uint8Array) {
  let body = initial;
  return Layer.succeed(
    EpochStream,
    EpochStream.of({
      read: (offset) =>
        Effect.succeed(
          offset === '-1'
            ? { requestOffset: offset, nextOffset: `o${body.length}`, upToDate: true, body }
            : { requestOffset: offset, nextOffset: offset, upToDate: true, body: new Uint8Array() }
        ),
      append: (offset, bytes) =>
        Effect.sync(() => {
          if (offset !== `o${body.length}`) return 'conflict' as const;
          const next = new Uint8Array(body.length + bytes.length);
          next.set(body);
          next.set(bytes, body.length);
          body = next;
          return 'accepted' as const;
        }),
    })
  );
}

describe('R2-C key stream read limit', () => {
  it('insider-appended duplicates of one admissible envelope must not stop all key delivery', async () => {
    const phone = await ed25519();
    const mallory = await ed25519(); // any current non-recovery device (Guest suffices)
    const s = await org([
      { keys: phone, kind: 'personal' },
      { keys: mallory, kind: 'personal' },
    ]);
    const malloryClient = await s.client(mallory);
    // Mallory legitimately holds K0 and signs ONE honest envelope to the Owner.
    const sent = await Effect.runPromise(
      malloryClient
        .sendEpochKey(value(Bytes.signingPublicKey(s.owner.publicKey)), s.k0)
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              sender(),
              signatureVerifierLayer,
              Layer.succeed(KeyOutbox, new MemoryLedgerKeyOutbox()),
              memoryRemote()
            )
          )
        )
    );
    const frame = sent.frame;
    // The gateway check is stateless: every exact re-append is admissible.
    for (let i = 0; i < 3; i++)
      expect(() => assertEpochStreamAppend(s.ledger.state, mallory.publicKey, frame)).not.toThrow();
    const copies = Math.ceil((16 * 1024 * 1024) / frame.length) + 1;
    const flooded = new Uint8Array(copies * frame.length);
    for (let i = 0; i < copies; i++) flooded.set(frame, i * frame.length);

    // Honest Owner now hands K0 to the phone through the ordinary stream remote.
    const ownerClient = await s.client(s.owner);
    const outcome = await Effect.runPromise(
      Effect.result(
        ownerClient
          .sendEpochKey(value(Bytes.signingPublicKey(phone.publicKey)), s.k0)
          .pipe(
            Effect.provide(
              Layer.mergeAll(
                sender(),
                signatureVerifierLayer,
                Layer.succeed(KeyOutbox, new MemoryLedgerKeyOutbox()),
                epochStreamDeliveryLayer.pipe(Layer.provide(memoryEpochStream(flooded)))
              )
            )
          )
      )
    );
    const observed = Result.isSuccess(outcome)
      ? outcome.success._tag
      : `${outcome.failure._tag}:${(outcome.failure as { code?: string }).code}`;
    expect(observed).toBe('Observed');
  }, 60_000);
});

describe('R2-C sender outbox lifetime', () => {
  it('a device that has sent 4096 envelopes can still send the next key', async () => {
    const phone = await ed25519();
    const s = await org([{ keys: phone, kind: 'personal' }]);
    const dir = mkdtempSync(join(tmpdir(), 'r2c-outbox-'));
    dirs.push(dir);
    const path = join(dir, 'key-outbox.sqlite');
    await Effect.runPromise(
      Layer.build(nodeKeyOutboxLayer({ path, mode: 'create' })).pipe(Effect.scoped)
    );
    // Every honest delivery leaves its exact frame forever (no removal API on
    // KeyOutbox). Model 4096 earlier deliveries (e.g. 64 devices x 64 rotations).
    const old = new Map<string, Uint8Array>();
    for (let i = 0; i < 4096; i++) old.set(keyId(random(16)), random(248));
    const lease = new SqliteTextStore(path, 0x4c454b30, 0, {
      createFile: false,
      initializeSchema: false,
    }).openExclusive();
    lease.save(value(encodeKeyOutbox(old)));
    lease.close();

    const ownerClient = await s.client(s.owner);
    const outcome = await Effect.runPromise(
      Effect.result(
        ownerClient
          .sendEpochKey(value(Bytes.signingPublicKey(phone.publicKey)), s.k0)
          .pipe(
            Effect.provide(
              Layer.mergeAll(
                sender(),
                signatureVerifierLayer,
                nodeKeyOutboxLayer({ path, mode: 'open' }),
                memoryRemote()
              )
            )
          )
      )
    );
    const observed = Result.isSuccess(outcome)
      ? outcome.success._tag
      : `${outcome.failure._tag}:${(outcome.failure as { code?: string }).code}`;
    expect(observed).toBe('Observed');
  }, 60_000);
});

describe('R2-C X25519 low-order recipient keys', () => {
  const lowOrder = [
    '0100000000000000000000000000000000000000000000000000000000000000',
    'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
    'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  ].map((h) => Uint8Array.from(Buffer.from(h, 'hex')));

  it('ledger admits a low-order encryption key, but HPKE never seals K to it (SAFE)', async () => {
    for (const enc of lowOrder) {
      const base = await ed25519();
      const weak: DeviceKeys = { ...base, enc };
      // Admission accepts (documented: only all-zero is rejected).
      const s = await org([{ keys: weak, kind: 'personal' }]);
      expect(
        [...s.ledger.state.devices.values()].some(
          (d) => keyId(d.encryptionPublicKey) === keyId(enc)
        )
      ).toBe(true);
      const ownerClient = await s.client(s.owner);
      const outcome = await Effect.runPromise(
        Effect.result(
          ownerClient
            .sendEpochKey(value(Bytes.signingPublicKey(weak.publicKey)), s.k0)
            .pipe(
              Effect.provide(
                Layer.mergeAll(
                  sender(),
                  signatureVerifierLayer,
                  Layer.succeed(KeyOutbox, new MemoryLedgerKeyOutbox()),
                  memoryRemote()
                )
              )
            )
        )
      );
      // No envelope whose DH output is public (all-zero) is ever produced.
      expect(Result.isFailure(outcome) && outcome.failure._tag).toBe('CryptoError');
    }
  });
});
