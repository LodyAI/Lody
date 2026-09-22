import { Cause, Deferred, Effect, Either, Exit, Fiber, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  LedgerClient,
  DeviceSigner,
  JournalStore,
  Bytes,
  PendingOperationExists,
  StorageError,
  prepareDeviceAdmission,
} from '@lody/e2ee-core/effect';
import {
  deviceSignerLayer,
  journalStoreLayer,
  ledgerTransportLayer,
} from '@lody/e2ee-core/effect/platform';
import { MemoryLedgerStore, MemoryLedgerStream, type LedgerStore } from '../src/ledger/submit';
import type { LedgerCommand, CommandOutcome } from '@lody/e2ee-core/effect';
import { ed25519, signGenesis, random } from './ledger-fixtures';
import { ControlLogError } from '../src/pure/legacy-error';

const value = <A, E>(either: Either.Either<A, E>): A =>
  Either.getOrThrowWith(either, (error) => error);

function outcomeContracts(outcome: CommandOutcome) {
  switch (outcome._tag) {
    case 'Committed':
    case 'Conflict':
    case 'Unsupported':
      return outcome.ledger;
    default: {
      // @ts-expect-error Pending is a real outcome, not an exception to forget.
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
void outcomeContracts;

async function setup() {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const anchor = value(Bytes.genesisHash(created.anchor));
  const store = new MemoryLedgerStore();
  const stream = new MemoryLedgerStream();
  const layer = Layer.mergeAll(
    journalStoreLayer(store),
    ledgerTransportLayer(stream),
    deviceSignerLayer(value(Bytes.signingPublicKey(owner.publicKey)), owner.sign)
  );
  const create = LedgerClient.create({ anchor, genesisRecord: created.record }).pipe(
    Effect.provide(layer)
  );
  const phone = await ed25519();
  const command = await Effect.runPromise(
    prepareDeviceAdmission({
      genesis: anchor,
      membershipId: value(Bytes.membershipId(created.membershipId)),
      encryptionPublicKey: value(Bytes.encryptionPublicKey(phone.enc)),
      grant: { kind: 'personal', canManage: false },
    }).pipe(
      Effect.provide(deviceSignerLayer(value(Bytes.signingPublicKey(phone.publicKey)), phone.sign))
    )
  );
  return { owner, created, anchor, store, stream, layer, create, command };
}

describe('Effect client owns submissions', () => {
  it('captures construction inputs without doing I/O or following later caller mutations', async () => {
    const s = await setup();
    const input = { anchor: s.anchor, genesisRecord: new Uint8Array(s.created.record) };
    const create = LedgerClient.create(input).pipe(Effect.provide(s.layer));
    input.anchor = value(Bytes.genesisHash(random(32)));
    input.genesisRecord.fill(0);
    expect(s.store.journal).toBeNull();
    const client = await Effect.runPromise(create);
    const mutable = { ...s.command };
    const execute = client.execute(mutable);
    mutable.canManage = true;
    const result = await Effect.runPromise(execute);
    expect(result._tag).toBe('Committed');
    expect(result.ledger.genesis.equals(s.anchor)).toBe(true);
    expect(result.ledger.deviceCount).toBe(2);
  });

  it('constructs lazily and executes an intent without client-side signing or offsets', async () => {
    const s = await setup();
    expect(s.store.journal).toBeNull();
    const client = await Effect.runPromise(s.create);
    const result = await Effect.runPromise(client.execute(s.command));
    expect(result._tag).toBe('Committed');
    expect(result.ledger.deviceCount).toBe(2);
    expect(s.store.journal?.pending).toBeNull();
    expect((await Effect.runPromise(client.resume()))._tag).toBe('Idle');
    expect(s.stream.records).toHaveLength(1);
  });

  it('keeps exact pending bytes across reopen and blocks different intents', async () => {
    const s = await setup();
    const client = await Effect.runPromise(s.create);
    s.stream.mode = 'false-ack';
    expect((await Effect.runPromise(client.execute(s.command)))._tag).toBe('Pending');
    const pending = new Uint8Array(s.store.journal!.pending!);
    const blocked = await Effect.runPromise(Effect.either(client.execute(s.command)));
    expect(blocked).toEqual(Either.left(new PendingOperationExists()));
    const reopened = await Effect.runPromise(
      LedgerClient.restore(s.anchor).pipe(Effect.provide(s.layer))
    );
    s.stream.mode = 'ok';
    expect((await Effect.runPromise(reopened.resume()))._tag).toBe('Committed');
    expect(s.stream.records[0]).toEqual(pending);
  });

  it('reports missing/existing stores distinctly and never recreates a missing journal', async () => {
    const s = await setup();
    expect(
      await Effect.runPromise(
        Effect.either(LedgerClient.restore(s.anchor).pipe(Effect.provide(s.layer)))
      )
    ).toEqual(Either.left(new StorageError({ reason: 'missing' })));
    await Effect.runPromise(s.create);
    expect(await Effect.runPromise(Effect.either(s.create))).toEqual(
      Either.left(new StorageError({ reason: 'exists' }))
    );
    expect(s.stream.records).toEqual([]);
  });

  it('never treats cache invalidation as permission to roll back an observed prefix', async () => {
    const s = await setup();
    const client = await Effect.runPromise(s.create);
    const before = structuredClone(s.store.journal);
    expect((await Effect.runPromise(client.execute(s.command)))._tag).toBe('Committed');
    s.store.journal = before;
    const result = await Effect.runPromise(Effect.either(client.refresh()));
    expect(result).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'ValidationError', code: 'replay' },
    });
  });

  it('checks nested proofs and policy before invoking the signing capability', async () => {
    const s = await setup();
    const badSigner = Layer.succeed(DeviceSigner, {
      publicKey: value(Bytes.signingPublicKey(s.owner.publicKey)),
      sign: () => Effect.die('must-not-sign-an-invalid-proof'),
    });
    const client = await Effect.runPromise(
      LedgerClient.create({ anchor: s.anchor, genesisRecord: s.created.record }).pipe(
        Effect.provide(
          Layer.mergeAll(journalStoreLayer(s.store), ledgerTransportLayer(s.stream), badSigner)
        )
      )
    );
    const forged: LedgerCommand = {
      ...s.command,
      _tag: 'AdmitDevice',
      kind: 'personal',
      canManage: false,
      signingPublicKey: value(Bytes.signingPublicKey(s.owner.publicKey)),
      encryptionPublicKey: value(Bytes.encryptionPublicKey(s.owner.enc)),
      possessionSignature: value(Bytes.signature(new Uint8Array(64))),
    };
    const result = await Effect.runPromise(Effect.either(client.execute(forged)));
    expect(result).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'ValidationError', code: 'bad-proof' },
    });
    expect(s.stream.records).toEqual([]);
    expect(s.store.journal?.pending).toBeNull();
  });

  it('keeps pending when readback fails after a real commit, then reconciles without signing', async () => {
    const s = await setup();
    const client = await Effect.runPromise(s.create);
    const append = s.stream.appendCas.bind(s.stream);
    const read = s.stream.readAfter.bind(s.stream);
    s.stream.appendCas = async (...args) => {
      const result = await append(...args);
      s.stream.readAfter = async () => {
        throw new Error('network-unavailable');
      };
      return result;
    };
    expect((await Effect.runPromise(client.execute(s.command)))._tag).toBe('Pending');
    expect(s.store.journal?.pending).toEqual(s.stream.records[0]);
    s.stream.readAfter = read;
    expect((await Effect.runPromise(client.resume()))._tag).toBe('Committed');
    expect(s.stream.records).toHaveLength(1);
  });

  it('does not turn a programming defect in transport into Pending', async () => {
    const s = await setup();
    const client = await Effect.runPromise(s.create);
    s.stream.appendCas = async () => {
      throw new TypeError('broken-adapter');
    };
    const result = await Effect.runPromiseExit(client.execute(s.command));
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isSuccess(result)) return;
    expect(Cause.dieOption(result.cause)._tag).toBe('Some');
    expect(s.store.journal?.pending).not.toBeNull();
    expect(s.stream.records).toEqual([]);
  });

  it('never replaces an existing Org or silently ignores partial snapshot metadata', async () => {
    const s = await setup();
    await Effect.runPromise(s.create);
    const foreign = value(Bytes.genesisHash(random(32)));
    expect(
      await Effect.runPromise(
        Effect.either(LedgerClient.restore(foreign).pipe(Effect.provide(s.layer)))
      )
    ).toMatchObject({ _tag: 'Left', left: { _tag: 'StorageError', reason: 'foreign' } });
    const journal = s.store.journal;
    if (!journal) throw new Error('fixture journal missing');
    s.store.journal = { ...journal, snapshot: new Uint8Array([1]) };
    expect(
      await Effect.runPromise(
        Effect.either(LedgerClient.restore(s.anchor).pipe(Effect.provide(s.layer)))
      )
    ).toMatchObject({ _tag: 'Left', left: { _tag: 'StorageError', reason: 'corrupt' } });
  });

  it('does not downgrade a malformed read-back page to a transient Pending result', async () => {
    const s = await setup();
    const client = await Effect.runPromise(s.create);
    const append = s.stream.appendCas.bind(s.stream);
    s.stream.appendCas = async (...args) => {
      const result = await append(...args);
      s.stream.readAfter = async () => {
        throw new ControlLogError('invalid-page');
      };
      return result;
    };
    const result = await Effect.runPromise(Effect.either(client.execute(s.command)));
    expect(result).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'StreamProtocolError', code: 'invalid-page' },
    });
    expect(s.store.journal?.pending).toEqual(s.stream.records[0]);
  });

  it('serializes two local intents and leaves neither pending record overwritten', async () => {
    const s = await setup();
    const client = await Effect.runPromise(s.create);
    s.stream.mode = 'false-ack';
    const results = await Effect.runPromise(
      Effect.all(
        [Effect.either(client.execute(s.command)), Effect.either(client.execute(s.command))],
        { concurrency: 2 }
      )
    );
    expect(results.filter(Either.isRight).map((r) => r.right._tag)).toEqual(['Pending']);
    expect(results.filter(Either.isLeft).map((r) => r.left._tag)).toEqual([
      'PendingOperationExists',
    ]);
    const exact = s.store.journal?.pending;
    s.stream.mode = 'ok';
    expect((await Effect.runPromise(client.resume()))._tag).toBe('Committed');
    expect(s.stream.records).toEqual([exact]);
  });
});

describe('transaction lifetime', () => {
  it('does not resume another device pending record through the bound intent client', async () => {
    const s = await setup();
    const ownerClient = await Effect.runPromise(s.create);
    s.stream.mode = 'false-ack';
    expect((await Effect.runPromise(ownerClient.execute(s.command)))._tag).toBe('Pending');
    const exact = s.store.journal?.pending;
    const other = await ed25519();
    const otherClient = await Effect.runPromise(
      LedgerClient.restore(s.anchor).pipe(
        Effect.provide(
          Layer.mergeAll(
            journalStoreLayer(s.store),
            ledgerTransportLayer(s.stream),
            deviceSignerLayer(value(Bytes.signingPublicKey(other.publicKey)), other.sign)
          )
        )
      )
    );
    s.stream.mode = 'ok';
    expect(await Effect.runPromise(Effect.either(otherClient.resume()))).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'ContextMismatch', context: 'signer' },
    });
    expect(s.store.journal?.pending).toEqual(exact);
    expect(s.stream.records).toEqual([]);
    expect((await Effect.runPromise(ownerClient.resume()))._tag).toBe('Committed');
    expect(s.stream.records).toEqual([exact]);
  });

  for (const point of ['before-pending', 'after-pending', 'before-clear', 'after-clear'] as const) {
    it(`preserves exact recovery state when cancelled at ${point}`, async () => {
      const s = await setup();
      let enter: () => void = () => {};
      let release: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let armed = false;
      let seenPending = false;
      let original: Uint8Array | undefined;
      const store: LedgerStore = {
        exclusive: (work) =>
          s.store.exclusive((tx) =>
            work({
              load: () => tx.load(),
              save: async (journal) => {
                const pending = journal.pending !== null;
                const chosen =
                  armed && (point.endsWith('pending') ? pending : seenPending && !pending);
                if (pending) {
                  seenPending = true;
                  original ??= new Uint8Array(journal.pending);
                }
                if (chosen) armed = false;
                if (chosen && point.startsWith('before')) {
                  enter();
                  await released;
                }
                await tx.save(journal);
                if (chosen && point.startsWith('after')) {
                  enter();
                  await released;
                }
              },
            })
          ),
      };
      const layer = Layer.mergeAll(
        journalStoreLayer(store),
        ledgerTransportLayer(s.stream),
        deviceSignerLayer(value(Bytes.signingPublicKey(s.owner.publicKey)), s.owner.sign)
      );
      const client = await Effect.runPromise(
        LedgerClient.create({ anchor: s.anchor, genesisRecord: s.created.record }).pipe(
          Effect.provide(layer)
        )
      );
      armed = true;
      const controller = new AbortController();
      const operation = Effect.runPromiseExit(client.execute(s.command), {
        signal: controller.signal,
      });
      await entered;
      controller.abort();
      release();
      const interrupted = await operation;
      expect(Exit.isFailure(interrupted) && Cause.isInterrupted(interrupted.cause)).toBe(true);
      const reopened = await Effect.runPromise(
        LedgerClient.restore(s.anchor).pipe(Effect.provide(layer))
      );
      const recovered = await Effect.runPromise(reopened.resume());
      expect(recovered._tag).toBe(point.endsWith('pending') ? 'Committed' : 'Idle');
      expect(s.stream.records).toEqual([original]);
      expect(recovered.ledger.deviceCount).toBe(2);
      expect(s.store.journal?.pending).toBeNull();
    });
  }

  it('releases a lock on interruption without a nested runtime', async () => {
    const store = new MemoryLedgerStore();
    const program = Effect.gen(function* () {
      const service = yield* JournalStore;
      const acquired = yield* Deferred.make<void>();
      const worker = yield* Effect.fork(
        service.exclusive(() =>
          Deferred.succeed(acquired, undefined).pipe(Effect.zipRight(Effect.never))
        )
      );
      yield* Deferred.await(acquired);
      yield* Fiber.interrupt(worker);
      return yield* service.exclusive((tx) => tx.load);
    }).pipe(Effect.provide(journalStoreLayer(store)));
    expect(await Effect.runPromise(program)).toBeNull();
  });

  it('cancels a queued lock acquisition and releases it when the first holder completes', async () => {
    const memory = new MemoryLedgerStore();
    let entered: () => void = () => {};
    const scheduled = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const store: LedgerStore = {
      exclusive: (work) => {
        calls++;
        if (calls === 2) entered();
        return memory.exclusive(work);
      },
    };
    const program = Effect.gen(function* () {
      const service = yield* JournalStore;
      const acquired = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* Effect.fork(
        service.exclusive(() =>
          Deferred.succeed(acquired, undefined).pipe(Effect.zipRight(Deferred.await(release)))
        )
      );
      yield* Deferred.await(acquired);
      const second = yield* Effect.fork(
        service.exclusive(() => Effect.die('cancelled callback must not run'))
      );
      yield* Effect.promise(() => scheduled);
      const interrupted = yield* Fiber.interrupt(second);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      const next = yield* service.exclusive((tx) => tx.load);
      return { interrupted, next };
    }).pipe(Effect.provide(journalStoreLayer(store)));
    const result = await Effect.runPromise(program);
    expect(
      Exit.isFailure(result.interrupted) && Cause.isInterrupted(result.interrupted.cause)
    ).toBe(true);
    expect(result.next).toBeNull();
  });
});
