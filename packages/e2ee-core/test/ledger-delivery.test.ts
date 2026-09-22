import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cause, Effect, Exit, Either, Layer } from 'effect';
import { EpochStream } from '../src/ports/epoch-stream';
import { KeyDeliveryRemote } from '../src/ports/key-delivery';
import { epochStreamDeliveryLayer } from '../src/workflows/epoch-stream';
import { parseEpochEnvelopeChunk } from '../src/pure/epoch-envelope-stream';
import { TransportError } from '../src/pure/errors';
import { afterEach, describe, expect, it } from 'vitest';
import { LedgerError } from '../src/ledger';
import {
  LedgerKeyDelivery,
  MemoryLedgerKeyOutbox,
  openEpochEnvelope,
  sealEpochEnvelope,
} from '../src/ledger';
import { SqliteLedgerKeyOutbox } from '../src/ledger/node-store';
import { admitDeviceOp, append, ed25519, hex, random, signGenesis } from './ledger-fixtures';

const dirs: string[] = [];

describe('Effect raw epoch stream', () => {
  async function fixture() {
    const owner = await device();
    const key = random(32);
    const created = await signGenesis(owner, key);
    const frame = await sealEpochEnvelope({
      state: created.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: owner.publicKey,
      recipientEncryptionKey: owner.enc,
      epochKey: key,
      sign: owner.sign,
    });
    const parsed = Either.getOrThrow(parseEpochEnvelopeChunk(new Uint8Array(), frame));
    const first = parsed.frames[0];
    if (!first) throw new Error('fixture frame missing');
    return { frame, id: hex(first.deliveryId.toBytes()) };
  }

  it('reads split frames, reconciles lost ACK and never appends an observed frame twice', async () => {
    const { frame, id } = await fixture();
    let stored: Uint8Array | null = null;
    let appends = 0;
    const layer = epochStreamDeliveryLayer.pipe(
      Layer.provide(
        Layer.succeed(EpochStream, {
          read: (offset) =>
            Effect.sync(() =>
              stored === null
                ? {
                    requestOffset: offset,
                    nextOffset: 'empty',
                    upToDate: true,
                    body: new Uint8Array(),
                  }
                : offset === '-1'
                  ? {
                      requestOffset: offset,
                      nextOffset: 'middle',
                      upToDate: false,
                      body: stored.slice(0, 37),
                    }
                  : {
                      requestOffset: offset,
                      nextOffset: 'end',
                      upToDate: true,
                      body: stored.slice(37),
                    }
            ),
          append: (offset, bytes) =>
            Effect.gen(function* () {
              expect(offset).toBe('empty');
              appends++;
              stored = new Uint8Array(bytes);
              return yield* Effect.fail(new TransportError({ operation: 'append' }));
            }),
        })
      )
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const remote = yield* KeyDeliveryRemote;
        expect(yield* Effect.either(remote.put(id, frame))).toMatchObject({
          _tag: 'Left',
          left: { _tag: 'TransportError' },
        });
        expect(yield* remote.read(id)).toEqual(frame);
        yield* remote.put(id, frame);
        expect(appends).toBe(1);
        expect(stored).toEqual(frame);
      }).pipe(Effect.provide(layer))
    );
  });

  it('rejects a truncated suffix even after finding the requested complete frame', async () => {
    const { frame, id } = await fixture();
    const body = new Uint8Array(frame.length + 1);
    body.set(frame);
    body[frame.length] = 0x84;
    const layer = epochStreamDeliveryLayer.pipe(
      Layer.provide(
        Layer.succeed(EpochStream, {
          read: (offset) =>
            Effect.succeed({ requestOffset: offset, nextOffset: 'end', upToDate: true, body }),
          append: () => Effect.die('must not append'),
        })
      )
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const remote = yield* KeyDeliveryRemote;
        return yield* Effect.either(remote.read(id));
      }).pipe(Effect.provide(layer))
    );
    expect(result).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'ValidationError', code: 'truncated' },
    });
  });

  it('rejects cursor rewind and reports CAS contention without silently retrying', async () => {
    const { frame, id } = await fixture();
    const bad = epochStreamDeliveryLayer.pipe(
      Layer.provide(
        Layer.succeed(EpochStream, {
          read: (offset) =>
            Effect.succeed(
              offset === '-1'
                ? { requestOffset: offset, nextOffset: 'middle', upToDate: false, body: frame }
                : {
                    requestOffset: offset,
                    nextOffset: '-1',
                    upToDate: true,
                    body: new Uint8Array(),
                  }
            ),
          append: () => Effect.die('must not append'),
        })
      )
    );
    const read = Effect.gen(function* () {
      return yield* (yield* KeyDeliveryRemote).read(id);
    });
    expect(await Effect.runPromise(Effect.either(read.pipe(Effect.provide(bad))))).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'StreamProtocolError' },
    });
    const conflict = epochStreamDeliveryLayer.pipe(
      Layer.provide(
        Layer.succeed(EpochStream, {
          read: (offset) =>
            Effect.succeed({
              requestOffset: offset,
              nextOffset: 'empty',
              upToDate: true,
              body: new Uint8Array(),
            }),
          append: () => Effect.succeed('conflict'),
        })
      )
    );
    const put = Effect.gen(function* () {
      return yield* (yield* KeyDeliveryRemote).put(id, frame);
    });
    expect(
      await Effect.runPromise(Effect.either(put.pipe(Effect.provide(conflict))))
    ).toMatchObject({ _tag: 'Right', right: 'conflict' });
  });
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deliveryId(): string {
  return hex(random(16));
}

async function device() {
  const keys = await ed25519();
  const dh = (await crypto.subtle.generateKey('X25519', false, ['deriveBits'])) as CryptoKeyPair;
  const enc = new Uint8Array(await crypto.subtle.exportKey('raw', dh.publicKey));
  return { ...keys, enc, dh };
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(LedgerError);
  expect((error as LedgerError).code).toBe(code);
}

describe('K1 durable epoch-key delivery', () => {
  it('captures deferred input and isolates authorization from persisted ciphertext', async () => {
    const outbox = new MemoryLedgerKeyOutbox();
    const remote = new Map<string, Uint8Array>();
    const delivery = new LedgerKeyDelivery(outbox, {
      async put(id, bytes) {
        remote.set(id, new Uint8Array(bytes));
      },
      async read(id) {
        return remote.get(id) ?? null;
      },
    });
    const input = random(112);
    const expected = new Uint8Array(input);
    const id = deliveryId();
    const pending = delivery.sendEffect(id, input, (bytes) => {
      bytes.fill(0);
    });
    input.fill(0);
    expect(outbox.frames.size).toBe(0);
    expect(await Effect.runPromise(pending)).toBe('observed');
    expect(outbox.frames.get(id)).toEqual(expected);
    expect(remote.get(id)).toEqual(expected);
    const invalid = delivery.sendEffect('invalid-id', expected, () => {});
    expect(await Effect.runPromise(Effect.either(invalid))).toMatchObject({
      _tag: 'Left',
      left: { code: 'canonical' },
    });
  });

  it.each(['put', 'read'] as const)(
    'does not hide %s defects or protocol rejection as unknown',
    async (stage) => {
      const outbox = new MemoryLedgerKeyOutbox();
      let failure: Error = new TypeError('adapter-bug');
      const delivery = new LedgerKeyDelivery(outbox, {
        async put() {
          if (stage === 'put') throw failure;
        },
        async read() {
          if (stage === 'read') throw failure;
          return null;
        },
      });
      const id = deliveryId();
      const frame = random(112);
      const exit = await Effect.runPromiseExit(delivery.sendEffect(id, frame, () => {}));
      expect(Exit.isFailure(exit) && Cause.isDie(exit.cause)).toBe(true);
      expect(outbox.frames.get(id)).toEqual(frame);
      failure = new LedgerError('unauthorized');
      expect(
        await Effect.runPromise(Effect.either(delivery.sendEffect(id, undefined, () => {})))
      ).toMatchObject({ _tag: 'Left', left: { code: 'unauthorized' } });
      expect(outbox.frames.get(id)).toEqual(frame);
    }
  );

  it('persists exact ciphertext, retries without re-encrypting, and refuses a revoked recipient', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', true)
    );
    const frame = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    const sealedOnce = new Uint8Array(frame);
    let state = admitted.ledger.state;
    const authorize = async (bytes: Uint8Array) => {
      const sender = state.devices.get(hex(owner.publicKey));
      if (!sender || sender.kind !== 'personal' || !sender.canManage) {
        throw new LedgerError('unauthorized');
      }
      await openEpochEnvelope({
        state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: bytes,
      });
    };

    const remoteFrames = new Map<string, Uint8Array>();
    let puts = 0;
    let failPut = true;
    let failRead = true;
    const remote = {
      async put(id: string, body: Uint8Array) {
        puts += 1;
        if (failPut) throw new Error('lost-ack');
        remoteFrames.set(id, new Uint8Array(body));
      },
      async read(id: string) {
        if (failRead) throw new Error('unreachable');
        const saved = remoteFrames.get(id);
        return saved === undefined ? null : new Uint8Array(saved);
      },
    };
    const outbox = new MemoryLedgerKeyOutbox();
    const delivery = new LedgerKeyDelivery(outbox, remote);
    const id = deliveryId();

    expect(await delivery.send(id, frame, authorize)).toBe('unknown');
    expect(puts).toBe(1);
    const stored = outbox.frames.get(id);
    expect(stored).toEqual(sealedOnce);
    frame.fill(0);
    expect(outbox.frames.get(id)).toEqual(sealedOnce);

    const other = new Uint8Array(sealedOnce);
    other[0] = (other[0] ?? 0) ^ 0xff;
    try {
      await delivery.send(id, other, authorize);
      throw new Error('accepted-reencrypt');
    } catch (error) {
      expectCode(error, 'replay');
    }
    expect(outbox.frames.get(id)).toEqual(sealedOnce);

    failPut = false;
    failRead = false;
    expect(await delivery.send(id, undefined, authorize)).toBe('observed');
    expect(puts).toBe(2);
    expect(remoteFrames.get(id)).toEqual(sealedOnce);
    expect(
      await openEpochEnvelope({
        state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: remoteFrames.get(id)!,
      })
    ).toEqual(k0);

    const revoked = await append(admitted.ledger, owner, {
      type: 'revokeDevice',
      target: phone.publicKey,
    });
    state = revoked.ledger.state;
    const before = puts;
    try {
      await delivery.send(id, undefined, authorize);
      throw new Error('delivered-after-revoke');
    } catch (error) {
      expectCode(error, 'unauthorized');
    }
    expect(puts).toBe(before);
    expect(outbox.frames.get(id)).toEqual(sealedOnce);
  });

  it('Promise and Effect send persist and retry the same ciphertext', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', true)
    );
    const frame = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    const remoteA = new Map<string, Uint8Array>();
    const remoteB = new Map<string, Uint8Array>();
    const authorize = async () => {};
    const deliveryA = new LedgerKeyDelivery(new MemoryLedgerKeyOutbox(), {
      async put(id, body) {
        remoteA.set(id, new Uint8Array(body));
      },
      async read(id) {
        return remoteA.get(id) ? new Uint8Array(remoteA.get(id)!) : null;
      },
    });
    const deliveryB = new LedgerKeyDelivery(new MemoryLedgerKeyOutbox(), {
      async put(id, body) {
        remoteB.set(id, new Uint8Array(body));
      },
      async read(id) {
        return remoteB.get(id) ? new Uint8Array(remoteB.get(id)!) : null;
      },
    });
    const id = deliveryId();
    expect(await deliveryA.send(id, new Uint8Array(frame), authorize)).toBe('observed');
    expect(
      await Effect.runPromise(deliveryB.sendEffect(id, new Uint8Array(frame), authorize))
    ).toBe('observed');
    expect(remoteA.get(id)).toEqual(frame);
    expect(remoteB.get(id)).toEqual(frame);
  });

  it('interruption during remote put keeps the persisted frame and releases the outbox', async () => {
    const outbox = new MemoryLedgerKeyOutbox();
    const remote = new Map<string, Uint8Array>();
    let putBegan!: () => void;
    const began = new Promise<void>((resolve) => (putBegan = resolve));
    let releasePut!: () => void;
    let blocked = true;
    const delivery = new LedgerKeyDelivery(outbox, {
      put: async (putId, body) => {
        putBegan();
        if (!blocked) {
          remote.set(putId, new Uint8Array(body));
          return;
        }
        await new Promise<void>((resolve) => {
          releasePut = resolve;
        });
        remote.set(putId, new Uint8Array(body));
      },
      read: async (readId) => remote.get(readId) ?? null,
    });
    const id = deliveryId();
    const frame = random(112);
    const controller = new AbortController();
    const run = Effect.runPromiseExit(
      delivery.sendEffect(id, frame, () => {}),
      {
        signal: controller.signal,
      }
    );
    await began;
    controller.abort();
    const exit = await run;
    expect(Exit.isFailure(exit)).toBe(true);
    // Exact bytes were persisted before the remote wait; the lock is released.
    expect(outbox.frames.get(id)).toEqual(frame);
    blocked = false;
    releasePut();

    // Retry without re-supplying bytes reconciles by read-back of the same frame.
    expect(await delivery.send(id, undefined, () => {})).toBe('observed');
    expect(remote.get(id)).toEqual(frame);
  });

  it('re-checks authorization after save and does not put if the second check fails', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', true)
    );
    const frame = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    let checks = 0;
    const remotePuts: Uint8Array[] = [];
    const delivery = new LedgerKeyDelivery(new MemoryLedgerKeyOutbox(), {
      async put(_id, body) {
        remotePuts.push(new Uint8Array(body));
      },
      async read() {
        return null;
      },
    });
    try {
      await delivery.send(deliveryId(), frame, async () => {
        checks += 1;
        if (checks >= 2) throw new LedgerError('unauthorized');
      });
      throw new Error('put-after-failed-recheck');
    } catch (error) {
      expectCode(error, 'unauthorized');
    }
    expect(checks).toBe(2);
    expect(remotePuts).toEqual([]);
  });

  it('reloads the exact saved frame from sqlite after a lost ACK', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lody-ledger-key-outbox-'));
    dirs.push(dir);
    const path = join(dir, 'keys.sqlite');
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', true)
    );
    const frame = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    const sealedOnce = new Uint8Array(frame);
    const authorize = async (bytes: Uint8Array) => {
      await openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: bytes,
      });
    };
    const remoteFrames = new Map<string, Uint8Array>();
    let failPut = true;
    const remote = {
      async put(id: string, body: Uint8Array) {
        if (failPut) throw new Error('lost-ack');
        remoteFrames.set(id, new Uint8Array(body));
      },
      async read(id: string) {
        const saved = remoteFrames.get(id);
        return saved === undefined ? null : new Uint8Array(saved);
      },
    };
    const id = deliveryId();
    const first = new LedgerKeyDelivery(new SqliteLedgerKeyOutbox(path), remote);
    expect(await first.send(id, frame, authorize)).toBe('unknown');

    failPut = false;
    const restarted = new LedgerKeyDelivery(new SqliteLedgerKeyOutbox(path), remote);
    expect(await restarted.send(id, undefined, authorize)).toBe('observed');
    expect(remoteFrames.get(id)).toEqual(sealedOnce);
  });

  it('does not persist when the recipient is revoked before the first authorize returns', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', true)
    );
    const frame = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    let state = admitted.ledger.state;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authorize = async (bytes: Uint8Array) => {
      entered();
      await blocked;
      const sender = state.devices.get(hex(owner.publicKey));
      if (!sender || sender.kind !== 'personal' || !sender.canManage) {
        throw new LedgerError('unauthorized');
      }
      await openEpochEnvelope({
        state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: bytes,
      });
    };
    const outbox = new MemoryLedgerKeyOutbox();
    const puts: Uint8Array[] = [];
    const delivery = new LedgerKeyDelivery(outbox, {
      async put(_id, body) {
        puts.push(new Uint8Array(body));
      },
      async read() {
        return null;
      },
    });
    const id = deliveryId();
    const pending = delivery.send(id, frame, authorize);
    await started;
    const revoked = await append(admitted.ledger, owner, {
      type: 'revokeDevice',
      target: phone.publicKey,
    });
    state = revoked.ledger.state;
    release();
    try {
      await pending;
      throw new Error('persisted-after-pre-save-revoke');
    } catch (error) {
      expectCode(error, 'unauthorized');
    }
    expect(outbox.frames.size).toBe(0);
    expect(puts).toEqual([]);
  });

  it('keeps admission, outbox persist, remote observe, and local open as distinct states', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', true)
    );
    const frame = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    const sealedOnce = new Uint8Array(frame);
    const outbox = new MemoryLedgerKeyOutbox();
    const remoteFrames = new Map<string, Uint8Array>();
    const delivery = new LedgerKeyDelivery(outbox, {
      async put(id, body) {
        remoteFrames.set(id, new Uint8Array(body));
      },
      async read(id) {
        const saved = remoteFrames.get(id);
        return saved === undefined ? null : new Uint8Array(saved);
      },
    });
    const id = deliveryId();
    expect(outbox.frames.has(id)).toBe(false);
    expect(remoteFrames.has(id)).toBe(false);
    const observed = await delivery.send(id, frame, async (bytes) => {
      await openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: bytes,
      });
    });
    expect(observed).toBe('observed');
    expect(outbox.frames.get(id)).toEqual(sealedOnce);
    expect(remoteFrames.get(id)).toEqual(sealedOnce);
    const opened = await openEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientKeyPair: phone.dh,
      frame: remoteFrames.get(id)!,
    });
    expect(opened).toEqual(k0);
    expect(admitted.ledger.state.epoch.number).toBe(0);
  });
});
