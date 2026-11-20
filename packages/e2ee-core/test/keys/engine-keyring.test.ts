/**
 * EngineKeyringSync against the real native engine keyring: what the engine can
 * seal and open after a sync is the observable result.
 * Spec: specs/native-engine-cloud-e2ee.md, section 5.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { ContentKeyring } from '@loro-dev/loro-repo-engine';
import { Clock, Effect, Layer, Result } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EngineKeyringSync,
  InstalledEpochHistory,
  InstalledEpochKeys,
  InstalledKeyError,
  VerifiedLedger,
} from '@lody/e2ee-core';
import {
  DeviceIdentity,
  EngineKeyringSink,
  EngineKeyringSinkError,
  LedgerViewSource,
  WorkspaceScope,
} from '@lody/e2ee-core/services';
import { sqliteLedgerPinStore } from '@lody/e2ee-core/adapters/node-sqlite';
import * as Ledger from '@lody/e2ee-core/protocol';
import { Bytes } from '@lody/e2ee-core/protocol';
import type * as Signing from '@lody/e2ee-core/protocol';
import { encodeCbor, type CborValue } from '../../src/internal/foundation/cbor';
import { disposeEpochKey } from '../../src/internal/foundation/epoch-key';

const read = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result);
const NS = 'ws';
const KEYS = [new Uint8Array(32).fill(7), new Uint8Array(32).fill(8)];
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function identity(seed: number) {
  const seedBytes = new Uint8Array(32).fill(seed);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seedBytes]),
    format: 'der',
    type: 'pkcs8',
  });
  const raw = new Uint8Array(
    createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
  );
  const signBytes = (message: Uint8Array) => new Uint8Array(sign(null, message, privateKey));
  const signer: Signing.DeviceSigner = {
    publicKey: read(Bytes.signingPublicKey(raw)),
    sign: (message) => Effect.succeed(read(Bytes.signature(signBytes(message)))),
  };
  return { seed: seedBytes, raw, signBytes, signer };
}

/** Owner genesis at epoch 0; optional phone, a published epoch 1, and revocation. */
function workspace() {
  const owner = identity(1),
    phone = identity(2);
  const tag = (name: string, payload: Uint8Array) =>
    new Uint8Array(Buffer.concat([Buffer.from(`lody-e2ee/${name}\0`), payload]));
  const record = (body: readonly CborValue[]) =>
    read(encodeCbor([body, owner.signBytes(tag('sig/v1', read(encodeCbor(body))))]));
  const rows = [
    record([
      1,
      owner.raw,
      new Uint8Array(32).fill(10),
      new Uint8Array(16).fill(10),
      new Uint8Array(32).fill(100),
      read(
        Ledger.commitEpochKey(
          read(Bytes.genesisHash(new Uint8Array(32))),
          0,
          read(Bytes.epochKey(KEYS[0]!))
        )
      ).toBytes(),
    ]),
  ];
  const anchor = read(Bytes.genesisHash(Ledger.hashRecordBytes(rows[0]!).toBytes()));
  const view = () =>
    read(
      Ledger.verifyLedger({
        anchor,
        records: rows,
        checkpoint: { head: Ledger.hashRecordBytes(rows.at(-1)!), length: rows.length },
      })
    );
  const append = (op: readonly CborValue[]) =>
    rows.push(record([Ledger.hashRecordBytes(rows.at(-1)!).toBytes(), owner.raw, op]));
  const addPhone = () => {
    const enc = new Uint8Array(32).fill(102);
    const proof = phone.signBytes(
      tag(
        'possess/v2',
        read(encodeCbor([anchor.toBytes(), new Uint8Array(16).fill(10), phone.raw, enc, 0]))
      )
    );
    append([4, 0, phone.raw, enc, proof]);
  };
  const rotate = () => {
    const previousKey = read(Bytes.epochKey(KEYS[0]!));
    const currentKey = read(Bytes.epochKey(KEYS[1]!));
    try {
      append([
        7,
        1,
        read(Ledger.commitEpochKey(anchor, 1, currentKey)).toBytes(),
        read(Ledger.sealHistoryPacket({ genesis: anchor, epoch: 1, currentKey, previousKey })),
      ]);
    } finally {
      disposeEpochKey(previousKey);
      disposeEpochKey(currentKey);
    }
  };
  return {
    owner,
    phone,
    anchor,
    view,
    addPhone,
    rotate,
    revokePhone: () => append([5, phone.raw]),
  };
}

type Workspace = ReturnType<typeof workspace>;

/** Runs one sync as `device`, holding `held` epoch keys, into `keyring`. */
/** A clock the test moves; the retained-epoch budget reads wall and monotonic time. */
function testClock() {
  const real = Effect.runSync(Clock.Clock);
  const time = { ms: 1_000_000 };
  const clock: Clock.Clock = Object.assign(Object.create(real), {
    currentTimeMillisUnsafe: () => time.ms,
    monotonicTimeNanosUnsafe: () => BigInt(time.ms) * 1_000_000n,
    currentTimeMillis: Effect.sync(() => time.ms),
    monotonicTimeNanos: Effect.sync(() => BigInt(time.ms) * 1_000_000n),
  });
  return { clock, advance: (ms: number) => void (time.ms += ms) };
}

function syncInto(
  f: Workspace,
  keyring: ContentKeyring,
  device: ReturnType<typeof identity>,
  held: readonly number[],
  options: { dir?: string; clock?: Clock.Clock } = {}
) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'engine-keyring-'));
  if (!options.dir) dirs.push(dir);
  const call = (operation: string, run: () => void) =>
    Effect.try({ try: run, catch: (cause) => new EngineKeyringSinkError({ operation, cause }) });
  const sink = Layer.succeed(EngineKeyringSink, {
    configure: (genesis) => call('configure', () => void keyring.configureNamespace(NS, genesis)),
    admit: (keys) =>
      call('admit', () => {
        for (const key of keys) keyring.admitWriterPubkey(NS, key);
      }),
    installEpoch: (epoch, key) =>
      call('installEpoch', () => keyring.installEpochKey(NS, epoch, key)),
    setSealEpoch: (epoch) => call('setSealEpoch', () => keyring.setSealEpoch(NS, epoch)),
    installSigner: () =>
      call('installSigner', () => void keyring.configureWriterSigner(NS, 'self', device.seed)),
    holdSealing: () => call('holdSealing', () => keyring.holdSealing(NS, 'self')),
    releaseSealing: () => call('releaseSealing', () => keyring.releaseSealing(NS, 'self')),
  });
  const installed = Layer.succeed(InstalledEpochKeys, {
    read: (epoch) =>
      held.includes(epoch)
        ? Effect.succeed(read(Bytes.epochKey(KEYS[epoch]!)))
        : Effect.fail(new InstalledKeyError({ reason: 'missing-key' })),
    check: () => Effect.void,
    saveAndReload: () => Effect.void,
  });
  const scope = Layer.succeed(WorkspaceScope, { genesis: f.anchor });
  const base = Layer.mergeAll(
    sqliteLedgerPinStore({ path: join(dir, 'pin.sqlite'), mode: 'create-or-open' }).pipe(
      Layer.provideMerge(scope)
    ),
    Layer.succeed(LedgerViewSource, { current: () => Effect.succeed(f.view()) }),
    Layer.succeed(DeviceIdentity, {
      signer: device.signer,
      encryptionKeyPair: undefined as unknown as CryptoKeyPair,
    }),
    sink,
    installed
  );
  const ledger = VerifiedLedger.layer.pipe(Layer.provideMerge(base));
  const history = InstalledEpochHistory.layer.pipe(Layer.provideMerge(ledger));
  const layer = EngineKeyringSync.layer.pipe(Layer.provide(history));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sync = yield* EngineKeyringSync;
        return yield* sync.sync();
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(Clock.Clock, options.clock ?? Effect.runSync(Clock.Clock))
      )
    )
  );
}

const room = { kind: 'loro_doc' as const, id: 'session-0001' };
const contextAad = new Uint8Array([1, 2, 3]);
const seal = (k: ContentKeyring, writer = 'self') =>
  k.seal({
    namespace: NS,
    room,
    payloadKind: 'update_batch',
    writer,
    continuationOffset: null,
    contextAad,
    plaintext: new Uint8Array([9]),
  });
const epochOf = (sealed: Uint8Array) => new DataView(sealed.buffer, sealed.byteOffset).getUint32(1);

describe('EngineKeyringSync', () => {
  it('installs every verified epoch and seals at the current one', async () => {
    const f = workspace();
    f.rotate();
    const keyring = new ContentKeyring();
    const report = await syncInto(f, keyring, f.owner, [0, 1]);
    expect(report).toMatchObject({ installedEpochs: [0, 1], sealEpoch: 1, mayWrite: true });
    expect(epochOf(seal(keyring).sealed)).toBe(1);
    expect(await syncInto(f, keyring, f.owner, [0, 1])).toEqual(report);
  });

  it('keeps admitting a device revoked later, so its frames still open', async () => {
    const f = workspace();
    f.addPhone();
    const phoneKeyring = new ContentKeyring();
    await syncInto(f, phoneKeyring, f.phone, [0]);
    const byPhone = seal(phoneKeyring);
    f.revokePhone();
    const ownerKeyring = new ContentKeyring();
    const report = await syncInto(f, ownerKeyring, f.owner, [0]);
    expect(report.admittedDevices).toBe(2);
    expect(await syncInto(f, phoneKeyring, f.phone, [0])).toMatchObject({ mayWrite: false });
    expect(() => seal(phoneKeyring)).toThrow(/CONTENT_KEYRING:unauthorized/);
    expect(
      ownerKeyring.open({
        namespace: NS,
        room,
        payloadKind: 'update_batch',
        continuationOffset: null,
        header: byPhone.header,
        sealed: byPhone.sealed,
        additionalData: openAad(byPhone.header),
      })
    ).toEqual(new Uint8Array([9]));
  });

  it('seals at the retained epoch while the current key is missing, then holds after the budget', async () => {
    const f = workspace();
    f.rotate();
    const dir = mkdtempSync(join(tmpdir(), 'engine-keyring-'));
    dirs.push(dir);
    const { clock, advance } = testClock();
    const keyring = new ContentKeyring();
    const within = await syncInto(f, keyring, f.owner, [0], { dir, clock });
    expect(within).toMatchObject({
      installedEpochs: [0],
      missingEpochs: [1],
      sealEpoch: 0,
      mayWrite: true,
    });
    expect(epochOf(seal(keyring).sealed)).toBe(0);
    advance(16 * 60_000);
    const after = await syncInto(f, keyring, f.owner, [0], { dir, clock });
    expect(after).toMatchObject({ missingEpochs: [1], mayWrite: false });
    expect(after.sealEpoch).toBeUndefined();
    expect(() => seal(keyring)).toThrow(/CONTENT_KEYRING:unauthorized/);
    expect(await syncInto(f, keyring, f.owner, [0, 1], { dir, clock })).toMatchObject({
      sealEpoch: 1,
      mayWrite: true,
    });
    expect(epochOf(seal(keyring).sealed)).toBe(1);
  });
});

/** Open AAD = seal contextAad || u32be(len) || envelope AAD (see the engine's lsce.rs). */
function openAad(header: Uint8Array) {
  const envelope = new Uint8Array([
    ...Buffer.from('loro-streams-crdt-payload-protection/v2\0'),
    ...Buffer.from('LSCE'),
    2,
    1,
    0,
    header.byteLength,
    0,
    0,
    ...header,
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(envelope.byteLength);
  return new Uint8Array([...contextAad, ...length, ...envelope]);
}
