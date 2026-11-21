import { Effect } from 'effect';
import { LocalStoreError, type RecoveryVaultLocalStore } from '@lody/e2ee-core/services';

const fail = (reason: LocalStoreError['reason'] = 'storage') =>
  new LocalStoreError({ store: 'RecoveryVaultLocalStore', reason });
const validKey = (key: string) => key.length > 0 && key.length <= 4096;
const own = (value: unknown): Uint8Array | null => {
  if (value === undefined) return null;
  if (!(value instanceof Uint8Array) || value.length < 1 || value.length > 256 * 1024)
    throw fail('corrupt');
  return value.slice();
};
const same = (a: Uint8Array | null, b: Uint8Array | null) =>
  a === null ? b === null : b !== null && a.length === b.length && a.every((v, i) => b[i] === v);

/** Account-scoped non-secret pins/intents. Never create an empty replacement for a corrupt journal. */
export const clientRecoveryJournal = (
  accountId: string,
  check: () => void,
  platform: 'mobile' | 'web'
) =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          new Promise<IDBDatabase>((resolve, reject) => {
            check();
            if (!accountId || accountId.length > 256) {
              reject(fail());
              return;
            }
            let rejected = false;
            const request = indexedDB.open(
              `lody-e2ee:${platform}:recovery:v1:${JSON.stringify(accountId)}`,
              1
            );
            request.onupgradeneeded = (event) => {
              if (event.oldVersion !== 0) {
                request.transaction?.abort();
                return;
              }
              request.result.createObjectStore('journal');
            };
            request.onerror = () => {
              rejected = true;
              reject(fail());
            };
            request.onblocked = () => {
              rejected = true;
              reject(fail('storage'));
            };
            request.onsuccess = () => {
              const db = request.result;
              if (rejected) {
                db.close();
                return;
              }
              try {
                check();
                if (!db.objectStoreNames.contains('journal')) throw fail('corrupt');
                db.onversionchange = () => db.close();
                resolve(db);
              } catch (error) {
                db.close();
                reject(error);
              }
            };
          }),
        catch: (error) => error,
      }),
      (db) => Effect.sync(() => db.close())
    );
    function transaction<A>(
      mode: IDBTransactionMode,
      work: (
        store: IDBObjectStore,
        done: (value: A) => void,
        reject: (error: unknown) => void
      ) => void
    ) {
      return Effect.tryPromise({
        try: () =>
          new Promise<A>((resolve, reject) => {
            check();
            const tx = db.transaction('journal', mode, { durability: 'strict' });
            let result: A,
              hasResult = false,
              failure: unknown;
            const abort = (error: unknown) => {
              failure = error;
              tx.abort();
            };
            tx.onerror = () => {
              failure ??= fail();
            };
            tx.onabort = () => reject(failure ?? fail());
            tx.oncomplete = () => {
              try {
                check();
                if (!hasResult) throw fail();
                resolve(result);
              } catch (error) {
                reject(error);
              }
            };
            try {
              if (tx.durability !== 'strict') throw fail();
              work(
                tx.objectStore('journal'),
                (value) => {
                  result = value;
                  hasResult = true;
                },
                abort
              );
            } catch (error) {
              abort(error);
            }
          }),
        catch: (error) => error,
      }).pipe(Effect.uninterruptible);
    }
    return {
      read: (key) =>
        transaction('readonly', (store, done, abort) => {
          if (!validKey(key)) throw fail();
          const request = store.get(key);
          request.onsuccess = () => {
            try {
              done(own(request.result));
            } catch (error) {
              abort(error);
            }
          };
        }),
      compareAndSwap: (key, expected, next) =>
        transaction<'Committed' | 'Conflict'>('readwrite', (store, done, abort) => {
          if (
            !validKey(key) ||
            !(next instanceof Uint8Array) ||
            next.length < 1 ||
            next.length > 256 * 1024
          )
            throw fail();
          const desired = next.slice(),
            compare = expected?.slice() ?? null;
          const request = store.get(key);
          request.onsuccess = () => {
            try {
              if (!same(own(request.result), compare)) {
                done('Conflict');
                return;
              }
              check();
              const put = store.put(desired, key);
              put.onsuccess = () => {
                const readback = store.get(key);
                readback.onsuccess = () => {
                  try {
                    if (!same(own(readback.result), desired)) throw fail();
                    done('Committed');
                  } catch (error) {
                    abort(error);
                  }
                };
              };
            } catch (error) {
              abort(error);
            }
          };
        }),
      list: (prefix) =>
        transaction('readonly', (store, done, abort) => {
          if (!validKey(prefix)) throw fail();
          const rows: { key: string; value: Uint8Array }[] = [];
          const request = store.openCursor(IDBKeyRange.lowerBound(prefix));
          request.onsuccess = () => {
            try {
              const cursor = request.result;
              if (!cursor || typeof cursor.key !== 'string' || !cursor.key.startsWith(prefix)) {
                done(rows);
                return;
              }
              if (!validKey(cursor.key) || rows.length >= 4096) throw fail('capacity');
              const value = own(cursor.value);
              if (!value) throw fail('corrupt');
              rows.push({ key: cursor.key, value });
              cursor.continue();
            } catch (error) {
              abort(error);
            }
          };
        }),
    } satisfies RecoveryVaultLocalStore['Service'];
  });
