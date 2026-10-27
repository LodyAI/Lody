import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { LoroRepo } from 'loro-repo';
import { createLoroSessionData } from '@lody/shared/session-data';
import {
  createHistoryWriter,
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  getMachineRoomId,
  getSessionRoomId,
} from '@lody/shared';
import { createConversationSession } from '../src/lib/conversation-view';
import { createDirectWorkspaceWriter } from '../src/providers/workspace-writer-impl';
import { createWorkspacePendingSends } from '../src/providers/workspace-pending-sends';
import { acceptSessionUserTurn } from '../src/lib/session-send-admission';
import { createSessionSubmission } from '../src/lib/session-submission';
import * as localFileSender from '../src/lib/electron-session-file-sender';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { IDBFactory } from 'fake-indexeddb';
import {
  createAcceptedSessionInputs,
  SESSION_INPUT_SLOW_STAGE_MS,
  SessionInputNotSentError,
  type SessionInputDiagnostic,
} from '../src/lib/session-accepted-inputs';
import { createSessionInputStorage } from '../src/lib/session-input-storage';
import { createSessionSendResources } from '../src/lib/session-send-resources';
import type { PendingSessionSend } from '../src/lib/session-pending-sends';
import type { SessionHistory, SessionId, SessionInputBlock, SessionMeta } from '@lody/shared';
import type { SessionInputAcceptanceResult, SessionTurn } from '@lody/shared/session-data';

const cleanup: (() => Promise<void>)[] = [];
const releaseOnCleanup: (() => void)[] = [];
afterEach(async () => {
  for (const release of releaseOnCleanup.splice(0)) release();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releaseOnCleanup.push(resolve);
  return { promise, resolve };
};
const send = (id = 'input-1', overrides: Partial<PendingSessionSend> = {}): PendingSessionSend => ({
  id,
  sessionId: 'input-session' as SessionId,
  workspaceId: 'input-workspace',
  sequence: 1,
  targetMachineId: 'target-machine' as PendingSessionSend['targetMachineId'],
  historyBackend: 'roost',
  entry: {
    id,
    role: 'user',
    userId: 'source-user',
    timestamp: '2026-10-13T00:00:00.000Z',
    status: 'pending',
    read: false,
    finished: true,
    fileDiff: [],
    items: [{ type: 'text', text: id }],
    inputConfig: {
      cliType: 'builtin',
      agentType: 'codex',
      inputBlocks: [{ type: 'text', text: id }],
    },
  } as SessionHistory,
  delivery: { kind: 'dispatch' },
  attachments: [],
  ...overrides,
});
const when = (
  owner: Pick<ReturnType<typeof createAcceptedSessionInputs>, 'subscribe' | 'getSnapshot'>,
  predicate: () => boolean
) =>
  new Promise<void>((resolve) => {
    const check = () => {
      if (predicate()) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = owner.subscribe(check);
    check();
  });
function harness(
  options: {
    factory?: IDBFactory;
    accountId?: string;
    write?: (
      input: PendingSessionSend,
      signal: AbortSignal
    ) => Promise<SessionInputAcceptanceResult>;
    lookup?: (
      input: PendingSessionSend,
      signal: AbortSignal
    ) => Promise<SessionInputAcceptanceResult>;
    deliver?: (input: PendingSessionSend, signal: AbortSignal) => Promise<void>;
    visible?: () => boolean;
    paused?: boolean;
    lock?: <T>(sessionId: SessionId, signal: AbortSignal, work: () => Promise<T>) => Promise<T>;
    canceled?: () => void;
    confirmed?: (input: PendingSessionSend) => void;
  } = {}
) {
  const diagnostics: (SessionInputDiagnostic & { event: string })[] = [];
  const factory = options.factory ?? new IDBFactory();
  const storage = createSessionInputStorage(
    options.accountId ?? 'input-account',
    'input-workspace',
    factory
  );
  if (options.canceled) {
    const patch = storage.patch;
    storage.patch = async (id, value) => {
      const result = await patch(id, value);
      if (value.canceled) options.canceled?.();
      return result;
    };
  }
  const resources = createSessionSendResources({
    acquire: async () => {
      throw new Error('No session store needed in this storage/coordination test');
    },
    releaseRef: () => {},
  });
  const accepted = new Map<string, SessionHistory>();
  const delivered: string[] = [];
  const owner = createAcceptedSessionInputs({
    storage,
    resources,
    paused: options.paused,
    lock: options.lock ?? (async (_sessionId, _signal, work) => work()),
    write:
      options.write ??
      (async (input) => {
        accepted.set(input.id, structuredClone(input.entry));
        return { status: 'accepted', turnId: input.id, active: true };
      }),
    lookup:
      options.lookup ??
      (async (input) =>
        accepted.has(input.id)
          ? { status: 'accepted', turnId: input.id, active: true }
          : { status: 'unobserved' }),
    deliver:
      options.deliver ??
      (async (input) => {
        delivered.push(input.id);
      }),
    confirmed: options.confirmed,
    visible: async () => options.visible?.() ?? false,
    unknownMessage: () => 'Original send has no confirmed outcome',
    diagnose: (_level, event, details) => diagnostics.push({ event, ...details }),
  });
  cleanup.push(async () => {
    await owner.dispose();
    await resources.dispose();
  });
  return { storage, resources, owner, accepted, delivered, factory, diagnostics };
}

async function workspaceHarness(options: {
  accept(
    entry: SessionTurn,
    owner: ReturnType<typeof createLoroSessionData>
  ): Promise<SessionInputAcceptanceResult>;
  beforeAcquire?: () => Promise<void>;
  newSession?: boolean;
  paused?: boolean;
  leaseQueued?: () => void;
  queuePublished?: () => void;
  onDelivered?: (sessionId: SessionId, turnId: string) => void;
}) {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('BroadcastChannel', undefined);
  let tail = Promise.resolve();
  let leased = false;
  vi.stubGlobal('navigator', {
    locks: {
      request: async (
        _name: string,
        args: { signal: AbortSignal },
        work: () => Promise<unknown>
      ) => {
        const prior = tail,
          done = gate();
        tail = done.promise;
        if (leased) options.leaseQueued?.();
        await prior;
        if (args.signal.aborted) {
          done.resolve();
          throw new DOMException('Canceled', 'AbortError');
        }
        leased = true;
        try {
          return await work();
        } finally {
          leased = false;
          done.resolve();
        }
      },
    },
  });
  const input = send('first'),
    sessionId = input.sessionId;
  const repo = await LoroRepo.create({});
  const ownerDoc = new LoroDoc();
  const owner = createLoroSessionData({
    sessionId,
    doc: ownerDoc,
    writer: createHistoryWriter(ownerDoc),
  });
  const delivered: string[] = [];
  if (!options.newSession)
    await repo.upsertDocMeta(getSessionRoomId(sessionId), {
      id: sessionId,
      machineId: input.targetMachineId,
      historyBackend: 'roost',
      userId: 'source-user',
    });
  await repo.upsertDocMeta(getMachineRoomId(input.targetMachineId!), {
    protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  });
  const handle = await repo.openPersistedDoc(getSessionRoomId(sessionId));
  const conversation = createConversationSession(handle.doc, {
    sessionId,
    backendKind: 'roost',
    createSessionData: () => ({
      ...owner,
      history: { ...owner.history },
      inputAcceptance: {
        targetMachineId: input.targetMachineId,
        accept: (entry) => options.accept(entry, owner),
        acceptAndDispatch: async (entry) => {
          const receipt = await options.accept(entry, owner);
          if (receipt.status === 'accepted' && receipt.active) {
            delivered.push(entry.id);
            await repo.upsertDocMeta(getSessionRoomId(sessionId), { latestUserMsgId: entry.id });
          }
          return receipt;
        },
        lookup: async (entry) =>
          (await owner.history.readTurn(entry.id)).state === 'ready'
            ? { status: 'accepted', turnId: entry.id, active: true }
            : { status: 'unobserved' },
      },
    }),
  });
  const store = {
    doc: handle.doc,
    sessionData: conversation.sessionData,
    history: conversation.history,
    getState: () => conversation.mirror.getState(),
    setState: (change: never) => conversation.mirror.setState(change),
    waitUntilSynced: async () => {},
  };
  const makeRuntime = () => {
    const resources = createSessionSendResources({
      acquire: async () => {
        await options.beforeAcquire?.();
        return store as never;
      },
      releaseRef: () => {},
    });
    const writer = createDirectWorkspaceWriter({
      repo,
      acquireSessionStore: async () => store as never,
      releaseSessionStoreRef: () => {},
      acquirePreviewVisualCommentStore: async () => {
        throw new Error('unused');
      },
      releasePreviewVisualCommentStoreRef: () => {},
    });
    const enqueueQueue = writer.enqueueSessionMessage;
    writer.enqueueSessionMessage = async (...args) => {
      await enqueueQueue(...args);
      options.queuePublished?.();
    };
    const runtime = {
      repo,
      writer,
      sendResources: resources,
      workspaceId: input.workspaceId,
      requestSessionDispatchTurn: async (_machineId: unknown, request: { userTurnId: string }) => {
        delivered.push(request.userTurnId);
        return { accepted: true };
      },
    } as unknown as WorkspaceRuntime;
    const pending = createWorkspacePendingSends({
      runtime,
      paused: options.paused,
      accountId: 'input-account',
      workspaceId: input.workspaceId,
      token: () => null,
      localMachineId: () => input.targetMachineId ?? null,
      onDelivered: options.onDelivered,
    });
    runtime.pendingSends = pending;
    cleanup.push(async () => {
      await pending.dispose();
      await resources.dispose();
    });
    return { runtime, pending };
  };
  cleanup.push(async () => {
    conversation.dispose();
    ownerDoc.free();
    await repo.unloadDoc(getSessionRoomId(sessionId));
    await repo.destroy();
  });
  return { input, sessionId, repo, owner, conversation, delivered, makeRuntime };
}

describe('locally accepted Roost input', () => {
  it.each(['handoff', 'cancel-dispatch', 'cancel-guide'] as const)(
    'never lets the facade reclaim delivery after its row disappears: %s',
    async (phase) => {
      const fixture = await workspaceHarness({
        paused: phase !== 'handoff',
        accept: async (entry, owner) => {
          await owner.commands.appendTurn(entry);
          return { status: 'accepted', turnId: entry.id, active: true };
        },
      });
      const { runtime, pending } = fixture.makeRuntime();
      const guide = phase === 'cancel-guide';
      await acceptSessionUserTurn(
        runtime,
        fixture.sessionId,
        { ...fixture.input.entry, status: guide ? 'pending_apply' : 'pending' },
        guide ? { kind: 'guide', expectedTurnId: 'assistant-target' } : { kind: 'dispatch' }
      );
      if (phase === 'handoff') {
        await when(pending, () => !pending.has(fixture.input.id));
      } else await pending.cancel(fixture.input.id);
      expect(pending.has(fixture.input.id)).toBe(false);
      const entered = gate(),
        release = gate();
      fixture.conversation.sessionData.history.readTurn = async (id) => {
        entered.resolve();
        await release.promise;
        return fixture.owner.history.readTurn(id);
      };
      const submission = createSessionSubmission({
        runtime,
        assertSessionCreateAllowed: () => {},
        recordWorkspaceActivity: () => {},
        publishSessionMeta: () => {},
        readSessionMeta: () => undefined,
        recordChat: () => {},
        onRpcDelivered: () => {},
      });
      const result = guide
        ? submission.requestSessionSteer(fixture.sessionId, 'assistant-target', fixture.input.id)
        : submission.requestSessionDispatch(fixture.sessionId, fixture.input.id);
      expect(
        await Promise.race([
          result.then(() => 'still-owned'),
          entered.promise.then(() => 'reclaimed'),
        ])
      ).toBe('still-owned');
      expect(await fixture.owner.history.count()).toBe(phase === 'handoff' ? 1 : 0);
      expect(
        (await fixture.repo.getDocMeta(getSessionRoomId(fixture.sessionId)))?.meta?.latestUserMsgId
      ).toBe(phase === 'handoff' ? fixture.input.id : undefined);
      release.resolve();
    }
  );
  it('publishes an actual owner receipt before the source confirmation storage transaction completes', async () => {
    const entered = gate(),
      release = gate(),
      receipts = new Set<string>();
    const h = harness({ confirmed: (input) => receipts.add(input.id) });
    const patch = h.storage.patch;
    h.storage.patch = async (id, value) => {
      if (value.state === 'confirmed') {
        entered.resolve();
        await release.promise;
      }
      return patch(id, value);
    };
    h.owner.enqueue(send());
    await entered.promise;
    expect(receipts).toEqual(new Set(['input-1']));
    expect(h.accepted.get('input-1')?.items).toEqual([{ type: 'text', text: 'input-1' }]);
    expect((await h.storage.get('input-1'))?.state).toBe('unknown');
    expect(h.owner.getSnapshot()[0]?.inputState).toBe('sending');
    release.resolve();
    await when(h.owner, () => h.owner.getSnapshot()[0]?.inputState === 'confirmed');
  });
  it('refuses an older owner before consuming a new-session draft or publishing routing', async () => {
    const fixture = await workspaceHarness({
      newSession: true,
      accept: async () => {
        throw new Error('Older owner must not receive input');
      },
    });
    const { runtime, pending } = fixture.makeRuntime();
    await fixture.repo.upsertDocMeta(getMachineRoomId(fixture.input.targetMachineId!), {
      protocolCapabilities: { sessionHistory: 2, sessionInputAcceptance: 1 },
    });
    const creation = {
      id: fixture.sessionId,
      machineId: fixture.input.targetMachineId,
      historyBackend: 'roost',
      userId: 'source-user',
    } as SessionMeta;
    await expect(
      acceptSessionUserTurn(
        runtime,
        fixture.sessionId,
        fixture.input.entry,
        { kind: 'dispatch' },
        creation
      )
    ).rejects.toBeInstanceOf(SessionInputNotSentError);
    expect(pending.getSnapshot()).toEqual([]);
    expect(
      (await fixture.repo.getDocMeta(getSessionRoomId(fixture.sessionId)))?.meta?.id
    ).toBeUndefined();
    expect(await fixture.owner.history.count()).toBe(0);
  });
  it.each([false, true])(
    'hands ordinary input to the owner and publishes delivery without source history readback: new session %s',
    async (newSession) => {
      const ownerEntered = gate(),
        releaseOwner = gate(),
        sourceRead = gate(),
        releaseRead = gate();
      const delivered = new Set<string>();
      const fixture = await workspaceHarness({
        newSession,
        onDelivered: (_sessionId, turnId) => delivered.add(turnId),
        accept: async (entry, owner) => {
          ownerEntered.resolve();
          await releaseOwner.promise;
          await owner.commands.appendTurn(entry);
          return { status: 'accepted', turnId: entry.id, active: true };
        },
      });
      const { runtime, pending } = fixture.makeRuntime();
      fixture.conversation.sessionData.history.readTurn = async (id) => {
        sourceRead.resolve();
        await releaseRead.promise;
        return fixture.owner.history.readTurn(id);
      };
      const creation = newSession
        ? ({
            id: fixture.sessionId,
            machineId: fixture.input.targetMachineId,
            historyBackend: 'roost',
            userId: 'source-user',
          } as SessionMeta)
        : undefined;
      await acceptSessionUserTurn(
        runtime,
        fixture.sessionId,
        fixture.input.entry,
        { kind: 'dispatch' },
        creation
      );
      await ownerEntered.promise;
      expect(delivered.size).toBe(0);
      expect(pending.has(fixture.input.id)).toBe(true);
      const confirmed = when(pending, () => delivered.has(fixture.input.id));
      releaseOwner.resolve();
      await confirmed;
      expect(delivered).toEqual(new Set([fixture.input.id]));
      expect(await fixture.owner.history.readTurn(fixture.input.id)).toMatchObject({
        state: 'ready',
        turn: { id: fixture.input.id },
      });
      expect(
        (await fixture.repo.getDocMeta(getSessionRoomId(fixture.sessionId)))?.meta?.latestUserMsgId
      ).toBe(fixture.input.id);
      expect(fixture.delivered).toEqual([fixture.input.id]);
      releaseRead.resolve();
    }
  );
  it.each(['activate', 'removed'] as const)(
    'recovers committed ordinary input through the owner after a lost activation reply: %s',
    async (outcome) => {
      let committed = false;
      const releaseRead = gate();
      const fixture = await workspaceHarness({
        accept: async (entry, owner) => {
          if (!committed) {
            await owner.commands.appendTurn(entry);
            committed = true;
            throw new Error('activation-reply-lost');
          }
          if (outcome === 'removed')
            await owner.commands.applyHistoryAction({ kind: 'remove-turn', turnId: entry.id });
          return { status: 'accepted', turnId: entry.id, active: outcome === 'activate' };
        },
      });
      fixture.conversation.sessionData.history.readTurn = async (id) => {
        await releaseRead.promise;
        return fixture.owner.history.readTurn(id);
      };
      const { runtime, pending } = fixture.makeRuntime();
      await acceptSessionUserTurn(runtime, fixture.sessionId, fixture.input.entry, {
        kind: 'dispatch',
      });
      await when(pending, () => pending.getSnapshot()[0]?.inputState === 'unknown');
      expect(await fixture.owner.history.count()).toBe(1);
      expect(await fixture.owner.history.readTurn(fixture.input.id)).toMatchObject({
        state: 'ready',
        turn: { id: fixture.input.id },
      });
      expect(
        (await fixture.repo.getDocMeta(getSessionRoomId(fixture.sessionId)))?.meta?.latestUserMsgId
      ).toBeUndefined();
      pending.retry(fixture.input.id);
      if (outcome === 'activate') {
        // A directory entry alone cannot replace the only available local body.
        await when(pending, () => pending.getSnapshot()[0]?.inputState === 'confirmed');
        expect(pending.has(fixture.input.id)).toBe(true);
        releaseRead.resolve();
        const range = fixture.conversation.history.acquireRange(0, 1);
        await range.ready;
        await pending.resume();
        range.release();
      }
      await when(pending, () => !pending.has(fixture.input.id));
      expect(await fixture.owner.history.count()).toBe(outcome === 'activate' ? 1 : 0);
      expect(await fixture.owner.history.readTurn(fixture.input.id)).toMatchObject({
        state: outcome === 'activate' ? 'ready' : 'missing',
      });
      expect(
        (await fixture.repo.getDocMeta(getSessionRoomId(fixture.sessionId)))?.meta?.latestUserMsgId
      ).toBe(outcome === 'activate' ? fixture.input.id : undefined);
      expect(pending.getSnapshot()).toEqual([]);
      expect(fixture.delivered).toEqual(outcome === 'activate' ? [fixture.input.id] : []);
      releaseRead.resolve();
    }
  );
  it('appears before storage or owner completion, freezes the input, and keeps one row until authoritative history lands', async () => {
    const entered = gate(),
      release = gate();
    const h = harness({
      write: async (input) => {
        entered.resolve();
        await release.promise;
        h.accepted.set(input.id, structuredClone(input.entry));
        return { status: 'accepted', turnId: input.id, active: true };
      },
    });
    const input = send();
    h.owner.enqueue(input);
    expect(h.owner.getSnapshot()).toMatchObject([
      { id: input.id, inputState: 'saving', entry: { items: [{ text: 'input-1' }] } },
    ]);
    input.entry.items![0] = { type: 'text', text: 'changed-after-acceptance' };
    await entered.promise;
    expect((await h.storage.get(input.id))?.state).toBe('unknown');
    release.resolve();
    await when(
      h.owner,
      () => h.owner.getSnapshot()[0]?.inputState === 'confirmed' && h.delivered.length === 1
    );
    expect(h.accepted.get(input.id)?.items).toEqual([{ type: 'text', text: 'input-1' }]);
    expect(h.owner.getSnapshot()).toHaveLength(1);
    await h.owner.acknowledgeLanded([input.id]);
    expect(h.owner.getSnapshot()).toEqual([]);
    expect(await h.storage.list()).toEqual([]);
  });

  it('queries lost confirmation and retries only the identical immutable input after a missing receipt', async () => {
    const h = harness({
      write: async (input) => {
        h.accepted.set(input.id, structuredClone(input.entry));
        throw new Error('confirmation-lost');
      },
    });
    h.owner.enqueue(send());
    await when(h.owner, () => h.owner.getSnapshot()[0]?.inputState === 'unknown');
    expect(h.delivered).toEqual([]);
    expect(h.accepted.size).toBe(1);
    h.owner.retry('input-1');
    await when(
      h.owner,
      () => h.owner.getSnapshot()[0]?.inputState === 'confirmed' && h.delivered.length === 1
    );
    expect(h.accepted.size).toBe(1);
    expect(h.delivered).toEqual(['input-1']);

    let online = false;
    const noReceipt = harness({
      write: async (input) => {
        if (!online) throw new Error('transport-unknown');
        noReceipt.accepted.set(input.id, structuredClone(input.entry));
        return { status: 'accepted', turnId: input.id, active: true };
      },
    });
    noReceipt.owner.enqueue(send('unobserved'));
    await when(noReceipt.owner, () => noReceipt.owner.getSnapshot()[0]?.inputState === 'unknown');
    expect((await noReceipt.storage.get('unobserved'))?.state).toBe('unknown');
    expect(noReceipt.accepted.size).toBe(0);
    expect(noReceipt.delivered).toEqual([]);
    online = true;
    await noReceipt.owner.resume();
    await when(noReceipt.owner, () => noReceipt.delivered.length === 1);
    expect([...noReceipt.accepted.keys()]).toEqual(['unobserved']);
    expect(noReceipt.accepted.get('unobserved')?.items).toEqual([
      { type: 'text', text: 'unobserved' },
    ]);
    expect(noReceipt.delivered).toEqual(['unobserved']);
  });

  it('keeps unknown outcome when its later lookup is refused before starting, and blocks later input', async () => {
    const h = harness({
      write: async () => {
        throw new Error('write-outcome-unknown');
      },
      lookup: async () => {
        throw new SessionInputNotSentError('target-unavailable-now');
      },
    });
    h.owner.enqueue(send('first'));
    await when(h.owner, () => h.owner.getSnapshot()[0]?.inputState === 'unknown');
    h.owner.enqueue(send('second'));
    await when(h.owner, () =>
      h.owner
        .getSnapshot()
        .some((row) => row.id === 'first' && row.error === 'target-unavailable-now')
    );
    expect((await h.storage.get('first'))?.state).toBe('unknown');
    expect((await h.storage.get('second'))?.state).toBe('queued');
    expect(h.delivered).toEqual([]);
    // The client log names the input holding the conversation and what waits behind it.
    expect(h.diagnostics).toContainEqual({
      event: 'session_input.stalled',
      sessionId: 'input-session',
      inputId: 'first',
      waiting: 1,
      state: 'unknown',
      stage: 'lookup',
      error: 'target-unavailable-now',
    });
    expect(h.diagnostics.some((entry) => entry.inputId === 'second')).toBe(false);
  });

  it('reports a session lease another window never releases, without interrupting the wait', async () => {
    // Only the slow-stage timer is faked; IndexedDB keeps its own scheduling.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    cleanup.push(async () => {
      vi.useRealTimers();
    });
    const held = gate();
    const requested = gate();
    const h = harness({
      lock: async (_sessionId, _signal, work) => {
        requested.resolve();
        await held.promise;
        return work();
      },
    });
    h.owner.enqueue(send());
    await requested.promise;
    await vi.advanceTimersByTimeAsync(SESSION_INPUT_SLOW_STAGE_MS - 1);
    expect(h.diagnostics).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.diagnostics).toEqual([
      {
        event: 'session_input.slow',
        sessionId: 'input-session',
        stage: 'lock',
        elapsedMs: SESSION_INPUT_SLOW_STAGE_MS,
      },
    ]);
    held.resolve();
    await vi.waitFor(() => expect(h.delivered).toEqual(['input-1']));
  });

  it('restores a saved unsent input, scopes accounts, and preserves admission order', async () => {
    const factory = new IDBFactory();
    const h = harness({ factory, paused: true });
    h.owner.enqueue(send('first'));
    h.owner.enqueue(send('second'));
    await when(
      h.owner,
      () =>
        h.owner.getSnapshot().length === 2 && h.owner.getSnapshot().every((row) => row.persisted)
    );
    await h.owner.dispose();
    const other = harness({ factory, accountId: 'another-account', paused: true });
    await other.owner.refresh();
    expect(other.owner.getSnapshot()).toEqual([]);
    const restored = harness({ factory });
    await restored.owner.resume();
    await when(restored.owner, () => restored.delivered.length === 2);
    expect(restored.delivered).toEqual(['first', 'second']);
    expect(restored.owner.getSnapshot().map((row) => row.id)).toEqual(['first', 'second']);
  });

  it('only retries a proven pre-handoff refusal and keeps the same identity', async () => {
    let capable = false;
    const h = harness({
      write: async (input) => {
        if (!capable) throw new SessionInputNotSentError('owner-needs-update');
        h.accepted.set(input.id, structuredClone(input.entry));
        return { status: 'accepted', turnId: input.id, active: true };
      },
    });
    h.owner.enqueue(send());
    await when(h.owner, () => h.owner.getSnapshot()[0]?.error === 'owner-needs-update');
    expect((await h.storage.get('input-1'))?.state).toBe('failed');
    capable = true;
    h.owner.retry('input-1');
    await when(h.owner, () => h.delivered.length === 1);
    expect([...h.accepted.keys()]).toEqual(['input-1']);
    expect(h.delivered).toEqual(['input-1']);
    expect(h.diagnostics.map(({ event, state, stage }) => ({ event, state, stage }))).toEqual([
      { event: 'session_input.stalled', state: 'failed', stage: 'write' },
      { event: 'session_input.resolved', state: 'confirmed', stage: 'write' },
    ]);
  });

  it('never resurrects an accepted input removed from its owner history', async () => {
    const h = harness({
      write: async () => {
        throw new Error('ack-lost');
      },
      lookup: async (input) => ({ status: 'accepted', turnId: input.id, active: false }),
    });
    h.owner.enqueue(send());
    await when(h.owner, () => h.owner.getSnapshot()[0]?.inputState === 'unknown');
    h.owner.retry('input-1');
    await when(h.owner, () => h.owner.getSnapshot().length === 0);
    expect(h.delivered).toEqual([]);
    expect(await h.storage.list()).toEqual([]);
  });

  it('a close joins abort-ignoring owner work and leaves a recoverable receipt query without executing', async () => {
    const entered = gate(),
      aborted = gate(),
      release = gate();
    const h = harness({
      write: async (input, signal) => {
        signal.addEventListener('abort', aborted.resolve, { once: true });
        entered.resolve();
        await release.promise;
        h.accepted.set(input.id, structuredClone(input.entry));
        return { status: 'accepted', turnId: input.id, active: true };
      },
    });
    h.owner.enqueue(send());
    await entered.promise;
    let closed = false;
    const closing = h.owner.dispose().then(() => {
      closed = true;
    });
    await aborted.promise;
    expect(closed).toBe(false);
    expect(h.delivered).toEqual([]);
    release.resolve();
    await closing;
    const check = createSessionInputStorage('input-account', 'input-workspace', h.factory);
    expect((await check.get('input-1'))?.state).toBe('unknown');
    expect((await check.get('input-1'))?.send.entry.items).toEqual([
      { type: 'text', text: 'input-1' },
    ]);
    await check.close();
    expect(h.accepted.size).toBe(1);
    expect(h.delivered).toEqual([]);
  });

  it('cancel fences and joins the active source task, removes the local input and does not dispatch its late result', async () => {
    const entered = gate(),
      aborted = gate(),
      release = gate();
    const h = harness({
      write: async (input, signal) => {
        signal.addEventListener('abort', aborted.resolve, { once: true });
        entered.resolve();
        await release.promise;
        h.accepted.set(input.id, structuredClone(input.entry));
        return { status: 'accepted', turnId: input.id, active: true };
      },
    });
    h.owner.enqueue(send());
    await entered.promise;
    const cancel = h.owner.cancel('input-1');
    await aborted.promise;
    expect(h.owner.getSnapshot()).toEqual([]);
    release.resolve();
    await cancel;
    expect(await h.storage.get('input-1')).toBeUndefined();
    expect(h.delivered).toEqual([]);
  });

  it('cancels shared durable work even when the other window has not received its projection', async () => {
    const factory = new IDBFactory(),
      entered = gate(),
      release = gate(),
      canceled = gate();
    let tail = Promise.resolve();
    const lock = async <T>(_sessionId: SessionId, _signal: AbortSignal, work: () => Promise<T>) => {
      const prior = tail;
      const done = gate();
      tail = done.promise;
      await prior;
      try {
        return await work();
      } finally {
        done.resolve();
      }
    };
    const right = harness({ factory, lock, canceled: canceled.resolve });
    await right.owner.refresh();
    const left = harness({
      factory,
      lock,
      write: async (input) => {
        entered.resolve();
        await release.promise;
        left.accepted.set(input.id, structuredClone(input.entry));
        return { status: 'accepted', turnId: input.id, active: true };
      },
    });
    left.owner.enqueue(send());
    await entered.promise;
    expect(right.owner.getSnapshot()).toEqual([]);
    let done = false;
    const cancellation = right.owner.cancelSessions(['input-session' as SessionId]).then(() => {
      done = true;
    });
    await canceled.promise;
    expect(done).toBe(false);
    expect((await right.storage.get('input-1'))?.canceled).toBe(true);
    release.resolve();
    await cancellation;
    expect(await right.storage.list()).toEqual([]);
    expect(left.delivered).toEqual([]);
    expect(left.accepted.size).toBe(1);
  });

  it('never reoffers a guide after an interrupted offer, even though owner acceptance is confirmed', async () => {
    const factory = new IDBFactory(),
      entered = gate(),
      aborted = gate(),
      release = gate();
    const first = harness({
      factory,
      deliver: async (_input, signal) => {
        signal.addEventListener('abort', aborted.resolve, { once: true });
        entered.resolve();
        await release.promise;
      },
    });
    first.owner.enqueue(
      send('guide', { delivery: { kind: 'guide', expectedTurnId: 'assistant-1' } })
    );
    await entered.promise;
    expect((await first.storage.get('guide'))?.deliveryStarted).toBe(true);
    const closing = first.owner.dispose();
    await aborted.promise;
    release.resolve();
    await closing;
    const restored = harness({
      factory,
      lookup: async (input) => ({ status: 'accepted', turnId: input.id, active: true }),
    });
    await restored.owner.resume();
    await when(restored.owner, () => restored.owner.getSnapshot()[0]?.inputState === 'confirmed');
    expect(restored.delivered).toEqual([]);
  });

  it('stores only prepared attachment references and refuses conflicting stored identities', async () => {
    const storage = createSessionInputStorage('input-account', 'input-workspace', new IDBFactory());
    const input = send('with-attachment', {
      attachments: [
        {
          id: 'image-1',
          kind: 'image',
          name: 'diagram.png',
          mimeType: 'image/png',
          lastModified: 0,
          source: new Blob(['private-bytes']),
          ready: { type: 'image', imageId: 'uploaded-image', mimeType: 'image/png', sizeBytes: 13 },
        },
      ],
    });
    const row = await storage.save(input);
    expect(row.send.attachments[0]).not.toHaveProperty('source');
    expect(row.send.attachments[0]?.ready).toMatchObject({ imageId: 'uploaded-image' });
    await expect(
      storage.save({
        ...input,
        entry: { ...input.entry, items: [{ type: 'text', text: 'different' }] },
      })
    ).rejects.toThrow('different content');
    expect((await storage.get(input.id))?.send.entry.items).toEqual([
      { type: 'text', text: input.id },
    ]);
    await storage.close();
  });

  it('saves creation metadata with ordinary undefined optional fields and restores its frozen target', async () => {
    const factory = new IDBFactory();
    const h = harness({ factory, paused: true });
    h.owner.enqueue(
      send('creation', {
        creation: {
          id: 'input-session' as SessionId,
          machineId: 'target-machine' as PendingSessionSend['targetMachineId'],
          historyBackend: 'roost',
          userId: 'source-user',
          acpSessionId: undefined,
          diffStats: undefined,
        } as PendingSessionSend['creation'],
      })
    );
    await when(h.owner, () => Boolean(h.owner.getSnapshot()[0]?.persisted));
    expect((await h.storage.get('creation'))?.send.creation).toMatchObject({
      historyBackend: 'roost',
      machineId: 'target-machine',
    });
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
    h.owner.enqueue(send('first'));
    h.owner.enqueue(send('second'));
    await when(
      h.owner,
      () => h.owner.getSnapshot().length === 2 && h.owner.getSnapshot().every((row) => row.error)
    );
    unavailable = false;
    await h.owner.refresh();
    expect(h.owner.getSnapshot().map((row) => row.id)).toEqual(['first', 'second']);
    expect(h.delivered).toEqual([]);
    h.owner.retry('first');
    await when(h.owner, () => h.delivered.length === 2);
    expect(h.delivered).toEqual(['first', 'second']);
    expect((await h.storage.list()).map((row) => row.id)).toEqual(['first', 'second']);
  });

  it('admits a new conversation before store acquisition and records its human receipt before owner history', async () => {
    const entered = gate(),
      release = gate(),
      accepting = gate(),
      write = gate();
    const fixture = await workspaceHarness({
      newSession: true,
      beforeAcquire: async () => {
        entered.resolve();
        await release.promise;
      },
      accept: async (entry, owner) => {
        accepting.resolve();
        await write.promise;
        await owner.commands.appendTurn(entry);
        return { status: 'accepted', turnId: entry.id, active: true };
      },
    });
    const { input, sessionId, conversation, owner, repo } = fixture;
    const { runtime, pending } = fixture.makeRuntime();
    const creation = {
      id: sessionId,
      machineId: input.targetMachineId,
      historyBackend: 'roost',
      userId: 'source-user',
    } as SessionMeta;
    const admission = acceptSessionUserTurn(
      runtime,
      sessionId,
      input.entry,
      { kind: 'dispatch' },
      creation
    );
    expect(
      await Promise.race([admission.then(() => 'admitted'), entered.promise.then(() => 'blocked')])
    ).toBe('admitted');
    expect(pending.getSnapshot()).toMatchObject([{ id: input.id, entry: input.entry }]);
    expect((await repo.getDocMeta(getSessionRoomId(sessionId)))?.meta).toMatchObject(creation);
    await entered.promise;
    expect(conversation.mirror.getState().humanInputReceipts).toEqual({});
    expect(await owner.history.count()).toBe(0);
    release.resolve();
    await accepting.promise;
    expect(conversation.mirror.getState().humanInputReceipts).toEqual({
      [input.id]: { userId: 'source-user' },
    });
    expect(await owner.history.count()).toBe(0);
    write.resolve();
    await when(pending, () => pending.getSnapshot().length === 0);
    expect((await owner.history.readAll()).map((entry) => entry.id)).toEqual([input.id]);
    expect(fixture.delivered).toEqual([input.id]);
  });

  it.each(['image', 'file'] as const)(
    'accepts already prepared %s content through the shared history input parser',
    async (kind) => {
      const fixture = await workspaceHarness({
        accept: async (entry, owner) => {
          await owner.commands.appendTurn(entry);
          return { status: 'accepted', turnId: entry.id, active: true };
        },
      });
      const { input, sessionId, owner } = fixture;
      const { runtime, pending } = fixture.makeRuntime();
      const ready: SessionInputBlock =
        kind === 'image'
          ? { type: 'image', imageId: 'prepared-image', mimeType: 'image/png', sizeBytes: 13 }
          : {
              type: 'file',
              transport: 'local',
              fileId: 'prepared-file',
              fileName: 'input.txt',
              mimeType: 'text/plain',
              sizeBytes: 13,
              machineId: input.targetMachineId!,
              sha256: 'a'.repeat(64),
              textPreview: true,
              uploadedAt: 1,
            };
      await acceptSessionUserTurn(
        runtime,
        sessionId,
        input.entry,
        { kind: 'dispatch' },
        undefined,
        undefined,
        [
          {
            id: 'attachment',
            kind,
            name: kind === 'image' ? 'input.png' : 'input.txt',
            mimeType: ready.mimeType,
            lastModified: 0,
            ready,
          },
        ]
      );
      await when(
        pending,
        () => pending.getSnapshot().length === 0 || Boolean(pending.getSnapshot()[0]?.error)
      );
      expect(pending.getSnapshot()).toEqual([]);
      const history = await owner.history.readAll();
      expect(history).toMatchObject([
        { id: input.id, inputConfig: { inputBlocks: [ready, { type: 'text', text: input.id }] } },
      ]);
      expect(history).toHaveLength(1);
      expect(history[0]?.items?.[0]).toMatchObject({ type: kind });
      expect(history[0]?.items?.[0]).not.toHaveProperty('text');
      expect(fixture.delivered).toEqual([input.id]);
    }
  );

  it('retries attachment preparation and then the same durable input after an owner refusal', async () => {
    let transferReady = false,
      ownerReady = false;
    const transferred: string[] = [];
    vi.spyOn(localFileSender, 'canUseElectronLocalFileSend').mockReturnValue(true);
    vi.spyOn(localFileSender, 'sendSessionFileToLocalRuntime').mockImplementation(
      async ({ file, machineId }) => {
        if (!transferReady) throw new Error('Synthetic local transfer unavailable');
        transferred.push(await file.text());
        return {
          ok: true,
          files: [
            {
              type: 'file',
              transport: 'local',
              fileId: 'prepared-file',
              fileName: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
              machineId,
              sha256: 'a'.repeat(64),
              textPreview: true,
              uploadedAt: 1,
            },
          ],
        };
      }
    );
    const fixture = await workspaceHarness({
      accept: async (entry, owner) => {
        if (!ownerReady) throw new SessionInputNotSentError('Synthetic owner refusal');
        await owner.commands.appendTurn(entry);
        return { status: 'accepted', turnId: entry.id, active: true };
      },
    });
    const { input, sessionId, owner } = fixture;
    const { runtime, pending } = fixture.makeRuntime();
    const storage = createSessionInputStorage('input-account', input.workspaceId);
    cleanup.push(() => storage.close());
    await acceptSessionUserTurn(
      runtime,
      sessionId,
      input.entry,
      { kind: 'dispatch' },
      undefined,
      undefined,
      [
        {
          id: 'attachment',
          kind: 'file',
          source: new Blob(['synthetic attachment']),
          name: 'input.txt',
          mimeType: 'text/plain',
          lastModified: 0,
        },
      ]
    );
    await when(pending, () => Boolean(pending.getSnapshot()[0]?.error));
    expect(pending.getSnapshot()).toMatchObject([
      { id: input.id, attachments: [{ error: 'Missing workspace or auth token' }] },
    ]);
    expect(await storage.list()).toEqual([]);
    expect(await owner.history.count()).toBe(0);

    transferReady = true;
    pending.retry(input.id);
    await when(pending, () => pending.getSnapshot()[0]?.error === 'Synthetic owner refusal');
    const frozen = await storage.get(input.id);
    expect(frozen).toMatchObject({
      id: input.id,
      state: 'failed',
      send: { attachments: [{ ready: { fileId: 'prepared-file' } }] },
    });
    expect(frozen?.send.attachments[0]).not.toHaveProperty('source');
    expect(await owner.history.count()).toBe(0);
    expect(fixture.delivered).toEqual([]);

    ownerReady = true;
    pending.retry(input.id);
    await when(pending, () => pending.getSnapshot().length === 0);
    expect(await owner.history.readAll()).toEqual([frozen!.send.entry]);
    expect(fixture.delivered).toEqual([input.id]);
    expect(transferred).toEqual(['synthetic attachment']);
    expect(await storage.list()).toEqual([]);
  });

  it.each([false, true])(
    'holds a later control queue behind owner acceptance, including a stale second window: %s',
    async (twoWindows) => {
      const entered = gate(),
        release = gate(),
        leaseQueued = gate(),
        published = gate();
      const { input, sessionId, repo, owner, conversation, makeRuntime } = await workspaceHarness({
        accept: async (entry, historyOwner) => {
          entered.resolve();
          await release.promise;
          await historyOwner.commands.appendTurn(entry);
          return { status: 'accepted', turnId: entry.id, active: true };
        },
        leaseQueued: leaseQueued.resolve,
        queuePublished: published.resolve,
      });
      const a = makeRuntime(),
        b = twoWindows ? makeRuntime() : a;
      if (twoWindows) await b.pending.resume();
      await acceptSessionUserTurn(a.runtime, sessionId, input.entry, { kind: 'dispatch' });
      await entered.promise;
      expect(conversation.mirror.getState().humanInputReceipts).toEqual({
        [input.id]: { userId: 'source-user' },
      });
      if (twoWindows) expect(b.pending.getSnapshot()).toEqual([]);
      const later = send('second');
      await acceptSessionUserTurn(b.runtime, sessionId, later.entry, { kind: 'queue' }, undefined, {
        userTurnId: later.id,
        task: 'second',
        timestamp: later.entry.timestamp,
      });
      await leaseQueued.promise;
      expect(await owner.history.count()).toBe(0);
      expect(conversation.mirror.getState().mq ?? []).toEqual([]);
      if (!twoWindows)
        expect(b.pending.getSnapshot().map((row) => row.id)).toEqual(['first', 'second']);
      release.resolve();
      await published.promise;
      expect((await owner.history.readDirectory(0, 10)).map((row) => row.turnId)).toEqual([
        'first',
      ]);
      expect(conversation.mirror.getState().mq?.map((row) => row.userTurnId)).toEqual(['second']);
      expect(conversation.mirror.getState().humanInputReceipts).toEqual({
        first: { userId: 'source-user' },
        second: { userId: 'source-user' },
      });
      expect((await repo.getDocMeta(getSessionRoomId(sessionId)))?.meta).toMatchObject({
        latestUserMsgId: 'first',
      });
    }
  );
});
