import type { SessionHistoryChange, SessionHistoryInput } from '@lody/shared';
import type { SessionDirectoryRow, SessionHistoryDirectoryPage } from '@lody/shared/session-data';
import { createRoostDirectoryRow, type SessionEntry } from '@lody/shared/session-data';

/** A durable, read-only projection of owner-accepted history; never an outbox. */
export const ROOST_HISTORY_CACHE_DB = 'lody:roost-history-v1';
const HEADS = 'heads';
const ROWS = 'rows';

export type RoostCachedHead = {
  revision: number;
  count: number;
  start: number;
  slot: number;
};
type CachedRow = {
  scope: string;
  slot: number;
  position: number;
  turnId: string;
  row: SessionDirectoryRow;
  turn: SessionHistoryInput;
};
export type RoostCachedPage = {
  head: RoostCachedHead;
  page: SessionHistoryDirectoryPage;
  turns: readonly SessionHistoryInput[];
};

export function roostCacheCursor(revision: number, end: number): string {
  return `roost-cache:${revision}:${end}`;
}

export function parseRoostCacheCursor(
  cursor: string
): { revision: number; end: number } | undefined {
  const match = /^roost-cache:(\d+):(\d+)$/.exec(cursor);
  if (!match) return undefined;
  const revision = Number(match[1]);
  const end = Number(match[2]);
  return Number.isSafeInteger(revision) && Number.isSafeInteger(end)
    ? { revision, end }
    : undefined;
}

export function createRoostHistoryCache(scope: string) {
  let opening: Promise<IDBDatabase> | undefined;
  let disposed = false;
  const open = () => {
    if (disposed) return Promise.reject(new Error('History cache is disposed'));
    if (!opening) {
      opening = new Promise<IDBDatabase>((resolve, reject) => {
        let blocked = false;
        const request = indexedDB.open(ROOST_HISTORY_CACHE_DB, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore(HEADS);
          const rows = db.createObjectStore(ROWS, { keyPath: ['scope', 'slot', 'position'] });
          rows.createIndex('turn', ['scope', 'slot', 'turnId'], { unique: true });
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
          blocked = true;
          reject(new Error('History cache upgrade is blocked'));
        };
        request.onsuccess = () => {
          const db = request.result;
          if (disposed || blocked) {
            db.close();
            reject(new Error('History cache is disposed'));
          } else {
            db.onversionchange = () => {
              db.close();
              opening = undefined;
            };
            resolve(db);
          }
        };
      }).catch((error) => {
        opening = undefined;
        throw error;
      });
    }
    return opening;
  };
  const key = (kind: 'head' | 'staging') => [scope, kind];
  const positions = (slot: number, from = 0, to = Number.MAX_SAFE_INTEGER) =>
    IDBKeyRange.bound([scope, slot, from], [scope, slot, to]);
  const transact = async <T>(
    mode: IDBTransactionMode,
    run: (tx: IDBTransaction, result: (value: T) => void) => void
  ): Promise<T> => {
    const db = await open();
    if (disposed) throw new Error('History cache is disposed');
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction([HEADS, ROWS], mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error ?? new Error('History cache transaction aborted'));
      tx.onerror = () => reject(tx.error);
      run(tx, (result) => {
        value = result;
      });
    });
  };
  const getHead = () =>
    transact<RoostCachedHead | undefined>('readonly', (tx, done) => {
      const request = tx.objectStore(HEADS).get(key('head'));
      request.onsuccess = () => done(request.result);
    });
  const readRows = (from: number, to: number) =>
    transact<CachedRow[] | undefined>('readonly', (tx, done) => {
      const request = tx.objectStore(HEADS).get(key('head'));
      request.onsuccess = () => {
        const head = request.result as RoostCachedHead | undefined;
        if (!head || from < head.start || to > head.count || from > to) return done(undefined);
        if (from === to) return done([]);
        const rows = tx.objectStore(ROWS).getAll(positions(head.slot, from, to - 1));
        rows.onsuccess = () => done(rows.result.length === to - from ? rows.result : undefined);
      };
    });
  const readPage = (limit: number, before?: { revision: number; end: number }) =>
    transact<RoostCachedPage | undefined>('readonly', (tx, done) => {
      const request = tx.objectStore(HEADS).get(key('head'));
      request.onsuccess = () => {
        const head = request.result as RoostCachedHead | undefined;
        if (!head || (before && before.revision !== head.revision)) return done(undefined);
        const end = before?.end ?? head.count;
        const start = Math.max(before ? 0 : head.start, end - limit);
        if (end > head.count || start < head.start) return done(undefined);
        const finish = (rows: CachedRow[]) => {
          if (rows.length !== end - start) return done(undefined);
          done({
            head,
            turns: rows.map((row) => row.turn),
            page: {
              startPosition: start,
              totalCount: head.count,
              rows: rows.map((row) => row.row),
              hasMoreOlder: start > 0,
              cursor: start > 0 ? roostCacheCursor(head.revision, start) : null,
            },
          });
        };
        if (end === start) return finish([]);
        const rows = tx.objectStore(ROWS).getAll(positions(head.slot, start, end - 1));
        rows.onsuccess = () => finish(rows.result);
      };
    });

  /** Commit page bodies with their directory and revision in one transaction.
   * Unknown revision gaps rebuild in the other slot; the previous readable
   * snapshot remains available until a complete replacement is durable. */
  const acceptPage = (
    page: SessionHistoryDirectoryPage,
    turns: readonly SessionHistoryInput[],
    revision: number,
    change?: SessionHistoryChange | null
  ) =>
    transact<boolean>('readwrite', (tx, done) => {
      if (
        turns.length !== page.rows.length ||
        turns.some((turn, i) => turn.id !== page.rows[i]?.turnId)
      ) {
        tx.abort();
        return;
      }
      const heads = tx.objectStore(HEADS);
      const store = tx.objectStore(ROWS);
      const request = heads.get(key('head'));
      const put = (slot: number) => {
        page.rows.forEach((row, i) =>
          store.put({
            scope,
            slot,
            position: row.position,
            turnId: turns[i]!.id,
            row,
            turn: turns[i]!,
          } satisfies CachedRow)
        );
      };
      request.onsuccess = () => {
        const head = request.result as RoostCachedHead | undefined;
        if (head && head.revision > revision) return done(false);
        if (head?.revision === revision && head.count !== page.totalCount) {
          tx.abort();
          return;
        }
        const end = page.startPosition + page.rows.length;
        const isLatest = end === page.totalCount;
        if (!head) {
          if (!isLatest) return done(false);
          put(0);
          heads.put(
            {
              revision,
              count: page.totalCount,
              start: page.startPosition,
              slot: 0,
            } satisfies RoostCachedHead,
            key('head')
          );
          return done(true);
        }
        if (head.revision === revision && head.count === page.totalCount) {
          put(head.slot);
          if (end >= head.start)
            heads.put({ ...head, start: Math.min(head.start, page.startPosition) }, key('head'));
          return done(false);
        }
        // A complete consecutive delta can advance the existing projection in
        // place. Streaming normally updates just this latest page.
        const coversDelta =
          revision === head.revision + 1 &&
          ((change === null && head.count === page.totalCount) ||
            (change?.kind === 'changed' &&
              head.count === page.totalCount &&
              change.ids.every((id) => turns.some((turn) => turn.id === id))) ||
            (change?.kind === 'structure' &&
              isLatest &&
              page.startPosition <= change.from &&
              change.from >= head.start));
        if (coversDelta) {
          if (change?.kind === 'structure') store.delete(positions(head.slot, change.from));
          put(head.slot);
          heads.put(
            {
              ...head,
              revision,
              count: page.totalCount,
              start: Math.min(head.start, page.startPosition),
            },
            key('head')
          );
          heads.delete(key('staging'));
          return done(true);
        }
        const pending = heads.get(key('staging'));
        pending.onsuccess = () => {
          let staging = pending.result as RoostCachedHead | undefined;
          if (staging && staging.revision > revision) return done(false);
          const slot = 1 - head.slot;
          if (!staging || staging.revision !== revision || staging.count !== page.totalCount) {
            if (!isLatest) return done(false);
            store.delete(positions(slot));
            staging = { revision, count: page.totalCount, start: page.startPosition, slot };
          } else if (end < staging.start) return done(false);
          staging = { ...staging, start: Math.min(staging.start, page.startPosition) };
          put(slot);
          if (staging.start === 0) {
            heads.put(staging, key('head'));
            heads.delete(key('staging'));
            store.delete(positions(head.slot));
            done(true);
          } else {
            heads.put(staging, key('staging'));
            done(false);
          }
        };
      };
    });

  return {
    getHead,
    readPage,
    readRows,
    acceptPage,
    updateTurns: (revision: number, count: number, turns: readonly SessionHistoryInput[]) =>
      transact<boolean>('readwrite', (tx, done) => {
        const heads = tx.objectStore(HEADS);
        const rows = tx.objectStore(ROWS);
        const request = heads.get(key('head'));
        request.onsuccess = () => {
          const head = request.result as RoostCachedHead | undefined;
          if (!head || head.revision + 1 !== revision || head.count !== count) return done(false);
          for (const turn of turns) {
            const existing = rows.index('turn').get([scope, head.slot, turn.id]);
            existing.onsuccess = () => {
              const row = existing.result as CachedRow | undefined;
              if (row)
                rows.put({
                  ...row,
                  turn,
                  row: createRoostDirectoryRow(row.position, turn as SessionEntry),
                });
            };
          }
          heads.put({ ...head, revision }, key('head'));
          heads.delete(key('staging'));
          done(true);
        };
      }),
    readTurn: (turnId: string) =>
      transact<SessionHistoryInput | undefined>('readonly', (tx, done) => {
        const request = tx.objectStore(HEADS).get(key('head'));
        request.onsuccess = () => {
          const head = request.result as RoostCachedHead | undefined;
          if (!head) return done(undefined);
          const turn = tx.objectStore(ROWS).index('turn').get([scope, head.slot, turnId]);
          turn.onsuccess = () => done((turn.result as CachedRow | undefined)?.turn);
        };
      }),
    dispose() {
      disposed = true;
      void opening?.then(
        (db) => db.close(),
        () => {}
      );
      opening = undefined;
    },
  };
}
