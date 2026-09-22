import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { Cause, Deferred, Effect, Either, Exit, Fiber, Layer } from 'effect';
import {
  Bytes,
  LedgerClient as EffectLedgerClient,
  JournalStore,
  KeyOutbox,
  EpochCandidateStore,
  EpochKeyring,
  type JournalTransaction,
} from '@lody/e2ee-core/effect';
import {
  deviceSignerLayer,
  ledgerTransportLayer,
  cryptoEntropyLayer,
  signatureVerifierLayer,
} from '@lody/e2ee-core/effect/platform';
import {
  nodeJournalStoreLayer,
  nodeKeyOutboxLayer,
  nodeEpochFilesLayer,
} from '@lody/e2ee-core/effect/platform-node';
import * as JournalCodec from '../src/pure/journal-codec';
import * as OutboxCodec from '../src/pure/key-outbox-codec';
import * as KeyringCodec from '../src/pure/epoch-keyring';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Ledger, LedgerClient, MemoryLedgerStream } from '../src/ledger';
import {
  decodeLedgerJournal,
  encodeLedgerJournal,
  SqliteLedgerStore,
  SqliteLedgerKeyOutbox,
} from '../src/ledger/node-store';
import { admitDeviceOp, append, ed25519, signGenesis } from './ledger-fixtures';

const dirs: string[] = [];
const children = new Set<ChildProcess>();

it('native rotation reopens a pending file candidate without fresh entropy or a new record', async () => {
  const path = location();
  const keyringPath = `${path}.epochs.json`;
  const candidatePath = `${path}.candidate.json`;
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const genesis = Either.getOrThrow(Bytes.genesisHash(created.anchor));
  const oldKeys = `${JSON.stringify([[0, Buffer.from(created.secret).toString('hex')]])}\n`;
  writeFileSync(keyringPath, oldKeys);
  const stream = new MemoryLedgerStream();
  stream.mode = 'false-ack';
  const capabilities = Layer.mergeAll(
    deviceSignerLayer(Either.getOrThrow(Bytes.signingPublicKey(owner.publicKey)), owner.sign),
    ledgerTransportLayer(stream),
    signatureVerifierLayer
  );
  const initial = await Effect.runPromise(
    EffectLedgerClient.importGenesis({ anchor: genesis, genesisRecord: created.record }).pipe(
      Effect.provide(Layer.merge(capabilities, nodeJournalStoreLayer({ path, mode: 'create' })))
    )
  );
  const files = () => nodeEpochFilesLayer({ genesis, keyringPath, candidatePath });
  expect(
    await Effect.runPromise(
      initial.rotateEpoch().pipe(Effect.provide(files()), Effect.provide(cryptoEntropyLayer))
    )
  ).toMatchObject({ _tag: 'Pending', epoch: 1 });
  const candidate = readFileSync(candidatePath, 'utf8');
  expect(readFileSync(keyringPath, 'utf8')).toBe(oldKeys);
  stream.mode = 'ok';
  const reopened = await Effect.runPromise(
    EffectLedgerClient.restore(genesis).pipe(
      Effect.provide(Layer.merge(capabilities, nodeJournalStoreLayer({ path, mode: 'open' })))
    )
  );
  expect(
    await Effect.runPromise(reopened.resumeEpochRotation().pipe(Effect.provide(files())))
  ).toMatchObject({ _tag: 'Committed', epoch: 1, binding: 'current' });
  const saved = JSON.parse(candidate);
  expect(stream.records).toEqual([new Uint8Array(Buffer.from(saved.recordHex, 'hex'))]);
  expect(
    Either.getOrThrow(KeyringCodec.decodeEpochKeyring(readFileSync(keyringPath, 'utf8'))).get(1)
  ).toEqual(new Uint8Array(Buffer.from(saved.secretHex, 'hex')));
  expect(existsSync(candidatePath)).toBe(false);
  expect((await new SqliteLedgerStore(path).exclusive((tx) => tx.load()))?.pending).toBeNull();
});

it('native epoch files preserve old JSON, reject replacement keys, and fail closed on missing/corrupt data', async () => {
  const keyringPath = location();
  const candidatePath = `${keyringPath}.candidate`;
  const genesis = Either.getOrThrow(Bytes.genesisHash(new Uint8Array(32).fill(1)));
  const epoch = Either.getOrThrow(Bytes.epochNumber(0));
  const key = Either.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(2)));
  const layer = () => nodeEpochFilesLayer({ genesis, keyringPath, candidatePath });
  const run = Effect.gen(function* () {
    const keys = yield* EpochKeyring;
    yield* keys.put(genesis, epoch, key);
    return yield* keys.get(genesis, epoch);
  });
  expect(await Effect.runPromise(run.pipe(Effect.provide(layer()), Effect.either))).toMatchObject({
    _tag: 'Left',
    left: { reason: 'missing' },
  });
  expect(existsSync(keyringPath)).toBe(false);
  writeFileSync(keyringPath, '[]\n');
  expect(await Effect.runPromise(run.pipe(Effect.provide(layer())))).not.toBeNull();
  const exact = `[[0,"${'02'.repeat(32)}"]]\n`;
  expect(readFileSync(keyringPath, 'utf8')).toBe(exact);
  await Effect.runPromise(run.pipe(Effect.provide(layer())));
  expect(readFileSync(keyringPath, 'utf8')).toBe(exact);
  const wrong = Either.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(3)));
  const overwrite = Effect.flatMap(EpochKeyring, (keys) => keys.put(genesis, epoch, wrong));
  expect(
    await Effect.runPromise(overwrite.pipe(Effect.provide(layer()), Effect.either))
  ).toMatchObject({ _tag: 'Left', left: { reason: 'corrupt' } });
  expect(readFileSync(keyringPath, 'utf8')).toBe(exact);
  for (const broken of ['{', '[[0,"00"]]', `[[0,"${'02'.repeat(32)}"],[0,"${'02'.repeat(32)}"]]`]) {
    writeFileSync(keyringPath, broken);
    expect(await Effect.runPromise(run.pipe(Effect.provide(layer()), Effect.either))).toMatchObject(
      { _tag: 'Left', left: { reason: 'corrupt' } }
    );
    expect(readFileSync(keyringPath, 'utf8')).toBe(broken);
  }
  expect(KeyringCodec.decodeEpochKeyring(exact)).toEqual(
    Either.right(new Map([[0, new Uint8Array(32).fill(2)]]))
  );
});

it('native epoch candidate leases retain saved bytes across interruption and exclude other handles', async () => {
  const keyringPath = location();
  const candidatePath = `${keyringPath}.candidate`;
  writeFileSync(keyringPath, '[]\n');
  const genesis = Either.getOrThrow(Bytes.genesisHash(new Uint8Array(32).fill(1)));
  const layer = () => nodeEpochFilesLayer({ genesis, keyringPath, candidatePath });
  const text = `${JSON.stringify({ genesisHex: '01'.repeat(32), epoch: 1, commitmentHex: '02'.repeat(32), secretHex: '03'.repeat(32), recordHex: '0102' })}\n`;
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* EpochCandidateStore;
      const saved = yield* Deferred.make<void>();
      const holder = yield* Effect.fork(
        store.exclusive(genesis, (tx) =>
          Effect.gen(function* () {
            yield* tx.save(text);
            yield* Deferred.succeed(saved, undefined);
            yield* Effect.never;
          })
        )
      );
      yield* Deferred.await(saved);
      const concurrent = yield* Effect.flatMap(EpochCandidateStore, (other) =>
        other.exclusive(genesis, (tx) => tx.load)
      ).pipe(Effect.provide(layer()), Effect.either);
      expect(concurrent).toMatchObject({ _tag: 'Left', left: { reason: 'busy' } });
      yield* Fiber.interrupt(holder);
      expect(yield* store.exclusive(genesis, (tx) => tx.load)).toBe(text);
      expect(readFileSync(candidatePath, 'utf8')).toBe(text);
      const overwrite = yield* store
        .exclusive(genesis, (tx) => tx.save(text.replace('"epoch":1', '"epoch":2')))
        .pipe(Effect.either);
      expect(overwrite).toMatchObject({ _tag: 'Left', left: { reason: 'exists' } });
      expect(readFileSync(candidatePath, 'utf8')).toBe(text);
      yield* store.exclusive(genesis, (tx) => tx.clear);
      expect(existsSync(candidatePath)).toBe(false);
      const escaped = yield* store.exclusive(genesis, (tx) => Effect.succeed(tx));
      expect(yield* escaped.save(text).pipe(Effect.either)).toMatchObject({
        _tag: 'Left',
        left: { reason: 'closed' },
      });
      expect(yield* escaped.load.pipe(Effect.either)).toMatchObject({
        _tag: 'Left',
        left: { reason: 'closed' },
      });
      expect(existsSync(candidatePath)).toBe(false);
    }).pipe(Effect.provide(layer()))
  );
});

it('outbox codec preserves canonical v0 bytes and rejects ambiguous rows', () => {
  const id = '12'.repeat(16);
  const text = `["lody-e2ee-key-outbox/v0",[["${id}","0102ff"]]]`;
  expect(OutboxCodec.encodeKeyOutbox(new Map([[id, new Uint8Array([1, 2, 255])]]))).toEqual(
    Either.right(text)
  );
  expect(OutboxCodec.decodeKeyOutbox(text)).toEqual(
    Either.right(new Map([[id, new Uint8Array([1, 2, 255])]]))
  );
  for (const bad of [
    text + ' ',
    text.replace('0102ff', '0102FF'),
    `["lody-e2ee-key-outbox/v0",[["${id}","01"],["${id}","02"]]]`,
  ]) {
    expect(OutboxCodec.decodeKeyOutbox(bad)).toMatchObject({
      _tag: 'Left',
      left: { code: 'canonical' },
    });
  }
  expect(OutboxCodec.decodeKeyOutbox(text.replace('/v0', '/v9'))).toMatchObject({
    _tag: 'Left',
    left: { code: 'unknown-version' },
  });
});

it('native outbox interruption keeps committed bytes and releases its SQLite lease', async () => {
  const path = location();
  const id = '12'.repeat(16),
    frame = new Uint8Array([1, 2, 3]);
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* KeyOutbox;
      const saved = yield* Deferred.make<void>();
      const holder = yield* Effect.fork(
        store.exclusive((tx) =>
          tx
            .save(id, frame)
            .pipe(
              Effect.zipRight(Deferred.succeed(saved, undefined)),
              Effect.zipRight(Effect.never)
            )
        )
      );
      yield* Deferred.await(saved);
      const interrupted = yield* Fiber.interrupt(holder);
      expect(Exit.isFailure(interrupted) && Cause.isInterrupted(interrupted.cause)).toBe(true);
      expect(yield* store.exclusive((tx) => tx.load(id))).toEqual(frame);
    }).pipe(Effect.provide(nodeKeyOutboxLayer({ path, mode: 'create' })))
  );
  expect(await new SqliteLedgerKeyOutbox(path).exclusive((tx) => tx.load(id))).toEqual(frame);
});

it('native outbox preserves the v0 payload across legacy and Effect reopen', async () => {
  const path = location();
  const id = '12'.repeat(16);
  const frame = new Uint8Array([1, 2, 3]);
  const initial = nodeKeyOutboxLayer({ path, mode: 'create' });
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* KeyOutbox;
      yield* store.exclusive((tx) => tx.save(id, frame));
    }).pipe(Effect.provide(initial))
  );
  expect(await new SqliteLedgerKeyOutbox(path).exclusive((tx) => tx.load(id))).toEqual(frame);
  const reopened = nodeKeyOutboxLayer({ path, mode: 'open' });
  const otherId = '34'.repeat(16);
  await new SqliteLedgerKeyOutbox(path).exclusive((tx) => tx.save(otherId, new Uint8Array([4, 5])));
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* KeyOutbox;
      expect(yield* store.exclusive((tx) => tx.load(otherId))).toEqual(new Uint8Array([4, 5]));
      expect(
        yield* Effect.either(store.exclusive((tx) => tx.save(id, new Uint8Array([9]))))
      ).toMatchObject({ _tag: 'Left', left: { code: 'replay' } });
      const failed = yield* Effect.either(
        store.exclusive((tx) =>
          tx.save('56'.repeat(16), frame).pipe(Effect.zipRight(Effect.fail('after-save')))
        )
      );
      expect(failed).toEqual(Either.left('after-save'));
    }).pipe(Effect.provide(reopened))
  );
  expect(await new SqliteLedgerKeyOutbox(path).exclusive((tx) => tx.load(id))).toEqual(frame);
  expect(await new SqliteLedgerKeyOutbox(path).exclusive((tx) => tx.load('56'.repeat(16)))).toEqual(
    frame
  );
});

it('native outbox open never creates missing or initializes foreign files', async () => {
  const path = location();
  const open = Effect.gen(function* () {
    yield* KeyOutbox;
  }).pipe(Effect.provide(nodeKeyOutboxLayer({ path, mode: 'open' })));
  expect(await Effect.runPromise(Effect.either(open))).toMatchObject({
    _tag: 'Left',
    left: { _tag: 'StorageError', reason: 'missing' },
  });
  expect(existsSync(path)).toBe(false);
  writeFileSync(path, '');
  expect(await Effect.runPromise(Effect.either(open))).toMatchObject({
    _tag: 'Left',
    left: { _tag: 'StorageError', reason: 'foreign' },
  });
  expect(readFileSync(path).byteLength).toBe(0);
  writeFileSync(path, 'not a sqlite database');
  expect(await Effect.runPromise(Effect.either(open))).toMatchObject({
    _tag: 'Left',
    left: { _tag: 'StorageError', reason: 'corrupt' },
  });
  expect(readFileSync(path, 'utf8')).toBe('not a sqlite database');
});

function location() {
  const dir = mkdtempSync(join(tmpdir(), 'lody-ledger-store-'));
  dirs.push(dir);
  return join(dir, 'ledger.sqlite');
}

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  children.delete(child);
}

afterEach(async () => {
  await Promise.all([...children].map(kill));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('L6 sqlite journal restart', () => {
  it('native Effect client reopens exact uncertain submissions without signing again', async () => {
    const path = location();
    const owner = await ed25519();
    const phone = await ed25519();
    const created = await signGenesis(owner);
    const proof = await admitDeviceOp(
      created.anchor,
      created.membershipId,
      phone,
      'personal',
      false
    );
    const stream = new MemoryLedgerStream();
    const value = <A, E>(result: Either.Either<A, E>) =>
      Either.getOrThrowWith(result, (error) => error);
    const publicKey = value(Bytes.signingPublicKey(owner.publicKey));
    const create = EffectLedgerClient.create({
      userId: value(Bytes.userId(created.userId)),
      membershipId: value(Bytes.membershipId(created.membershipId)),
      encryptionPublicKey: value(Bytes.encryptionPublicKey(owner.enc)),
      epochCommitment: value(Bytes.epochCommitment(created.commitment)),
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          nodeJournalStoreLayer({ path, mode: 'create' }),
          ledgerTransportLayer(stream),
          deviceSignerLayer(publicKey, owner.sign),
          signatureVerifierLayer
        )
      )
    );
    const client = await Effect.runPromise(create);
    stream.mode = 'false-ack';
    const pending = await Effect.runPromise(
      client.execute({
        _tag: 'AdmitDevice',
        kind: 'personal',
        canManage: false,
        signingPublicKey: value(Bytes.signingPublicKey(phone.publicKey)),
        encryptionPublicKey: value(Bytes.encryptionPublicKey(phone.enc)),
        possessionSignature: value(Bytes.signature(proof.possessionSignature)),
      })
    );
    expect(pending._tag).toBe('Pending');
    const persisted = await new SqliteLedgerStore(path).exclusive((tx) => tx.load());
    const reopened = await Effect.runPromise(
      EffectLedgerClient.restore(pending.ledger.genesis).pipe(
        Effect.provide(
          Layer.mergeAll(
            nodeJournalStoreLayer({ path, mode: 'open' }),
            ledgerTransportLayer(stream),
            deviceSignerLayer(publicKey, async () => {
              throw new Error('resume must not sign');
            }),
            signatureVerifierLayer
          )
        )
      )
    );
    stream.mode = 'ok';
    expect((await Effect.runPromise(reopened.resume()))._tag).toBe('Committed');
    expect(stream.records).toEqual([persisted?.pending]);
    expect((await new SqliteLedgerStore(path).exclusive((tx) => tx.load()))?.pending).toBeNull();
  });

  it('native Effect interruption releases the lock without rolling back saved pending bytes', async () => {
    const path = location();
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const journal = {
      genesis: created.anchor,
      records: [created.record],
      pending: created.record,
      offset: '0',
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* JournalStore;
        const saved = yield* Deferred.make<JournalTransaction>();
        const holder = yield* Effect.fork(
          store.exclusive((tx) =>
            Effect.gen(function* () {
              yield* tx.save(journal);
              yield* Deferred.succeed(saved, tx);
              yield* Effect.never;
            })
          )
        );
        const escaped = yield* Deferred.await(saved);
        const interrupted = yield* Fiber.interrupt(holder);
        expect(Exit.isFailure(interrupted) && Cause.isInterrupted(interrupted.cause)).toBe(true);
        expect(yield* Effect.either(escaped.load)).toMatchObject({
          _tag: 'Left',
          left: { _tag: 'StorageError', reason: 'closed' },
        });
        expect(yield* store.exclusive((tx) => tx.load)).toEqual(journal);
        const defect = yield* Effect.exit(store.exclusive(() => Effect.die('fixture-defect')));
        expect(Exit.isFailure(defect) && Cause.isDie(defect.cause)).toBe(true);
        expect(yield* store.exclusive((tx) => tx.load)).toEqual(journal);
      }).pipe(Effect.provide(nodeJournalStoreLayer({ path, mode: 'create' })))
    );
    const reopened = new SqliteLedgerStore(path, { createFile: false, initializeSchema: false });
    expect(await reopened.exclusive((tx) => tx.load())).toEqual(journal);
  });

  it('explicit Effect open never creates missing storage, overwrites existing storage or recreates deleted storage', async () => {
    const path = location();
    const inspect = Effect.gen(function* () {
      const store = yield* JournalStore;
      return yield* store.exclusive((tx) => tx.load);
    });
    const opening = inspect.pipe(Effect.provide(nodeJournalStoreLayer({ path, mode: 'open' })));
    expect(await Effect.runPromise(Effect.either(opening))).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'StorageError', reason: 'missing' },
    });
    expect(existsSync(path)).toBe(false);
    const creating = inspect.pipe(Effect.provide(nodeJournalStoreLayer({ path, mode: 'create' })));
    expect(existsSync(path)).toBe(false);
    expect(await Effect.runPromise(creating)).toBeNull();
    expect(await Effect.runPromise(Effect.either(creating))).toMatchObject({
      _tag: 'Left',
      left: { reason: 'exists' },
    });
    expect(await Effect.runPromise(opening)).toBeNull();
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* JournalStore;
        unlinkSync(path);
        const missing = yield* Effect.either(store.exclusive((tx) => tx.load));
        expect(missing).toMatchObject({ _tag: 'Left', left: { reason: 'missing' } });
        expect(existsSync(path)).toBe(false);
      }).pipe(Effect.provide(nodeJournalStoreLayer({ path, mode: 'open' })))
    );
  });

  it('explicit Effect open distinguishes foreign and corrupt storage without replacing either', async () => {
    for (const [contents, reason] of [
      ['', 'foreign'],
      ['not a SQLite database', 'corrupt'],
    ] as const) {
      const path = location();
      writeFileSync(path, contents);
      const opening = Effect.gen(function* () {
        return yield* JournalStore;
      }).pipe(Effect.provide(nodeJournalStoreLayer({ path, mode: 'open' })), Effect.either);
      expect(await Effect.runPromise(opening)).toMatchObject({ _tag: 'Left', left: { reason } });
      expect(readFileSync(path, 'utf8')).toBe(contents);
    }
  });

  it('the Effect store reports a held SQLite lock as busy and reopens after release', async () => {
    const path = location();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* JournalStore;
      }).pipe(Effect.provide(nodeJournalStoreLayer({ path, mode: 'create' })))
    );
    let enter = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new SqliteLedgerStore(path).exclusive(async () => {
      enter();
      await released;
    });
    await entered;
    const inspect = Effect.gen(function* () {
      const store = yield* JournalStore;
      return yield* store.exclusive((tx) => tx.load);
    }).pipe(Effect.provide(nodeJournalStoreLayer({ path, mode: 'open' })));
    try {
      expect(await Effect.runPromise(Effect.either(inspect))).toMatchObject({
        _tag: 'Left',
        left: { reason: 'busy' },
      });
    } finally {
      release();
      await held;
    }
    expect(await Effect.runPromise(inspect)).toBeNull();
  });

  it('pure journal decoding preserves frozen v0/v1 envelopes and rejects corruption without throwing', () => {
    const samples = [
      '["lody-e2ee-journal/v0","aa",["bb"],"cc","cursor"]',
      '["lody-e2ee-journal/v1","aa",[],null,"cursor","bb",["cc","dd","ee"]]',
      '["lody-e2ee-journal/v1","aa",[],"ff","cursor","bb",["cc","dd","ee"],true]',
    ];
    for (const text of samples) {
      const decoded = JournalCodec.decodeLedgerJournal(text);
      if (Either.isLeft(decoded)) throw new Error('frozen journal must decode');
      expect(JournalCodec.encodeLedgerJournal(decoded.right)).toEqual(Either.right(text));
      expect(encodeLedgerJournal(decoded.right)).toBe(text);
      decoded.right.genesis.fill(0);
      expect(JournalCodec.decodeLedgerJournal(text)).not.toEqual(decoded);
      expect(JournalCodec.decodeLedgerJournal(text + ' ')).toMatchObject({
        _tag: 'Left',
        left: { code: 'canonical' },
      });
    }
    for (const text of ['{', 'null', '["foreign"]'])
      expect(JournalCodec.decodeLedgerJournal(text)).toMatchObject({ _tag: 'Left' });
  });

  it('reloads verified records after process restart and does not treat disk as authority', async () => {
    const path = location();
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', true)
      )
    ).record;
    const stream = new MemoryLedgerStream();
    const first = new LedgerClient(
      created.record,
      created.anchor,
      new SqliteLedgerStore(path),
      stream
    );
    expect((await first.submit(record)).status).toBe('committed');

    const restarted = new LedgerClient(
      created.record,
      created.anchor,
      new SqliteLedgerStore(path),
      stream
    );
    const view = await restarted.read();
    expect(view.length).toBe(2);
    expect(view.head).toEqual((await first.read()).head);

    await new SqliteLedgerStore(path).exclusive(async (tx) => {
      const journal = await tx.load();
      if (!journal) throw new Error('missing-journal');
      const garbled = {
        ...journal,
        records: [journal.records[0]!, new Uint8Array(journal.records[1]!).fill(7)],
      };
      await tx.save(garbled);
    });
    const poisoned = new LedgerClient(
      created.record,
      created.anchor,
      new SqliteLedgerStore(path),
      new MemoryLedgerStream()
    );
    await expect(poisoned.read()).rejects.toBeTruthy();
  });

  it('retains pending across a killed holder and releases the OS lock', async () => {
    const path = location();
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const store = new SqliteLedgerStore(path);
    const baseline = {
      genesis: created.anchor,
      records: [created.record],
      pending: null as Uint8Array | null,
      offset: 'empty:/+',
    };
    await store.exclusive((tx) => tx.save(baseline));
    const phone = await ed25519();
    const pending = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', true)
      )
    ).record;
    const withPending = { ...baseline, pending };
    const child = fork(new URL('./ledger-node-store-child.ts', import.meta.url), [path], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.add(child);
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const failed = new Promise<never>((_, reject) =>
      child.once('exit', (code, signal) =>
        reject(new Error(`fixture exited: ${code}/${signal}: ${stderr}`))
      )
    );
    expect(await Promise.race([once(child, 'message'), failed])).toEqual(['ready', undefined]);
    const locked = once(child, 'message');
    child.send({ mode: 'save', journal: encodeLedgerJournal(withPending) });
    expect(await Promise.race([locked, failed])).toEqual(['locked', undefined]);
    await expect(store.exclusive((tx) => tx.load())).rejects.toThrow('journal-busy');
    await kill(child);
    const recovered = await store.exclusive((tx) => tx.load());
    expect(recovered?.pending).toEqual(pending);
    expect(recovered?.records).toHaveLength(1);
  });

  it('rolls back an uncommitted sqlite update after process death', async () => {
    const path = location();
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const store = new SqliteLedgerStore(path);
    const baseline = {
      genesis: created.anchor,
      records: [created.record],
      pending: null as Uint8Array | null,
      offset: 'empty:/+',
    };
    await store.exclusive((tx) => tx.save(baseline));
    const child = fork(new URL('./ledger-node-store-child.ts', import.meta.url), [path], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.add(child);
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const failed = new Promise<never>((_, reject) =>
      child.once('exit', (code, signal) =>
        reject(new Error(`fixture exited: ${code}/${signal}: ${stderr}`))
      )
    );
    expect(await Promise.race([once(child, 'message'), failed])).toEqual(['ready', undefined]);
    const locked = once(child, 'message');
    child.send({ mode: 'uncommitted', journal: encodeLedgerJournal(baseline) });
    expect(await Promise.race([locked, failed])).toEqual(['locked', undefined]);
    await kill(child);
    const recovered = await store.exclusive((tx) => tx.load());
    expect(recovered?.records).toHaveLength(1);
    expect(recovered?.pending).toBeNull();
    expect(recovered?.offset).toBe('empty:/+');
  });

  it('resumes exact pending after restart when CAS ACK was lost, and reloads after commit', async () => {
    const path = location();
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', true)
      )
    ).record;
    const stream = new MemoryLedgerStream();
    stream.mode = 'false-ack';
    const first = new LedgerClient(
      created.record,
      created.anchor,
      new SqliteLedgerStore(path),
      stream
    );
    expect((await first.submit(record)).status).toBe('unknown');
    const pending = await new SqliteLedgerStore(path).exclusive(
      async (tx) => (await tx.load())?.pending
    );
    expect(pending).toEqual(record);

    stream.mode = 'ok';
    const resumed = new LedgerClient(
      created.record,
      created.anchor,
      new SqliteLedgerStore(path),
      stream
    );
    expect((await resumed.resume()).status).toBe('committed');
    expect(stream.records[0]).toEqual(record);

    const after = new LedgerClient(
      created.record,
      created.anchor,
      new SqliteLedgerStore(path),
      stream
    );
    const view = await after.read();
    expect(view.length).toBe(2);
    const loaded = await new SqliteLedgerStore(path).exclusive((tx) => tx.load());
    expect(loaded?.pending).toBeNull();
    expect(loaded?.records).toHaveLength(2);
  });

  it('rejects malformed and foreign journal encodings', () => {
    expect(() => decodeLedgerJournal('{')).toThrow();
    expect(() =>
      decodeLedgerJournal(JSON.stringify(['lody-control-journal/v2', 'aa', [], null, 'x']))
    ).toThrow();
    const ownerPending = JSON.stringify(['lody-e2ee-journal/v0', 'aa', ['bb'], null, 'empty:/+']);
    expect(() => decodeLedgerJournal(`${ownerPending} `)).toThrow();
    expect(() =>
      decodeLedgerJournal(JSON.stringify(['lody-e2ee-journal/v1', 'aa', [], null, 'empty:/+']))
    ).toThrow();
  });

  it('restarts a snapshot journal from sqlite without prefix records', async () => {
    const path = location();
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const phone = await ed25519();
    const extra = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', true)
      )
    ).record;
    const proposal = created.ledger.prepareSnapshot(owner.publicKey);
    const snapshot = await Ledger.finalizeSnapshot(
      proposal,
      await owner.sign(proposal.signingBytes)
    );
    const trust = {
      genesis: proposal.genesis,
      endorser: owner.publicKey,
      head: proposal.head,
      headSignature: await owner.sign(proposal.headAttestationSigningBytes),
    };
    const stream = new MemoryLedgerStream();
    stream.records = [created.record, extra];
    const store = new SqliteLedgerStore(path);
    const first = await LedgerClient.openFromSnapshot({ trust, snapshot, store, stream });
    expect((await first.submit(extra)).status).toBe('committed');
    const encoded = await new SqliteLedgerStore(path).exclusive(async (tx) => {
      const journal = await tx.load();
      if (!journal?.snapshot) throw new Error('missing-snapshot-journal');
      expect(journal.records).toHaveLength(1);
      return encodeLedgerJournal(journal);
    });
    expect(encoded.startsWith('["lody-e2ee-journal/v1"')).toBe(true);
    expect(decodeLedgerJournal(encoded).snapshot?.byteLength).toBe(snapshot.byteLength);

    const restarted = await LedgerClient.openJournal(
      created.anchor,
      new SqliteLedgerStore(path),
      stream
    );
    const view = await restarted.read();
    expect(view.origin).toBe('snapshot');
    expect(view.length).toBe(2);
    expect(view.state.devices.size).toBe(2);
    expect(() => view.hashAt(1)).not.toThrow();
  });

  it('keeps v1 journals without snapshotBound and fails closed on a foreign genesis after restart', async () => {
    const path = location();
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const extra = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, await ed25519(), 'personal', true)
      )
    ).record;
    const proposal = created.ledger.prepareSnapshot(owner.publicKey);
    const snapshot = await Ledger.finalizeSnapshot(
      proposal,
      await owner.sign(proposal.signingBytes)
    );
    const trust = {
      genesis: proposal.genesis,
      endorser: owner.publicKey,
      head: proposal.head,
      headSignature: await owner.sign(proposal.headAttestationSigningBytes),
    };
    const unbound = encodeLedgerJournal({
      genesis: created.anchor,
      records: [],
      pending: null,
      offset: 'empty:/+',
      snapshot,
      snapshotTrust: trust,
    });
    expect(unbound.startsWith('["lody-e2ee-journal/v1"')).toBe(true);
    expect(JSON.parse(unbound)).toHaveLength(7);
    expect(decodeLedgerJournal(unbound).snapshotBound).toBeUndefined();

    const stream = new MemoryLedgerStream();
    stream.records = [created.record, extra];
    const store = new SqliteLedgerStore(path);
    await store.exclusive((tx) => tx.save(decodeLedgerJournal(unbound)));
    const first = await LedgerClient.openJournal(created.anchor, store, stream);
    const joined = await first.read();
    expect(joined.origin).toBe('snapshot');
    expect(joined.length).toBe(2);
    const encoded = await new SqliteLedgerStore(path).exclusive(async (tx) => {
      const journal = await tx.load();
      if (!journal) throw new Error('missing-journal');
      expect(journal.snapshotBound).toBe(true);
      return encodeLedgerJournal(journal);
    });
    expect(JSON.parse(encoded)).toHaveLength(8);

    const foreign = await signGenesis(await ed25519());
    stream.records.push(foreign.record);
    const before = await new SqliteLedgerStore(path).exclusive(
      async (tx) => (await tx.load())?.offset
    );
    await expect(first.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    const afterFail = await new SqliteLedgerStore(path).exclusive((tx) => tx.load());
    expect(afterFail?.offset).toBe(before);
    expect(afterFail?.records).toHaveLength(1);

    const restarted = await LedgerClient.openJournal(
      created.anchor,
      new SqliteLedgerStore(path),
      stream
    );
    await expect(restarted.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    const afterRestart = await new SqliteLedgerStore(path).exclusive((tx) => tx.load());
    expect(afterRestart?.offset).toBe(before);
  });
});
