import { Effect, Result } from 'effect';
import {
  PersonalHostError,
  verifyPersonalOffer,
  type PersonalPairingOffer,
} from '@lody/e2ee-client';

type Pin = {
  version: 1;
  accountId: string;
  offer: PersonalPairingOffer;
  phase: 'pending' | 'ready' | 'cancelled';
  /** A team-member join's identity offer; absent for a personal device pairing. */
  kind?: 'member';
};
export const samePersonalOffer = (a: PersonalPairingOffer, b: PersonalPairingOffer) =>
  (
    [
      'version',
      'workspaceId',
      'genesisHash',
      'genesisRecordHex',
      'endorser',
      'membershipId',
      'pairingSessionId',
    ] as const
  ).every((field) => a[field] === b[field]);
/** One compatibility predicate for read admission and the transaction's CAS recheck. */
export function assertPersonalEntryOffer(old: Pin | null, offer: PersonalPairingOffer): void {
  if (
    old &&
    (old.offer.genesisHash !== offer.genesisHash ||
      old.offer.genesisRecordHex !== offer.genesisRecordHex ||
      ((old.phase === 'pending' || old.phase === 'ready') && !samePersonalOffer(old.offer, offer)))
  )
    throw new PersonalHostError({ code: 'conflict' });
}
const failure = () => new PersonalHostError({ code: 'storage' });
const parse = (raw: unknown, accountId: string, workspaceId: string): Pin | null => {
  if (raw === undefined) return null;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('version' in raw) ||
    raw.version !== 1 ||
    !('accountId' in raw) ||
    raw.accountId !== accountId ||
    !('offer' in raw) ||
    !('phase' in raw) ||
    !['pending', 'ready', 'cancelled'].includes(String(raw.phase)) ||
    ('kind' in raw && raw.kind !== 'member')
  )
    throw failure();
  const candidate = raw.offer as PersonalPairingOffer;
  const valid = verifyPersonalOffer(candidate);
  if (Result.isFailure(valid) || candidate.workspaceId !== workspaceId) throw failure();
  return {
    version: 1,
    accountId,
    offer: { ...candidate },
    phase: raw.phase as Pin['phase'],
    ...('kind' in raw ? { kind: 'member' as const } : {}),
  };
};
/** Public desktop pins only; neither this routing index nor its phase grants approval. */
export function personalEntryPins(databaseName: string) {
  const database = Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          let finished = false;
          const request = indexedDB.open(databaseName, 1);
          request.onupgradeneeded = (event) => {
            if (event.oldVersion !== 0) {
              request.transaction?.abort();
              return;
            }
            request.result.createObjectStore('pins');
          };
          request.onerror = request.onblocked = () => {
            finished = true;
            reject(failure());
          };
          request.onsuccess = () => {
            const value = request.result;
            if (finished) {
              value.close();
              return;
            }
            finished = true;
            if (value.objectStoreNames.length !== 1 || !value.objectStoreNames.contains('pins')) {
              value.close();
              reject(failure());
              return;
            }
            resolve(value);
          };
        }),
      catch: failure,
    }),
    (opened) => Effect.sync(() => opened.close())
  );
  const transact = <A>(
    accountId: string,
    workspaceId: string,
    write: boolean,
    work: (old: Pin | null) => { result: A; next?: Pin }
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* database;
        return yield* Effect.tryPromise({
          try: () =>
            new Promise<A>((resolve, reject) => {
              const tx = db.transaction('pins', write ? 'readwrite' : 'readonly'),
                store = tx.objectStore('pins'),
                key = JSON.stringify([accountId, workspaceId]);
              let result: A,
                complete = false,
                error: unknown;
              const abort = (cause: unknown) => {
                error = cause;
                tx.abort();
              };
              tx.onabort = () => reject(error ?? failure());
              tx.oncomplete = () => (complete ? resolve(result) : reject(failure()));
              const read = store.get(key);
              read.onsuccess = () => {
                try {
                  const next = work(parse(read.result, accountId, workspaceId));
                  result = next.result;
                  if (!next.next) {
                    complete = true;
                    return;
                  }
                  const put = store.put(next.next, key);
                  put.onsuccess = () => {
                    const back = store.get(key);
                    back.onsuccess = () => {
                      try {
                        const saved = parse(back.result, accountId, workspaceId);
                        if (JSON.stringify(saved) !== JSON.stringify(next.next)) throw failure();
                        complete = true;
                      } catch (cause) {
                        abort(cause);
                      }
                    };
                  };
                } catch (cause) {
                  abort(cause);
                }
              };
            }),
          catch: (cause) => (cause instanceof PersonalHostError ? cause : failure()),
        });
      })
    );
  return {
    read: (accountId: string, workspaceId: string) =>
      transact(accountId, workspaceId, false, (old) => ({ result: old })),
    /**
     * Every `ready` pin of this account, for an approving device that has not opened
     * all of its workspaces in this process. A malformed pin is skipped here; reading
     * that workspace still refuses it.
     */
    listReady: (accountId: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* database;
          return yield* Effect.tryPromise({
            try: () =>
              new Promise<Pin[]>((resolve, reject) => {
                const tx = db.transaction('pins', 'readonly'),
                  store = tx.objectStore('pins'),
                  ready: Pin[] = [];
                const cursor = store.openCursor();
                cursor.onsuccess = () => {
                  const row = cursor.result;
                  if (!row) return;
                  let key: unknown;
                  try {
                    key = JSON.parse(String(row.key));
                  } catch {
                    key = null;
                  }
                  if (
                    Array.isArray(key) &&
                    key.length === 2 &&
                    key[0] === accountId &&
                    typeof key[1] === 'string'
                  ) {
                    try {
                      const pin = parse(row.value, accountId, key[1]);
                      if (pin?.phase === 'ready') ready.push(pin);
                    } catch {
                      /* Skipped; `read` keeps refusing it. */
                    }
                  }
                  row.continue();
                };
                tx.oncomplete = () => resolve(ready);
                tx.onabort = tx.onerror = () => reject(failure());
              }),
            catch: failure,
          });
        })
      ),
    prepare: (accountId: string, offer: PersonalPairingOffer, kind?: 'member') =>
      transact(accountId, offer.workspaceId, true, (old) => {
        if (Result.isFailure(verifyPersonalOffer(offer)))
          throw new PersonalHostError({ code: 'invalid-input' });
        assertPersonalEntryOffer(old, offer);
        // The same identity offer is never both a pairing and a member join.
        if (old && (old.phase === 'pending' || old.phase === 'ready') && old.kind !== kind)
          throw new PersonalHostError({ code: 'conflict' });
        if (old?.phase === 'ready') return { result: undefined };
        const next: Pin = {
          version: 1,
          accountId,
          offer: { ...offer },
          phase: 'pending',
          ...(kind ? { kind } : {}),
        };
        return { result: undefined, next };
      }),
    finish: (accountId: string, offer: PersonalPairingOffer, phase: 'ready' | 'cancelled') =>
      transact(accountId, offer.workspaceId, true, (old) => {
        if (!old || !samePersonalOffer(old.offer, offer))
          throw new PersonalHostError({ code: 'conflict' });
        return { result: undefined, next: { ...old, phase } };
      }),
    /**
     * Confirmed access loss: stop routing exactly this ready offer, keeping the offer and so
     * its genesis. One transaction, unlike read-then-`finish`: a pin another tab has moved on
     * (pending again, or another offer) is never overwritten.
     */
    retire: (accountId: string, offer: PersonalPairingOffer) =>
      transact(accountId, offer.workspaceId, true, (old) =>
        old?.phase === 'ready' && samePersonalOffer(old.offer, offer)
          ? { result: undefined, next: { ...old, phase: 'cancelled' as const } }
          : { result: undefined }
      ),
  };
}
export type PersonalEntryPins = ReturnType<typeof personalEntryPins>;
