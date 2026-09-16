import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { LoroDoc } from 'loro-crdt';
import { createHistoryWriter, type SessionHistory, type SessionId } from '@lody/shared';
import { createSessionSendResources } from '../src/lib/session-send-resources';
import { createSessionSendJournal } from '../src/lib/session-send-journal';
import { createSessionSendJournalStorage } from '../src/lib/session-send-journal-storage';
import { prepareDraftAttachments } from '../src/lib/session-attachment-preparation';

const upload = vi.hoisted(() => ({
  run: undefined as undefined | ((file: File, signal: AbortSignal) => Promise<unknown>),
}));
vi.mock('../src/lib/session-image-upload', () => ({
  uploadSessionImage: (args: { file: File; signal: AbortSignal }) =>
    upload.run!(args.file, args.signal),
}));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function fixture() {
  const doc = new LoroDoc();
  const writer = createHistoryWriter(doc);
  const resources = createSessionSendResources({
    acquire: async () => {
      throw new Error('Unexpected borrow');
    },
    releaseRef: () => {},
  });
  const factory = new IDBFactory();
  const storage = createSessionSendJournalStorage({
    accountId: 'account',
    workspaceId: 'workspace',
    indexedDB: factory,
  });
  const locks = new Map<string, Promise<void>>();
  const journal = createSessionSendJournal({
    resources,
    storage,
    lock: async (key, _signal, execute) => {
      const previous = locks.get(key) ?? Promise.resolve();
      const release = Promise.withResolvers<void>();
      locks.set(
        key,
        previous.then(() => release.promise)
      );
      await previous;
      try {
        return await execute();
      } finally {
        release.resolve();
      }
    },
    prepareInput: (record, signal, checkpoint, report) =>
      prepareDraftAttachments({
        record,
        signal,
        checkpoint,
        report,
        resources,
        token: () => 'token',
        localMachineId: () => null,
      }),
    prepare: async (record) => writer.prepareAppend(record.entry),
    commit: async (record) => {
      writer.applyPrepared(record.update!);
    },
    deliver: async () => {},
  });
  cleanup.push(async () => {
    await resources.dispose();
    await journal.close();
    doc.free();
  });
  return { journal, writer, storage, factory };
}
const input = (id: string, names: string[]) => ({
  id,
  sessionId: 'session' as SessionId,
  accountId: 'account',
  workspaceId: 'workspace',
  sourceReplica: 'replica',
  entry: {
    id,
    role: 'user',
    userId: 'account',
    timestamp: '2026-01-01T00:00:00Z',
    items: [],
    fileDiff: [],
    inputConfig: {
      cliType: 'builtin',
      agentType: 'codex',
      inputBlocks: [{ type: 'text', text: 'keep this text' }],
    },
  } as SessionHistory,
  delivery: { kind: 'dispatch' as const },
  attachments: names.map((name) => ({
    id: name,
    kind: 'image' as const,
    source: new Blob([name]),
    name,
    mimeType: 'image/png',
    lastModified: 1,
  })),
});
const ready = (file: File) => ({
  imageId: file.name,
  mimeType: 'image/png',
  fileName: file.name,
  sizeBytes: file.size,
});

it('preserves the whole message and successful attachment receipts, retrying only failure', async () => {
  const f = fixture();
  const storedImages = new Set<string>();
  let rejectSecond = true;
  upload.run = async (file) => {
    if (file.name === 'second' && rejectSecond) throw new Error('Upload failed');
    if (storedImages.has(file.name)) throw new Error('Successful attachment uploaded twice');
    storedImages.add(file.name);
    return ready(file);
  };
  await f.journal.accept(input('message', ['first', 'second']));
  await expect(f.journal.retry('session' as SessionId)).rejects.toThrow('Upload failed');
  expect(f.writer.readStored()).toEqual([]);
  expect(
    (await f.storage.list())[0]?.attachments?.map((item) => [item.name, !!item.ready])
  ).toEqual([
    ['first', true],
    ['second', false],
  ]);
  rejectSecond = false;
  await f.journal.retry('session' as SessionId);
  const turns = f.writer.readStored();
  expect(turns).toHaveLength(1);
  expect(turns[0]?.items).toHaveLength(3);
  expect(JSON.stringify(turns[0])).toContain('keep this text');
  expect((await f.storage.list())[0]?.stage).toBe('delivered');
});

it('joins a late upload before cancel returns and never publishes the canceled message', async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const interrupted = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  upload.run = async (file, signal) => {
    signal.addEventListener('abort', () => interrupted.resolve(), { once: true });
    started.resolve();
    await finish.promise;
    return ready(file);
  };
  await f.journal.accept(input('canceled', ['late']));
  const work = f.journal.retry('session' as SessionId);
  await started.promise;
  let canceled = false;
  const cancellation = f.journal.cancel('canceled').then(() => {
    canceled = true;
  });
  await interrupted.promise;
  expect(canceled).toBe(false);
  finish.resolve();
  await Promise.allSettled([work, cancellation]);
  expect(canceled).toBe(true);
  expect(await f.storage.list()).toEqual([]);
  expect(f.writer.readStored()).toEqual([]);
});

it('rejects stale publication after a durable cancellation request in another storage connection', async () => {
  const f = fixture();
  const saved = await f.journal.accept(input('message', ['image']));
  const peer = createSessionSendJournalStorage({
    accountId: 'account',
    workspaceId: 'workspace',
    indexedDB: f.factory,
  });
  await peer.requestCancel!('message');
  await expect(
    f.storage.put({ ...saved, stage: 'prepared', update: new Uint8Array([1]) })
  ).rejects.toThrow('canceled');
  expect((await f.storage.list())[0]?.cancelRequested).toBe(true);
  await peer.close();
});

it('rechecks current billing eligibility after upload without retransmitting the successful file', async () => {
  const { createWorkspaceSessionSendJournal } =
    await import('../src/providers/workspace-session-send-journal');
  const { createConversationSession } = await import('../src/lib/conversation-view');
  const doc = new LoroDoc();
  const session = createConversationSession(doc, { sessionId: 'session' as SessionId });
  const store = {
    doc,
    sessionData: session.sessionData,
    history: session.history,
    getState: () => session.mirror.getState(),
  };
  const resources = createSessionSendResources({
    acquire: async () => store as never,
    releaseRef: () => {},
  });
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('navigator', {
    locks: {
      request: async (_key: string, _options: unknown, execute: () => Promise<unknown>) =>
        execute(),
    },
  });
  let checkoutPending = false;
  let uploaded = false;
  upload.run = async (file) => {
    if (uploaded) throw new Error('Already successful file was retransmitted');
    uploaded = true;
    checkoutPending = true;
    return ready(file);
  };
  const journal = createWorkspaceSessionSendJournal({
    accountId: 'account',
    sourceReplica: 'replica',
    token: () => 'token',
    localMachineId: () => null,
    getAdmissionContext: () => ({
      entitlement: { effectivePlanTier: 'free', checkoutPending },
      sessionCount: 1,
    }),
    runtime: {
      workspaceId: 'workspace',
      sendResources: resources,
      repo: {
        getDocMeta: async () => ({ meta: { id: 'session', machineId: 'machine' } }),
        flush: async () => {},
      },
      writer: { upsertDocMeta: async () => {} },
      requestSessionDispatchTurn: async () => null,
    } as never,
    waitForTargetSync: async () => {},
  });
  try {
    await journal.accept(input('message', ['image']));
    await expect(journal.retry('session' as SessionId)).rejects.toThrow('checkout');
    expect(session.historyWriter.readStored()).toEqual([]);
    expect(journal.getSnapshot()[0]?.attachments?.[0]?.ready).toBeDefined();
    checkoutPending = false;
    await journal.retry('session' as SessionId);
    expect(session.historyWriter.readStored()).toHaveLength(1);
  } finally {
    await resources.dispose();
    await journal.close();
    session.dispose();
    doc.free();
    vi.unstubAllGlobals();
  }
});

it('reopens saved source bytes and transfers a canceled creation to the next text message', async () => {
  const f = fixture();
  const creation = {
    id: 'session',
    machineId: 'machine',
    userId: 'account',
  } as import('@lody/shared').SessionMeta;
  await f.journal.accept({ ...input('first', ['original']), creation });
  await f.journal.accept(input('next', []));
  const peer = createSessionSendJournalStorage({
    accountId: 'account',
    workspaceId: 'workspace',
    indexedDB: f.factory,
  });
  const reopened = (await peer.list())[0]!;
  expect(await reopened.attachments![0]!.source.text()).toBe('original');
  await f.journal.cancel('first');
  expect((await peer.list()).map((row) => [row.id, row.creation])).toEqual([['next', creation]]);
  await f.journal.retry('session' as SessionId);
  expect(f.writer.readStored().map((turn) => turn.id)).toEqual(['next']);
  await peer.close();
});

it('preparing an already checkpointed input does not duplicate its attachment blocks', async () => {
  const { preparedDraftInput, buildDraftUserHistoryEntry } =
    await import('../src/lib/session-attachment-draft');
  const attachments = input('only', ['image']).attachments.map((item) => ({
    ...item,
    ready: { type: 'image' as const, imageId: item.id, mimeType: item.mimeType },
  }));
  const draft = buildDraftUserHistoryEntry(
    { userId: 'account', timestamp: '2026-01-01T00:00:00Z', inputBlocks: [] },
    attachments
  );
  expect(draft?.items).toEqual([]);
  const first = preparedDraftInput({ inputBlocks: [] }, attachments);
  expect(first).toHaveLength(1);
  expect(preparedDraftInput({ inputBlocks: first }, attachments)).toEqual(first);
});

it('keeps creation reachable when cancellation races a following message admission', async () => {
  const { acceptSessionUserTurn } = await import('../src/lib/session-send-admission');
  const f = fixture();
  const creation = {
    id: 'session',
    machineId: 'machine',
    userId: 'account',
  } as import('@lody/shared').SessionMeta;
  await f.journal.accept({ ...input('first', ['image']), creation });
  const admitting = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const runtime = {
    accountId: 'account',
    workspaceId: 'workspace',
    sourceReplica: 'replica',
    repo: { getDocMeta: async () => undefined },
    sendJournal: {
      ...f.journal,
      accept: async (record: Parameters<typeof f.journal.accept>[0]) => {
        admitting.resolve();
        await proceed.promise;
        return f.journal.accept(record);
      },
    },
  } as unknown as import('../src/atoms/runtime').WorkspaceRuntime;
  const next = input('next', []);
  const admission = acceptSessionUserTurn(runtime, next.sessionId, next.entry, next.delivery);
  await admitting.promise;
  await f.journal.cancel('first');
  proceed.resolve();
  await admission;
  await f.journal.retry(next.sessionId);
  expect((await f.storage.list()).find((record) => record.id === 'next')?.creation).toEqual(
    creation
  );
  expect(f.writer.readStored().map((turn) => turn.id)).toEqual(['next']);
});
