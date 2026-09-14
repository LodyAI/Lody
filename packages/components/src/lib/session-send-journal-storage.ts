import type { SessionSendJournalStorage, SessionSendRecord } from './session-send-journal';

const STORE = 'submissions';
export const SESSION_SEND_DATABASE = 'lody-session-send-v1';
export const SESSION_SEND_STORAGE_LOCK = 'lody-session-send-storage';
const MAX_PENDING_RECORDS = 100;
const MAX_PENDING_BYTES = 128 * 1024 * 1024;

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Recovery storage request failed'));
  });
}
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Recovery storage transaction aborted'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Recovery storage transaction failed'));
  });
}

function decodeRecords(
  values: unknown[],
  accountId: string,
  workspaceId: string
): SessionSendRecord[] {
  return values.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid session recovery record');
    const record = value as SessionSendRecord;
    if (record.version !== 1 && record.version !== 2)
      throw new Error('Unsupported session recovery version; execute a compatible application');
    if (
      record.accountId !== accountId ||
      record.workspaceId !== workspaceId ||
      typeof record.id !== 'string' ||
      !record.id ||
      record.entry?.id !== record.id ||
      typeof record.sessionId !== 'string' ||
      typeof record.sourceReplica !== 'string' ||
      !Number.isSafeInteger(record.sequence) ||
      !['saved', 'prepared', 'committed', 'delivered'].includes(record.stage) ||
      !['queue', 'dispatch', 'guide'].includes(record.delivery?.kind) ||
      (record.stage !== 'saved' && !(record.update instanceof Uint8Array))
    ) {
      throw new Error('Invalid session recovery record; content retained for recovery');
    }
    if (
      record.attachments !== undefined &&
      (record.version !== 2 ||
        !Array.isArray(record.attachments) ||
        record.attachments.some(
          (attachment) =>
            !attachment ||
            typeof attachment.id !== 'string' ||
            !attachment.id ||
            !['image', 'file'].includes(attachment.kind) ||
            !(attachment.source instanceof Blob) ||
            typeof attachment.name !== 'string' ||
            typeof attachment.mimeType !== 'string' ||
            !Number.isFinite(attachment.lastModified)
        ) ||
        new Set(record.attachments.map((attachment) => attachment.id)).size !==
          record.attachments.length)
    )
      throw new Error('Invalid saved attachments; content retained for recovery');
    return record;
  });
}

/** Account/workspace scoped, strict transaction receipts; failed admissions preserve the composer. */
export function createSessionSendJournalStorage(args: {
  accountId: string;
  workspaceId: string;
  indexedDB?: IDBFactory;
}): SessionSendJournalStorage {
  const factory = args.indexedDB ?? globalThis.indexedDB;
  const name = SESSION_SEND_DATABASE;
  const scope = [args.accountId, args.workspaceId];
  const key = (id: string) => [...scope, id];
  let closed = false;
  let opened: Promise<IDBDatabase> | undefined;
  const database = () => {
    if (closed) return Promise.reject(new Error('Recovery storage closed'));
    return (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, {
          keyPath: ['accountId', 'workspaceId', 'id'],
        });
        store.createIndex('scope', ['accountId', 'workspaceId']);
        store.createIndex('stage', 'stage');
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          closed = true;
          db.close();
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('Cannot open recovery storage'));
      request.onblocked = () =>
        reject(new Error('Recovery storage upgrade blocked by another window'));
    }));
  };
  const mutate = async <T>(execute: (store: IDBObjectStore) => Promise<T>): Promise<T> => {
    const db = await database();
    const transaction = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    const done = transactionDone(transaction);
    void done.catch(() => {});
    // Attach rejection handling immediately; a request can fail before execute settles.
    void done.catch(() => {});
    try {
      const result = await execute(transaction.objectStore(STORE));
      await done;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* already settled */
      }
      await done.catch(() => {});
      throw error;
    }
  };
  return {
    list: async () => {
      const db = await database();
      const transaction = db.transaction(STORE, 'readonly');
      const done = transactionDone(transaction);
      void done.catch(() => {});
      const values = await requestValue<unknown[]>(
        transaction.objectStore(STORE).index('scope').getAll(scope)
      );
      await done;
      return decodeRecords(values, args.accountId, args.workspaceId);
    },
    insert: (record) =>
      mutate(async (store) => {
        decodeRecords([{ ...record, sequence: 1 }], args.accountId, args.workspaceId);
        const values = decodeRecords(
          await requestValue<unknown[]>(store.index('scope').getAll(scope)),
          args.accountId,
          args.workspaceId
        );
        const existing = values.find((value) => value.id === record.id);
        if (existing) {
          if (
            JSON.stringify(existing.entry) !== JSON.stringify(record.entry) ||
            existing.sessionId !== record.sessionId
          )
            throw new Error('Submission identity conflicts with saved content');
          return existing;
        }
        const active = values.filter((value) => value.stage !== 'delivered');
        const bytes = active.reduce(
          (sum, value) =>
            sum +
            JSON.stringify(value.entry).length * 2 +
            (value.update?.byteLength ?? 0) +
            (value.attachments?.reduce((total, item) => total + item.source.size, 0) ?? 0),
          0
        );
        if (
          active.length >= MAX_PENDING_RECORDS ||
          bytes +
            JSON.stringify(record.entry).length * 2 +
            (record.attachments?.reduce((total, item) => total + item.source.size, 0) ?? 0) >
            MAX_PENDING_BYTES
        ) {
          throw new Error(
            'Pending message storage is full; finish or remove pending messages first'
          );
        }
        // Delivered rows contain redundant input. Retire them only on the next successful admission.
        for (const value of values)
          if (value.stage === 'delivered') await requestValue(store.delete(key(value.id)));
        const saved = {
          ...record,
          sequence: Math.max(0, ...values.map((value) => value.sequence)) + 1,
        };
        await requestValue(store.add(saved));
        return saved;
      }),
    put: (record) =>
      mutate(async (store) => {
        decodeRecords([record], args.accountId, args.workspaceId);
        const values = decodeRecords(
          await requestValue<unknown[]>(store.index('scope').getAll(scope)),
          args.accountId,
          args.workspaceId
        );
        const current = values.find((item) => item.id === record.id);
        if (!current) throw new Error('Submission was removed; stale work cannot restore it');
        if (current?.cancelRequested) {
          if (record.stage !== 'saved')
            throw new DOMException('Submission canceled before publication', 'AbortError');
          record = { ...record, cancelRequested: true };
        }
        const bytes = [
          ...values.filter((value) => value.id !== record.id && value.stage !== 'delivered'),
          record,
        ].reduce(
          (sum, value) =>
            sum +
            JSON.stringify(value.entry).length * 2 +
            (value.update?.byteLength ?? 0) +
            (value.attachments?.reduce((total, item) => total + item.source.size, 0) ?? 0),
          0
        );
        if (bytes > MAX_PENDING_BYTES) throw new Error('Pending message storage is full');
        await requestValue(store.put(record));
      }),
    requestCancel: (id) =>
      mutate(async (store) => {
        const current = await requestValue<SessionSendRecord | undefined>(store.get(key(id)));
        if (!current) return undefined;
        if (current.stage !== 'saved')
          throw new Error('Submission may already be accepted; reconcile before cancellation');
        if (current.creation) {
          const records = decodeRecords(
            await requestValue<unknown[]>(store.index('scope').getAll(scope)),
            args.accountId,
            args.workspaceId
          );
          const next = records
            .filter(
              (item) =>
                item.sessionId === current.sessionId &&
                item.id !== id &&
                item.stage === 'saved' &&
                !item.cancelRequested
            )
            .sort((a, b) => a.sequence - b.sequence)[0];
          if (next) await requestValue(store.put({ ...next, creation: current.creation }));
        }
        const canceled = { ...current, cancelRequested: true };
        await requestValue(store.put(canceled));
        return canceled;
      }),
    remove: (id) =>
      mutate(async (store) => {
        await requestValue(store.delete(key(id)));
      }),
    close: async () => {
      closed = true;
      if (opened) (await opened).close();
    },
  };
}

/** Cache repair must retain both the journal and every original replica it needs. */
export async function hasPendingSessionSends(
  factory: IDBFactory,
  accountId?: string
): Promise<boolean> {
  const databases = await factory.databases?.();
  if (databases && !databases.some((database) => database.name === SESSION_SEND_DATABASE))
    return false;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(SESSION_SEND_DATABASE);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, {
        keyPath: ['accountId', 'workspaceId', 'id'],
      });
      store.createIndex('scope', ['accountId', 'workspaceId']);
      store.createIndex('stage', 'stage');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    if (db.version !== 1 || !db.objectStoreNames.contains(STORE)) return true;
    const transaction = db.transaction(STORE, 'readonly');
    const done = transactionDone(transaction);
    void done.catch(() => {});
    const store = transaction.objectStore(STORE);
    if (accountId) {
      const values = await requestValue<SessionSendRecord[]>(store.getAll());
      await done;
      return values.some(
        (record) => record.accountId === accountId && record.stage !== 'delivered'
      );
    }
    const [total, delivered] = await Promise.all([
      requestValue(store.count()),
      requestValue(store.index('stage').count('delivered')),
    ]);
    await done;
    return total > delivered;
  } finally {
    db.close();
  }
}
