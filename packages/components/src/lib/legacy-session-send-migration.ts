/**
 * One-time migration of the retired durable send journal (IndexedDB
 * `lody-session-send-v1`, record versions 1–4). Self-contained so it can be
 * deleted once no supported build can have written that database.
 */
import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  isSessionHistoryStatusAwaitingStart,
  type MessageQueueItem,
  type SessionHistory,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import type { SessionAttachmentDraft } from './session-attachment-draft';
import { finalizePreparedSend } from './session-attachment-preparation';
import {
  dispatchUserTurn,
  writeUserTurn,
  type SessionSendRuntime,
} from './session-send-delivery';

export const LEGACY_SESSION_SEND_DATABASE = 'lody-session-send-v1';
const STORE = 'submissions';
const LOCK = 'lody-legacy-session-send-migration';

/** The fields of the retired record this migration still reads. */
type LegacySessionSendRecord = {
  version: number;
  id: string;
  sessionId: SessionId;
  accountId: string;
  workspaceId: string;
  sequence: number;
  entry: SessionHistory;
  creation?: SessionMeta;
  queue?: Record<string, unknown>;
  attachments?: SessionAttachmentDraft[];
  delivery: { kind: 'queue' | 'dispatch' } | { kind: 'guide'; expectedTurnId: string };
  stage: 'saved' | 'prepared' | 'committed' | 'delivered';
  cancelRequested?: boolean;
  guideOffer?: 'offered' | 'applied' | 'not-applied' | 'recovered';
};

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Legacy send storage request failed'));
  });

/** Open the retired database only if it exists; never create it. */
async function openExisting(factory: IDBFactory): Promise<IDBDatabase | null> {
  const listed = await factory.databases?.().catch(() => undefined);
  if (listed && !listed.some((database) => database.name === LEGACY_SESSION_SEND_DATABASE))
    return null;
  return new Promise((resolve, reject) => {
    const open = factory.open(LEGACY_SESSION_SEND_DATABASE);
    let absent = false;
    open.onupgradeneeded = () => {
      // A fresh version means it did not exist; aborting leaves nothing behind.
      absent = true;
      open.transaction?.abort();
    };
    open.onsuccess = () => {
      const db = open.result;
      if (db.objectStoreNames.contains(STORE)) resolve(db);
      else {
        db.close();
        resolve(null);
      }
    };
    open.onerror = (event) => {
      if (absent) {
        event.preventDefault();
        resolve(null);
      } else reject(open.error ?? new Error('Legacy send storage is unavailable'));
    };
  });
}

async function readScope(db: IDBDatabase, accountId: string, workspaceId: string) {
  const transaction = db.transaction(STORE, 'readonly');
  const values = await request<unknown[]>(
    transaction.objectStore(STORE).index('scope').getAll([accountId, workspaceId])
  );
  return values.filter(
    (value): value is LegacySessionSendRecord =>
      !!value &&
      typeof value === 'object' &&
      typeof (value as LegacySessionSendRecord).id === 'string' &&
      (value as LegacySessionSendRecord).entry?.id === (value as LegacySessionSendRecord).id
  );
}

async function removeRow(db: IDBDatabase, record: LegacySessionSendRecord) {
  const transaction = db.transaction(STORE, 'readwrite');
  await request(transaction.objectStore(STORE).delete([record.accountId, record.workspaceId, record.id]));
}

async function isPresent(runtime: SessionSendRuntime, record: LegacySessionSendRecord) {
  return runtime.sendResources.withSessionStore(record.sessionId, async (store) => {
    if ((await store.sessionData.history.readTurn(record.id)).state !== 'missing') return true;
    return ((store.getState().mq ?? []) as MessageQueueItem[]).some(
      (item) => item.userTurnId === record.id
    );
  });
}

/** Resolves once the record needs nothing more; rejects to retry at next start. */
async function migrateRecord(runtime: SessionSendRuntime, record: LegacySessionSendRecord) {
  if (record.stage === 'delivered' || record.cancelRequested) return;
  // The daemon may already hold an offered guide; replaying it could run it twice.
  if (record.delivery.kind === 'guide' && record.guideOffer === 'offered') return;
  if (record.attachments?.some((attachment) => !attachment.ready)) {
    console.warn('Dropped a pending message whose attachments never finished uploading', {
      sessionId: record.sessionId,
      turnId: record.id,
    });
    return;
  }
  const found = await runtime.repo.getDocMeta(getSessionRoomId(record.sessionId));
  if (isLoroRepoDocDeleted(found)) return;
  const meta = found?.meta as SessionMeta | undefined;
  if (!meta?.id && !record.creation) return;
  // An unoffered or refused guide targeted a turn that has long ended.
  const followUp =
    record.delivery.kind === 'dispatch' ||
    (record.delivery.kind === 'guide' &&
      record.guideOffer !== 'applied' &&
      record.guideOffer !== 'recovered');
  // Version 2 `committed` was already written by its own window's replica; a
  // fresh replica may not have synchronized it yet, so never append it again.
  const written = record.stage === 'committed' && record.version !== 4;
  if (!written && !(await isPresent(runtime, record))) {
    const { entry, queue } = record.attachments?.length
      ? finalizePreparedSend({
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          entry: record.entry,
          queue: record.queue,
          attachments: record.attachments,
        })
      : record;
    await writeUserTurn(runtime, {
      sessionId: record.sessionId,
      entry: followUp && entry.status === 'pending_apply' ? { ...entry, status: 'pending' } : entry,
      delivery: record.queue ? { kind: 'queue' } : { kind: followUp ? 'dispatch' : 'history' },
      creation: record.creation,
      queue,
    });
  }
  if (!followUp || record.queue || meta?.isArchived) return;
  const turn = await runtime.sendResources.withSessionStore(record.sessionId, async (store) => {
    await store.sessionData.commands.applyHistoryAction({
      kind: 'user-status',
      turnId: record.id,
      status: 'pending',
      onlyPendingApply: true,
    });
    return store.sessionData.history.readTurn(record.id);
  });
  if (turn.state !== 'ready' || !isSessionHistoryStatusAwaitingStart(turn.turn.status)) return;
  void dispatchUserTurn(runtime, record.sessionId, record.id, {
    machineId: meta?.machineId ?? record.creation?.machineId ?? null,
  }).catch((error: unknown) => {
    console.warn('Migrated pending message dispatch failed', { turnId: record.id, error });
  });
}

/**
 * Write this account/workspace's leftover journal records as ordinary local
 * sends, delete the rows it handled, and delete the database once it is empty.
 */
export async function migrateLegacySessionSends(args: {
  accountId: string;
  workspaceId: string;
  runtime: SessionSendRuntime;
  indexedDB?: IDBFactory;
}): Promise<void> {
  const factory = args.indexedDB ?? globalThis.indexedDB;
  if (!factory) return;
  const run = async () => {
    const db = await openExisting(factory);
    if (!db) return;
    let remaining = 0;
    try {
      const records = await readScope(db, args.accountId, args.workspaceId);
      for (const record of records.sort((a, b) => a.sequence - b.sequence)) {
        try {
          await migrateRecord(args.runtime, record);
          await removeRow(db, record);
        } catch (error) {
          console.warn('Pending message migration will be retried at next start', {
            turnId: record.id,
            error,
          });
        }
      }
      const transaction = db.transaction(STORE, 'readonly');
      remaining = await request(transaction.objectStore(STORE).count());
    } finally {
      db.close();
    }
    if (remaining === 0)
      await new Promise<void>((resolve) => {
        const deletion = factory.deleteDatabase(LEGACY_SESSION_SEND_DATABASE);
        deletion.onsuccess = () => resolve();
        deletion.onerror = () => resolve();
        deletion.onblocked = () => resolve();
      });
  };
  // Windows keep separate replicas; one migrator at a time sees deleted rows.
  if (typeof navigator !== 'undefined' && navigator.locks)
    await navigator.locks.request(LOCK, run);
  else await run();
}
