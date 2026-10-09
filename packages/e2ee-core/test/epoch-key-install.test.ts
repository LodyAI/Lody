/**
 * Epoch-key installation, envelopes and history. Real crypto, real
 * Node keyring files, deterministic stream hooks (no sleeps).
 *
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Effect, Result, Layer } from 'effect';
import {
  Bytes,
  EpochKeyring,
  HpkeRecipient,
  LedgerClient as NativeLedgerClient,
  JournalStore,
  KeyOutbox,
} from '@lody/e2ee-core/effect';
import {
  cryptoEntropyLayer,
  deviceSignerLayer,
  hpkeRecipientLayer,
  hpkeSenderLayer,
  keyDeliveryRemoteLayer,
  ledgerTransportLayer,
  signatureVerifierLayer,
} from '@lody/e2ee-core/effect/platform';
import { nodeEpochFilesLayer } from '@lody/e2ee-core/effect/platform-node';
import { MemoryLedgerStore, MemoryLedgerStream } from '../src/ledger/submit';
import { MemoryLedgerKeyOutbox } from '../src/ledger/delivery';
import { commitEpochKey, sealHistoryPacket } from '../src/ledger';
import { copyEpochKeyBytes } from '../src/pure/epoch-key';
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

async function device(): Promise<DeviceKeys & { dh: CryptoKeyPair }> {
  const keys = await ed25519();
  const dh = (await crypto.subtle.generateKey('X25519', false, ['deriveBits'])) as CryptoKeyPair;
  const enc = new Uint8Array(await crypto.subtle.exportKey('raw', dh.publicKey));
  return { ...keys, enc, dh };
}

const value = <A, E>(parsed: Result.Result<A, E>) =>
  Result.getOrThrowWith(parsed, (error) => error);

/** A stream whose reads can be observed and extended deterministically. */
class HookedStream extends MemoryLedgerStream {
  onRead: (() => void) | null = null;
  override async readAfter(offset: string) {
    this.onRead?.();
    return super.readAfter(offset);
  }
}

async function scenario() {
  const owner = await device();
  const phone = await device(); // honest receiving device of the Owner
  const laptop = await device(); // revoked device; it legitimately held K0
  const created = await signGenesis(owner);
  const admitPhone = await append(
    created.ledger,
    owner,
    await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
  );
  const admitLaptop = await append(
    admitPhone.ledger,
    owner,
    await admitDeviceOp(created.anchor, created.membershipId, laptop, 'personal')
  );
  const revoke = await append(admitLaptop.ledger, owner, {
    type: 'revokeDevice',
    target: laptop.publicKey,
  });
  const k1 = random(32);
  const commitment1 = await commitEpochKey(created.anchor, 1, k1);
  const rotate = await append(revoke.ledger, owner, {
    type: 'publishEpoch',
    epoch: 1,
    commitment: commitment1,
    previousEpochKey: sealHistoryPacket(k1, created.secret, created.anchor, 1),
  });
  const prefix = [created.record, admitPhone.record, admitLaptop.record, revoke.record];
  const genesis = value(Bytes.genesisHash(created.anchor));
  const makeClient = (keys: DeviceKeys, stream: MemoryLedgerStream) =>
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
  const frames = new Map<string, Uint8Array>();
  const deliveryLayer = Layer.mergeAll(
    hpkeSenderLayer().pipe(Layer.provide(cryptoEntropyLayer)),
    signatureVerifierLayer,
    Layer.succeed(KeyOutbox, new MemoryLedgerKeyOutbox()),
    keyDeliveryRemoteLayer({
      async put(id, bytes) {
        frames.set(id, new Uint8Array(bytes));
      },
      async read(id) {
        return frames.get(id) ?? null;
      },
    })
  );
  const dir = mkdtempSync(join(tmpdir(), 'sec-review-c-'));
  dirs.push(dir);
  const keyringPath = join(dir, 'epochs.json');
  writeFileSync(keyringPath, '[]\n');
  const phoneKeyring = nodeEpochFilesLayer({
    genesis,
    candidatePath: join(dir, 'epoch-candidate.json'),
    keyringPath,
  });
  return {
    owner,
    phone,
    laptop,
    created,
    rotate,
    prefix,
    genesis,
    k1,
    commitment1,
    makeClient,
    deliveryLayer,
    phoneKeyring,
    ownerId: value(Bytes.signingPublicKey(owner.publicKey)),
    phoneId: value(Bytes.signingPublicKey(phone.publicKey)),
  };
}

/** Owner prepares/sends the epoch-0 key to the phone while the ledger is at epoch 0. */
async function epochZeroFrame(s: Awaited<ReturnType<typeof scenario>>) {
  const ownerStream = new MemoryLedgerStream();
  ownerStream.records = [...s.prefix];
  const ownerClient = await s.makeClient(s.owner, ownerStream);
  const sent = await Effect.runPromise(
    ownerClient
      .sendEpochKey(s.phoneId, value(Bytes.epochKey(s.created.secret)))
      .pipe(Effect.provide(s.deliveryLayer))
  );
  expect(sent._tag).toBe('Observed');
  return sent.frame;
}

/**
 * The phone opens the epoch-0 envelope; the epoch-1 rotation becomes visible on the
 * `revealAt`-th ledger read after decryption.
 */
async function racedReceive(
  s: Awaited<ReturnType<typeof scenario>>,
  frame: Uint8Array,
  revealAt: number
) {
  const phoneStream = new HookedStream();
  phoneStream.records = [...s.prefix];
  const phoneClient = await s.makeClient(s.phone, phoneStream);
  let opened = false;
  let readsAfterOpen = 0;
  phoneStream.onRead = () => {
    if (opened && ++readsAfterOpen === revealAt) phoneStream.records.push(s.rotate.record);
  };
  const flagOpen = Layer.effect(
    HpkeRecipient,
    Effect.gen(function* () {
      const actual = yield* HpkeRecipient;
      return HpkeRecipient.of({
        publicKey: actual.publicKey,
        open: (parts) =>
          actual.open(parts).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                opened = true;
              })
            )
          ),
      });
    })
  ).pipe(Layer.provide(hpkeRecipientLayer(s.phone.dh)));
  const layer = Layer.mergeAll(flagOpen, signatureVerifierLayer, s.phoneKeyring);
  const result = await Effect.runPromise(
    Effect.result(phoneClient.receiveEpochKey(s.ownerId, frame).pipe(Effect.provide(layer)))
  );
  return { result, phoneClient, phoneStream, layer };
}

const readSlot = (s: Awaited<ReturnType<typeof scenario>>, epoch: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const keyring = yield* EpochKeyring;
      const key = yield* keyring.get(s.genesis, value(Bytes.epochNumber(epoch)));
      return key === null ? null : copyEpochKeyBytes(key);
    }).pipe(Effect.provide(s.phoneKeyring))
  );

describe('epoch-key installation slot', () => {
  it('installs a verified key at its own epoch when rotation lands after verification', async () => {
    const s = await scenario();
    const frame = await epochZeroFrame(s);
    const raced = await racedReceive(s, frame, 2);
    expect(raced.result).toEqual(Result.succeed({ _tag: 'Installed', epoch: 0 }));
    expect(await readSlot(s, 0)).toEqual(s.created.secret);
    // K0 (known to the revoked laptop) never occupies the epoch-1 slot ...
    expect(await readSlot(s, 1)).toBeNull();

    // ... so the committed K1 still installs there.
    raced.phoneStream.onRead = null;
    raced.phoneStream.records.splice(s.prefix.length, Infinity, s.rotate.record);
    const ownerStream = new MemoryLedgerStream();
    ownerStream.records = [...s.prefix, s.rotate.record];
    const ownerClient = await s.makeClient(s.owner, ownerStream);
    const sent = await Effect.runPromise(
      ownerClient
        .sendEpochKey(s.phoneId, value(Bytes.epochKey(s.k1)))
        .pipe(Effect.provide(s.deliveryLayer))
    );
    expect(sent._tag).toBe('Observed');
    const second = await Effect.runPromise(
      raced.phoneClient.receiveEpochKey(s.ownerId, sent.frame).pipe(Effect.provide(raced.layer))
    );
    expect(second).toEqual({ _tag: 'Installed', epoch: 1 });
    expect(await readSlot(s, 1)).toEqual(s.k1);
  });

  it('fails closed when rotation lands between decryption and the recheck', async () => {
    const s = await scenario();
    const raced = await racedReceive(s, await epochZeroFrame(s), 1);
    expect(raced.result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'ContextMismatch' } });
    expect(await readSlot(s, 0)).toBeNull();
    expect(await readSlot(s, 1)).toBeNull();
  });

  it('installs a key at the epoch it was verified against, even if the ledger advanced later', async () => {
    const s = await scenario();
    const frame = await epochZeroFrame(s);
    const phoneStream = new HookedStream();
    phoneStream.records = [...s.prefix];
    const phoneClient = await s.makeClient(s.phone, phoneStream);
    const layer = Layer.mergeAll(
      hpkeRecipientLayer(s.phone.dh),
      signatureVerifierLayer,
      s.phoneKeyring
    );
    const installed = await Effect.runPromise(
      phoneClient.receiveEpochKey(s.ownerId, frame).pipe(Effect.provide(layer))
    );
    expect(installed).toEqual({ _tag: 'Installed', epoch: 0 });
    phoneStream.records.push(s.rotate.record);
    expect(await readSlot(s, 0)).toEqual(s.created.secret);
    expect(await readSlot(s, 1)).toBeNull();
  });
});

describe('C safe checks (role-derived rotation, R cannot send, cross-epoch replay)', () => {
  it('SAFE: rotation follows the current role of every personal device; machine/R never rotate', async () => {
    const { signJoin } = await import('./ledger-fixtures');
    const owner = await device();
    const bob = await device();
    const bobPhone = await device();
    const bobMachine = await device();
    const created = await signGenesis(owner);
    const admitted = await append(created.ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request: await signJoin(created.anchor, bob),
    });
    const bobId = [...admitted.ledger.state.devices.entries()].find(
      ([id]) => id === Buffer.from(bob.publicKey).toString('hex')
    )![1].membershipId;
    const promoted = await append(admitted.ledger, owner, {
      type: 'setRole',
      membershipId: bobId,
      role: 'admin',
    });
    const phone = await append(
      promoted.ledger,
      bob,
      await admitDeviceOp(created.anchor, bobId, bobPhone, 'personal')
    );
    const machine = await append(
      phone.ledger,
      bob,
      await admitDeviceOp(created.anchor, bobId, bobMachine, 'machine')
    );
    const publish = (epoch: number) => {
      const k = random(32);
      return commitEpochKey(created.anchor, epoch, k).then((commitment) => ({
        type: 'publishEpoch' as const,
        epoch,
        commitment,
        previousEpochKey: sealHistoryPacket(k, random(32), created.anchor, epoch),
      }));
    };
    // Admin's second personal device may rotate; machine may not.
    await expect(append(machine.ledger, bobMachine, await publish(1))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    const rotated = await append(machine.ledger, bobPhone, await publish(1));
    const demoted = await append(rotated.ledger, owner, {
      type: 'setRole',
      membershipId: bobId,
      role: 'member',
    });
    for (const d of [bob, bobPhone, bobMachine])
      await expect(append(demoted.ledger, d, await publish(2))).rejects.toMatchObject({
        code: 'unauthorized',
      });
  });

  it('SAFE: native sendEpochKey refuses a recovery-device sender; stale-epoch frames are refused after rotation', async () => {
    const s = await scenario();
    const recovery = await device();
    const withR = await append(
      s.created.ledger,
      s.owner,
      await admitDeviceOp(s.created.anchor, s.created.membershipId, recovery, 'recovery')
    );
    const stream = new MemoryLedgerStream();
    stream.records = [s.created.record, withR.record];
    const rClient = await s.makeClient(recovery, stream);
    const refused = await Effect.runPromise(
      Effect.result(
        rClient
          .sendEpochKey(s.ownerId, value(Bytes.epochKey(s.created.secret)))
          .pipe(Effect.provide(s.deliveryLayer))
      )
    );
    expect(refused).toMatchObject({ _tag: 'Failure', failure: { code: 'unauthorized' } });

    // An epoch-0 frame presented after the phone already observed epoch 1 is refused.
    const frame = await epochZeroFrame(s);
    const phoneStream = new MemoryLedgerStream();
    phoneStream.records = [...s.prefix, s.rotate.record];
    const phoneClient = await s.makeClient(s.phone, phoneStream);
    const stale = await Effect.runPromise(
      Effect.result(
        phoneClient
          .receiveEpochKey(s.ownerId, frame)
          .pipe(
            Effect.provide(
              Layer.mergeAll(hpkeRecipientLayer(s.phone.dh), signatureVerifierLayer, s.phoneKeyring)
            )
          )
      )
    );
    expect(stale).toMatchObject({ _tag: 'Failure', failure: { code: 'canonical' } });
    expect(await readSlot(s, 1)).toBeNull();
  });
});
