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
interface CachedIdbHandle {
  readonly withDatabase: <A>(
    work: (db: IDBDatabase) => Promise<A>
  ) => Effect.Effect<A, PersonalHostError>;
  readonly close: () => void;
}
function makeCachedIdbHandle(databaseName: string): CachedIdbHandle {
  let cachedDb: IDBDatabase | null = null;
  let opening: Promise<IDBDatabase> | null = null;
  let cachedFactory: IDBFactory | null = null;
  let epoch = 0;

  const close = () => {
    epoch++;
    opening = null;
    const db = cachedDb;
    cachedDb = null;
    if (db) {
      try {
        db.close();
      } catch {}
    }
  };

  const openDatabase = (): Promise<IDBDatabase> => {
    const factory = indexedDB;
    if (cachedFactory !== factory) {
      close();
      cachedFactory = factory;
    }
    if (cachedDb) return Promise.resolve(cachedDb);
    if (opening) return opening;
    const startEpoch = epoch;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      let finished = false;
      const request = factory.open(databaseName, 1);
      request.onupgradeneeded = (event) => {
        if (event.oldVersion !== 0) {
          request.transaction?.abort();
          return;
        }
        request.result.createObjectStore('pins');
      };
      request.onerror = request.onblocked = () => {
        finished = true;
        if (opening === pending) opening = null;
        reject(failure());
      };
      request.onsuccess = () => {
        const value = request.result;
        if (opening === pending) opening = null;
        if (finished) {
          value.close();
          return;
        }
        finished = true;
        if (
          epoch !== startEpoch ||
          cachedFactory !== factory ||
          value.objectStoreNames.length !== 1 ||
          !value.objectStoreNames.contains('pins')
        ) {
          value.close();
          reject(failure());
          return;
        }
        value.onversionchange = () => {
          if (cachedDb === value) cachedDb = null;
          value.close();
        };
        value.onclose = () => {
          if (cachedDb === value) cachedDb = null;
        };
        cachedDb = value;
        resolve(value);
      };
    });
    opening = pending;
    return pending;
  };

  const withDatabase = <A>(work: (db: IDBDatabase) => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        const db = await openDatabase();
        try {
          return await work(db);
        } catch (cause) {
          if (cause instanceof PersonalHostError) throw cause;
          if (
            cause instanceof DOMException &&
            cause.name === 'InvalidStateError' &&
            cachedDb === db
          ) {
            cachedDb = null;
            const reopened = await openDatabase();
            return await work(reopened);
          }
          throw cause;
        }
      },
      catch: (cause) => (cause instanceof PersonalHostError ? cause : failure()),
    });

  return { withDatabase, close };
}
/** Public desktop pins only; neither this routing index nor its phase grants approval. */
export function personalEntryPins(databaseName: string) {
  const { withDatabase, close } = makeCachedIdbHandle(databaseName);

  const transact = <A>(
    accountId: string,
    workspaceId: string,
    write: boolean,
    work: (old: Pin | null) => { result: A; next?: Pin }
  ) =>
    withDatabase(
      (db) =>
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
        })
    );
  const listAccountPins = (accountId: string) =>
    withDatabase(
      (db) =>
        new Promise<{ readonly ready: Pin[]; readonly corruptWorkspaceIds: ReadonlySet<string> }>(
          (resolve, reject) => {
            const tx = db.transaction('pins', 'readonly'),
              store = tx.objectStore('pins'),
              ready: Pin[] = [],
              corruptWorkspaceIds = new Set<string>();
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
                  corruptWorkspaceIds.add(key[1]);
                }
              }
              row.continue();
            };
            tx.oncomplete = () => resolve({ ready, corruptWorkspaceIds });
            tx.onabort = tx.onerror = () => reject(failure());
          }
        )
    );
  return {
    read: (accountId: string, workspaceId: string) =>
      transact(accountId, workspaceId, false, (old) => ({ result: old })),
    /**
     * Every `ready` pin of this account, for an approving device that has not opened
     * all of its workspaces in this process. A malformed pin is skipped here; reading
     * that workspace still refuses it.
     */
    listReady: (accountId: string) => Effect.map(listAccountPins(accountId), ({ ready }) => ready),
    listAccountPins,
    close,
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
    retire: (accountId: string, offer: PersonalPairingOffer, allowPending = false) =>
      transact(accountId, offer.workspaceId, true, (old) =>
        (old?.phase === 'ready' || (allowPending && old?.phase === 'pending')) &&
        samePersonalOffer(old.offer, offer)
          ? { result: undefined, next: { ...old, phase: 'cancelled' as const } }
          : { result: undefined }
      ),
  };
}
export type PersonalEntryPins = ReturnType<typeof personalEntryPins>;
