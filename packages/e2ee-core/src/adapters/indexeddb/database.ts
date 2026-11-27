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

const BLOCKED_RETRY_DELAYS_MS = [50, 100, 200] as const;

/** One Scope's IDB connection. No request callback awaits external work. */
export class DatabaseOwner {
  private database: IDBDatabase | undefined;
  private opening: IDBOpenDBRequest | undefined;
  private rejectOpening: ((error: LocalStoreError) => void) | undefined;
  private openPromise: Promise<void> | undefined;
  private cancelOpenWait: (() => void) | undefined;
  private lockAbort: AbortController | undefined;
  private readonly active = new Set<Promise<unknown>>();
  private explicitlyClosed = false;
  private closing: Promise<void> | undefined;
  constructor(
    readonly scope: BoundScope,
    readonly name: string,
    readonly mode: 'create-or-open' | 'open-existing',
    private readonly layout: DatabaseLayout = ledgerLayout
  ) {}

  private async withOpenLock<A>(work: () => Promise<A>): Promise<A> {
    const locks =
      typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function'
        ? navigator.locks
        : undefined;
    if (!locks) return work();
    const controller = new AbortController();
    this.lockAbort = controller;
    let entered = false;
    try {
      return await locks.request(
        `lody:idb-open:${this.name}`,
        { signal: controller.signal },
        () => {
          entered = true;
          return work();
        }
      );
    } catch (error) {
      if (this.explicitlyClosed) throw failure('IndexedDbClientStores', 'closed');
      if (!entered && error instanceof DOMException && error.name === 'SecurityError') {
        return work();
      }
      throw error;
    } finally {
      if (this.lockAbort === controller) this.lockAbort = undefined;
    }
  }

  private openOnce(): Promise<'opened' | 'blocked'> {
    return new Promise<'opened' | 'blocked'>((resolve, reject) => {
      if (this.explicitlyClosed) return reject(failure('IndexedDbClientStores', 'closed'));
      let settled = false;
      this.rejectOpening = (error) => {
        if (settled) return;
        settled = true;
        this.opening = undefined;
        this.rejectOpening = undefined;
        reject(error);
      };
      let request: IDBOpenDBRequest;
      try {
        request = globalThis.indexedDB.open(this.name, 1);
      } catch (cause) {
        settled = true;
        this.rejectOpening = undefined;
        reject(storageFailure('IndexedDbClientStores', cause));
        return;
      }
      this.opening = request;
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        this.opening = undefined;
        this.rejectOpening = undefined;
        resolve('blocked');
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        this.opening = undefined;
        this.rejectOpening = undefined;
        reject(storageFailure('IndexedDbClientStores', request.error));
      };
      request.onupgradeneeded = (event) => {
        if (
          this.explicitlyClosed ||
          settled ||
          this.mode === 'open-existing' ||
          event.oldVersion !== 0
        ) {
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
        const db = request.result;
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        this.opening = undefined;
        this.rejectOpening = undefined;
        if (this.explicitlyClosed) {
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
          if (this.database === db) this.database = undefined;
          db.close();
        };
        db.onclose = () => {
          if (this.database === db) this.database = undefined;
        };
        resolve('opened');
      };
    });
  }

  private waitRetry(delayMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.explicitlyClosed) return reject(failure('IndexedDbClientStores', 'closed'));
      const timer = setTimeout(() => {
        this.cancelOpenWait = undefined;
        resolve();
      }, delayMs);
      this.cancelOpenWait = () => {
        clearTimeout(timer);
        this.cancelOpenWait = undefined;
        reject(failure('IndexedDbClientStores', 'closed'));
      };
    });
  }

  private ensureOpen(): Promise<void> {
    if (this.explicitlyClosed) return Promise.reject(failure('IndexedDbClientStores', 'closed'));
    if (this.database) return Promise.resolve();
    if (!this.openPromise) {
      this.openPromise = this.withOpenLock(async () => {
        for (let attempt = 0; attempt <= BLOCKED_RETRY_DELAYS_MS.length; attempt++) {
          if (this.explicitlyClosed) throw failure('IndexedDbClientStores', 'closed');
          if (this.database) return;
          const status = await this.openOnce();
          if (status === 'opened') return;
          const delay = BLOCKED_RETRY_DELAYS_MS[attempt];
          if (delay === undefined) throw failure('IndexedDbClientStores', 'conflict');
          await this.waitRetry(delay);
        }
      }).finally(() => {
        this.openPromise = undefined;
      });
    }
    return this.openPromise;
  }

  readonly open = Effect.tryPromise({
    try: () => this.ensureOpen(),
    catch: (cause) => storageFailure('IndexedDbClientStores', cause),
  });

  readonly close = Effect.uninterruptible(
    Effect.promise(() => {
      this.explicitlyClosed = true;
      this.lockAbort?.abort();
      this.cancelOpenWait?.();
      this.rejectOpening?.(failure('IndexedDbClientStores', 'closed'));
      try {
        this.opening?.transaction?.abort();
      } catch {
        /* Already settled; the late success handler closes the connection. */
      }
      const db = this.database;
      this.database = undefined;
      db?.close();
      return (this.closing ??= Promise.allSettled([...this.active]).then(() => undefined));
    })
  );

  private runTransaction<A>(
    db: IDBDatabase,
    name: string,
    tables: readonly string[],
    mode: IDBTransactionMode,
    checkBinding: (value: unknown) => void,
    work: (transaction: Transaction, finish: (value: A) => void) => void
  ): Promise<A> {
    return new Promise<A>((resolve, reject) => {
      const tx = db.transaction([...new Set(['meta', ...tables])], mode, {
        durability: mode === 'readonly' ? 'relaxed' : 'strict',
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
      const finish = (result: A) => {
        if (mode === 'readonly') {
          if (ready) throw failure(name, 'corrupt');
          value = result;
          ready = true;
          return;
        }
        request(tx.objectStore('meta').get(0), (row) => {
          if (ready) throw failure(name, 'corrupt');
          checkBinding(row);
          value = result;
          ready = true;
        });
      };
      request(tx.objectStore('meta').get(0), (row) => {
        checkBinding(row);
        work(transaction, finish);
      });
    });
  }

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
          if (this.explicitlyClosed) return Promise.reject(failure(name, 'closed'));
          const pending = (async (): Promise<A> => {
            for (let attempt = 0; attempt < 2; attempt++) {
              if (this.explicitlyClosed) throw failure(name, 'closed');
              if (!this.database) await this.ensureOpen();
              const db = this.database;
              if (this.explicitlyClosed || !db) throw failure(name, 'closed');
              try {
                return await this.runTransaction(db, name, tables, mode, checkBinding, work);
              } catch (cause) {
                if (
                  attempt === 0 &&
                  !this.explicitlyClosed &&
                  cause instanceof DOMException &&
                  cause.name === 'InvalidStateError'
                ) {
                  if (this.database === db) this.database = undefined;
                  continue;
                }
                throw cause;
              }
            }
            throw failure(name, 'closed');
          })();
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
