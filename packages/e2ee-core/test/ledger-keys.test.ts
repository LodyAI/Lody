import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { describe, expect, it } from 'vitest';
import { Cause, Effect, Either, Exit, Layer } from 'effect';
import {
  Bytes,
  HpkeSender,
  HpkeRecipient,
  CryptoEntropy,
  EpochCandidateStorage,
  EpochKeyring,
  StorageError,
  parseEpochEnvelopeChunk,
  LedgerClient as NativeLedgerClient,
} from '@lody/e2ee-core/effect';
import {
  hpkeSenderLayer,
  cryptoEntropyLayer,
  hpkeRecipientLayer,
  signatureVerifierLayer,
  deviceSignerLayer,
  journalStoreLayer,
  ledgerTransportLayer,
  keyOutboxLayer,
  keyDeliveryRemoteLayer,
} from '@lody/e2ee-core/effect/platform';
import { MemoryLedgerStore, MemoryLedgerStream } from '../src/ledger/submit';
import { MemoryLedgerKeyOutbox } from '../src/ledger/delivery';
import * as Envelope from '../src/pure/epoch-envelope';
import { epochDeliveryId } from '../src/pure/key-delivery';
import * as History from '../src/pure/epoch-history';
import { LedgerError } from '../src/ledger';
import { encodeCbor } from '../src/ledger/cbor';
import { decodeRecord } from '../src/ledger/schema';
import {
  EPOCH_U32_MAX,
  canSendEpoch,
  collectEpochPackets,
  commitEpochKey,
  openEpochEnvelope,
  openHistoryPacket,
  recoverHistory,
  sealEpochEnvelope,
  sealHistoryPacket,
} from '../src/ledger';
import {
  HISTORY_PACKET_BYTES,
  admitDeviceOp,
  append,
  ed25519,
  findMembership,
  hex,
  random,
  signGenesis,
  signJoin,
  type DeviceKeys,
} from './ledger-fixtures';

describe('raw epoch envelope framing', () => {
  it('carries every possible page split and preserves unsigned routing IDs across epoch widths', async () => {
    const genesis = new Uint8Array(32).fill(1),
      sender = (await ed25519()).publicKey,
      recipient = (await ed25519()).publicKey;
    for (const epoch of [0, 23, 24, 255, 256, 65535, 65536, 0xffffffff]) {
      const aad = encodeCbor([genesis, epoch, sender, recipient]);
      // Parser tests only: zero crypto payload is deliberately not authenticated.
      const frame = new Uint8Array(aad.length + 144);
      frame.set(aad);
      const packed = new Uint8Array(frame.length * 2);
      packed.set(frame);
      packed.set(frame, frame.length);
      const expectedId = Either.getOrThrow(
        epochDeliveryId(
          Either.getOrThrow(Bytes.genesisHash(genesis)),
          Either.getOrThrow(Bytes.epochNumber(epoch)),
          Either.getOrThrow(Bytes.signingPublicKey(sender)),
          Either.getOrThrow(Bytes.signingPublicKey(recipient))
        )
      );
      for (let cut = 0; cut <= packed.length; cut++) {
        const first = Either.getOrThrow(
          parseEpochEnvelopeChunk(new Uint8Array(), packed.subarray(0, cut))
        );
        const second = Either.getOrThrow(parseEpochEnvelopeChunk(first.tail, packed.subarray(cut)));
        const frames = [...first.frames, ...second.frames];
        expect(frames.map((entry) => entry.bytes)).toEqual([frame, frame]);
        expect(frames.every((entry) => entry.deliveryId.equals(expectedId))).toBe(true);
        expect(second.tail.length).toBe(0);
      }
      const parsed = Either.getOrThrow(parseEpochEnvelopeChunk(new Uint8Array(), frame));
      frame.fill(0);
      expect(parsed.frames[0]?.bytes[0]).toBe(0x84);
    }
  });

  it('rejects noncanonical headers without treating incomplete ciphertext as a full frame', async () => {
    const aad = encodeCbor([
      new Uint8Array(32),
      0,
      (await ed25519()).publicKey,
      (await ed25519()).publicKey,
    ]);
    const frame = new Uint8Array(aad.length + 144);
    frame.set(aad);
    const partial = Either.getOrThrow(
      parseEpochEnvelopeChunk(new Uint8Array(), frame.subarray(0, -1))
    );
    expect(partial.frames).toEqual([]);
    expect(partial.tail).toEqual(frame.subarray(0, -1));
    const noncanonical = new Uint8Array(frame.length + 1);
    noncanonical.set(frame.subarray(0, 35));
    noncanonical.set([0x18, 0], 35);
    noncanonical.set(frame.subarray(36), 37);
    for (const bytes of [new Uint8Array([0x83]), noncanonical])
      expect(Either.isLeft(parseEpochEnvelopeChunk(new Uint8Array(), bytes))).toBe(true);
    expect(Either.isLeft(parseEpochEnvelopeChunk(new Uint8Array(252), new Uint8Array()))).toBe(
      true
    );
  });
});

describe('epoch candidate storage', () => {
  const row = {
    genesisHex: '01'.repeat(32),
    epoch: 1,
    commitmentHex: '02'.repeat(32),
    secretHex: '03'.repeat(32),
    recordHex: '0405',
  };
  it('preserves the old JSON bytes without confusing decoding with authorization', () => {
    const text = `${JSON.stringify(row)}\n`;
    const decoded = Either.getOrThrow(EpochCandidateStorage.decodeEpochCandidate(text));
    expect(decoded.secret).toEqual(new Uint8Array(32).fill(3));
    expect(Either.getOrThrow(EpochCandidateStorage.encodeEpochCandidate(decoded))).toBe(text);
    decoded.secret.fill(0);
    expect(Either.getOrThrow(EpochCandidateStorage.decodeEpochCandidate(text)).secret[0]).toBe(3);
    // Shape-valid record bytes are deliberately not treated as a signed/committed record.
    expect(decoded.record).toEqual(new Uint8Array([4, 5]));
  });
  it('rejects malformed candidate storage as typed failures', () => {
    for (const bad of [
      'null',
      '[]',
      '{',
      JSON.stringify({ ...row, epoch: 1.5 }),
      JSON.stringify({ ...row, epoch: -1 }),
      JSON.stringify({ ...row, epoch: 0 }),
      JSON.stringify({ ...row, epoch: Number.MAX_SAFE_INTEGER + 1 }),
      JSON.stringify({ ...row, secretHex: 'ff' }),
      JSON.stringify({ ...row, recordHex: '0' }),
      JSON.stringify({ ...row, recordHex: 'gg' }),
      JSON.stringify({ ...row, genesisHex: undefined }),
    ]) {
      expect(Either.isLeft(EpochCandidateStorage.decodeEpochCandidate(bad))).toBe(true);
    }
  });
});

async function device(): Promise<DeviceKeys & { dh: CryptoKeyPair }> {
  const keys = await ed25519();
  const dh = (await crypto.subtle.generateKey('X25519', false, ['deriveBits'])) as CryptoKeyPair;
  const enc = new Uint8Array(await crypto.subtle.exportKey('raw', dh.publicKey));
  return { ...keys, enc, dh };
}

function genesisCommitment(record: Uint8Array) {
  const decoded = decodeRecord(record);
  if (decoded.body.type !== 'genesis') throw new Error('not-genesis');
  return decoded.body.fields.epochCommitment;
}

describe('P3 key delivery and history unwrap', () => {
  it('classifies rotation candidates only after their exact record is in verified history', async () => {
    const owner = await device();
    const created = await signGenesis(owner);
    const secret = random(32);
    const commitment = await commitEpochKey(created.anchor, 1, secret);
    const first = await append(created.ledger, owner, {
      type: 'publishEpoch',
      epoch: 1,
      commitment,
      previousEpochKey: sealHistoryPacket(secret, created.secret, created.anchor, 1),
    });
    const candidate = {
      genesis: created.anchor,
      epoch: 1,
      commitment,
      secret,
      record: first.record,
    };
    expect(created.ledger.inspectEpochCandidate(candidate)).toBe('absent');
    expect(first.ledger.inspectEpochCandidate(candidate)).toBe('current');
    expect(first.ledger.inspectEpochCandidate({ ...candidate, secret: random(32) })).toBe(
      'mismatch'
    );
    expect(first.ledger.inspectEpochCandidate({ ...candidate, genesis: random(32) })).toBe(
      'mismatch'
    );
    expect(first.ledger.inspectEpochCandidate({ ...candidate, record: created.record })).toBe(
      'mismatch'
    );
    const next = random(32);
    const second = await append(first.ledger, owner, {
      type: 'publishEpoch',
      epoch: 2,
      commitment: await commitEpochKey(created.anchor, 2, next),
      previousEpochKey: sealHistoryPacket(next, secret, created.anchor, 2),
    });
    expect(second.ledger.inspectEpochCandidate(candidate)).toBe('historical');
    expect(second.ledger.state.epoch.number).toBe(2);
    candidate.record.fill(0);
    expect(second.ledger.inspectEpochCandidate(candidate)).toBe('mismatch');
    expect(second.ledger.state.epoch.number).toBe(2);
  });
  it('native envelope workflows resolve recipients from refreshed ledgers and reject revoked or mismatched keys', async () => {
    const owner = await device();
    const phone = await device();
    const created = await signGenesis(owner);
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
    );
    const stream = new MemoryLedgerStream();
    stream.records = [created.record, admitted.record];
    const value = <A, E>(parsed: Either.Either<A, E>) =>
      Either.getOrThrowWith(parsed, (error) => error);
    let afterOwnerSign = () => {};
    const makeClient = (keys: DeviceKeys, sign = keys.sign, remote = stream) =>
      Effect.runPromise(
        NativeLedgerClient.importGenesis({
          anchor: value(Bytes.genesisHash(created.anchor)),
          genesisRecord: created.record,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              journalStoreLayer(new MemoryLedgerStore()),
              ledgerTransportLayer(remote),
              deviceSignerLayer(value(Bytes.signingPublicKey(keys.publicKey)), sign),
              signatureVerifierLayer
            )
          )
        )
      );
    const ownerClient = await makeClient(owner, async (message) => {
      const signed = await owner.sign(message);
      afterOwnerSign();
      return signed;
    });
    const phoneClient = await makeClient(phone);
    const phoneId = value(Bytes.signingPublicKey(phone.publicKey));
    const ownerId = value(Bytes.signingPublicKey(owner.publicKey));
    const key = value(Bytes.epochKey(created.secret));
    const senderLayer = Layer.merge(
      hpkeSenderLayer().pipe(Layer.provide(cryptoEntropyLayer)),
      signatureVerifierLayer
    );
    const receiverLayer = Layer.merge(hpkeRecipientLayer(phone.dh), signatureVerifierLayer);
    expect(
      await Effect.runPromise(
        Effect.either(
          ownerClient
            .prepareEpochEnvelope(phoneId, value(Bytes.epochKey(random(32))))
            .pipe(Effect.provide(senderLayer))
        )
      )
    ).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'ContextMismatch', context: 'epoch' },
    });
    const prepared = await Effect.runPromise(
      ownerClient.prepareEpochEnvelope(phoneId, key).pipe(Effect.provide(senderLayer))
    );
    expect(prepared.stage).toBe('Prepared');
    expect(prepared.recipient.equals(phoneId)).toBe(true);
    const outbox = new MemoryLedgerKeyOutbox();
    const frames = new Map<string, Uint8Array>();
    let reachable = false;
    const deliveryLayer = Layer.mergeAll(
      signatureVerifierLayer,
      keyOutboxLayer(outbox),
      keyDeliveryRemoteLayer({
        async put(id, bytes) {
          if (!reachable) throw new Error('unavailable');
          frames.set(id, new Uint8Array(bytes));
        },
        async read(id) {
          if (!reachable) throw new Error('unavailable');
          return frames.get(id) ?? null;
        },
      })
    );
    const deliveryId = value(Bytes.deliveryId(random(16)));
    expect(
      await Effect.runPromise(
        ownerClient.deliverEpochEnvelope(deliveryId, prepared).pipe(Effect.provide(deliveryLayer))
      )
    ).toMatchObject({ _tag: 'Pending', frame: prepared.toBytes() });
    reachable = true;
    // No HPKE Service or epoch secret is supplied on resume.
    expect(
      await Effect.runPromise(
        ownerClient.resumeEpochDelivery(deliveryId, phoneId).pipe(Effect.provide(deliveryLayer))
      )
    ).toMatchObject({ _tag: 'Observed', frame: prepared.toBytes() });
    expect([...frames.values()]).toEqual([prepared.toBytes()]);
    expect(
      await Effect.runPromise(
        Effect.either(
          ownerClient.resumeEpochDelivery(deliveryId, ownerId).pipe(Effect.provide(deliveryLayer))
        )
      )
    ).toMatchObject({ _tag: 'Left', left: { code: 'canonical' } });
    expect(
      await Effect.runPromise(
        Effect.either(
          phoneClient.deliverEpochEnvelope(deliveryId, prepared).pipe(Effect.provide(deliveryLayer))
        )
      )
    ).toMatchObject({ _tag: 'Left', left: { code: 'canonical' } });
    await expect(
      openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: prepared.toBytes(),
      })
    ).resolves.toEqual(created.secret);
    const input = prepared.toBytes();
    const opening = phoneClient
      .openEpochEnvelope(ownerId, input)
      .pipe(Effect.provide(receiverLayer));
    input.fill(0);
    const opened = await Effect.runPromise(opening);
    expect(Envelope.checkEpochKey(admitted.ledger.state, opened)).toEqual(Either.void);
    expect(
      await Effect.runPromise(
        Effect.either(
          phoneClient
            .openEpochEnvelope(ownerId, prepared.toBytes())
            .pipe(Effect.provide(Layer.merge(hpkeRecipientLayer(owner.dh), signatureVerifierLayer)))
        )
      )
    ).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'ContextMismatch', context: 'recipient' },
    });
    frames.clear();
    reachable = false;
    const intentLayers = Layer.merge(senderLayer, deliveryLayer);
    const pendingSend = await Effect.runPromise(
      ownerClient.sendEpochKey(phoneId, key).pipe(Effect.provide(intentLayers))
    );
    expect(pendingSend._tag).toBe('Pending');
    const persistedBeforeRetry = [...outbox.frames.values()].map((bytes) => new Uint8Array(bytes));
    reachable = true;
    const restartedSender = await makeClient(owner);
    const noReencryption = Layer.merge(
      deliveryLayer,
      Layer.succeed(HpkeSender, {
        seal: () => Effect.die(new Error('retry must not re-encrypt')),
      })
    );
    const retried = await Effect.runPromise(
      restartedSender.sendEpochKey(phoneId, key).pipe(Effect.provide(noReencryption))
    );
    expect(retried._tag).toBe('Observed');
    expect(retried.deliveryId.equals(pendingSend.deliveryId)).toBe(true);
    expect([...outbox.frames.values()]).toEqual(persistedBeforeRetry);
    const delivered = [...frames.values()];
    expect(delivered).toHaveLength(1);
    const intentKey = await Effect.runPromise(
      phoneClient.openEpochEnvelope(ownerId, delivered[0]!).pipe(Effect.provide(receiverLayer))
    );
    expect(Envelope.checkEpochKey(admitted.ledger.state, intentKey)).toEqual(Either.void);
    const concurrent = await Effect.runPromise(
      Effect.all(
        [restartedSender.sendEpochKey(phoneId, key), restartedSender.sendEpochKey(phoneId, key)],
        { concurrency: 'unbounded' }
      ).pipe(Effect.provide(noReencryption))
    );
    expect(concurrent.map((result) => result._tag)).toEqual(['Observed', 'Observed']);
    expect([...frames.values()]).toEqual(delivered);
    const keyringKeys = new Map([[0, key]]);
    const currentLayers = Layer.merge(
      noReencryption,
      Layer.succeed(EpochKeyring, {
        get: (_genesis, epoch) => Effect.succeed(keyringKeys.get(epoch) ?? null),
        put: () => Effect.die(new Error('send must not install')),
      })
    );
    const fromKeyring = await Effect.runPromise(
      restartedSender.sendCurrentEpochKey(phoneId).pipe(Effect.provide(currentLayers))
    );
    expect(fromKeyring._tag).toBe('Observed');
    expect(fromKeyring.frame).toEqual(delivered[0]);
    expect(
      await Effect.runPromise(
        Effect.either(
          restartedSender.sendCurrentEpochKey(phoneId).pipe(
            Effect.provide(
              Layer.merge(
                noReencryption,
                Layer.succeed(EpochKeyring, {
                  get: () => Effect.succeed(null),
                  put: () => Effect.void,
                })
              )
            )
          )
        )
      )
    ).toMatchObject({ _tag: 'Left', left: { reason: 'key-missing' } });
    const installed = new Map<number, Bytes.EpochKey>();
    let failInstall = false;
    const installLayer = Layer.merge(
      receiverLayer,
      Layer.succeed(EpochKeyring, {
        get: (_genesis, epoch) => Effect.succeed(installed.get(epoch) ?? null),
        put: (_genesis, epoch, secret) =>
          Effect.suspend(() => {
            if (failInstall) return Effect.fail(new StorageError({ reason: 'io' }));
            installed.set(epoch, secret);
            return Effect.void;
          }),
      })
    );
    failInstall = true;
    expect(
      await Effect.runPromise(
        Effect.either(
          phoneClient.receiveEpochKey(ownerId, delivered[0]!).pipe(Effect.provide(installLayer))
        )
      )
    ).toMatchObject({ _tag: 'Left', left: { reason: 'io' } });
    expect(installed.size).toBe(0);
    failInstall = false;
    expect(
      await Effect.runPromise(
        phoneClient.receiveEpochKey(ownerId, delivered[0]!).pipe(Effect.provide(installLayer))
      )
    ).toEqual({ _tag: 'Installed', epoch: 0 });
    expect(installed.size).toBe(1);
    const tampered = prepared.toBytes();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(
      await Effect.runPromise(
        Effect.either(
          phoneClient.openEpochEnvelope(ownerId, tampered).pipe(Effect.provide(receiverLayer))
        )
      )
    ).toMatchObject({ _tag: 'Left', left: { code: 'bad-signature' } });
    const revoked = await append(admitted.ledger, owner, {
      type: 'revokeDevice',
      target: phone.publicKey,
    });
    const nextSecret = random(32);
    const rotated = await append(admitted.ledger, owner, {
      type: 'publishEpoch',
      epoch: 1,
      commitment: await commitEpochKey(created.anchor, 1, nextSecret),
      previousEpochKey: sealHistoryPacket(nextSecret, created.secret, created.anchor, 1),
    });
    const rotatedStream = new MemoryLedgerStream();
    rotatedStream.records = [created.record, admitted.record, rotated.record];
    const rotatedClient = await makeClient(owner, owner.sign, rotatedStream);
    expect(
      await Effect.runPromise(
        Effect.either(
          rotatedClient.resumeEpochDelivery(deliveryId, phoneId).pipe(Effect.provide(deliveryLayer))
        )
      )
    ).toMatchObject({ _tag: 'Left', left: { code: 'canonical' } });
    // Isolated backend view: revoke only after real HPKE decryption resolves.
    const receivingStream = new MemoryLedgerStream();
    receivingStream.records = [created.record, admitted.record];
    const receiver = await makeClient(phone, phone.sign, receivingStream);
    const revokeAfterOpen = Layer.effect(
      HpkeRecipient,
      Effect.gen(function* () {
        const actual = yield* HpkeRecipient;
        return HpkeRecipient.of({
          publicKey: actual.publicKey,
          open: (parts) =>
            actual.open(parts).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  receivingStream.records.push(revoked.record);
                })
              )
            ),
        });
      })
    ).pipe(Layer.provide(hpkeRecipientLayer(phone.dh)));
    expect(
      await Effect.runPromise(
        Effect.either(
          receiver
            .openEpochEnvelope(ownerId, prepared.toBytes())
            .pipe(Effect.provide(Layer.merge(revokeAfterOpen, signatureVerifierLayer)))
        )
      )
    ).toMatchObject({
      _tag: 'Left',
      left: { code: 'unauthorized' },
    });
    afterOwnerSign = () => {
      stream.records.push(revoked.record);
    };
    expect(
      await Effect.runPromise(
        Effect.either(
          ownerClient.prepareEpochEnvelope(phoneId, key).pipe(Effect.provide(senderLayer))
        )
      )
    ).toMatchObject({ _tag: 'Left', left: { code: 'unauthorized' } });
    frames.clear();
    expect(
      await Effect.runPromise(
        Effect.either(
          ownerClient.resumeEpochDelivery(deliveryId, phoneId).pipe(Effect.provide(deliveryLayer))
        )
      )
    ).toMatchObject({ _tag: 'Left', left: { code: 'unauthorized' } });
    expect(frames.size).toBe(0);
    expect(
      await Effect.runPromise(
        Effect.either(
          phoneClient
            .openEpochEnvelope(ownerId, prepared.toBytes())
            .pipe(Effect.provide(receiverLayer))
        )
      )
    ).toMatchObject({ _tag: 'Left', left: { code: 'unauthorized' } });
  });

  it('native HPKE Services interoperate with legacy envelopes and own deferred inputs', async () => {
    const owner = await device();
    const created = await signGenesis(owner);
    const context = {
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: owner.publicKey,
    };
    const ikm = random(32);
    const entropy = {
      fill: (_label: string, bytes: Uint8Array) => {
        bytes.set(ikm);
        return bytes;
      },
    };
    const frame = await sealEpochEnvelope({
      ...context,
      state: created.ledger.state,
      recipientEncryptionKey: owner.enc,
      epochKey: created.secret,
      sign: owner.sign,
      entropy,
    });
    const original = Envelope.decodeEnvelopeFrame(context, frame);
    if (Either.isLeft(original)) throw new Error('valid envelope required');
    await Effect.runPromise(
      Effect.gen(function* () {
        const sender = yield* HpkeSender;
        const recipient = yield* HpkeRecipient;
        expect(recipient.publicKey.toBytes()).toEqual(owner.enc);
        const key = yield* Bytes.epochKey(created.secret);
        const aad = new Uint8Array(original.right.aad);
        const sealing = sender.seal({ recipient: recipient.publicKey, key, aad });
        aad.fill(0);
        const sealed = yield* sealing;
        expect(sealed.enc).toEqual(original.right.enc);
        expect(sealed.ct).toEqual(original.right.ct);
        const opening = recipient.open({ ...sealed, aad: original.right.aad });
        sealed.ct.fill(0);
        sealed.enc.fill(0);
        const openedKey = yield* opening;
        const resealed = yield* sender.seal({
          recipient: recipient.publicKey,
          key: openedKey,
          aad: original.right.aad,
        });
        expect(resealed.enc).toEqual(original.right.enc);
        expect(resealed.ct).toEqual(original.right.ct);
        expect(
          yield* Effect.either(recipient.open({ ...sealed, aad: original.right.aad }))
        ).toMatchObject({
          _tag: 'Left',
          left: { _tag: 'CryptoError', operation: 'open' },
        });
      }).pipe(
        Effect.provide(
          Layer.merge(
            hpkeSenderLayer().pipe(
              Layer.provide(
                Layer.succeed(CryptoEntropy, {
                  bytes: (label, length) =>
                    Effect.sync(() => entropy.fill(label, new Uint8Array(length))),
                })
              )
            ),
            hpkeRecipientLayer(owner.dh)
          )
        )
      )
    );
  });

  it('HPKE entropy defects are not downgraded to expected crypto failures', async () => {
    const owner = await device();
    const program = Effect.gen(function* () {
      const sender = yield* HpkeSender;
      return yield* sender.seal({
        recipient: yield* Bytes.encryptionPublicKey(owner.enc),
        key: yield* Bytes.epochKey(random(32)),
        aad: new Uint8Array(),
      });
    }).pipe(
      Effect.provide(
        hpkeSenderLayer().pipe(
          Layer.provide(
            Layer.succeed(CryptoEntropy, {
              bytes: () => Effect.die(new TypeError('injected-entropy-defect')),
            })
          )
        )
      )
    );
    const exit = await Effect.runPromiseExit(program);
    expect(Exit.isFailure(exit) && Cause.isDie(exit.cause)).toBe(true);
  });

  it('native HPKE requests fresh entropy per execution and rejects malformed entropy', async () => {
    const owner = await device();
    const secret = random(32);
    let generation = 0;
    let malformed = false;
    const entropyLayer = Layer.succeed(CryptoEntropy, {
      bytes: (_label, length) =>
        Effect.sync(() => {
          generation += 1;
          return new Uint8Array(malformed ? length - 1 : length).fill(generation);
        }),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const sender = yield* HpkeSender;
        const recipient = yield* HpkeRecipient;
        const key = yield* Bytes.epochKey(secret);
        const aad = new Uint8Array([1, 2, 3]);
        const seal = sender.seal({ recipient: recipient.publicKey, key, aad });
        expect(generation).toBe(0);
        const first = yield* seal;
        const second = yield* seal;
        expect(first.enc).not.toEqual(second.enc);
        expect(first.ct).not.toEqual(second.ct);
        const opened = yield* recipient.open({ ...second, aad });
        // Repeat the first deterministic seed to compare the authenticated plaintext.
        generation = 0;
        const resealed = yield* sender.seal({ recipient: recipient.publicKey, key: opened, aad });
        expect(resealed).toEqual(first);
        malformed = true;
        expect(yield* Effect.either(seal)).toMatchObject({
          _tag: 'Left',
          left: { _tag: 'CryptoError', operation: 'generate' },
        });
      }).pipe(
        Effect.provide(
          Layer.merge(
            hpkeSenderLayer().pipe(Layer.provide(entropyLayer)),
            hpkeRecipientLayer(owner.dh)
          )
        )
      )
    );
  });

  it('pure history uses explicit nonce, owns recovered keys and rejects a corrupted link', async () => {
    const genesis = random(32);
    const currentKey = random(32);
    const previousKey = random(32);
    const nonce = random(24);
    const packet = History.sealHistoryPacket({ currentKey, previousKey, genesis, epoch: 1, nonce });
    if (Either.isLeft(packet)) throw new Error('valid history fixture required');
    expect(packet).toEqual(
      History.sealHistoryPacket({ currentKey, previousKey, genesis, epoch: 1, nonce })
    );
    expect(
      sealHistoryPacket(currentKey, previousKey, genesis, 1, {
        fill: (_label, bytes) => {
          bytes.set(nonce);
          return bytes;
        },
      })
    ).toEqual(packet.right);
    expect(
      History.sealHistoryPacket({
        currentKey,
        previousKey,
        genesis,
        epoch: 1,
        nonce: new Uint8Array(23),
      })
    ).toMatchObject({ _tag: 'Left' });
    const packets = new Map([
      [0, { commitment: await commitEpochKey(genesis, 0, previousKey), packet: new Uint8Array() }],
      [1, { commitment: await commitEpochKey(genesis, 1, currentKey), packet: packet.right }],
    ]);
    const result = History.recoverHistory({
      genesis,
      latestEpoch: 1,
      latestKey: currentKey,
      packets,
    });
    if (Either.isLeft(result)) throw new Error('valid chain must recover');
    const original = new Uint8Array(currentKey);
    expect(result.right.get(0)).toEqual(previousKey);
    result.right.get(1)?.fill(0);
    expect(currentKey).toEqual(original);
    packet.right[30] = packet.right[30]! ^ 1;
    expect(
      History.recoverHistory({ genesis, latestEpoch: 1, latestKey: currentKey, packets })
    ).toMatchObject({ _tag: 'Left' });
  });

  it('pure envelope parsing owns frame bytes but never proves a forged signature', async () => {
    const owner = await device();
    const created = await signGenesis(owner);
    const context = {
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: owner.publicKey,
    };
    const state = created.ledger.state;
    const frame = await sealEpochEnvelope({
      ...context,
      state,
      recipientEncryptionKey: owner.enc,
      epochKey: created.secret,
      sign: owner.sign,
    });
    const parsed = Envelope.decodeEnvelopeFrame(context, frame);
    if (Either.isLeft(parsed)) throw new Error('valid frame must parse');
    const saved = new Uint8Array(frame);
    frame.fill(0);
    expect(parsed.right.signature).toEqual(saved.subarray(-64));
    expect(parsed.right.enc).toEqual(
      saved.subarray(parsed.right.aad.length, parsed.right.aad.length + 32)
    );
    const recipientKey = Envelope.recipientEncryptionKey(state, owner.publicKey, owner.publicKey);
    if (Either.isLeft(recipientKey)) throw new Error('admitted recipient required');
    recipientKey.right.fill(0);
    expect(Envelope.recipientEncryptionKey(state, owner.publicKey, owner.publicKey)).toEqual(
      Either.right(owner.enc)
    );
    saved[saved.length - 1] = saved[saved.length - 1]! ^ 1;
    expect(Either.isRight(Envelope.decodeEnvelopeFrame(context, saved))).toBe(true);
    await expect(
      openEpochEnvelope({ ...context, state, frame: saved, recipientKeyPair: owner.dh })
    ).rejects.toMatchObject({ code: 'bad-signature' });
    expect(Envelope.decodeEnvelopeFrame({ ...context, epoch: 1 }, saved)).toMatchObject({
      _tag: 'Left',
    });
  });

  it('rejects epoch numbers that would truncate in uint32 AAD', async () => {
    const genesis = random(32);
    const secret = random(32);
    const previous = random(32);
    await expect(commitEpochKey(genesis, EPOCH_U32_MAX + 1, secret)).rejects.toMatchObject({
      code: 'invalid-operation',
    });
    expect(() => sealHistoryPacket(secret, previous, genesis, EPOCH_U32_MAX + 1)).toThrowError(
      LedgerError
    );
    await expect(commitEpochKey(genesis, EPOCH_U32_MAX, secret)).resolves.toBeInstanceOf(
      Uint8Array
    );
    expect(sealHistoryPacket(secret, previous, genesis, EPOCH_U32_MAX).byteLength).toBe(
      HISTORY_PACKET_BYTES
    );
  });

  it('commits a garbage history packet and then cannot unwrap (accepted availability limit)', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const junk = random(HISTORY_PACKET_BYTES);
    const next = random(32);
    const published = await append(created.ledger, owner, {
      type: 'publishEpoch',
      epoch: 1,
      commitment: await commitEpochKey(created.anchor, 1, next),
      previousEpochKey: junk,
    });
    expect(published.ledger.state.epoch.number).toBe(1);
    await expect(
      recoverHistory({
        genesis: created.anchor,
        latestEpoch: 1,
        latestKey: next,
        packets: collectEpochPackets(
          [created.record, published.record],
          genesisCommitment(created.record)
        ),
      })
    ).rejects.toMatchObject({ code: 'invalid-operation' });
  });

  it('recovers every retained epoch from the latest key only', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    let ledger = created.ledger;
    const records = [created.record];
    const keys = [k0];
    for (let epoch = 1; epoch <= 3; epoch++) {
      const next = random(32);
      const packet = sealHistoryPacket(next, keys[epoch - 1]!, created.anchor, epoch);
      expect(packet.byteLength).toBe(HISTORY_PACKET_BYTES);
      const published = await append(ledger, owner, {
        type: 'publishEpoch',
        epoch,
        commitment: await commitEpochKey(created.anchor, epoch, next),
        previousEpochKey: packet,
      });
      records.push(published.record);
      ledger = published.ledger;
      keys.push(next);
    }
    const packets = collectEpochPackets(records, genesisCommitment(created.record));
    const recovered = await recoverHistory({
      genesis: created.anchor,
      latestEpoch: 3,
      latestKey: keys[3]!,
      packets,
    });
    expect(recovered.size).toBe(4);
    for (let epoch = 0; epoch <= 3; epoch++) expect(recovered.get(epoch)).toEqual(keys[epoch]);
    expect(keys[0]).not.toEqual(keys[3]);

    const bad = new Map(packets);
    const broken = new Uint8Array(packets.get(2)!.packet);
    broken[0] = (broken[0] ?? 0) ^ 0xff;
    bad.set(2, { ...packets.get(2)!, packet: broken });
    await expect(
      recoverHistory({
        genesis: created.anchor,
        latestEpoch: 3,
        latestKey: keys[3]!,
        packets: bad,
      })
    ).rejects.toBeInstanceOf(LedgerError);

    const other = await signGenesis(await device(), random(32));
    await expect(
      recoverHistory({
        genesis: other.anchor,
        latestEpoch: 3,
        latestKey: keys[3]!,
        packets,
      })
    ).rejects.toMatchObject({ code: 'invalid-operation' });
    try {
      openHistoryPacket(keys[3]!, packets.get(3)!.packet, other.anchor, 3);
      throw new Error('cross-org-history-opened');
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe('invalid-operation');
    }
  });

  it('HPKE-wraps the current epoch to an admitted device and refuses a revoked recipient', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
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
    const opened = await openEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientKeyPair: phone.dh,
      frame,
    });
    expect(opened).toEqual(k0);

    const ikm = random(32);
    const entropy = {
      fill(label: string, bytes: Uint8Array) {
        if (label !== 'hpke-dhkem-ikm' || bytes.byteLength !== ikm.byteLength) {
          throw new Error(`entropy-mismatch:${label}`);
        }
        bytes.set(ikm);
        return bytes;
      },
    };
    const sealedA = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
      entropy,
    });
    const sealedB = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
      entropy,
    });
    expect(sealedA).toEqual(sealedB);
    const otherIkm = random(32);
    const sealedC = await sealEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientEncryptionKey: phone.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
      entropy: {
        fill(label, bytes) {
          if (label !== 'hpke-dhkem-ikm') throw new Error(`entropy-mismatch:${label}`);
          bytes.set(otherIkm);
          return bytes;
        },
      },
    });
    expect(sealedC).not.toEqual(sealedA);
    expect(
      await openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: sealedA,
      })
    ).toEqual(k0);

    const revoked = await append(admitted.ledger, owner, {
      type: 'revokeDevice',
      target: phone.publicKey,
    });
    await expect(
      sealEpochEnvelope({
        state: revoked.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientEncryptionKey: phone.enc,
        epochKey: k0,
        sign: (bytes) => owner.sign(bytes),
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });

    const rotated = await append(admitted.ledger, owner, {
      type: 'publishEpoch',
      epoch: 1,
      commitment: await commitEpochKey(created.anchor, 1, random(32)),
      previousEpochKey: random(HISTORY_PACKET_BYTES),
    });
    await expect(
      openEpochEnvelope({
        state: rotated.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame,
      })
    ).rejects.toMatchObject({ code: 'invalid-operation' });
  });

  it('rejects a stranger-signed epoch envelope whose plaintext does not match the ledger commitment', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const admitted = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
    );
    const attacker = await device();
    const fakeKey = random(32);
    const suite = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Chacha20Poly1305(),
    });
    const aad = encodeCbor([created.anchor, 0, attacker.publicKey, phone.publicKey]);
    const sealed = await suite.seal(
      {
        recipientPublicKey: await suite.kem.deserializePublicKey(phone.enc),
        info: new TextEncoder().encode('lody-e2ee/hpke-epoch/v1\0'),
      },
      fakeKey,
      aad
    );
    const unsigned = new Uint8Array(aad.byteLength + 32 + 48);
    unsigned.set(aad);
    unsigned.set(new Uint8Array(sealed.enc), aad.byteLength);
    unsigned.set(new Uint8Array(sealed.ct), aad.byteLength + 32);
    const domain = new TextEncoder().encode('lody-e2ee/epoch-env/v1\0');
    const message = new Uint8Array(domain.byteLength + unsigned.byteLength);
    message.set(domain);
    message.set(unsigned, domain.byteLength);
    const frame = new Uint8Array(unsigned.byteLength + 64);
    frame.set(unsigned);
    frame.set(await attacker.sign(message), unsigned.byteLength);
    await expect(
      openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: attacker.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame,
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await commitEpochKey(created.anchor, 0, fakeKey)).not.toEqual(
      created.ledger.state.epoch.keyCommitment
    );
  });

  it('lets an Owner recovery device receive keys but not publish an epoch', async () => {
    const owner = await device();
    const created = await signGenesis(owner, random(32));
    const recovery = await device();
    const withR = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, recovery, 'recovery')
    );
    const k0 = created.secret;
    const frame = await sealEpochEnvelope({
      state: withR.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: recovery.publicKey,
      recipientEncryptionKey: recovery.enc,
      epochKey: k0,
      sign: (bytes) => owner.sign(bytes),
    });
    const opened = await openEpochEnvelope({
      state: withR.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: recovery.publicKey,
      recipientKeyPair: recovery.dh,
      frame,
    });
    expect(opened).toEqual(k0);
    await expect(
      append(withR.ledger, recovery, {
        type: 'publishEpoch',
        epoch: 1,
        commitment: await commitEpochKey(created.anchor, 1, random(32)),
        previousEpochKey: random(HISTORY_PACKET_BYTES),
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('refuses swapped, truncated, tampered, unadmitted, and post-revoke envelopes', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const phone = await device();
    const laptop = await device();
    await expect(
      sealEpochEnvelope({
        state: created.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientEncryptionKey: phone.enc,
        epochKey: k0,
        sign: (bytes) => owner.sign(bytes),
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });

    const admittedPhone = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
    );
    const admitted = await append(
      admittedPhone.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, laptop, 'personal')
    );
    await expect(
      sealEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientEncryptionKey: laptop.enc,
        epochKey: k0,
        sign: (bytes) => owner.sign(bytes),
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });

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
    await expect(
      openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: laptop.publicKey,
        recipientKeyPair: laptop.dh,
        frame,
      })
    ).rejects.toMatchObject({ code: 'canonical' });
    // phone is an eligible sender, but the frame's AAD and signature name owner.
    await expect(
      openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: phone.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame,
      })
    ).rejects.toMatchObject({ code: 'canonical' });
    await expect(
      openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: frame.subarray(0, frame.byteLength - 1),
      })
    ).rejects.toMatchObject({ code: 'canonical' });

    const tampered = new Uint8Array(frame);
    const flipAt = tampered.byteLength - 65;
    tampered[flipAt] = (tampered[flipAt] ?? 0) ^ 0xff;
    await expect(
      openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: tampered,
      })
    ).rejects.toBeInstanceOf(LedgerError);

    const other = await signGenesis(await device(), random(32));
    await expect(
      openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: other.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame,
      })
    ).rejects.toMatchObject({ code: 'canonical' });
    await expect(
      openEpochEnvelope({
        state: admitted.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame: random(HISTORY_PACKET_BYTES),
      })
    ).rejects.toMatchObject({ code: 'canonical' });

    const honest = await openEpochEnvelope({
      state: admitted.ledger.state,
      genesis: created.anchor,
      epoch: 0,
      sender: owner.publicKey,
      recipient: phone.publicKey,
      recipientKeyPair: phone.dh,
      frame,
    });
    expect(honest).toEqual(k0);

    const revoked = await append(admitted.ledger, owner, {
      type: 'revokeDevice',
      target: phone.publicKey,
    });
    await expect(
      openEpochEnvelope({
        state: revoked.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: owner.publicKey,
        recipient: phone.publicKey,
        recipientKeyPair: phone.dh,
        frame,
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('lets any active non-recovery device forward the current key; recovery and revoked senders cannot', async () => {
    const owner = await device();
    const k0 = random(32);
    const created = await signGenesis(owner, k0);
    const member = await device();
    const request = await signJoin(created.anchor, member);
    const joined = await append(created.ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request,
    });
    const memberMembership = findMembership(joined.ledger, request.userId);
    const laptop = await device();
    const withLaptop = await append(
      joined.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, laptop, 'personal')
    );
    const machine = await device();
    const withMachine = await append(
      withLaptop.ledger,
      member,
      await admitDeviceOp(created.anchor, memberMembership, machine, 'machine')
    );
    const recovery = await device();
    const admitted = await append(
      withMachine.ledger,
      member,
      await admitDeviceOp(created.anchor, memberMembership, recovery, 'recovery')
    );
    const state = admitted.ledger.state;
    expect(canSendEpoch(state, owner.publicKey)).toBe(true);
    expect(canSendEpoch(state, member.publicKey)).toBe(true);
    expect(canSendEpoch(state, machine.publicKey)).toBe(true);
    expect(canSendEpoch(state, recovery.publicKey)).toBe(false);
    expect(canSendEpoch(state, (await device()).publicKey)).toBe(false);

    // A plain member forwards the real key to another member's device.
    const fromMember = await sealEpochEnvelope({
      state,
      genesis: created.anchor,
      epoch: 0,
      sender: member.publicKey,
      recipient: laptop.publicKey,
      recipientEncryptionKey: laptop.enc,
      epochKey: k0,
      sign: (bytes) => member.sign(bytes),
    });
    expect(
      await openEpochEnvelope({
        state,
        genesis: created.anchor,
        epoch: 0,
        sender: member.publicKey,
        recipient: laptop.publicKey,
        recipientKeyPair: laptop.dh,
        frame: fromMember,
      })
    ).toEqual(k0);

    // A machine may forward to its owner's recovery device.
    const fromMachine = await sealEpochEnvelope({
      state,
      genesis: created.anchor,
      epoch: 0,
      sender: machine.publicKey,
      recipient: recovery.publicKey,
      recipientEncryptionKey: recovery.enc,
      epochKey: k0,
      sign: (bytes) => machine.sign(bytes),
    });
    expect(
      await openEpochEnvelope({
        state,
        genesis: created.anchor,
        epoch: 0,
        sender: machine.publicKey,
        recipient: recovery.publicKey,
        recipientKeyPair: recovery.dh,
        frame: fromMachine,
      })
    ).toEqual(k0);

    // A forwarded key that is not the committed key still fails the commitment check.
    await expect(
      openEpochEnvelope({
        state,
        genesis: created.anchor,
        epoch: 0,
        sender: member.publicKey,
        recipient: laptop.publicKey,
        recipientKeyPair: laptop.dh,
        frame: await sealEpochEnvelope({
          state,
          genesis: created.anchor,
          epoch: 0,
          sender: member.publicKey,
          recipient: laptop.publicKey,
          recipientEncryptionKey: laptop.enc,
          epochKey: random(32),
          sign: (bytes) => member.sign(bytes),
        }),
      })
    ).rejects.toMatchObject({ code: 'invalid-operation' });

    // Recovery devices only receive keys, even if the sender forges a personal entry.
    await expect(
      sealEpochEnvelope({
        state,
        genesis: created.anchor,
        epoch: 0,
        sender: recovery.publicKey,
        recipient: laptop.publicKey,
        recipientEncryptionKey: laptop.enc,
        epochKey: k0,
        sign: (bytes) => recovery.sign(bytes),
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
    const recoveryRow = state.devices.get(hex(recovery.publicKey));
    if (!recoveryRow) throw new Error('missing-recovery-device');
    const fakeDevices = new Map(state.devices);
    fakeDevices.set(hex(recovery.publicKey), { ...recoveryRow, kind: 'personal' });
    const forged = await sealEpochEnvelope({
      state: { ...state, devices: fakeDevices },
      genesis: created.anchor,
      epoch: 0,
      sender: recovery.publicKey,
      recipient: laptop.publicKey,
      recipientEncryptionKey: laptop.enc,
      epochKey: k0,
      sign: (bytes) => recovery.sign(bytes),
    });
    await expect(
      openEpochEnvelope({
        state,
        genesis: created.anchor,
        epoch: 0,
        sender: recovery.publicKey,
        recipient: laptop.publicKey,
        recipientKeyPair: laptop.dh,
        frame: forged,
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });

    // A sender revoked before the recipient opens is rejected against the current ledger.
    const revoked = await append(admitted.ledger, member, {
      type: 'revokeDevice',
      target: machine.publicKey,
    });
    expect(canSendEpoch(revoked.ledger.state, machine.publicKey)).toBe(false);
    await expect(
      openEpochEnvelope({
        state: revoked.ledger.state,
        genesis: created.anchor,
        epoch: 0,
        sender: machine.publicKey,
        recipient: recovery.publicKey,
        recipientKeyPair: recovery.dh,
        frame: fromMachine,
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
