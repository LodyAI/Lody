import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Effect, Layer, Result } from 'effect';
import {
  Bytes,
  CryptoEntropy,
  LedgerClient,
  JournalStore,
  HpkeSender,
  KeyOutbox,
  EpochCandidateStore,
  EpochKeyring,
  DistributionStore,
  EpochMailboxIndexStore,
  MailboxAuthority,
  KeyMailboxHost,
  KeyMailboxRemote,
  KeyDeliveryRemote,
  StorageError,
  TransportError,
  type EpochKey,
} from '../src/effect';
import {
  MemoryJournalStore,
  MemoryKeyOutbox,
  MemoryDistributionStore,
  MemoryEpochMailboxIndexStore,
  deviceSignerLayer,
  hpkeSenderLayer,
  hpkeRecipientLayer,
  signatureVerifierLayer,
  ledgerTransportLayer,
  keyMailboxRemoteLayer,
} from '../src/platform';
import {
  nodeDistributionStoreLayer,
  nodeMailboxIndexStoreLayer,
} from '../src/platform/node-journal';
import { MemoryLedgerStream } from '../src/ledger/submit';
import { admitDeviceOp, append, signGenesis, type DeviceKeys } from './ledger-fixtures';
import { finishTask } from '../src/pure/key-distribution';
import { keyId } from '../src/pure/identifiers';
import { fromHex, mailboxDigest, decodeInstallationReport } from '../src/pure/key-mailbox';
import { copyEpochKeyBytes } from '../src/pure/epoch-key';

const value = <A, E>(r: Result.Result<A, E>) => Result.getOrThrowWith(r, (e) => e);
const dirs: string[] = [];
let identityCounter = 0;
/** Synthetic deterministic fixture entropy; all encryption/signatures remain real. */
function fixtureEntropy() {
  let counter = 0;
  return Layer.succeed(CryptoEntropy, {
    bytes: (label, length) =>
      Effect.sync(() => {
        const out = new Uint8Array(length);
        for (let offset = 0; offset < length; offset += 32)
          out.set(
            createHash('sha256')
              .update(`central-fixture:${label}:${counter++}`)
              .digest()
              .subarray(0, Math.min(32, length - offset)),
            offset
          );
        return out;
      }),
  });
}

afterEach(() => {
  identityCounter = 0;
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true });
});
function directory() {
  const p = mkdtempSync(join(tmpdir(), 'e2ee-mailbox-'));
  dirs.push(p);
  return p;
}
async function device() {
  const id = identityCounter++;
  async function pair(algorithm: 'Ed25519' | 'X25519', oid: string): Promise<CryptoKeyPair> {
    const seed = createHash('sha256')
      .update(`synthetic-central-device:${id}:${algorithm}`)
      .digest();
    const der = Buffer.concat([Buffer.from(`302e020100300506032b65${oid}04220420`, 'hex'), seed]);
    const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
    return {
      privateKey: await crypto.subtle.importKey(
        'pkcs8',
        der,
        algorithm,
        true,
        algorithm === 'Ed25519' ? ['sign'] : ['deriveBits']
      ),
      publicKey: await crypto.subtle.importKey(
        'raw',
        raw,
        algorithm,
        true,
        algorithm === 'Ed25519' ? ['verify'] : []
      ),
    };
  }
  const signing = await pair('Ed25519', '70'),
    dh = await pair('X25519', '6e');
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey));
  const enc = new Uint8Array(await crypto.subtle.exportKey('raw', dh.publicKey));
  const keys: DeviceKeys & { dh: CryptoKeyPair; privateJwk: JsonWebKey; dhJwk: JsonWebKey } = {
    publicKey,
    enc,
    dh,
    privateJwk: await crypto.subtle.exportKey('jwk', signing.privateKey),
    dhJwk: await crypto.subtle.exportKey('jwk', dh.privateKey),
    sign: async (bytes) =>
      new Uint8Array(
        await crypto.subtle.sign('Ed25519', signing.privateKey, new Uint8Array(bytes))
      ),
  };
  return keys;
}
async function scenario(
  indexLayer?: Layer.Layer<
    EpochMailboxIndexStore,
    StorageError | import('../src/effect').ValidationError
  >
) {
  const owner = await device(),
    phone = await device(),
    recovery = await device();
  const created = await signGenesis(owner, new Uint8Array(32).fill(7), {
    userId: new Uint8Array(32).fill(8),
    membershipId: new Uint8Array(16).fill(9),
  });
  const admitted = await append(
    created.ledger,
    owner,
    await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
  );
  const r = await append(
    admitted.ledger,
    owner,
    await admitDeviceOp(created.anchor, created.membershipId, recovery, 'recovery')
  );
  const stream = new MemoryLedgerStream();
  stream.records = [created.record, admitted.record, r.record];
  const genesis = value(Bytes.genesisHash(created.anchor));
  const signerLayer = (keys: DeviceKeys) =>
    deviceSignerLayer(value(Bytes.signingPublicKey(keys.publicKey)), keys.sign);
  const makeLedger = (keys: DeviceKeys) =>
    Effect.runPromise(
      LedgerClient.importGenesis({ anchor: genesis, genesisRecord: created.record }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(JournalStore, new MemoryJournalStore()),
            ledgerTransportLayer(stream),
            signerLayer(keys),
            signatureVerifierLayer
          )
        )
      )
    );
  const ownerLedger = await makeLedger(owner),
    phoneLedger = await makeLedger(phone);
  const index = new MemoryEpochMailboxIndexStore();
  const host = await Effect.runPromise(
    KeyMailboxHost.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          indexLayer ?? Layer.succeed(EpochMailboxIndexStore, index),
          Layer.succeed(MailboxAuthority, { current: ownerLedger.refresh() }),
          signatureVerifierLayer
        )
      )
    )
  );
  const keys = new Map<string, Map<number, EpochKey>>();
  function keyring(keysFor: DeviceKeys) {
    let map = keys.get(keyId(keysFor.publicKey));
    if (!map) {
      map = new Map();
      keys.set(keyId(keysFor.publicKey), map);
    }
    const owned = map;
    return EpochKeyring.of({
      get: (_g, e) => Effect.sync(() => owned.get(e) ?? null),
      put: (_g, e, k) =>
        Effect.sync(() => {
          owned.set(e, k);
        }),
    });
  }
  keys.set(keyId(owner.publicKey), new Map([[0, value(Bytes.epochKey(created.secret))]]));
  const candidates = new Map<string, string | null>();
  const distribution = new Map<string, MemoryDistributionStore>();
  const outboxes = new Map<string, MemoryKeyOutbox>();
  function layer(
    keysFor: typeof owner,
    extra?: Layer.Layer<DistributionStore, StorageError | import('../src/effect').ValidationError>
  ) {
    const id = keyId(keysFor.publicKey);
    if (!distribution.has(id)) distribution.set(id, new MemoryDistributionStore());
    if (!outboxes.has(id)) outboxes.set(id, new MemoryKeyOutbox());
    return Layer.mergeAll(
      extra ?? Layer.succeed(DistributionStore, distribution.get(id)!),
      Layer.succeed(KeyOutbox, outboxes.get(id)!),
      Layer.succeed(EpochCandidateStore, {
        exclusive: (_g, work) =>
          work({
            load: Effect.sync(() => candidates.get(id) ?? null),
            save: (text) =>
              Effect.sync(() => {
                candidates.set(id, text);
              }),
            clear: Effect.sync(() => {
              candidates.delete(id);
            }),
          }),
      }),
      Layer.succeed(EpochKeyring, keyring(keysFor)),
      keyMailboxRemoteLayer(host, value(Bytes.signingPublicKey(keysFor.publicKey))),
      signatureVerifierLayer,
      hpkeSenderLayer().pipe(Layer.provide(fixtureEntropy())),
      hpkeRecipientLayer(keysFor.dh),
      fixtureEntropy()
    );
  }
  const ownerLayer = layer(owner),
    phoneLayer = layer(phone);
  const ownerClient = await Effect.runPromise(
    ownerLedger.keyDistribution().pipe(Effect.provide(ownerLayer))
  );
  const phoneClient = await Effect.runPromise(
    phoneLedger.keyDistribution().pipe(Effect.provide(phoneLayer))
  );
  const runOwner = <A, E>(e: Effect.Effect<A, E, Layer.Success<typeof ownerLayer>>) =>
    Effect.runPromise(e.pipe(Effect.provide(ownerLayer)));
  const runPhone = <A, E>(e: Effect.Effect<A, E, Layer.Success<typeof phoneLayer>>) =>
    Effect.runPromise(e.pipe(Effect.provide(phoneLayer)));
  const slot = (keysFor: DeviceKeys, epoch = 0) => ({
    genesis: keyId(created.anchor),
    epoch,
    recipient: keyId(keysFor.publicKey),
  });
  const remote = (keysFor: DeviceKeys) =>
    host.remote(value(Bytes.signingPublicKey(keysFor.publicKey)));
  return {
    owner,
    phone,
    recovery,
    created,
    stream,
    genesis,
    ownerLedger,
    phoneLedger,
    host,
    index,
    makeLedger,
    keyring,
    keys,
    layer,
    ownerLayer,
    phoneLayer,
    ownerClient,
    phoneClient,
    runOwner,
    runPhone,
    slot,
    remote,
    distribution,
    outboxes,
  };
}
async function fanout(s: Awaited<ReturnType<typeof scenario>>) {
  await s.runOwner(s.ownerClient.reconcileCurrentEpoch());
  await s.runOwner(s.ownerClient.resumePendingDeliveries());
}

describe('central mailbox, durable finite coordination', () => {
  it('discovers startup publication gaps; retains offline/R ciphertext without endless encryption, and reports verified genesis locally', async () => {
    const s = await scenario();
    await fanout(s);
    expect(
      (await Effect.runPromise(s.remote(s.owner).list('needsEnvelope', null, 100))).items
    ).toHaveLength(1); // local report queued, not yet flushed
    await s.runOwner(s.ownerClient.flushInstallationReports());
    expect(
      (await Effect.runPromise(s.remote(s.owner).list('needsEnvelope', null, 100))).items
    ).toHaveLength(0);
    expect(
      (
        await Effect.runPromise(s.remote(s.owner).list('awaitingInstallationReport', null, 100))
      ).items
        .map((t) => t.recipient)
        .sort()
    ).toEqual([keyId(s.phone.publicKey), keyId(s.recovery.publicKey)].sort());
    const before = await Effect.runPromise(s.index.exclusive((tx) => tx.load));
    await fanout(s);
    await fanout(s);
    const after = await Effect.runPromise(s.index.exclusive((tx) => tx.load));
    expect(after.entries.flatMap((e) => e.envelopes)).toEqual(
      before.entries.flatMap((e) => e.envelopes)
    );
    expect((await Effect.runPromise(s.remote(s.recovery).fetch(0, null, 1))).items).toHaveLength(1);
  });
  it('authenticates fetch/report, bounds queries, and does not treat DeliveryId as authorization', async () => {
    const s = await scenario();
    await fanout(s);
    const phone = await Effect.runPromise(s.remote(s.phone).fetch(0, null, 100));
    expect(phone.items).toHaveLength(1);
    expect(
      value(
        decodeInstallationReport(
          fromHex(
            (
              await Effect.runPromise(
                s.distribution.get(keyId(s.owner.publicKey))!.exclusive((tx) => tx.load)
              )
            ).receives[0]!.report!
          )
        )
      ).context.source._tag
    ).toBe('LocalPublication');
    await expect(
      Effect.runPromise(s.remote(s.phone).put('0'.repeat(32), phone.items[0]!.frame))
    ).rejects.toMatchObject({ _tag: 'ValidationError', code: 'unauthorized' });
    await expect(
      Effect.runPromise(s.remote(s.owner).list('needsEnvelope', null, 101))
    ).rejects.toMatchObject({ code: 'canonical' });
    const stranger = await device();
    await expect(Effect.runPromise(s.remote(stranger).fetch(0, null, 10))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await s.runPhone(s.phoneClient.fetchAndInstall());
    const report = (
      await Effect.runPromise(
        s.distribution.get(keyId(s.phone.publicKey))!.exclusive((tx) => tx.load)
      )
    ).receives[0]!.report!;
    await expect(
      Effect.runPromise(s.remote(s.owner).report(fromHex(report)))
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('retries identical lost reports, accepts duplicates, and explicitly acknowledges durable results', async () => {
    const s = await scenario();
    await fanout(s);
    await s.runPhone(s.phoneClient.fetchAndInstall());
    const normal = s.remote(s.phone);
    let first = true;
    const seen: string[] = [];
    const lossy = {
      ...normal,
      report: (b: Uint8Array, p?: Uint8Array) =>
        normal.report(b, p).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              seen.push(keyId(b));
              if (first) {
                first = false;
                return Effect.fail(new TransportError({ operation: 'deliver' }));
              }
              return Effect.void;
            })
          )
        ),
    };
    await Effect.runPromise(
      s.phoneClient.flushInstallationReports().pipe(Effect.provideService(KeyMailboxRemote, lossy))
    );
    const reopened = await s.runPhone(s.phoneLedger.keyDistribution());
    await Effect.runPromise(
      reopened.flushInstallationReports().pipe(Effect.provideService(KeyMailboxRemote, lossy))
    );
    expect(seen[0]).toBe(seen[1]);
    const results = await Effect.runPromise(reopened.readUnacknowledgedResults());
    expect(results.items).toHaveLength(1);
    expect(results.items[0]!.outcome).toBe('Reported');
    await Effect.runPromise(reopened.acknowledgeResult(results.items[0]!.id));
    expect((await Effect.runPromise(reopened.readUnacknowledgedResults())).items).toHaveLength(0);
  });
  it('does not recreate an acknowledged result when a concurrent stale completion arrives', async () => {
    const s = await scenario();
    await fanout(s);
    const store = s.distribution.get(keyId(s.owner.publicKey))!;
    const completed = await Effect.runPromise(store.exclusive((tx) => tx.load));
    const task = completed.tasks.find((t) => t.phase === 'done')!;
    const result = completed.results.find((r) => r.taskId === task.id)!;
    await Effect.runPromise(s.ownerClient.acknowledgeResult(result.id));
    await Effect.runPromise(
      store.exclusive((tx) =>
        Effect.gen(function* () {
          const doc = yield* tx.load;
          yield* tx.save(finishTask(doc, 'tasks', task.id, 'Failed', 'late-completion'));
        })
      )
    );
    expect(
      (await Effect.runPromise(s.ownerClient.readUnacknowledgedResults())).items.some(
        (r) => r.id === result.id
      )
    ).toBe(false);
  });
  it('recovers installed-before-queued-report with no original handler and no second HPKE open', async () => {
    const s = await scenario();
    await fanout(s);
    const actual = s.keyring(s.phone);
    let failed = true;
    const failing = EpochKeyring.of({
      ...actual,
      put: (g, e, k) =>
        actual.put(g, e, k).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (failed) {
                failed = false;
                return Effect.fail(new StorageError({ reason: 'io' }));
              }
              return Effect.void;
            })
          )
        ),
    });
    await expect(
      Effect.runPromise(
        s.phoneClient
          .fetchAndInstall()
          .pipe(Effect.provideService(EpochKeyring, failing), Effect.provide(s.phoneLayer))
      )
    ).rejects.toMatchObject({ _tag: 'StorageError' });
    expect(copyEpochKeyBytes(s.keys.get(keyId(s.phone.publicKey))!.get(0)!)).toEqual(
      s.created.secret
    );
    const reopened = await s.runPhone(s.phoneLedger.keyDistribution());
    await s.runPhone(reopened.resumeReceives());
    await s.runPhone(reopened.flushInstallationReports());
    expect((await Effect.runPromise(s.remote(s.phone).status(s.slot(s.phone)))).status).toBe(
      'InstallationReported'
    );
  });
  it('retains receive context when keyring installation fails before writing, then installs on restart', async () => {
    const s = await scenario();
    await fanout(s);
    const actual = s.keyring(s.phone);
    const failing = EpochKeyring.of({
      ...actual,
      put: () => Effect.fail(new StorageError({ reason: 'io' })),
    });
    await expect(
      Effect.runPromise(
        s.phoneClient
          .fetchAndInstall()
          .pipe(Effect.provideService(EpochKeyring, failing), Effect.provide(s.phoneLayer))
      )
    ).rejects.toMatchObject({ _tag: 'StorageError' });
    expect(s.keys.get(keyId(s.phone.publicKey))!.has(0)).toBe(false);
    const doc = await Effect.runPromise(
      s.distribution.get(keyId(s.phone.publicKey))!.exclusive((tx) => tx.load)
    );
    expect(doc.receives[0]).toMatchObject({ phase: 'install', report: null });
    const reopened = await s.runPhone(s.phoneLedger.keyDistribution());
    await s.runPhone(reopened.resumeReceives());
    await s.runPhone(reopened.flushInstallationReports());
    expect((await Effect.runPromise(s.remote(s.phone).status(s.slot(s.phone)))).status).toBe(
      'InstallationReported'
    );
  });
  it('adds same-epoch devices from its own ledger, allows helpers, and R never forwards', async () => {
    const s = await scenario();
    await fanout(s);
    await s.runPhone(s.phoneClient.fetchAndInstall());
    const newcomer = await device();
    const current = await import('../src/ledger');
    const ledger = await current.Ledger.verify({
      anchor: s.created.anchor,
      records: s.stream.records,
    });
    const admission = await append(
      ledger,
      s.owner,
      await admitDeviceOp(s.created.anchor, s.created.membershipId, newcomer, 'machine')
    );
    s.stream.records.push(admission.record);
    await s.runPhone(s.phoneClient.reconcileCurrentEpoch());
    await s.runPhone(s.phoneClient.resumePendingDeliveries());
    expect((await Effect.runPromise(s.remote(newcomer).status(s.slot(newcomer)))).status).toBe(
      'EnvelopeStored'
    );
    const rLedger = await s.makeLedger(s.recovery),
      rLayer = s.layer(s.recovery);
    const rClient = await Effect.runPromise(rLedger.keyDistribution().pipe(Effect.provide(rLayer)));
    await Effect.runPromise(rClient.fetchAndInstall().pipe(Effect.provide(rLayer)));
    expect(
      await Effect.runPromise(rClient.reconcileCurrentEpoch().pipe(Effect.provide(rLayer)))
    ).toEqual({ scheduled: 0 });
  });
  it('durably retires tasks on revocation/rotation, including atomic failure after commit', async () => {
    const s = await scenario();
    await s.runOwner(s.ownerClient.reconcileCurrentEpoch());
    const { Ledger } = await import('../src/ledger');
    let ledger = await Ledger.verify({ anchor: s.created.anchor, records: s.stream.records });
    const pending = await Effect.runPromise(
      s.distribution.get(keyId(s.owner.publicKey))!.exclusive((tx) => tx.load)
    );
    const revoked = await append(ledger, s.owner, {
      type: 'revokeDevice',
      target: fromHex(pending.tasks[0]!.recipient),
    });
    s.stream.records.push(revoked.record);
    ledger = revoked.ledger;
    const store = s.distribution.get(keyId(s.owner.publicKey))!;
    store.failSave = 'after';
    await expect(s.runOwner(s.ownerClient.resumePendingDeliveries())).rejects.toMatchObject({
      _tag: 'StorageError',
    });
    const reopened = await s.runOwner(s.ownerLedger.keyDistribution());
    expect((await Effect.runPromise(reopened.readUnacknowledgedResults())).items).toContainEqual(
      expect.objectContaining({ outcome: 'Revoked' })
    );
    await s.runOwner(s.ownerLedger.rotateEpoch());
    await s.runOwner(reopened.resumePendingDeliveries());
    expect((await Effect.runPromise(reopened.readUnacknowledgedResults())).items).toContainEqual(
      expect.objectContaining({ outcome: 'Obsolete' })
    );
    expect(
      (
        await Effect.runPromise(
          s.remote(s.owner).status({
            genesis: keyId(s.created.anchor),
            epoch: 0,
            recipient: pending.tasks[1]!.recipient,
          })
        )
      ).status
    ).toBe('Obsolete');
  });
  it('rejects delayed old-epoch reports without advancing the current index', async () => {
    const s = await scenario();
    await fanout(s);
    await s.runPhone(s.phoneClient.fetchAndInstall());
    const saved = (
      await Effect.runPromise(
        s.distribution.get(keyId(s.phone.publicKey))!.exclusive((tx) => tx.load)
      )
    ).receives[0]!.report!;
    await s.runOwner(s.ownerLedger.rotateEpoch());
    await fanout(s);
    await expect(Effect.runPromise(s.remote(s.phone).report(fromHex(saved)))).rejects.toMatchObject(
      { code: 'unauthorized' }
    );
    expect((await Effect.runPromise(s.remote(s.phone).status(s.slot(s.phone, 1)))).status).toBe(
      'EnvelopeStored'
    );
  });
  it('repairs local key loss with retained ciphertext; delayed pre-repair report cannot close the repair', async () => {
    const s = await scenario();
    await fanout(s);
    await s.runPhone(s.phoneClient.fetchAndInstall());
    const saved = (
      await Effect.runPromise(
        s.distribution.get(keyId(s.phone.publicKey))!.exclusive((tx) => tx.load)
      )
    ).receives[0]!.report!;
    await s.runPhone(s.phoneClient.flushInstallationReports());
    s.keys.get(keyId(s.phone.publicKey))!.delete(0);
    await s.runPhone(s.phoneClient.requestRepair('lost-key-1'));
    await expect(Effect.runPromise(s.remote(s.phone).report(fromHex(saved)))).rejects.toMatchObject(
      { code: 'unauthorized' }
    );
    await fanout(s);
    await s.runPhone(s.phoneClient.fetchAndInstall());
    await s.runPhone(s.phoneClient.flushInstallationReports());
    expect(copyEpochKeyBytes(s.keys.get(keyId(s.phone.publicKey))!.get(0)!)).toEqual(
      s.created.secret
    );
    expect((await Effect.runPromise(s.remote(s.phone).status(s.slot(s.phone)))).status).toBe(
      'InstallationReported'
    );
    const doc = await Effect.runPromise(s.index.exclusive((tx) => tx.load));
    expect(
      doc.entries.find((e) => e.recipient === keyId(s.phone.publicKey))!.envelopes
    ).toHaveLength(1);
  });
  it('persists mailbox ciphertext and index together; reopening restores projection without stream rescans', async () => {
    const path = join(directory(), 'mailbox.sqlite');
    const s = await scenario(nodeMailboxIndexStoreLayer({ path, mode: 'create' }));
    await fanout(s);
    const reopened = await Effect.runPromise(
      KeyMailboxHost.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            nodeMailboxIndexStoreLayer({ path, mode: 'open' }),
            Layer.succeed(MailboxAuthority, { current: s.ownerLedger.refresh() }),
            signatureVerifierLayer
          )
        )
      )
    );
    await Effect.runPromise(reopened.reconcileProjection());
    expect(
      (
        await Effect.runPromise(
          reopened.remote(value(Bytes.signingPublicKey(s.recovery.publicKey))).fetch(0, null, 100)
        )
      ).items
    ).toHaveLength(1);
    await expect(
      scenario(
        nodeMailboxIndexStoreLayer({ path: join(directory(), 'missing.sqlite'), mode: 'open' })
      )
    ).rejects.toMatchObject({ reason: 'missing' });
  });
  it('stops a send when rotation happens at the server boundary, retaining a queryable outcome', async () => {
    const s = await scenario();
    await s.runOwner(s.ownerClient.reconcileCurrentEpoch());
    const normal = s.remote(s.owner);
    let rotate = true;
    const racing = {
      ...normal,
      put: (id: string, bytes: Uint8Array) =>
        Effect.gen(function* () {
          if (rotate) {
            rotate = false;
            yield* s.ownerLedger.rotateEpoch().pipe(Effect.provide(s.ownerLayer), Effect.orDie);
          }
          yield* normal.put(id, bytes);
        }),
    };
    await Effect.runPromise(
      s.ownerClient
        .resumePendingDeliveries()
        .pipe(Effect.provideService(KeyDeliveryRemote, racing), Effect.provide(s.ownerLayer))
    );
    const outcomes = (await Effect.runPromise(s.ownerClient.readUnacknowledgedResults())).items;
    expect(outcomes.every((r) => r.outcome === 'Obsolete')).toBe(true);
    expect((await Effect.runPromise(s.remote(s.phone).fetch(1, null, 100))).items).toHaveLength(0);
  });
  it('repairs a correctly signed envelope containing the wrong secret using another eligible helper', async () => {
    const s = await scenario();
    // Real HPKE with an intentionally wrong plaintext; server cannot inspect the commitment.
    const corruptSealer = Layer.effect(
      HpkeSender,
      Effect.gen(function* () {
        const actual = yield* HpkeSender;
        return HpkeSender.of({
          seal: (input) =>
            actual.seal({ ...input, key: value(Bytes.epochKey(new Uint8Array(32))) }),
        });
      })
    ).pipe(Layer.provide(hpkeSenderLayer().pipe(Layer.provide(fixtureEntropy()))));
    await Effect.runPromise(
      s.ownerLedger
        .sendEpochKey(
          value(Bytes.signingPublicKey(s.phone.publicKey)),
          value(Bytes.epochKey(s.created.secret))
        )
        .pipe(Effect.provide(corruptSealer), Effect.provide(s.ownerLayer))
    );
    await expect(s.runPhone(s.phoneClient.fetchAndInstall())).rejects.toMatchObject({
      _tag: 'ContextMismatch',
    });
    expect(s.keys.get(keyId(s.phone.publicKey))!.has(0)).toBe(false);
    const frame = (await Effect.runPromise(s.remote(s.phone).fetch(0, null, 100))).items[0]!.frame;
    await s.runPhone(s.phoneClient.requestRepair('bad-envelope-1', mailboxDigest(frame)));
    expect((await Effect.runPromise(s.remote(s.phone).status(s.slot(s.phone)))).status).toBe(
      'NeedsEnvelope'
    );
    const helper = await device();
    const { Ledger } = await import('../src/ledger');
    const ledger = await Ledger.verify({ anchor: s.created.anchor, records: s.stream.records });
    const admitted = await append(
      ledger,
      s.owner,
      await admitDeviceOp(s.created.anchor, s.created.membershipId, helper, 'personal')
    );
    s.stream.records.push(admitted.record);
    // Helper already obtained K0 via a legitimate prior installation.
    s.keys.set(keyId(helper.publicKey), new Map([[0, value(Bytes.epochKey(s.created.secret))]]));
    const helperLedger = await s.makeLedger(helper),
      helperLayer = s.layer(helper);
    await Effect.runPromise(
      helperLedger
        .sendCurrentEpochKey(value(Bytes.signingPublicKey(s.phone.publicKey)))
        .pipe(Effect.provide(helperLayer))
    );
    await s.runPhone(s.phoneClient.fetchAndInstall());
    await s.runPhone(s.phoneClient.flushInstallationReports());
    expect(copyEpochKeyBytes(s.keys.get(keyId(s.phone.publicKey))!.get(0)!)).toEqual(
      s.created.secret
    );
    expect(
      (await Effect.runPromise(s.phoneClient.readUnacknowledgedResults())).items
    ).toContainEqual(expect.objectContaining({ outcome: 'Failed' }));
  });
  it('aggregates multiple helpers by recipient/epoch while preserving each exact frame', async () => {
    const s = await scenario();
    await fanout(s);
    await s.runPhone(s.phoneClient.fetchAndInstall());
    const newcomer = await device();
    const { Ledger } = await import('../src/ledger');
    const ledger = await Ledger.verify({ anchor: s.created.anchor, records: s.stream.records });
    const admission = await append(
      ledger,
      s.owner,
      await admitDeviceOp(s.created.anchor, s.created.membershipId, newcomer, 'personal')
    );
    s.stream.records.push(admission.record);
    const recipient = value(Bytes.signingPublicKey(newcomer.publicKey));
    await Promise.all([
      s.runOwner(s.ownerLedger.sendCurrentEpochKey(recipient)),
      s.runPhone(s.phoneLedger.sendCurrentEpochKey(recipient)),
    ]);
    const doc = await Effect.runPromise(s.index.exclusive((tx) => tx.load));
    const row = doc.entries.find((e) => e.recipient === keyId(newcomer.publicKey))!;
    expect(row.envelopes).toHaveLength(2);
    expect(new Set(row.envelopes.map((e) => e.digest)).size).toBe(2);
    expect(
      (
        await Effect.runPromise(s.remote(s.owner).list('awaitingInstallationReport', null, 100))
      ).items.filter((e) => e.recipient === keyId(newcomer.publicKey))
    ).toHaveLength(1);
  });

  it.each(['install', 'report', 'terminal'])(
    'survives SIGKILL at durable %s checkpoint and resumes in a fresh process',
    async (stage) => {
      const s = await scenario();
      await fanout(s);
      const dir = directory();
      const frame = (await Effect.runPromise(s.remote(s.phone).fetch(0, null, 100))).items[0]!
        .frame;
      writeFileSync(join(dir, 'epochs.json'), '[]\n', { mode: 0o600 });
      writeFileSync(
        join(dir, 'fixture.json'),
        JSON.stringify({
          anchor: keyId(s.created.anchor),
          records: s.stream.records.map(keyId),
          recipient: keyId(s.phone.publicKey),
          sender: keyId(s.owner.publicKey),
          privateJwk: s.phone.privateJwk,
          dhJwk: s.phone.dhJwk,
          enc: keyId(s.phone.enc),
          frame: keyId(frame),
        }),
        { mode: 0o600 }
      );
      const childPath = resolve('test/crash-mailbox-client.ts');
      await new Promise<void>((done, reject) => {
        const child = fork(childPath, [dir, stage], {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let reached = false;
        let stderr = '';
        child.stderr!.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('message', (m: unknown) => {
          if ((m as { stage?: string }).stage === stage) {
            reached = true;
            child.kill('SIGKILL');
          }
        });
        child.on('exit', (_code, signal) => {
          if (reached && signal === 'SIGKILL') done();
          else reject(new Error(stderr || 'missing durable checkpoint'));
        });
      });
      const messages = await new Promise<
        { report?: number[]; results?: readonly { outcome: string }[] }[]
      >((done, reject) => {
        const child = fork(childPath, [dir, 'resume'], {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        const rows: { report?: number[]; results?: readonly { outcome: string }[] }[] = [];
        let stderr = '';
        child.stderr!.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('message', (m) => rows.push(m as (typeof rows)[number]));
        child.on('exit', (code) => (code === 0 ? done(rows) : reject(new Error(stderr))));
      });
      expect(messages.find((m) => m.results)?.results).toEqual([
        expect.objectContaining({ outcome: 'Reported' }),
      ]);
      const report = messages.find((m) => m.report)?.report;
      if (stage !== 'terminal') {
        expect(report).toBeDefined();
        await Effect.runPromise(s.remote(s.phone).report(new Uint8Array(report!)));
        expect((await Effect.runPromise(s.remote(s.phone).status(s.slot(s.phone)))).status).toBe(
          'InstallationReported'
        );
      }
      const reopened = await Effect.runPromise(
        s.phoneLedger
          .keyDistribution()
          .pipe(
            Effect.provide(
              nodeDistributionStoreLayer({ path: join(dir, 'distribution.sqlite'), mode: 'open' })
            )
          )
      );
      expect(
        (await Effect.runPromise(reopened.readUnacknowledgedResults())).items[0]!.outcome
      ).toBe('Reported');
      await Effect.runPromise(
        reopened.acknowledgeResult(
          (await Effect.runPromise(reopened.readUnacknowledgedResults())).items[0]!.id
        )
      );
      expect((await Effect.runPromise(reopened.readUnacknowledgedResults())).items).toHaveLength(0);
    },
    15000
  );
});
