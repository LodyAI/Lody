import { encode } from '@ipld/dag-cbor';
import { sha256 } from '@noble/hashes/sha2.js';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import {
  ClientKeyCustody,
  ClientCustodyWriter,
  ClientInstallationStore,
  ClientIdentityOriginals,
  ClientCustodyError,
  CLIENT_KEY_PURPOSES,
  type ClientCustodyBinding,
  type ClientKeyPurpose,
} from '../../services/client-custody';
import { ClientPairingOriginalStore, type ClientPairingKey } from '../../services/client-pairing';
import { KeyProtector, CandidateProtector } from '../../services/keys';
import { KeyProtectorError } from '../../services/errors';
import { makeAdmissionGate, own } from '../../internal/lifecycle';
import { bytesEqual } from '../../internal/foundation/cbor';
import {
  openClientDatabase,
  assertClientWritable,
  bindingRaw,
  bindingId,
  BindingSchema,
  sameBinding,
  sameScope,
  scopeRaw,
  equal,
  decode,
  boundedBytes,
  writeRow,
  safeInt,
} from '../indexeddb/client-database';
import { checkWriterScope } from './writer';
import type { Transaction } from '../indexeddb/database';

/** Explicit browser protection routing. Candidate requests are already durable public originals, not desktop approval. */
export interface BrowserClientCustodyOptions {
  /** Stable shared custody database; must match installation/journal routing. */
  readonly databaseName: string;
  /** Complete expected local binding, captured independently of ciphertext. */
  readonly binding: ClientCustodyBinding;
  /** Returning profiles must use open-existing; absence cannot initialize a replacement. */
  readonly mode: 'create-or-open' | 'open-existing';
  /** Replacement candidate only: exact request retained by the provided pairing store before KEK creation. */
  readonly candidateRequest?: ClientPairingKey;
}
const DOMAIN = 'lody-e2ee/client-custody/v1\0';
const PROBE = new TextEncoder().encode('lody-e2ee/client-custody/key-probe/v1');
const fail = (reason: ClientCustodyError['reason']) => new ClientCustodyError({ reason });
const Marker = Schema.Struct({
  version: Schema.Literal(1),
  binding: BindingSchema,
  phase: Schema.Literals(['creating', 'available', 'deleted']),
  nonceCount: Schema.Int,
  probe: Schema.NullOr(Schema.Uint8Array),
});
const KeyRow = Schema.Struct({
  version: Schema.Literal(1),
  binding: BindingSchema,
  key: Schema.Unknown,
});
const Wrapped = Schema.Struct({
  version: Schema.Literal(1),
  binding: BindingSchema,
  purpose: Schema.String,
  digest: Schema.String,
  nonce: Schema.Uint8Array,
  blob: Schema.NullOr(Schema.Uint8Array),
});
const markerDecode = Schema.decodeUnknownSync(Marker, { onExcessProperty: 'error' }),
  keyDecode = Schema.decodeUnknownSync(KeyRow, { onExcessProperty: 'error' }),
  wrappedDecode = Schema.decodeUnknownSync(Wrapped, { onExcessProperty: 'error' });
const hex = (body: Uint8Array) => Array.from(body, (x) => x.toString(16).padStart(2, '0')).join('');
const aad = (b: ClientCustodyBinding, purpose: ClientKeyPurpose) =>
  new Uint8Array(
    encode([
      DOMAIN,
      1,
      b.accountId,
      b.workspaceId,
      b.genesis.toBytes(),
      b.device.toBytes(),
      b.installationId,
      purpose,
    ])
  );
const validKey = (key: unknown): key is CryptoKey =>
  key instanceof CryptoKey &&
  key.type === 'secret' &&
  key.extractable === false &&
  key.algorithm.name === 'AES-GCM' &&
  (key.algorithm as AesKeyAlgorithm).length === 256 &&
  key.usages.length === 2 &&
  key.usages.includes('encrypt') &&
  key.usages.includes('decrypt');
const error = (cause: unknown) =>
  cause instanceof ClientCustodyError
    ? cause
    : fail(
        (cause as { reason?: string })?.reason === 'closed'
          ? 'closed'
          : (cause as { reason?: string })?.reason === 'corrupt'
            ? 'corrupt'
            : 'indeterminate'
      );
/** Persisted non-extractable AES-GCM KEK. No creation on status/open; marker, key probe, nonce reservations and exact wrapping originals are durable. */
export const browserClientCustody = (input: BrowserClientCustodyOptions) => {
  const options = {
    ...input,
    binding: { ...input.binding },
    candidateRequest: input.candidateRequest ? { ...input.candidateRequest } : undefined,
  };
  return Layer.effectContext(
    Effect.gen(function* () {
      const store = own(yield* ClientInstallationStore),
        providedWriter = yield* ClientCustodyWriter,
        writer = own(providedWriter),
        pairing = yield* Effect.serviceOption(ClientPairingOriginalStore);
      const b = yield* Effect.try({
        try: () => {
          checkWriterScope(providedWriter, options.binding);
          return bindingRaw(options.binding);
        },
        catch: error,
      });
      if (!sameScope(b, scopeRaw(store.scope))) return yield* fail('corrupt');
      if (
        !globalThis.crypto?.subtle ||
        !globalThis.crypto.getRandomValues ||
        typeof CryptoKey === 'undefined'
      )
        return yield* fail('unavailable');
      const subtle = crypto.subtle,
        encrypt = subtle.encrypt.bind(subtle),
        decrypt = subtle.decrypt.bind(subtle),
        generate = subtle.generateKey.bind(subtle),
        random = crypto.getRandomValues.bind(crypto);
      const db = yield* openClientDatabase({
        databaseName: options.databaseName,
        mode: options.mode,
        accountId: b.accountId,
        workspaceId: b.workspaceId,
      });
      const id = bindingId(b);
      const pending = new Map<string, Uint8Array>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const value of pending.values()) value.fill(0);
          pending.clear();
        })
      );
      const gate = yield* makeAdmissionGate(() => fail('closed'));
      const marker = (v: unknown) => {
        if (v === undefined) return null;
        const r = decode('ClientKeyCustody', () => markerDecode(v));
        if (
          !sameBinding(r.binding, b) ||
          !safeInt(r.nonceCount) ||
          (r.phase === 'available' && r.nonceCount < 1) ||
          (r.phase === 'creating' && r.probe !== null) ||
          (r.phase === 'available' && !boundedBytes(r.probe, 1024, 29))
        )
          throw fail('corrupt');
        return r;
      };
      const key = (v: unknown) => {
        if (v === undefined) return null;
        const r = decode('ClientKeyCustody', () => keyDecode(v));
        if (!sameBinding(r.binding, b) || !validKey(r.key)) throw fail('corrupt');
        return r.key;
      };
      const wrapped = (v: unknown, purpose: ClientKeyPurpose, digest: string) => {
        if (v === undefined) return null;
        const r = decode('ClientKeyCustody', () => wrappedDecode(v));
        if (
          !sameBinding(r.binding, b) ||
          r.purpose !== purpose ||
          r.digest !== digest ||
          r.nonce.length !== 12 ||
          (r.blob !== null &&
            (!boundedBytes(r.blob, 16 * 1024 * 1024 + 29, 29) ||
              r.blob[0] !== 1 ||
              !bytesEqual(r.blob.subarray(1, 13), r.nonce)))
        )
          throw fail('conflict');
        return r;
      };
      const eligibility = Effect.gen(function* () {
        const current = yield* store.read();
        if (yield* store.readRetired(options.binding)) return yield* fail('identity-lost');
        if (current && sameBinding(bindingRaw(current.binding), b)) {
          if (current.phase === 'retired') return yield* fail('identity-lost');
          return current;
        }
        if (options.candidateRequest) {
          if (!current) return yield* fail('indeterminate');
          const request = options.candidateRequest;
          if (
            !sameBinding(bindingRaw(request), b) ||
            request.purpose !== 'request' ||
            Option.isNone(pairing)
          )
            return yield* fail('indeterminate');
          if (!(yield* pairing.value.load(request))) return yield* fail('indeterminate');
          return null;
        }
        if (current) return yield* fail('conflict');
        return null;
      });
      const nonceRange = () => IDBKeyRange.bound(id + '/', id + '/~');
      const protectionTables = ['markers', 'keys', 'data', 'nonces', 'snapshots'];
      // Absence is scoped to the full incarnation, including first wrappers and pending intents.
      const noProtectionRecords = (tx: Transaction, done: () => void) => {
        const prefix = JSON.stringify([id]).slice(0, -1) + ',';
        const ranges: readonly (readonly [string, IDBKeyRange])[] = [
          ['data', IDBKeyRange.bound(prefix, prefix + '\uffff')],
          ['data', IDBKeyRange.bound([id], [id, []])],
          ['nonces', nonceRange()],
          ['snapshots', IDBKeyRange.bound(['meta', id], ['meta', id, []])],
          ['snapshots', IDBKeyRange.bound(['row', id], ['row', id, []])],
        ];
        const check = (index: number): void => {
          if (index === ranges.length) {
            done();
            return;
          }
          const [table, range] = ranges[index];
          tx.request(tx.store(table).count(range), (count) => {
            if (count !== 0) throw fail('identity-lost');
            check(index + 1);
          });
        };
        check(0);
      };
      const read = () =>
        db.run<{ marker: ReturnType<typeof marker>; key: CryptoKey | null }>(
          'ClientKeyCustody',
          protectionTables,
          'readonly',
          (tx, done) =>
            tx.request(tx.store('markers').get(id), (m) =>
              tx.request(tx.store('keys').get(id), (k) => {
                const finish = () => done({ marker: marker(m), key: key(k) });
                if (m === undefined && k === undefined) noProtectionRecords(tx, finish);
                else finish();
              })
            )
        );
      const native = <A>(work: () => Promise<A>) =>
        Effect.uninterruptible(Effect.tryPromise({ try: work, catch: () => fail('corrupt') }));
      const open = (k: CryptoKey, purpose: ClientKeyPurpose, blob: Uint8Array) =>
        native(async () => {
          if (!boundedBytes(blob, 16 * 1024 * 1024 + 29, 29) || blob[0] !== 1)
            throw fail('corrupt');
          return new Uint8Array(
            await decrypt(
              {
                name: 'AES-GCM',
                iv: new Uint8Array(blob.subarray(1, 13)),
                additionalData: aad(options.binding, purpose),
                tagLength: 128,
              },
              k,
              new Uint8Array(blob.subarray(13))
            )
          );
        });
      const checkNonces = (
        tx: Transaction,
        m: NonNullable<ReturnType<typeof marker>>,
        done: () => void
      ) => {
        tx.request(tx.store('nonces').count(nonceRange()), (count) => {
          if (count !== m.nonceCount) throw fail('corrupt');
          if (m.phase !== 'available') {
            done();
            return;
          }
          const probeId = id + '/' + hex(m.probe!.subarray(1, 13));
          tx.request(tx.store('nonces').get(probeId), (v) => {
            if (!equal(v, { version: 1, binding: b })) throw fail('corrupt');
            done();
          });
        });
      };
      const reserveNonce = (
        tx: Transaction,
        m: NonNullable<ReturnType<typeof marker>>,
        nonce: Uint8Array,
        done: (m: NonNullable<ReturnType<typeof marker>>) => void
      ) => {
        if (m.nonceCount === Number.MAX_SAFE_INTEGER) throw fail('unavailable');
        checkNonces(tx, m, () => {
          const nonceId = id + '/' + hex(nonce),
            value = { version: 1, binding: b };
          tx.request(tx.store('nonces').add(value, nonceId), () =>
            tx.request(tx.store('nonces').get(nonceId), (stored) => {
              if (!equal(stored, value)) throw fail('corrupt');
              writeRow(
                tx,
                'markers',
                id,
                { ...m, nonceCount: m.nonceCount + 1 },
                (v) => marker(v)!,
                done
              );
            })
          );
        });
      };
      const available = (r: Effect.Success<ReturnType<typeof read>>) =>
        Effect.gen(function* () {
          if (!r.marker) {
            if (r.key) return yield* fail('indeterminate');
            return yield* fail('identity-lost');
          }
          if (r.marker.phase === 'deleted') return yield* fail('identity-lost');
          if (r.marker.phase === 'creating') return yield* fail('indeterminate');
          if (!r.key || !r.marker.probe) return yield* fail('identity-lost');
          yield* db.run<void>('ClientKeyCustody', ['nonces'], 'readonly', (tx, done) =>
            checkNonces(tx, r.marker!, () => done(undefined))
          );
          yield* assertClientWritable(db);
          const probe = yield* open(r.key, 'device-credential', r.marker.probe);
          try {
            if (!bytesEqual(probe, PROBE)) return yield* fail('corrupt');
          } finally {
            probe.fill(0);
          }
          return r.key;
        });
      const call = <A, E, R>(work: Effect.Effect<A, E, R>) =>
        gate.run(writer.run(work)).pipe(Effect.mapError(error));
      const completeWrap = (slot: string, prior: typeof Wrapped.Type, cipher: Uint8Array) =>
        db.run<Uint8Array>('ClientKeyCustody', ['data'], 'readwrite', (tx, done) =>
          tx.request(tx.store('data').get(slot), (v) => {
            const r = wrapped(v, prior.purpose as ClientKeyPurpose, prior.digest);
            if (!r || !equal(r, prior)) throw fail('conflict');
            const next = { ...prior, blob: cipher };
            writeRow(
              tx,
              'data',
              slot,
              next,
              (x) => wrapped(x, prior.purpose as ClientKeyPurpose, prior.digest)!,
              (value) => done(new Uint8Array(value.blob!))
            );
          })
        );
      const port = ClientKeyCustody.of({
        binding: Object.freeze({ ...options.binding }),
        status: () =>
          call(
            Effect.gen(function* () {
              const current = yield* eligibility,
                r = yield* read();
              if (!r.marker && !r.key) {
                if (current && current.phase !== 'prepared') return yield* fail('identity-lost');
                return 'missing' as const;
              }
              yield* available(r);
              return 'available' as const;
            })
          ),
        create: () =>
          call(
            Effect.gen(function* () {
              const current = yield* eligibility,
                r = yield* read();
              if (r.marker || r.key) {
                yield* available(r);
                return undefined;
              }
              if (!(current?.phase === 'prepared' || options.candidateRequest))
                return yield* fail(current ? 'identity-lost' : 'indeterminate');
              const intent = {
                version: 1 as const,
                binding: b,
                phase: 'creating' as const,
                nonceCount: 0,
                probe: null,
              };
              yield* db.run<void>('ClientKeyCustody', protectionTables, 'readwrite', (tx, done) =>
                tx.request(tx.store('markers').get(id), (m) =>
                  tx.request(tx.store('keys').get(id), (k) => {
                    if (m !== undefined || k !== undefined) throw fail('conflict');
                    noProtectionRecords(tx, () =>
                      writeRow(
                        tx,
                        'markers',
                        id,
                        intent,
                        (x) => marker(x)!,
                        () => done(undefined)
                      )
                    );
                  })
                )
              );
              const k = yield* native(() =>
                generate({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
              );
              if (!validKey(k)) return yield* fail('corrupt');
              const nonce = random(new Uint8Array(12));
              const reserved = yield* db.run<NonNullable<ReturnType<typeof marker>>>(
                'ClientKeyCustody',
                ['markers', 'nonces'],
                'readwrite',
                (tx, done) =>
                  tx.request(tx.store('markers').get(id), (v) => {
                    const m = marker(v);
                    if (!equal(m, intent)) throw fail('conflict');
                    reserveNonce(tx, m!, nonce, done);
                  })
              );
              const cipher = yield* native(
                async () =>
                  new Uint8Array(
                    await encrypt(
                      {
                        name: 'AES-GCM',
                        iv: nonce,
                        additionalData: aad(options.binding, 'device-credential'),
                        tagLength: 128,
                      },
                      k,
                      PROBE
                    )
                  )
              );
              const probe = new Uint8Array([1, ...nonce, ...cipher]);
              yield* db.run<void>(
                'ClientKeyCustody',
                ['markers', 'keys'],
                'readwrite',
                (tx, done) =>
                  tx.request(tx.store('markers').get(id), (m) => {
                    if (!equal(marker(m), reserved)) throw fail('conflict');
                    tx.request(tx.store('keys').add({ version: 1, binding: b, key: k }, id), () =>
                      tx.request(tx.store('keys').get(id), (stored) => {
                        if (!key(stored)) throw fail('corrupt');
                        writeRow(
                          tx,
                          'markers',
                          id,
                          { ...reserved, phase: 'available' as const, probe },
                          (x) => marker(x)!,
                          () => done(undefined)
                        );
                      })
                    );
                  })
              );
              yield* available(yield* read());
              return undefined;
            })
          ),
        wrap: (purpose, source) =>
          call(
            Effect.acquireUseRelease(
              Effect.try({
                try: () => {
                  if (
                    !CLIENT_KEY_PURPOSES.includes(purpose) ||
                    !boundedBytes(source, 16 * 1024 * 1024, 0)
                  )
                    throw fail('corrupt');
                  return new Uint8Array(source);
                },
                catch: error,
              }),
              (body) =>
                Effect.gen(function* () {
                  yield* eligibility;
                  const digest = hex(sha256(body)),
                    identity = CLIENT_KEY_PURPOSES.slice(0, 3).includes(
                      purpose as (typeof CLIENT_KEY_PURPOSES)[0]
                    );
                  const slot = JSON.stringify([
                    id,
                    'wrap',
                    purpose,
                    identity ? 'identity' : digest,
                  ]);
                  const firstRead = yield* db.run(
                    'ClientKeyCustody',
                    ['data'],
                    'readonly',
                    (tx, done) =>
                      tx.request(tx.store('data').get(slot), (v) =>
                        done(wrapped(v, purpose, digest))
                      )
                  );
                  yield* available(yield* read());
                  const nonce = firstRead === null ? random(new Uint8Array(12)) : undefined;
                  const nonceId = nonce ? id + '/' + hex(nonce) : undefined;
                  // After intent commit, finish native settlement and ciphertext retention even on interruption.
                  return yield* Effect.uninterruptible(
                    Effect.gen(function* () {
                      const state = yield* db.run<{
                        row: typeof Wrapped.Type;
                        fresh: boolean;
                        key: CryptoKey;
                      }>(
                        'ClientKeyCustody',
                        ['data', 'nonces', 'keys', 'markers'],
                        'readwrite',
                        (tx, done) =>
                          tx.request(tx.store('markers').get(id), (m) =>
                            tx.request(tx.store('keys').get(id), (kv) => {
                              const mr = marker(m),
                                k = key(kv);
                              if (!mr || mr.phase !== 'available' || !k)
                                throw fail(
                                  mr?.phase === 'creating' ? 'indeterminate' : 'identity-lost'
                                );
                              tx.request(tx.store('data').get(slot), (v) => {
                                const prior = wrapped(v, purpose, digest);
                                if (prior) {
                                  done({ row: prior, fresh: false, key: k });
                                  return;
                                }
                                if (!nonce || !nonceId) throw fail('indeterminate');
                                const row = {
                                  version: 1 as const,
                                  binding: b,
                                  purpose,
                                  digest,
                                  nonce,
                                  blob: null,
                                };
                                reserveNonce(tx, mr, nonce, () =>
                                  writeRow(
                                    tx,
                                    'data',
                                    slot,
                                    row,
                                    (x) => wrapped(x, purpose, digest)!,
                                    (r) => done({ row: r, fresh: true, key: k })
                                  )
                                );
                              });
                            })
                          )
                      );
                      if (state.row.blob) return new Uint8Array(state.row.blob);
                      let cipher = pending.get(slot);
                      if (!cipher) {
                        // Only this operation's freshly reserved nonce may start encryption. A reopened incomplete intent is unknown.
                        if (!state.fresh) return yield* fail('indeterminate');
                        const out = yield* native(
                          async () =>
                            new Uint8Array(
                              await encrypt(
                                {
                                  name: 'AES-GCM',
                                  iv: new Uint8Array(state.row.nonce),
                                  additionalData: aad(options.binding, purpose),
                                  tagLength: 128,
                                },
                                state.key,
                                body
                              )
                            )
                        );
                        cipher = new Uint8Array([1, ...state.row.nonce, ...out]);
                        pending.set(slot, cipher);
                      }
                      const saved = yield* completeWrap(slot, state.row, cipher);
                      pending.delete(slot);
                      return saved;
                    })
                  );
                }),
              (body) => Effect.sync(() => body.fill(0))
            )
          ),
        unwrap: (purpose, inputBlob) =>
          call(
            Effect.gen(function* () {
              if (
                !CLIENT_KEY_PURPOSES.includes(purpose) ||
                !boundedBytes(inputBlob, 16 * 1024 * 1024 + 29, 29)
              )
                return yield* fail('corrupt');
              const blob = new Uint8Array(inputBlob);
              yield* eligibility;
              const k = yield* available(yield* read());
              return yield* open(k, purpose, blob);
            })
          ),
        delete: () =>
          call(
            Effect.gen(function* () {
              // Authorization is the host's explicit scoped hard reset/terminal-removal decision, not a row phase.
              yield* db.run<void>(
                'ClientKeyCustody',
                ['keys', 'markers'],
                'readwrite',
                (tx, done) =>
                  tx.request(tx.store('markers').get(id), (v) => {
                    const m = marker(v);
                    if (!m) {
                      tx.request(tx.store('keys').get(id), (k) => {
                        if (k !== undefined) throw fail('indeterminate');
                        done(undefined);
                      });
                      return;
                    }
                    tx.request(tx.store('keys').get(id), (retained) => {
                      if (retained !== undefined) key(retained);
                      tx.request(tx.store('keys').delete(id), () =>
                        tx.request(tx.store('keys').get(id), (k) => {
                          if (k !== undefined) throw fail('corrupt');
                          writeRow(
                            tx,
                            'markers',
                            id,
                            { ...m, phase: 'deleted' as const },
                            (x) => marker(x)!,
                            () => done(undefined)
                          );
                        })
                      );
                    });
                  })
              );
            })
          ),
      });
      const originals = ClientIdentityOriginals.of({
        binding: { ...options.binding },
        read: () =>
          call(
            db.run('ClientIdentityOriginals', ['data'], 'readonly', (tx, done) => {
              const rows: import('../../services/client-custody').ClientWrappedKey[] = [];
              const readOriginal = (index: number): void => {
                if (index === 3) {
                  done(rows);
                  return;
                }
                const purpose = CLIENT_KEY_PURPOSES[
                  index
                ] as import('../../services/client-custody').ClientWrappedKey['purpose'];
                const slot = JSON.stringify([id, 'wrap', purpose, 'identity']);
                tx.request(tx.store('data').get(slot), (v) => {
                  if (v !== undefined) {
                    const decoded = decode('ClientIdentityOriginals', () => wrappedDecode(v));
                    if (!/^[0-9a-f]{64}$/.test(decoded.digest)) throw fail('corrupt');
                    const r = wrapped(v, purpose, decoded.digest)!;
                    if (!r.blob) throw fail('indeterminate');
                    rows.push({ purpose, blob: new Uint8Array(r.blob) });
                  }
                  readOriginal(index + 1);
                });
              };
              readOriginal(0);
            })
          ),
      });
      return Context.make(ClientKeyCustody, port).pipe(
        Context.add(ClientIdentityOriginals, originals)
      );
    })
  );
};
/** Deliberately share the bound KEK with distinct installed/candidate AAD purposes; neither protector grants ledger admission. */
export const clientKeyProtectors = Layer.effectContext(
  Effect.gen(function* () {
    const custody = own(yield* ClientKeyCustody);
    const port = (purpose: ClientKeyPurpose) => ({
      protect: (body: Uint8Array) =>
        custody
          .wrap(purpose, body)
          .pipe(Effect.mapError((cause) => new KeyProtectorError({ cause }))),
      unprotect: (blob: Uint8Array) =>
        custody
          .unwrap(purpose, blob)
          .pipe(Effect.mapError((cause) => new KeyProtectorError({ cause }))),
    });
    return Context.make(KeyProtector, KeyProtector.of(port('installed-epoch-key'))).pipe(
      Context.add(CandidateProtector, CandidateProtector.of(port('rotation-candidate')))
    );
  })
);
