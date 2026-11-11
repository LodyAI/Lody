import { Effect } from 'effect';
import { MachineSharingError } from './errors';
import type {
  MachineSharingPinRow,
  MachineSharingRequestRow,
  MachineSharingStore,
  MachineSharingStoreStep,
  OpenMachineSharingStore,
} from './store';

const PINS = 'pins';
const REQUESTS = 'requests';
type StoredRequest = MachineSharingRequestRow & { readonly resource: string };

const storageError = () => new MachineSharingError({ code: 'sharing_storage' });
const asError = (error: unknown) => (error instanceof MachineSharingError ? error : storageError());

/**
 * Runs one transaction. `start` issues its requests; their success callbacks run the
 * caller's decision synchronously, inside the transaction, and record the result. The
 * effect resolves only on `complete`, after a readwrite transaction is durable; a
 * thrown decision aborts the transaction and nothing is written. Once started, a
 * transaction runs to its end: the effect is uninterruptible, as the SQLite store's
 * synchronous steps are.
 */
const transact = <A>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  start: (tx: IDBTransaction, settle: (result: A) => void, fail: (error: unknown) => void) => void
) =>
  Effect.uninterruptible(
    Effect.callback<A, MachineSharingError>((resume) => {
      let settled: { readonly result: A } | undefined;
      let failure: { readonly error: unknown } | undefined;
      let resumed = false;
      const finish = (effect: Effect.Effect<A, MachineSharingError>) => {
        if (resumed) return;
        resumed = true;
        resume(effect);
      };
      let tx: IDBTransaction;
      try {
        tx = db.transaction([PINS, REQUESTS], mode, { durability: 'strict' });
      } catch {
        finish(Effect.fail(storageError()));
        return;
      }
      tx.oncomplete = () =>
        finish(
          failure
            ? Effect.fail(asError(failure.error))
            : settled
              ? Effect.succeed(settled.result)
              : Effect.fail(storageError())
        );
      tx.onabort = () => finish(Effect.fail(asError(failure?.error)));
      tx.onerror = () => finish(Effect.fail(asError(failure?.error)));
      const fail = (error: unknown) => {
        failure ??= { error };
        try {
          tx.abort();
        } catch {
          // Already finished; `complete` or `abort` reports the recorded failure.
        }
      };
      try {
        start(
          tx,
          (result) => {
            settled = { result };
          },
          fail
        );
      } catch (error) {
        fail(error);
      }
    })
  );

/** Reads one request's result and passes it to `use` inside the same transaction. */
const onSuccess = <T>(
  request: IDBRequest<T>,
  use: (value: T) => void,
  fail: (e: unknown) => void
) => {
  request.onsuccess = () => {
    try {
      use(request.result);
    } catch (error) {
      fail(error);
    }
  };
};

const pinRow = (value: unknown): MachineSharingPinRow | null => {
  if (value === undefined) return null;
  const row = value as Partial<MachineSharingPinRow>;
  if (typeof row.head !== 'string' || (row.original !== null && typeof row.original !== 'string'))
    throw storageError();
  return { head: row.head, original: row.original };
};
const requestValue = (value: unknown): string | null => {
  if (value === undefined) return null;
  const row = value as Partial<StoredRequest>;
  if (typeof row.value !== 'string') throw storageError();
  return row.value;
};

/**
 * The browser and webview store: one IndexedDB database per workspace binding, named by
 * the caller's fixed namespace. Each step is one strict-durability transaction over
 * both stores; IndexedDB serializes overlapping readwrite transactions across tabs, so a
 * decision always sees committed state and no other writer interleaves with it.
 */
export const openIndexedDbMachineSharingStore = (
  name: string,
  environment: {
    readonly indexedDB: IDBFactory;
    readonly IDBKeyRange: typeof IDBKeyRange;
  } = globalThis
): OpenMachineSharingStore =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.callback<IDBDatabase, MachineSharingError>((resume) => {
        let open: IDBOpenDBRequest;
        try {
          open = environment.indexedDB.open(name, 1);
        } catch {
          resume(Effect.fail(storageError()));
          return;
        }
        open.onupgradeneeded = () => {
          const created = open.result;
          if (!created.objectStoreNames.contains(PINS)) created.createObjectStore(PINS);
          if (!created.objectStoreNames.contains(REQUESTS)) created.createObjectStore(REQUESTS);
        };
        open.onsuccess = () => {
          const opened = open.result;
          // A later schema owner takes over the database; this one stops writing to it.
          opened.onversionchange = () => opened.close();
          resume(Effect.succeed(opened));
        };
        open.onerror = () => resume(Effect.fail(storageError()));
        open.onblocked = () => resume(Effect.fail(storageError()));
      }),
      (opened) => Effect.sync(() => opened.close())
    );
    const requestKey = (resource: string, requestId: string) => [resource, requestId];
    return {
      readPin: <A>(resource: string, read: (row: MachineSharingPinRow | null) => A) =>
        transact<A>(db, 'readonly', (tx, settle, fail) =>
          onSuccess(
            tx.objectStore(PINS).get(resource),
            (value) => settle(read(pinRow(value))),
            fail
          )
        ),
      updatePin: <A>(
        resource: string,
        decide: (
          row: MachineSharingPinRow | null
        ) => MachineSharingStoreStep<MachineSharingPinRow, A>
      ) =>
        transact<A>(db, 'readwrite', (tx, settle, fail) => {
          const store = tx.objectStore(PINS);
          onSuccess(
            store.get(resource),
            (value) => {
              const step = decide(pinRow(value));
              if (step.write)
                store.put({ head: step.write.head, original: step.write.original }, resource);
              settle(step.result);
            },
            fail
          );
        }),
      readRequest: <A>(resource: string, requestId: string, read: (value: string | null) => A) =>
        transact<A>(db, 'readonly', (tx, settle, fail) =>
          onSuccess(
            tx.objectStore(REQUESTS).get(requestKey(resource, requestId)),
            (value) => settle(read(requestValue(value))),
            fail
          )
        ),
      updateRequest: <A>(
        resource: string,
        requestId: string,
        decide: (value: string | null) => MachineSharingStoreStep<string, A>
      ) =>
        transact<A>(db, 'readwrite', (tx, settle, fail) => {
          const store = tx.objectStore(REQUESTS);
          const key = requestKey(resource, requestId);
          onSuccess(
            store.get(key),
            (value) => {
              const step = decide(requestValue(value));
              if (step.write !== undefined)
                store.put({ resource, requestId, value: step.write } satisfies StoredRequest, key);
              settle(step.result);
            },
            fail
          );
        }),
      readRequests: <A>(resource: string, read: (rows: readonly MachineSharingRequestRow[]) => A) =>
        transact<A>(db, 'readonly', (tx, settle, fail) =>
          onSuccess(
            // Array keys sort after strings, so this spans exactly [resource, *] in
            // request-id order.
            tx
              .objectStore(REQUESTS)
              .getAll(environment.IDBKeyRange.bound([resource, ''], [resource, []])),
            (values) =>
              settle(
                read(
                  values.map((value) => {
                    const row = value as Partial<StoredRequest>;
                    if (typeof row.requestId !== 'string' || typeof row.value !== 'string')
                      throw storageError();
                    return { requestId: row.requestId, value: row.value };
                  })
                )
              ),
            fail
          )
        ),
    } satisfies MachineSharingStore;
  });
