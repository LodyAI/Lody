import { Effect } from 'effect';
import { LocalStoreError } from '../../services/errors';

export const TABLES = ['meta', 'pin', 'feed', 'records', 'submission', 'pairing'] as const;
export const failure = (store: string, reason: LocalStoreError['reason']) =>
  new LocalStoreError({ store, reason });
export const storageFailure = (store: string, cause: unknown) =>
  cause instanceof LocalStoreError
    ? cause
    : failure(
        store,
        cause instanceof DOMException && cause.name === 'QuotaExceededError'
          ? 'capacity'
          : 'storage'
      );
export type BoundScope = {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly genesis: string;
};
export type Transaction = {
  readonly store: (table: string) => IDBObjectStore;
  readonly request: <A>(request: IDBRequest<A>, next: (value: A) => void) => void;
};

/** Fixed adapter-owned schema; initialization is synchronous native IDB work only. */
export interface DatabaseLayout {
  readonly tables: readonly string[];
  readonly initialize: (tx: IDBTransaction) => void;
}
const ledgerLayout: DatabaseLayout = {
  tables: TABLES,
  initialize: (tx) => {
    tx.objectStore('pin').put({ version: 1, revision: 0, checkpoint: null }, 0);
    tx.objectStore('feed').put(
      { version: 1, revision: 0, origin: null, originCount: 0, tail: null },
      0
    );
    tx.objectStore('submission').put(
      { version: 1, revision: 0, record: null, outcome: null, checkpoint: null },
      0
    );
  },
};

/** One Scope's IDB connection. No request callback awaits external work. */
export class DatabaseOwner {
  private database: IDBDatabase | undefined;
  private opening: IDBOpenDBRequest | undefined;
  private rejectOpening: ((error: LocalStoreError) => void) | undefined;
  private readonly active = new Set<Promise<unknown>>();
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(
    readonly scope: BoundScope,
    readonly name: string,
    readonly mode: 'create-or-open' | 'open-existing',
    private readonly layout: DatabaseLayout = ledgerLayout
  ) {}

  readonly open = Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        if (this.closed) return reject(failure('IndexedDbClientStores', 'closed'));
        this.rejectOpening = reject;
        let request: IDBOpenDBRequest;
        try {
          request = globalThis.indexedDB.open(this.name, 1);
        } catch (cause) {
          reject(storageFailure('IndexedDbClientStores', cause));
          return;
        }
        this.opening = request;
        request.onblocked = () => {
          this.closed = true;
          reject(failure('IndexedDbClientStores', 'conflict'));
        };
        request.onerror = () => reject(storageFailure('IndexedDbClientStores', request.error));
        request.onupgradeneeded = (event) => {
          if (this.closed || this.mode === 'open-existing' || event.oldVersion !== 0) {
            request.transaction?.abort();
            return;
          }
          const db = request.result;
          for (const name of this.layout.tables) db.createObjectStore(name);
          const tx = request.transaction!;
          tx.objectStore('meta').put({ version: 1, ...this.scope }, 0);
          this.layout.initialize(tx);
        };
        request.onsuccess = () => {
          this.opening = undefined;
          this.rejectOpening = undefined;
          const db = request.result;
          if (this.closed) {
            db.close();
            reject(failure('IndexedDbClientStores', 'closed'));
            return;
          }
          if (
            db.version !== 1 ||
            this.layout.tables.length !== db.objectStoreNames.length ||
            this.layout.tables.some((name) => !db.objectStoreNames.contains(name))
          ) {
            db.close();
            reject(failure('IndexedDbClientStores', 'corrupt'));
            return;
          }
          this.database = db;
          db.onversionchange = () => {
            this.closed = true;
            db.close();
          };
          db.onclose = () => {
            this.closed = true;
          };
          resolve();
        };
      }),
    catch: (cause) => storageFailure('IndexedDbClientStores', cause),
  });

  readonly close = Effect.uninterruptible(
    Effect.promise(() => {
      this.closed = true;
      this.rejectOpening?.(failure('IndexedDbClientStores', 'closed'));
      try {
        this.opening?.transaction?.abort();
      } catch {
        /* Already settled; the late success handler closes the connection. */
      }
      this.database?.close();
      return (this.closing ??= Promise.allSettled([...this.active]).then(() => undefined));
    })
  );

  /** Callback requests and final binding readback share one transaction; only complete resolves success. */
  run<A>(
    name: string,
    tables: readonly string[],
    mode: IDBTransactionMode,
    checkBinding: (value: unknown) => void,
    work: (transaction: Transaction, finish: (value: A) => void) => void
  ): Effect.Effect<A, LocalStoreError> {
    return Effect.uninterruptible(
      Effect.tryPromise({
        try: () => {
          if (this.closed || !this.database) return Promise.reject(failure(name, 'closed'));
          const pending = new Promise<A>((resolve, reject) => {
            const db = this.database!;
            const tx = db.transaction([...new Set(['meta', ...tables])], mode, {
              durability: 'strict',
            });
            let error: LocalStoreError | undefined,
              ready = false,
              value: A;
            const abort = (cause: unknown) => {
              error = storageFailure(name, cause);
              try {
                tx.abort();
              } catch {
                reject(error);
              }
            };
            const request = <T>(req: IDBRequest<T>, next: (value: T) => void) => {
              req.onerror = () => {
                error ??= storageFailure(name, req.error);
              };
              req.onsuccess = () => {
                try {
                  next(req.result);
                } catch (cause) {
                  abort(cause);
                }
              };
            };
            const transaction: Transaction = { store: (table) => tx.objectStore(table), request };
            tx.onabort = () => reject(error ?? storageFailure(name, tx.error));
            tx.onerror = () => {
              error ??= storageFailure(name, tx.error);
            };
            tx.oncomplete = () => (ready ? resolve(value!) : reject(failure(name, 'corrupt')));
            const finish = (result: A) =>
              request(tx.objectStore('meta').get(0), (row) => {
                if (ready) throw failure(name, 'corrupt');
                checkBinding(row);
                value = result;
                ready = true;
              });
            request(tx.objectStore('meta').get(0), (row) => {
              checkBinding(row);
              work(transaction, finish);
            });
          });
          this.active.add(pending);
          void pending.then(
            () => this.active.delete(pending),
            () => this.active.delete(pending)
          );
          return pending;
        },
        catch: (cause) => storageFailure(name, cause),
      })
    );
  }
}
