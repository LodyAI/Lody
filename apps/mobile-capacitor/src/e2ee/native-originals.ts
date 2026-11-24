import { Effect, Schema } from 'effect';
import { CLIENT_KEY_PURPOSES, ClientCustodyError } from '@lody/e2ee-core/services';
const fail = (reason: ClientCustodyError['reason']) => new ClientCustodyError({ reason });
const Marker = Schema.Struct({
  version: Schema.Literal(1),
  binding: Schema.String,
  phase: Schema.Literals(['installing', 'available', 'deleting', 'deleted']),
});
const Wrapped = Schema.Struct({
  version: Schema.Literal(1),
  binding: Schema.String,
  purpose: Schema.String,
  digest: Schema.String,
  blob: Schema.NullOr(Schema.Uint8Array),
});
export type NativeMarker = Schema.Schema.Type<typeof Marker>;
export type NativeWrapped = Schema.Schema.Type<typeof Wrapped>;
const markerDecode = Schema.decodeUnknownSync(Marker, { onExcessProperty: 'error' }),
  wrappedDecode = Schema.decodeUnknownSync(Wrapped, { onExcessProperty: 'error' });
const bindingDecode = Schema.decodeUnknownSync(
  Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.String, Schema.String])
);
const keyDecode = Schema.decodeUnknownSync(
  Schema.Tuple([Schema.String, Schema.String, Schema.String])
);
const checkBinding = (value: string) => {
  const fields = bindingDecode(JSON.parse(value));
  if (
    JSON.stringify(fields) !== value ||
    fields
      .slice(0, 2)
      .some(
        (part) => !part || part.includes('\0') || new TextEncoder().encode(part).length > 256
      ) ||
    !fields.slice(2).every((part) => /^[0-9a-f]{64}$/.test(part))
  )
    throw fail('corrupt');
};
const parseKey = (value: string) => {
  try {
    const decoded = keyDecode(JSON.parse(value));
    checkBinding(decoded[0]);
    return decoded;
  } catch {
    throw fail('corrupt');
  }
};
const checkMarker = (raw: unknown, binding: string): NativeMarker | null => {
  if (raw === undefined) return null;
  try {
    const m = markerDecode(raw);
    if (m.binding !== binding) throw fail('corrupt');
    return m;
  } catch {
    throw fail('corrupt');
  }
};
const checkWrapped = (raw: unknown, binding: string, purpose: string): NativeWrapped | null => {
  if (raw === undefined) return null;
  try {
    const r = wrappedDecode(raw);
    if (
      r.binding !== binding ||
      r.purpose !== purpose ||
      !(CLIENT_KEY_PURPOSES as readonly string[]).includes(purpose) ||
      !/^[0-9a-f]{64}$/.test(r.digest) ||
      (r.blob !== null && (r.blob.length < 29 || r.blob.length > 4125 || r.blob[0] !== 1))
    )
      throw fail('corrupt');
    return { ...r, blob: r.blob === null ? null : new Uint8Array(r.blob) };
  } catch {
    throw fail('corrupt');
  }
};
const sameMarker = (a: NativeMarker | null, b: NativeMarker | null) =>
  JSON.stringify(a) === JSON.stringify(b);
/** Small native-wrapper journal; it never stores plaintext, native keys or approval. */
export const nativeOriginals = (databaseName: string, binding: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          if (!globalThis.indexedDB) {
            reject(fail('unavailable'));
            return;
          }
          let ended = false;
          const request = indexedDB.open(databaseName, 1);
          request.onupgradeneeded = (event) => {
            if (event.oldVersion !== 0) {
              request.transaction?.abort();
              return;
            }
            request.result.createObjectStore('markers');
            request.result.createObjectStore('wraps');
          };
          request.onerror = request.onblocked = () => {
            ended = true;
            reject(fail('unavailable'));
          };
          request.onsuccess = () => {
            const db = request.result;
            if (ended) {
              db.close();
              return;
            }
            if (
              db.objectStoreNames.length !== 2 ||
              !db.objectStoreNames.contains('markers') ||
              !db.objectStoreNames.contains('wraps')
            ) {
              ended = true;
              db.close();
              reject(fail('corrupt'));
              return;
            }
            ended = true;
            resolve(db);
          };
        }),
      catch: (reason) => (reason instanceof ClientCustodyError ? reason : fail('unavailable')),
    }),
    (db) => Effect.sync(() => db.close())
  ).pipe(
    Effect.map((db) => {
      const transaction = <A>(
        stores: string[],
        mode: IDBTransactionMode,
        body: (
          tx: IDBTransaction,
          request: <V>(r: IDBRequest<V>, next: (v: V) => void) => void,
          done: (v: A) => void
        ) => void
      ) =>
        Effect.tryPromise({
          try: () =>
            new Promise<A>((resolve, reject) => {
              const tx = db.transaction(stores, mode);
              let value: A,
                complete = false,
                error: unknown;
              const stop = (cause: unknown) => {
                error = cause;
                try {
                  tx.abort();
                } catch {
                  reject(cause);
                }
              };
              const request = <V>(r: IDBRequest<V>, next: (v: V) => void) => {
                r.onsuccess = () => {
                  try {
                    next(r.result);
                  } catch (cause) {
                    stop(cause);
                  }
                };
              };
              tx.oncomplete = () => (complete ? resolve(value) : reject(fail('corrupt')));
              tx.onabort = () => reject(error ?? fail('unavailable'));
              try {
                body(tx, request, (v) => {
                  value = v;
                  complete = true;
                });
              } catch (cause) {
                stop(cause);
              }
            }),
          catch: (cause) => (cause instanceof ClientCustodyError ? cause : fail('unavailable')),
        });
      const key = (purpose: string, digest: string, owner = binding) =>
        JSON.stringify([
          owner,
          purpose,
          ['signing-private-key', 'encryption-private-key', 'device-credential'].includes(purpose)
            ? 'identity'
            : digest,
        ]);
      // Validate keys as well as values: a malformed key must not hide a retained
      // original. Valid other installations remain untouched and independent.
      const scanWraps = (
        tx: IDBTransaction,
        request: <V>(r: IDBRequest<V>, next: (v: V) => void) => void,
        done: (present: boolean) => void
      ) => {
        let present = false;
        request(tx.objectStore('wraps').openCursor(), (cursor) => {
          if (!cursor) {
            done(present);
            return;
          }
          if (typeof cursor.key !== 'string') throw fail('corrupt');
          const [owner, purpose] = parseKey(cursor.key);
          const row = checkWrapped(cursor.value, owner, purpose);
          if (!row || cursor.key !== key(purpose, row.digest, owner)) throw fail('corrupt');
          if (owner === binding) present = true;
          cursor.continue();
        });
      };
      return {
        marker: () =>
          transaction<NativeMarker | null>(['markers'], 'readonly', (tx, request, done) =>
            request(tx.objectStore('markers').get(binding), (v) => done(checkMarker(v, binding)))
          ),
        hasProtectionRecords: () => transaction<boolean>(['wraps'], 'readonly', scanWraps),
        prepareInstallation: (expected: NativeMarker | null) =>
          transaction<NativeMarker>(['markers', 'wraps'], 'readwrite', (tx, request, done) => {
            const store = tx.objectStore('markers');
            request(store.get(binding), (raw) => {
              const current = checkMarker(raw, binding);
              if (!sameMarker(current, expected)) throw fail('conflict');
              if (current && current.phase !== 'installing') throw fail('indeterminate');
              scanWraps(tx, request, (present) => {
                if (present) throw fail('indeterminate');
                if (current) {
                  done(current);
                  return;
                }
                const next = { version: 1 as const, binding, phase: 'installing' as const };
                request(store.add(next, binding), () =>
                  request(store.get(binding), (stored) => {
                    const saved = checkMarker(stored, binding);
                    if (!sameMarker(saved, next)) throw fail('corrupt');
                    done(saved!);
                  })
                );
              });
            });
          }),
        setMarker: (expected: NativeMarker | null, phase: NativeMarker['phase']) =>
          transaction<NativeMarker>(['markers'], 'readwrite', (tx, request, done) => {
            const store = tx.objectStore('markers'),
              next = { version: 1 as const, binding, phase };
            request(store.get(binding), (raw) => {
              if (!sameMarker(checkMarker(raw, binding), expected)) throw fail('conflict');
              request(store.put(next, binding), () =>
                request(store.get(binding), (v) =>
                  (() => {
                    const saved = checkMarker(v, binding);
                    if (!sameMarker(saved, next)) throw fail('corrupt');
                    done(saved!);
                  })()
                )
              );
            });
          }),
        wrap: (purpose: string, digest: string) =>
          transaction<NativeWrapped | null>(['wraps'], 'readonly', (tx, request, done) =>
            request(tx.objectStore('wraps').get(key(purpose, digest)), (v) =>
              done(checkWrapped(v, binding, purpose))
            )
          ),
        begin: (purpose: string, digest: string) =>
          transaction<NativeWrapped>(['markers', 'wraps'], 'readwrite', (tx, request, done) => {
            request(tx.objectStore('markers').get(binding), (m) => {
              if (checkMarker(m, binding)?.phase !== 'available') throw fail('indeterminate');
              const store = tx.objectStore('wraps');
              request(store.get(key(purpose, digest)), (v) => {
                const prior = checkWrapped(v, binding, purpose);
                if (prior) {
                  if (prior.digest !== digest) throw fail('conflict');
                  done(prior);
                  return;
                }
                const pending = { version: 1 as const, binding, purpose, digest, blob: null };
                request(store.add(pending, key(purpose, digest)), () =>
                  request(store.get(key(purpose, digest)), (x) =>
                    done(checkWrapped(x, binding, purpose)!)
                  )
                );
              });
            });
          }),
        complete: (pending: NativeWrapped, blob: Uint8Array) =>
          transaction<Uint8Array>(['wraps'], 'readwrite', (tx, request, done) => {
            const store = tx.objectStore('wraps'),
              id = key(pending.purpose, pending.digest);
            request(store.get(id), (raw) => {
              const prior = checkWrapped(raw, binding, pending.purpose);
              if (!prior || prior.digest !== pending.digest) throw fail('conflict');
              if (prior.blob) {
                if (prior.blob.length !== blob.length || !prior.blob.every((v, i) => v === blob[i]))
                  throw fail('conflict');
                done(prior.blob);
                return;
              }
              const next = checkWrapped({ ...prior, blob }, binding, pending.purpose)!;
              request(store.put(next, id), () =>
                request(store.get(id), (v) =>
                  (() => {
                    const saved = checkWrapped(v, binding, pending.purpose);
                    if (
                      !saved ||
                      saved.digest !== pending.digest ||
                      !saved.blob ||
                      saved.blob.length !== blob.length ||
                      !saved.blob.every((b, i) => b === blob[i])
                    )
                      throw fail('corrupt');
                    done(saved.blob);
                  })()
                )
              );
            });
          }),
        identity: (purpose: string) =>
          transaction<NativeWrapped | null>(['wraps'], 'readonly', (tx, request, done) =>
            request(tx.objectStore('wraps').get(key(purpose, '')), (v) =>
              done(checkWrapped(v, binding, purpose))
            )
          ),
      };
    })
  );
