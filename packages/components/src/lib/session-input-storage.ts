import { z } from 'zod';
import { HistoryEntryWriteSchema, SessionInputBlockSchema, parseHistoryWrite } from '@lody/shared';
import { encryptedLocalInstance, type E2eeLocalDataIdentity } from './e2ee-local-data';
import type { PendingSessionSend } from './session-pending-sends';

/** User data: a pending input can be the only copy and is not a recoverable cache. */
export const SESSION_INPUT_DATABASE = 'lody-session-inputs-v1';
const INPUTS = 'inputs';
const ORDER = 'order';
export type StoredSessionInput = {
  version: 1;
  accountId: string;
  workspaceId: string;
  id: string;
  sequence: number;
  send: PendingSessionSend;
  state: 'queued' | 'unknown' | 'confirmed' | 'failed';
  canceled: boolean;
  deliveryStarted: boolean;
  error?: string;
};
const sendSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    workspaceId: z.string().min(1),
    targetMachineId: z.string().min(1),
    historyBackend: z.literal('roost'),
    entry: HistoryEntryWriteSchema,
    creation: z.record(z.string(), z.json()).optional(),
    queue: z.record(z.string(), z.json()).optional(),
    delivery: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('history') }),
      z.object({ kind: z.literal('dispatch') }),
      z.object({ kind: z.literal('queue') }),
      z.object({ kind: z.literal('guide'), expectedTurnId: z.string().min(1) }),
    ]),
    attachments: z.array(
      z.object({
        id: z.string().min(1),
        kind: z.enum(['image', 'file']),
        name: z.string(),
        mimeType: z.string(),
        lastModified: z.number().finite(),
        ready: SessionInputBlockSchema,
      })
    ),
    sequence: z.number().int().positive(),
  })
  .superRefine((send, ctx) => {
    if (send.id !== send.entry.id || send.entry.role !== 'user' || !send.entry.userId?.trim()) {
      ctx.addIssue({ code: 'custom', message: 'Invalid stored input identity' });
    }
  });
const recordSchema = z
  .object({
    version: z.literal(1),
    accountId: z.string().min(1),
    workspaceId: z.string().min(1),
    id: z.string().min(1),
    sequence: z.number().int().positive(),
    send: sendSchema,
    state: z.enum(['queued', 'unknown', 'confirmed', 'failed']),
    canceled: z.boolean(),
    deliveryStarted: z.boolean(),
    error: z.string().optional(),
  })
  .superRefine((row, ctx) => {
    if (
      row.id !== row.send.id ||
      row.workspaceId !== row.send.workspaceId ||
      row.sequence !== row.send.sequence
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid stored input scope' });
    }
  });
const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Input storage request failed'));
  });

export function createSessionInputStorage(
  accountId: string,
  workspaceId: string,
  factory?: IDBFactory,
  identity?: E2eeLocalDataIdentity
) {
  if (identity && (identity.accountId !== accountId || identity.workspaceId !== workspaceId))
    throw new Error('e2ee_local_identity_mismatch');
  const database = identity
    ? `${SESSION_INPUT_DATABASE}:${encryptedLocalInstance(identity)}`
    : SESSION_INPUT_DATABASE;
  const scope = [accountId, workspaceId];
  let opening: Promise<IDBDatabase> | undefined;
  let closed = false;
  const open = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (closed) {
        reject(new Error('Input storage is closed'));
        return;
      }
      const req = (factory ?? indexedDB).open(database, 1);
      req.onupgradeneeded = () => {
        const rows = req.result.createObjectStore(INPUTS, {
          keyPath: ['accountId', 'workspaceId', 'id'],
        });
        rows.createIndex('scope', ['accountId', 'workspaceId']);
        req.result.createObjectStore(ORDER);
      };
      req.onerror = () => reject(req.error ?? new Error('Input storage could not open'));
      req.onblocked = () => reject(new Error('Input storage upgrade is blocked'));
      req.onsuccess = () => {
        const db = req.result;
        if (closed) {
          db.close();
          reject(new Error('Input storage is closed'));
          return;
        }
        db.onversionchange = () => {
          db.close();
          opening = undefined;
        };
        resolve(db);
      };
    }).catch((error) => {
      opening = undefined;
      throw error;
    }));
  const transact = async <T>(
    mode: IDBTransactionMode,
    fn: (tx: IDBTransaction) => Promise<T>
  ): Promise<T> => {
    if (closed) throw new Error('Input storage is closed');
    const db = await open();
    const tx = db.transaction([INPUTS, ORDER], mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Input storage transaction aborted'));
      tx.onerror = () => {};
    });
    try {
      const result = await fn(tx);
      await done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {}
      await done.catch(() => {});
      throw error;
    }
  };
  const decode = (value: unknown): StoredSessionInput => {
    const parsed = recordSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.accountId !== accountId ||
      parsed.data.workspaceId !== workspaceId
    ) {
      throw new Error('Invalid stored input; recovery stopped without sending it');
    }
    return parsed.data as unknown as StoredSessionInput;
  };
  const key = (id: string) => [...scope, id];
  return {
    list: () =>
      transact('readonly', async (tx) =>
        (await request<unknown[]>(tx.objectStore(INPUTS).index('scope').getAll(scope)))
          .map(decode)
          .sort((a, b) => a.sequence - b.sequence)
      ),
    get: (id: string) =>
      transact('readonly', async (tx) => {
        const value: unknown = await request(tx.objectStore(INPUTS).get(key(id)));
        return value === undefined ? undefined : decode(value);
      }),
    save: (send: PendingSessionSend) =>
      transact('readwrite', async (tx) => {
        const store = tx.objectStore(INPUTS);
        const existing: unknown = await request(store.get(key(send.id)));
        const clean = (sequence: number) =>
          sendSchema.parse({
            ...send,
            sequence,
            entry: parseHistoryWrite(HistoryEntryWriteSchema, send.entry),
            creation:
              send.creation === undefined ? undefined : JSON.parse(JSON.stringify(send.creation)),
            queue: send.queue === undefined ? undefined : JSON.parse(JSON.stringify(send.queue)),
            attachments: send.attachments.map(({ source: _source, ...attachment }) => attachment),
          });
        if (existing !== undefined) {
          const prior = decode(existing);
          if (JSON.stringify(prior.send) !== JSON.stringify(clean(prior.sequence)))
            throw new Error('Stored input identity was reused with different content');
          return prior;
        }
        const order = tx.objectStore(ORDER);
        const previous: unknown = await request(order.get(scope));
        if (
          previous !== undefined &&
          (typeof previous !== 'number' || !Number.isSafeInteger(previous) || previous < 0)
        )
          throw new Error('Invalid input admission order');
        const sequence = (typeof previous === 'number' ? previous : 0) + 1;
        const row = decode({
          version: 1,
          accountId,
          workspaceId,
          id: send.id,
          sequence,
          send: clean(sequence),
          state: 'queued',
          canceled: false,
          deliveryStarted: false,
        });
        await request(order.put(sequence, scope));
        await request(store.add(row));
        return row;
      }),
    patch: (
      id: string,
      patch: Partial<Pick<StoredSessionInput, 'state' | 'error' | 'canceled' | 'deliveryStarted'>>
    ) =>
      transact('readwrite', async (tx) => {
        const store = tx.objectStore(INPUTS);
        const value: unknown = await request(store.get(key(id)));
        if (value === undefined) return undefined;
        const row = decode({ ...decode(value), ...patch });
        await request(store.put(row));
        return row;
      }),
    /** Terminal authenticated membership removal only, after this workspace stops. */
    removeWorkspace: () =>
      transact('readwrite', async (tx) => {
        const store = tx.objectStore(INPUTS);
        const keys = await request(store.index('scope').getAllKeys(scope));
        for (const owned of keys) await request(store.delete(owned));
        await request(tx.objectStore(ORDER).delete(scope));
      }),
    remove: (id: string) =>
      transact('readwrite', async (tx) => {
        await request(tx.objectStore(INPUTS).delete(key(id)));
      }),
    close: async () => {
      closed = true;
      const db = await opening?.catch(() => undefined);
      db?.close();
    },
  };
}
export type SessionInputStorage = ReturnType<typeof createSessionInputStorage>;
