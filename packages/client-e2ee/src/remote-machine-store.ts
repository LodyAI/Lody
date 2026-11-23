import { Effect } from 'effect';
import {
  remoteMachineJournalSchema,
  type RemoteMachineJournal,
  type RemoteMachineStore,
} from '@lody/e2ee-client/remote-machine';

const fail = () => new Error('e2ee_remote_pairing_storage');
/** One installation's command/approval originals. CAS and archive share one transaction;
 * success means commit, including when the observing fiber was interrupted. */
export function remoteMachineStore(databaseName: string): RemoteMachineStore {
  const database = Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          let abandoned = false;
          const request = indexedDB.open(databaseName, 1);
          request.onupgradeneeded = () => request.result.createObjectStore('originals');
          request.onerror = request.onblocked = () => {
            abandoned = true;
            reject(fail());
          };
          request.onsuccess = () => {
            const db = request.result;
            if (
              abandoned ||
              db.objectStoreNames.length !== 1 ||
              !db.objectStoreNames.contains('originals')
            ) {
              db.close();
              reject(fail());
            } else resolve(db);
          };
        }),
      catch: fail,
    }),
    (db) => Effect.sync(() => db.close())
  );
  const transaction = (change?: {
    previous: RemoteMachineJournal | null;
    next: RemoteMachineJournal;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* database;
        return yield* Effect.uninterruptible(
          Effect.tryPromise({
            try: () =>
              new Promise<RemoteMachineJournal | null>((resolve, reject) => {
                const tx = db.transaction('originals', change ? 'readwrite' : 'readonly');
                const store = tx.objectStore('originals');
                let result: RemoteMachineJournal | null = null;
                let error: unknown;
                tx.onabort = () => reject(error ?? fail());
                tx.oncomplete = () => resolve(result);
                const get = store.get('current');
                get.onsuccess = () => {
                  try {
                    result =
                      get.result === undefined
                        ? null
                        : remoteMachineJournalSchema.parse(get.result);
                    if (!change) return;
                    if (JSON.stringify(result) !== JSON.stringify(change.previous)) throw fail();
                    const next = remoteMachineJournalSchema.parse(change.next);
                    if (result && result.offer.pairingSessionId !== next.offer.pairingSessionId) {
                      if (!result.retired) throw fail();
                      store.add(result, result.offer.pairingSessionId);
                    }
                    store.put(next, 'current');
                    const back = store.get('current');
                    back.onsuccess = () => {
                      try {
                        if (
                          JSON.stringify(remoteMachineJournalSchema.parse(back.result)) !==
                          JSON.stringify(next)
                        )
                          throw fail();
                        result = next;
                      } catch (cause) {
                        error = cause;
                        tx.abort();
                      }
                    };
                  } catch (cause) {
                    error = cause;
                    tx.abort();
                  }
                };
              }),
            catch: fail,
          })
        );
      })
    );
  return {
    read: () => transaction(),
    save: (previous, next) => {
      const captured = {
        previous: previous && remoteMachineJournalSchema.parse(previous),
        next: remoteMachineJournalSchema.parse(next),
      };
      return transaction(captured).pipe(Effect.asVoid);
    },
  };
}
