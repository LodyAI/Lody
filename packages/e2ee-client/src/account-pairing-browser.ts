import { Effect } from 'effect';
import type {
  AccountPairingAdmissionRecord,
  AccountPairingRequestRecord,
  AccountPairingStore,
  AccountPairingTerminal,
} from './account-pairing';

/**
 * Browser pieces for the shared account pairing workflow: an IndexedDB
 * `AccountPairingStore` and single-tab ownership. Neither stores a secret or a private
 * key, and neither decides identity protection.
 */

const DATABASE_VERSION = 1;
const STORES = ['terminal', 'requests', 'joined', 'approved', 'admissions'] as const;
type StoreName = (typeof STORES)[number];

const fail = (code: string) => Object.assign(new Error(`e2ee_${code}`), { code });
const copy = (value: Uint8Array) => new Uint8Array(value);

/** One account's pairing state in its own IndexedDB database. Every mutation
 * resolves only after its transaction completes; an abort or quota error fails it
 * and advances nothing. */
export function makeIndexedDbAccountPairingStore(options: {
  accountId: string;
  indexedDB?: IDBFactory;
}): AccountPairingStore & { close(): void } {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const name = `lody-e2ee-account-pairing:${options.accountId}`;
  let connection: Promise<IDBDatabase> | undefined;
  let closed = false;
  const open = () =>
    (connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('terminal', { keyPath: 'lookupId' });
        db.createObjectStore('requests', { keyPath: 'seq', autoIncrement: true }).createIndex(
          'lookupId',
          'lookupId',
          { unique: true }
        );
        db.createObjectStore('joined', { keyPath: ['lookupId', 'workspaceId'] });
        db.createObjectStore('approved', { keyPath: 'lookupId' });
        db.createObjectStore('admissions', { keyPath: ['workspaceId', 'signingKey'] }).createIndex(
          'lookupId',
          'lookupId'
        );
      };
      request.onsuccess = () => {
        const db = request.result;
        // A current-only layout: anything else is a different database, never repaired.
        if (STORES.some((store) => !db.objectStoreNames.contains(store))) {
          db.close();
          reject(fail('corrupt'));
          return;
        }
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? fail('storage'));
      request.onblocked = () => reject(fail('storage'));
    }));
  /** Runs synchronous request callbacks in one transaction; the result is read
   * only after the transaction completes. */
  const transact = <A>(
    stores: readonly StoreName[],
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => () => A
  ): Effect.Effect<A, unknown> =>
    Effect.tryPromise({
      try: async () => {
        if (closed) throw fail('closed');
        const db = await open();
        return await new Promise<A>((resolve, reject) => {
          const tx = db.transaction(stores, mode);
          let result: () => A;
          try {
            result = work(tx);
          } catch (error) {
            tx.abort();
            reject(error);
            return;
          }
          tx.oncomplete = () => {
            try {
              resolve(result());
            } catch (error) {
              reject(error);
            }
          };
          tx.onerror = () => reject(tx.error ?? fail('storage'));
          tx.onabort = () => reject(tx.error ?? fail('storage'));
        });
      },
      catch: (error) => error,
    });
  const read = <T>(request: IDBRequest<T>) => {
    let value: T | undefined;
    request.onsuccess = () => (value = request.result);
    return () => value as T;
  };
  return {
    terminal: (lookupId) =>
      transact(['terminal'], 'readonly', (tx) => {
        const row = read(tx.objectStore('terminal').get(lookupId));
        return () => (row() as { state: AccountPairingTerminal } | undefined)?.state ?? null;
      }),
    settle: (lookupId, role, state, at) =>
      transact(['terminal'], 'readwrite', (tx) => {
        const store = tx.objectStore('terminal');
        const existing = store.get(lookupId);
        existing.onsuccess = () => {
          // First terminal state wins; it is never replaced.
          if (!existing.result) store.add({ lookupId, role, state, at });
        };
        return () => undefined;
      }),
    latestRequest: () =>
      transact(['requests'], 'readonly', (tx) => {
        const cursor = tx.objectStore('requests').openCursor(null, 'prev');
        let value: AccountPairingRequestRecord | null = null;
        cursor.onsuccess = () => {
          const row = cursor.result?.value as
            | (AccountPairingRequestRecord & { seq: number })
            | undefined;
          if (row)
            value = {
              lookupId: row.lookupId,
              request: copy(row.request),
              requestTag: row.requestTag,
              direction: row.direction,
              expiresAt: row.expiresAt,
            };
        };
        return () => value;
      }),
    hasRequest: (lookupId) =>
      transact(['requests'], 'readonly', (tx) => {
        const count = read(tx.objectStore('requests').index('lookupId').count(lookupId));
        return () => count() > 0;
      }),
    insertRequest: (record) =>
      transact(['requests'], 'readwrite', (tx) => {
        // The unique index refuses a second request under the same lookup ID.
        tx.objectStore('requests').add({ ...record, request: copy(record.request) });
        return () => undefined;
      }),
    joined: (lookupId) =>
      transact(['joined'], 'readonly', (tx) => {
        const rows = read(
          tx.objectStore('joined').getAll(IDBKeyRange.bound([lookupId, ''], [lookupId, '￿']))
        );
        return () => new Set((rows() as { workspaceId: string }[]).map((row) => row.workspaceId));
      }),
    addJoined: (lookupId, workspaceId) =>
      transact(['joined'], 'readwrite', (tx) => {
        tx.objectStore('joined').put({ lookupId, workspaceId });
        return () => undefined;
      }),
    approvedRequest: (lookupId) =>
      transact(['approved'], 'readonly', (tx) => {
        const row = read(tx.objectStore('approved').get(lookupId));
        return () => {
          const value = row() as { request: Uint8Array; requestTag: string } | undefined;
          return value ? { request: copy(value.request), requestTag: value.requestTag } : null;
        };
      }),
    putApprovedRequest: (lookupId, request, requestTag) =>
      transact(['approved'], 'readwrite', (tx) => {
        const store = tx.objectStore('approved');
        const existing = store.get(lookupId);
        existing.onsuccess = () => {
          if (!existing.result) store.add({ lookupId, request: copy(request), requestTag });
        };
        return () => undefined;
      }),
    admission: (workspaceId, signingKey) =>
      transact(['admissions'], 'readonly', (tx) => {
        const row = read(tx.objectStore('admissions').get([workspaceId, signingKey]));
        return () => {
          const value = row() as AccountPairingAdmissionRecord | undefined;
          return value
            ? {
                ...value,
                record: copy(value.record),
                invitation: value.invitation ? copy(value.invitation) : null,
              }
            : null;
        };
      }),
    insertAdmission: (record) =>
      transact(['admissions'], 'readwrite', (tx) => {
        tx.objectStore('admissions').add({
          ...record,
          record: copy(record.record),
          invitation: record.invitation ? copy(record.invitation) : null,
        });
        return () => undefined;
      }),
    setAdmissionInvitation: (workspaceId, signingKey, invitation) =>
      transact(['admissions'], 'readwrite', (tx) => {
        const store = tx.objectStore('admissions');
        const existing = store.get([workspaceId, signingKey]);
        existing.onsuccess = () => {
          const row = existing.result as AccountPairingAdmissionRecord | undefined;
          if (row && !row.invitation) store.put({ ...row, invitation: copy(invitation) });
        };
        return () => undefined;
      }),
    deleteAdmission: (workspaceId, signingKey, requestId) =>
      transact(['admissions'], 'readwrite', (tx) => {
        const store = tx.objectStore('admissions');
        const existing = store.get([workspaceId, signingKey]);
        existing.onsuccess = () => {
          const row = existing.result as AccountPairingAdmissionRecord | undefined;
          if (row?.requestId === requestId) store.delete([workspaceId, signingKey]);
        };
        return () => undefined;
      }),
    admissionCount: (lookupId) =>
      transact(['admissions'], 'readonly', (tx) => {
        const count = read(tx.objectStore('admissions').index('lookupId').count(lookupId));
        return () => count();
      }),
    close: () => {
      closed = true;
      void connection?.then((db) => db.close());
    },
  };
}

/** Which tab owns this account's pairing. One request belongs to one tab: its
 * secret lives only in that tab's memory. A closed tab releases its Web Lock. */
export function makeAccountPairingTabOwnership(options: { name: string; locks?: LockManager }) {
  const locks = options.locks ?? globalThis.navigator.locks;
  let release: (() => void) | undefined;
  let settled: Promise<unknown> | undefined;
  return {
    /** True when this tab owns the pairing, claiming it if no other tab holds it. */
    claim: () =>
      Effect.promise(
        () =>
          new Promise<boolean>((resolve) => {
            if (release) return resolve(true);
            settled = locks.request(options.name, { ifAvailable: true }, (lock) => {
              if (!lock) return resolve(false);
              resolve(true);
              return new Promise<void>((done) => (release = done));
            });
          })
      ),
    /** Gives the pairing up so another tab can take it. */
    release: () =>
      Effect.promise(async () => {
        const done = release;
        release = undefined;
        done?.();
        await settled;
      }),
  };
}

/** Every method runs only in the owning tab; elsewhere it refuses with
 * `pairing-elsewhere`, which the UI shows as "already running in another tab". */
export function withAccountPairingTabOwnership<
  T extends Record<string, (...args: never[]) => Effect.Effect<unknown, unknown>>,
>(pairing: T, ownership: ReturnType<typeof makeAccountPairingTabOwnership>): T {
  const wrapped: Record<string, unknown> = {};
  for (const [key, method] of Object.entries(pairing))
    wrapped[key] = (...args: never[]) =>
      Effect.flatMap(ownership.claim(), (owned) =>
        owned ? method(...args) : Effect.fail(fail('pairing-elsewhere'))
      );
  return wrapped as T;
}
