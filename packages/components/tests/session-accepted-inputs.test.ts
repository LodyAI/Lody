import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { LoroRepo } from 'loro-repo';
import { createLoroSessionData } from '@lody/shared/session-data';
import { createHistoryWriter, CURRENT_MACHINE_PROTOCOL_CAPABILITIES, getMachineRoomId, getSessionRoomId } from '@lody/shared';
import { createConversationSession } from '../src/lib/conversation-view';
import { createDirectWorkspaceWriter } from '../src/providers/workspace-writer-impl';
import { createWorkspacePendingSends } from '../src/providers/workspace-pending-sends';
import { acceptSessionUserTurn } from '../src/lib/session-send-admission';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { IDBFactory } from 'fake-indexeddb';
import { createAcceptedSessionInputs, SessionInputNotSentError } from '../src/lib/session-accepted-inputs';
import { createSessionInputStorage } from '../src/lib/session-input-storage';
import { createSessionSendResources } from '../src/lib/session-send-resources';
import type { PendingSessionSend } from '../src/lib/session-pending-sends';
import type { SessionHistory, SessionId } from '@lody/shared';
import type { SessionInputAcceptanceResult } from '@lody/shared/session-data';

const cleanup: (() => Promise<void>)[] = [];
const releaseOnCleanup: (() => void)[] = [];
afterEach(async () => { for (const release of releaseOnCleanup.splice(0)) release(); for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releaseOnCleanup.push(resolve);
  return { promise, resolve };
};
const send = (id = 'input-1', overrides: Partial<PendingSessionSend> = {}): PendingSessionSend => ({
  id, sessionId: 'input-session' as SessionId, workspaceId: 'input-workspace', sequence: 1,
  targetMachineId: 'target-machine' as PendingSessionSend['targetMachineId'], historyBackend: 'roost',
  entry: { id, role: 'user', userId: 'source-user', timestamp: '2026-10-13T00:00:00.000Z', status: 'pending', read: false,
    finished: true, fileDiff: [], items: [{ type: 'text', text: id }], inputConfig: { cliType: 'builtin', agentType: 'codex', inputBlocks: [{ type: 'text', text: id }] } } as SessionHistory,
  delivery: { kind: 'dispatch' }, attachments: [], ...overrides,
});
const when = (owner: ReturnType<typeof createAcceptedSessionInputs>, predicate: () => boolean) => new Promise<void>(resolve => {
  const check = () => { if (predicate()) { unsubscribe(); resolve(); } };
  const unsubscribe = owner.subscribe(check);
  check();
});
function harness(options: {
  factory?: IDBFactory; accountId?: string;
  write?: (input: PendingSessionSend, signal: AbortSignal) => Promise<SessionInputAcceptanceResult>;
  lookup?: (input: PendingSessionSend, signal: AbortSignal) => Promise<SessionInputAcceptanceResult>;
  deliver?: (input: PendingSessionSend, signal: AbortSignal) => Promise<void>;
  visible?: () => boolean;
  paused?: boolean;
  lock?: <T>(sessionId: SessionId, signal: AbortSignal, work: () => Promise<T>) => Promise<T>;
  canceled?: () => void;
} = {}) {
  const factory = options.factory ?? new IDBFactory();
  const storage = createSessionInputStorage(options.accountId ?? 'input-account', 'input-workspace', factory);
  if (options.canceled) {
    const patch = storage.patch;
    storage.patch = async (id, value) => {
      const result = await patch(id, value);
      if (value.canceled) options.canceled?.();
      return result;
    };
  }
  const resources = createSessionSendResources({ acquire: async () => { throw new Error('No session store needed in this storage/coordination test'); }, releaseRef: () => {} });
  const accepted = new Map<string, SessionHistory>();
  const delivered: string[] = [];
  const owner = createAcceptedSessionInputs({
    storage, resources, paused: options.paused,
    lock: options.lock ?? (async (_sessionId, _signal, work) => work()),
    write: options.write ?? (async input => { accepted.set(input.id, structuredClone(input.entry)); return { status: 'accepted', turnId: input.id, active: true }; }),
    lookup: options.lookup ?? (async input => accepted.has(input.id) ? { status: 'accepted', turnId: input.id, active: true } : { status: 'unobserved' }),
    deliver: options.deliver ?? (async input => { delivered.push(input.id); }),
    visible: async () => options.visible?.() ?? false,
    unknownMessage: () => 'Original send has no confirmed outcome',
  });
  cleanup.push(async () => { await owner.dispose(); await resources.dispose(); });
  return { storage, resources, owner, accepted, delivered, factory };
}

describe('locally accepted Roost input', () => {
  it('appears before storage or owner completion, freezes the input, and keeps one row until authoritative history lands', async () => {
    const entered = gate(), release = gate();
    const h = harness({ write: async input => { entered.resolve(); await release.promise; h.accepted.set(input.id, structuredClone(input.entry)); return { status: 'accepted', turnId: input.id, active: true }; } });
    const input = send();
    h.owner.enqueue(input);
    expect(h.owner.getSnapshot()).toMatchObject([{ id: input.id, inputState: 'saving', entry: { items: [{ text: 'input-1' }] } }]);
    input.entry.items![0] = { type: 'text', text: 'changed-after-acceptance' };
    await entered.promise;
    expect((await h.storage.get(input.id))?.state).toBe('unknown');
    release.resolve();
    await when(h.owner, () => h.owner.getSnapshot()[0]?.inputState === 'confirmed' && h.delivered.length === 1);
    expect(h.accepted.get(input.id)?.items).toEqual([{ type: 'text', text: 'input-1' }]);
    expect(h.owner.getSnapshot()).toHaveLength(1);
    await h.owner.acknowledgeLanded([input.id]);
    expect(h.owner.getSnapshot()).toEqual([]);
    expect(await h.storage.list()).toEqual([]);
  });

  it('queries lost confirmation and retries only the identical immutable input after a missing receipt', async () => {
    const h = harness({ write: async input => { h.accepted.set(input.id, structuredClone(input.entry)); throw new Error('confirmation-lost'); } });
    h.owner.enqueue(send());
    await when(h.owner, () => h.owner.getSnapshot()[0]?.inputState === 'unknown');
    expect(h.delivered).toEqual([]);
    expect(h.accepted.size).toBe(1);
    h.owner.retry('input-1');
    await when(h.owner, () => h.owner.getSnapshot()[0]?.inputState === 'confirmed' && h.delivered.length === 1);
    expect(h.accepted.size).toBe(1);
    expect(h.delivered).toEqual(['input-1']);

    let online = false;
    const noReceipt = harness({ write: async input => {
      if (!online) throw new Error('transport-unknown');
      noReceipt.accepted.set(input.id, structuredClone(input.entry));
      return { status: 'accepted', turnId: input.id, active: true };
    } });
    noReceipt.owner.enqueue(send('unobserved'));
    await when(noReceipt.owner, () => noReceipt.owner.getSnapshot()[0]?.inputState === 'unknown');
    expect((await noReceipt.storage.get('unobserved'))?.state).toBe('unknown');
    expect(noReceipt.accepted.size).toBe(0);
    expect(noReceipt.delivered).toEqual([]);
    online = true;
    await noReceipt.owner.resume();
    await when(noReceipt.owner, () => noReceipt.delivered.length === 1);
    expect([...noReceipt.accepted.keys()]).toEqual(['unobserved']);
    expect(noReceipt.accepted.get('unobserved')?.items).toEqual([{ type: 'text', text: 'unobserved' }]);
    expect(noReceipt.delivered).toEqual(['unobserved']);
  });

  it('keeps unknown outcome when its later lookup is refused before starting, and blocks later input', async () => {
    const h = harness({ write: async () => { throw new Error('write-outcome-unknown'); }, lookup: async () => { throw new SessionInputNotSentError('target-unavailable-now'); } });
    h.owner.enqueue(send('first'));
    await when(h.owner, () => h.owner.getSnapshot()[0]?.inputState === 'unknown');
    h.owner.enqueue(send('second'));
    await when(h.owner, () => h.owner.getSnapshot().some(row => row.id === 'first' && row.error === 'target-unavailable-now'));
    expect((await h.storage.get('first'))?.state).toBe('unknown');
    expect((await h.storage.get('second'))?.state).toBe('queued');
    expect(h.delivered).toEqual([]);
  });

  it('restores a saved unsent input, scopes accounts, and preserves admission order', async () => {
    const factory = new IDBFactory();
    const h = harness({ factory, paused: true });
    h.owner.enqueue(send('first')); h.owner.enqueue(send('second'));
    await when(h.owner, () => h.owner.getSnapshot().length === 2 && h.owner.getSnapshot().every(row => row.persisted));
    await h.owner.dispose();
    const other = harness({ factory, accountId: 'another-account', paused: true });
    await other.owner.refresh();
    expect(other.owner.getSnapshot()).toEqual([]);
    const restored = harness({ factory });
    await restored.owner.resume();
    await when(restored.owner, () => restored.delivered.length === 2);
    expect(restored.delivered).toEqual(['first', 'second']);
    expect(restored.owner.getSnapshot().map(row => row.id)).toEqual(['first', 'second']);
  });

  it('only retries a proven pre-handoff refusal and keeps the same identity', async () => {
    let capable = false;
    const h = harness({ write: async input => {
      if (!capable) throw new SessionInputNotSentError('owner-needs-update');
      h.accepted.set(input.id, structuredClone(input.entry)); return { status: 'accepted', turnId: input.id, active: true };
    } });
    h.owner.enqueue(send());
    await when(h.owner, () => h.owner.getSnapshot()[0]?.error === 'owner-needs-update');
    expect((await h.storage.get('input-1'))?.state).toBe('failed');
    capable = true; h.owner.retry('input-1');
    await when(h.owner, () => h.delivered.length === 1);
    expect([...h.accepted.keys()]).toEqual(['input-1']);
    expect(h.delivered).toEqual(['input-1']);
  });

  it('never resurrects an accepted input removed from its owner history', async () => {
    const h = harness({ write: async () => { throw new Error('ack-lost'); }, lookup: async input => ({ status: 'accepted', turnId: input.id, active: false }) });
    h.owner.enqueue(send());
    await when(h.owner, () => h.owner.getSnapshot()[0]?.inputState === 'unknown');
    h.owner.retry('input-1');
    await when(h.owner, () => h.owner.getSnapshot().length === 0);
    expect(h.delivered).toEqual([]);
    expect(await h.storage.list()).toEqual([]);
  });

  it('a close joins abort-ignoring owner work and leaves a recoverable receipt query without executing', async () => {
    const entered = gate(), aborted = gate(), release = gate();
    const h = harness({ write: async (input, signal) => {
      signal.addEventListener('abort', aborted.resolve, { once: true }); entered.resolve();
      await release.promise; h.accepted.set(input.id, structuredClone(input.entry));
      return { status: 'accepted', turnId: input.id, active: true };
    } });
    h.owner.enqueue(send()); await entered.promise;
    let closed = false;
    const closing = h.owner.dispose().then(() => { closed = true; });
    await aborted.promise;
    expect(closed).toBe(false);
    expect(h.delivered).toEqual([]);
    release.resolve(); await closing;
    const check = createSessionInputStorage('input-account', 'input-workspace', h.factory);
    expect((await check.get('input-1'))?.state).toBe('unknown');
    expect((await check.get('input-1'))?.send.entry.items).toEqual([{ type: 'text', text: 'input-1' }]);
    await check.close();
    expect(h.accepted.size).toBe(1);
    expect(h.delivered).toEqual([]);
  });

  it('cancel fences and joins the active source task, removes the local input and does not dispatch its late result', async () => {
    const entered = gate(), aborted = gate(), release = gate();
    const h = harness({ write: async (input, signal) => {
      signal.addEventListener('abort', aborted.resolve, { once: true }); entered.resolve();
      await release.promise; h.accepted.set(input.id, structuredClone(input.entry)); return { status: 'accepted', turnId: input.id, active: true };
    } });
    h.owner.enqueue(send()); await entered.promise;
    const cancel = h.owner.cancel('input-1'); await aborted.promise;
    expect(h.owner.getSnapshot()).toEqual([]);
    release.resolve(); await cancel;
    expect(await h.storage.get('input-1')).toBeUndefined();
    expect(h.delivered).toEqual([]);
  });

  it('cancels shared durable work even when the other window has not received its projection', async () => {
    const factory = new IDBFactory(), entered = gate(), release = gate(), canceled = gate();
    let tail = Promise.resolve();
    const lock = async <T>(_sessionId: SessionId, _signal: AbortSignal, work: () => Promise<T>) => {
      const prior = tail;
      const done = gate(); tail = done.promise;
      await prior;
      try { return await work(); } finally { done.resolve(); }
    };
    const right = harness({ factory, lock, canceled: canceled.resolve });
    await right.owner.refresh();
    const left = harness({ factory, lock, write: async input => {
      entered.resolve(); await release.promise;
      left.accepted.set(input.id, structuredClone(input.entry));
      return { status: 'accepted', turnId: input.id, active: true };
    } });
    left.owner.enqueue(send()); await entered.promise;
    expect(right.owner.getSnapshot()).toEqual([]);
    let done = false;
    const cancellation = right.owner.cancelSessions(['input-session' as SessionId]).then(() => { done = true; });
    await canceled.promise;
    expect(done).toBe(false);
    expect((await right.storage.get('input-1'))?.canceled).toBe(true);
    release.resolve(); await cancellation;
    expect(await right.storage.list()).toEqual([]);
    expect(left.delivered).toEqual([]);
    expect(left.accepted.size).toBe(1);
  });

  it('never reoffers a guide after an interrupted offer, even though owner acceptance is confirmed', async () => {
    const factory = new IDBFactory(), entered = gate(), aborted = gate(), release = gate();
    const first = harness({ factory, deliver: async (_input, signal) => {
      signal.addEventListener('abort', aborted.resolve, { once: true }); entered.resolve(); await release.promise;
    } });
    first.owner.enqueue(send('guide', { delivery: { kind: 'guide', expectedTurnId: 'assistant-1' } }));
    await entered.promise;
    expect((await first.storage.get('guide'))?.deliveryStarted).toBe(true);
    const closing = first.owner.dispose(); await aborted.promise; release.resolve(); await closing;
    const restored = harness({ factory, lookup: async input => ({ status: 'accepted', turnId: input.id, active: true }) });
    await restored.owner.resume();
    await when(restored.owner, () => restored.owner.getSnapshot()[0]?.inputState === 'confirmed');
    expect(restored.delivered).toEqual([]);
  });

  it('stores only prepared attachment references and refuses conflicting stored identities', async () => {
    const storage = createSessionInputStorage('input-account', 'input-workspace', new IDBFactory());
    const input = send('with-attachment', { attachments: [{ id: 'image-1', kind: 'image', name: 'diagram.png', mimeType: 'image/png', lastModified: 0,
      source: new Blob(['private-bytes']), ready: { type: 'image', imageId: 'uploaded-image', mimeType: 'image/png', sizeBytes: 13 } }] });
    const row = await storage.save(input);
    expect(row.send.attachments[0]).not.toHaveProperty('source');
    expect(row.send.attachments[0]?.ready).toMatchObject({ imageId: 'uploaded-image' });
    await expect(storage.save({ ...input, entry: { ...input.entry, items: [{ type: 'text', text: 'different' }] } })).rejects.toThrow('different content');
    expect((await storage.get(input.id))?.send.entry.items).toEqual([{ type: 'text', text: input.id }]);
    await storage.close();
  });

  it('saves creation metadata with ordinary undefined optional fields and restores its frozen target', async () => {
    const factory = new IDBFactory();
    const h = harness({ factory, paused: true });
    h.owner.enqueue(send('creation', { creation: {
      id: 'input-session' as SessionId, machineId: 'target-machine' as PendingSessionSend['targetMachineId'],
      historyBackend: 'roost', userId: 'source-user', acpSessionId: undefined, diffStats: undefined,
    } as PendingSessionSend['creation'] }));
    await when(h.owner, () => Boolean(h.owner.getSnapshot()[0]?.persisted));
    expect((await h.storage.get('creation'))?.send.creation).toMatchObject({ historyBackend: 'roost', machineId: 'target-machine' });
    expect((await h.storage.get('creation'))?.send.creation).not.toHaveProperty('acpSessionId');
  });

  it('keeps unsaved inputs visible across refresh and retries them in original admission order after storage recovers', async () => {
    const factory = new IDBFactory();
    const original = factory.open.bind(factory);
    let unavailable = true;
    vi.spyOn(factory, 'open').mockImplementation((name, version) => {
      if (unavailable) throw new Error('Synthetic storage unavailable');
      return original(name, version);
    });
    const h = harness({ factory });
    h.owner.enqueue(send('first')); h.owner.enqueue(send('second'));
    await when(h.owner, () => h.owner.getSnapshot().length === 2 && h.owner.getSnapshot().every(row => row.error));
    unavailable = false;
    await h.owner.refresh();
    expect(h.owner.getSnapshot().map(row => row.id)).toEqual(['first', 'second']);
    expect(h.delivered).toEqual([]);
    h.owner.retry('first');
    await when(h.owner, () => h.delivered.length === 2);
    expect(h.delivered).toEqual(['first', 'second']);
    expect((await h.storage.list()).map(row => row.id)).toEqual(['first', 'second']);
  });

  it.each([false, true])('holds a later control queue behind owner acceptance, including a stale second window: %s', async twoWindows => {
    const entered = gate(), release = gate(), leaseQueued = gate(), published = gate();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('BroadcastChannel', undefined);
    let tail = Promise.resolve();
    let leased = false;
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, options: { signal: AbortSignal }, work: () => Promise<unknown>) => {
      const prior = tail, done = gate(); tail = done.promise;
      if (leased) leaseQueued.resolve();
      await prior;
      if (options.signal.aborted) { done.resolve(); throw new DOMException('Canceled', 'AbortError'); }
      leased = true;
      try { return await work(); } finally { leased = false; done.resolve(); }
    } } });
    const input = send('first'), sessionId = input.sessionId;
    const repo = await LoroRepo.create({});
    const ownerDoc = new LoroDoc();
    const owner = createLoroSessionData({ sessionId, doc: ownerDoc, writer: createHistoryWriter(ownerDoc) });
    await repo.upsertDocMeta(getSessionRoomId(sessionId), { id: sessionId, machineId: input.targetMachineId, historyBackend: 'roost', userId: 'source-user' });
    await repo.upsertDocMeta(getMachineRoomId(input.targetMachineId!), { protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES });
    const handle = await repo.openPersistedDoc(getSessionRoomId(sessionId));
    const conversation = createConversationSession(handle.doc, { sessionId, backendKind: 'roost', createSessionData: () => ({
      ...owner, inputAcceptance: {
        targetMachineId: input.targetMachineId,
        accept: async entry => { entered.resolve(); await release.promise; await owner.commands.appendTurn(entry); return { status: 'accepted', turnId: entry.id, active: true }; },
        lookup: async entry => (await owner.history.readTurn(entry.id)).state === 'ready' ? { status: 'accepted', turnId: entry.id, active: true } : { status: 'unobserved' },
      },
    }) });
    const store = { sessionData: conversation.sessionData, history: conversation.history, setState: (change: never) => conversation.mirror.setState(change), waitUntilSynced: async () => {} };
    const makeRuntime = () => {
      const resources = createSessionSendResources({ acquire: async () => store as never, releaseRef: () => {} });
      const writer = createDirectWorkspaceWriter({ repo, acquireSessionStore: async () => store as never, releaseSessionStoreRef: () => {}, acquirePreviewVisualCommentStore: async () => { throw new Error('unused'); }, releasePreviewVisualCommentStoreRef: () => {} });
      const enqueueQueue = writer.enqueueSessionMessage;
      writer.enqueueSessionMessage = async (...args) => { await enqueueQueue(...args); published.resolve(); };
      const runtime = { repo, writer, sendResources: resources, workspaceId: input.workspaceId, requestSessionDispatchTurn: async () => ({ accepted: true }) } as unknown as WorkspaceRuntime;
      const pending = createWorkspacePendingSends({ runtime, accountId: 'input-account', workspaceId: input.workspaceId, token: () => null, localMachineId: () => input.targetMachineId ?? null });
      runtime.pendingSends = pending;
      cleanup.push(async () => { await pending.dispose(); await resources.dispose(); });
      return { runtime, pending };
    };
    cleanup.push(async () => { conversation.dispose(); ownerDoc.free(); await repo.unloadDoc(getSessionRoomId(sessionId)); await repo.destroy(); });
    const a = makeRuntime(), b = twoWindows ? makeRuntime() : a;
    if (twoWindows) await b.pending.resume();
    await acceptSessionUserTurn(a.runtime, sessionId, input.entry, { kind: 'dispatch' });
    await entered.promise;
    if (twoWindows) expect(b.pending.getSnapshot()).toEqual([]);
    const later = send('second');
    await acceptSessionUserTurn(b.runtime, sessionId, later.entry, { kind: 'queue' }, undefined, { userTurnId: later.id, task: 'second', timestamp: later.entry.timestamp });
    await leaseQueued.promise;
    expect(await owner.history.count()).toBe(0);
    expect(conversation.mirror.getState().mq ?? []).toEqual([]);
    if (!twoWindows) expect(b.pending.getSnapshot().map(row => row.id)).toEqual(['first', 'second']);
    release.resolve(); await published.promise;
    expect((await owner.history.readDirectory(0, 10)).map(row => row.turnId)).toEqual(['first']);
    expect(conversation.mirror.getState().mq?.map(row => row.userTurnId)).toEqual(['second']);
    expect((await repo.getDocMeta(getSessionRoomId(sessionId)))?.meta).toMatchObject({ latestUserMsgId: 'first' });
  });
});
