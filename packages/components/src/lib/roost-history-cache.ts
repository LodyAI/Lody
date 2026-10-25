import type { SessionHistoryChange, SessionHistoryInput } from '@lody/shared';
import type { SessionDirectoryRow, SessionHistoryDirectoryPage } from '@lody/shared/session-data';
import { createRoostDirectoryRow, type SessionEntry } from '@lody/shared/session-data';

/** A durable, read-only projection of owner-accepted history; never an outbox. */
// A Native publication revision has a different authority from a retired Loro
// cursor. Old tabs/rows must never overwrite or outrank its scoped checkpoint.
export const ROOST_HISTORY_CACHE_DB = 'lody:roost-history-v3';
const HEADS = 'heads';
const ROWS = 'rows';

export type RoostCachedHead = {
  checkpoint?: string;
  /** A covered change interval, usable only with complete bodies, never patches. */
  recoveryCheckpoint?: string;
  directoryRevision?: number;
  revision: number;
  count: number;
  start: number;
  slot: number;
};
const sameHead = (left: RoostCachedHead, right: RoostCachedHead) =>
  left.slot === right.slot &&
  left.count === right.count &&
  left.revision === right.revision &&
  left.start === right.start &&
  left.checkpoint === right.checkpoint &&
  left.recoveryCheckpoint === right.recoveryCheckpoint;
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
        if (
          !head ||
          (before &&
            (before.revision > head.revision ||
              before.revision < (head.directoryRevision ?? head.revision)))
        )
          return done(undefined);
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

  /** Commit a coherent window atomically. A reset replaces only the latest
   * window; invalidated older pages are fetched when a reader needs them. */
  const acceptPage = (
    page: SessionHistoryDirectoryPage,
    turns: readonly SessionHistoryInput[],
    revision: number,
    change?: SessionHistoryChange | null,
    replaceHead?: RoostCachedHead
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
        if (replaceHead && (!head || !sameHead(head, replaceHead))) return done(false);
        if (head && head.revision > revision) return done(false);
        if (!replaceHead && head?.revision === revision && head.count !== page.totalCount) {
          tx.abort();
          return;
        }
        const end = page.startPosition + page.rows.length;
        const isLatest = end === page.totalCount;
        const coversWindow = head && page.startPosition <= head.start && isLatest;
        if (!head) {
          if (!isLatest) return done(false);
          put(0);
          heads.put(
            {
              revision,
              directoryRevision: revision,
              ...(page.checkpoint ? { checkpoint: page.checkpoint } : {}),
              count: page.totalCount,
              start: page.startPosition,
              slot: 0,
            } satisfies RoostCachedHead,
            key('head')
          );
          return done(true);
        }
        if (!replaceHead && head.revision === revision && head.count === page.totalCount) {
          // A late legacy reply cannot improve this already observed revision.
          // Keep its verified patch base instead of overwriting it without proof.
          if (!page.checkpoint && (head.checkpoint || head.recoveryCheckpoint)) return done(false);
          if (
            end < head.start ||
            (!coversWindow &&
              (head.checkpoint || head.recoveryCheckpoint) &&
              page.checkpoint !== head.checkpoint)
          )
            return done(false);
          put(head.slot);
          if (end >= head.start) {
            const checkpoint =
              head.checkpoint === page.checkpoint || coversWindow ? page.checkpoint : undefined;
            heads.put(
              {
                ...head,
                checkpoint,
                recoveryCheckpoint: checkpoint
                  ? undefined
                  : (head.checkpoint ?? head.recoveryCheckpoint),
                start: Math.min(head.start, page.startPosition),
              },
              key('head')
            );
          }
          return done(false);
        }
        // A page checkpoint proves only its own bodies. Advance a retained
        // prefix through readChanges, which can also detect a foreign generation.
        if (
          !replaceHead &&
          !coversWindow &&
          page.checkpoint &&
          (head.checkpoint || head.recoveryCheckpoint)
        )
          return done(false);
        // A complete consecutive delta can advance the existing projection in
        // place. Streaming normally updates just this latest page.
        const coversDelta =
          !replaceHead &&
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
          const checkpoint =
            head.checkpoint !== undefined || coversWindow ? page.checkpoint : undefined;
          heads.put(
            {
              ...head,
              revision,
              directoryRevision:
                change?.kind === 'structure' ? revision : (head.directoryRevision ?? head.revision),
              checkpoint,
              recoveryCheckpoint: checkpoint
                ? undefined
                : (head.checkpoint ?? head.recoveryCheckpoint),
              count: page.totalCount,
              start: Math.min(head.start, page.startPosition),
            },
            key('head')
          );
          heads.delete(key('staging'));
          return done(true);
        }
        if (!isLatest) return done(false);
        if (!replaceHead && !coversWindow && (head.checkpoint || head.recoveryCheckpoint))
          return done(false);
        const slot = 1 - head.slot;
        store.delete(positions(slot));
        put(slot);
        heads.put(
          {
            revision,
            directoryRevision: revision,
            checkpoint: page.checkpoint,
            count: page.totalCount,
            start: page.startPosition,
            slot,
          } satisfies RoostCachedHead,
          key('head')
        );
        heads.delete(key('staging'));
        store.delete(positions(head.slot));
        done(true);
      };
    });

  return {
    getHead,
    readPage,
    readRows,
    acceptPage,
    readAffected: (ids: readonly string[]) =>
      transact<CachedRow[]>('readonly', (tx, done) => {
        const request = tx.objectStore(HEADS).get(key('head'));
        request.onsuccess = () => {
          const head = request.result as RoostCachedHead | undefined;
          if (!head || ids.length === 0) return done([]);
          const found: CachedRow[] = [];
          let remaining = ids.length;
          for (const id of ids) {
            const row = tx.objectStore(ROWS).index('turn').get([scope, head.slot, id]);
            row.onsuccess = () => {
              if (row.result) found.push(row.result);
              if (--remaining === 0) done(found);
            };
          }
        };
      }),
    applyChanges: (
      expected: RoostCachedHead,
      revision: number,
      count: number,
      checkpoint: string,
      from: number | undefined,
      replacements: readonly { position: number; turn: SessionHistoryInput }[],
      completeBodies = false
    ) =>
      transact<boolean>('readwrite', (tx, done) => {
        const heads = tx.objectStore(HEADS);
        const rows = tx.objectStore(ROWS);
        const request = heads.get(key('head'));
        request.onsuccess = () => {
          const head = request.result as RoostCachedHead | undefined;
          if (
            !head ||
            !(head.checkpoint || (completeBodies && head.recoveryCheckpoint)) ||
            !sameHead(head, expected) ||
            revision < head.revision
          )
            return done(false);
          if (from === undefined && count !== head.count) {
            tx.abort();
            return;
          }
          const start =
            head.start >= count && count > 0
              ? Math.max(0, count - 40)
              : Math.min(head.start, count);
          if (from !== undefined) {
            const first = Math.max(start, Math.min(from, count));
            const replacedPositions = new Set(replacements.map((row) => row.position));
            for (let position = first; position < count; position++) {
              if (!replacedPositions.has(position)) {
                tx.abort();
                return;
              }
            }
            rows.delete(positions(head.slot, Math.min(from, count)));
          }
          for (const replacement of replacements) {
            if (replacement.position < start || replacement.position >= count) {
              tx.abort();
              return;
            }
            rows.put({
              scope,
              slot: head.slot,
              position: replacement.position,
              turnId: replacement.turn.id,
              turn: replacement.turn,
              row: createRoostDirectoryRow(replacement.position, replacement.turn as SessionEntry),
            } satisfies CachedRow);
          }
          heads.put(
            {
              ...head,
              revision,
              count,
              start,
              checkpoint,
              recoveryCheckpoint: undefined,
              directoryRevision:
                from === undefined ? (head.directoryRevision ?? head.revision) : revision,
            },
            key('head')
          );
          heads.delete(key('staging'));
          done(true);
        };
      }),
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
          heads.put(
            {
              ...head,
              revision,
              checkpoint: undefined,
              recoveryCheckpoint: head.checkpoint ?? head.recoveryCheckpoint,
              directoryRevision: head.directoryRevision ?? head.revision,
            },
            key('head')
          );
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
          turn.onsuccess = () => {
            const row = turn.result as CachedRow | undefined;
            done(
              row && row.position >= head.start && row.position < head.count ? row.turn : undefined
            );
          };
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
