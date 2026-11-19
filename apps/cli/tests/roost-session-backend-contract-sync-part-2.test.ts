import { resolveLatestSessionGoalFromHistory, type SessionGoalMessage } from '@lody/shared';
import {
  hashHistoryEntryForVersion,
  hashText,
  type HistoryImportInput,
} from '@lody/shared/session-data';
import { Identity } from '@loro-dev/roost';
import { RoostNativeClient } from '@loro-dev/roost-node';
import { NodeLodyHistory } from '@loro-dev/roost/lody-history';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MessageHandler } from '../src/lib/message-handler';
import { RoostDispatchIndex } from '../src/session/roost-dispatch-index';
import { RoostHistoryGeneration } from '../src/session/roost-history-generation';
import { loadRoostOwnerSeedLegacy } from '../src/session/roost-writer-identity';
import {
  invalidateGoalIndex,
  nativeAssistant,
  nativeDirectory,
  nativeFixture,
  nativeUser,
  nextOrdinal,
  registerRoostNativeBackendSuite,
} from './roost-session-backend-test-helpers';

registerRoostNativeBackendSuite();
describe('Production Roost history semantics (projections, patches and goals)', () => {
  it('reads a persisted old goal without history bodies and returns an isolated goal', async () => {
    let fixture = await nativeFixture();
    const id = fixture.doc.sessionId;
    const goal = {
      type: 'goal' as const,
      threadId: 'old',
      objective: 'Retain',
      status: 'active' as const,
    };
    await fixture.backend.appendHistoryTurn({ ...nativeAssistant('old-goal'), items: [goal] });
    for (let i = 0; i < 45; i++) await fixture.backend.appendHistoryTurn(nativeUser(`plain-${i}`));
    await fixture.close();
    fixture = await nativeFixture(id);
    const readGoal = fixture.backend.readLatestGoal;
    if (!readGoal) throw new Error('Missing Native goal query');
    const full = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranch')
      .mockRejectedValue(new Error('body unavailable'));
    const page = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage')
      .mockRejectedValue(new Error('body unavailable'));
    try {
      const actual = await readGoal();
      expect(actual).toEqual(goal);
      if (actual) actual.objective = 'caller mutation';
      expect(await readGoal()).toEqual(goal);
    } finally {
      full.mockRestore();
      page.mockRestore();
    }
  });

  it('scans an unknown goal projection through state overlays without retaining old bodies or publishing it', async () => {
    let fixture = await nativeFixture();
    const id = fixture.doc.sessionId;
    const goal = (status: 'active' | 'paused'): SessionGoalMessage => ({
      type: 'goal',
      threadId: 'scan',
      objective: 'Retain',
      status,
    });
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('first-goal'),
      items: [goal('active')],
    });
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('newer-goal'),
      items: [goal('active')],
    });
    for (let i = 0; i < 45; i++)
      await fixture.backend.appendHistoryTurn(nativeUser(`scan-plain-${i}`));
    await fixture.backend.applyHistoryAction({
      kind: 'upsert-turn',
      turn: { ...nativeAssistant('newer-goal'), items: [goal('paused')] } as never,
    });
    const reference = resolveLatestSessionGoalFromHistory(await fixture.backend.readHistory());
    const seed = await loadRoostOwnerSeedLegacy(join(nativeDirectory, 'history.db'));
    const client = new RoostNativeClient({
      dbPath: join(nativeDirectory, 'history.db'),
      seed,
      allowedOwners: [Identity.fromSeed(seed).owner()],
      maxQueuedRequests: 32,
      maxQueuedBytes: 8 * 1024 * 1024,
    });
    await client.ready;
    const host = client.stream(`lody-session:${id}`);
    const key = { table: 'lody_goal_projection_v1', key: new Uint8Array() };
    const invalid = new TextEncoder().encode('{invalid');
    try {
      await host.writeBatch([], { indexPuts: [{ ...key, value: invalid }] });
      await fixture.close();
      fixture = await nativeFixture(id);
      const readGoal = fixture.backend.readLatestGoal;
      if (!readGoal) throw new Error('Missing Native goal query');
      const full = vi
        .spyOn(NodeLodyHistory.prototype, 'readActiveBranch')
        .mockRejectedValue(new Error('whole read forbidden'));
      try {
        expect(await readGoal()).toEqual(reference);
        expect(await host.readIndex([key])).toEqual([invalid]);
        const body = new Error('old body unavailable');
        const page = vi
          .spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage')
          .mockRejectedValue(body);
        const indexed = vi
          .spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages')
          .mockRejectedValue(body);
        try {
          expect(await readGoal()).toEqual(reference);
          await expect(fixture.backend.history.readAt(0)).rejects.toBe(body);
          expect(await fixture.backend.history.readAt(46)).toMatchObject({
            state: 'ready',
            turn: { id: 'scan-plain-44' },
          });
        } finally {
          page.mockRestore();
          indexed.mockRestore();
        }
      } finally {
        full.mockRestore();
      }
    } finally {
      await client.close();
    }
  });

  it('preserves GC metadata fallback, non-active overrides and read failures', async () => {
    const fixture = await nativeFixture();
    const legacy: SessionGoalMessage = {
      type: 'goal',
      threadId: 'legacy',
      objective: 'Retain',
      status: 'active',
    };
    const ports = {
      workspaceDocument: {
        peekSessionDoc: () => undefined,
        // Not native: an uncached Session is opened, never read from the engine.
        openIdleSessionReader: async () => undefined,
        getOrCreateSessionDoc: async () => ({ getMetaState: async () => ({ latestGoal: legacy }) }),
      },
      getSessionBackend: async () => fixture.backend,
    };
    const receiver = ports as unknown as MessageHandler;
    expect(await MessageHandler.prototype.hasActiveGoal.call(receiver, fixture.doc.sessionId)).toBe(
      true
    );
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('cleared-goal'),
      items: [{ ...legacy, status: 'cleared' }],
    });
    expect(await MessageHandler.prototype.hasActiveGoal.call(receiver, fixture.doc.sessionId)).toBe(
      false
    );
    const failure = new Error('goal read failed');
    const failed = {
      ...ports,
      getSessionBackend: async () => ({
        readLatestGoal: async () => {
          throw failure;
        },
      }),
    } as unknown as MessageHandler;
    await expect(
      MessageHandler.prototype.hasActiveGoal.call(failed, fixture.doc.sessionId)
    ).rejects.toBe(failure);
    const rpc = {
      ...ports,
      getSessionBackend: async () => ({
        readLatestGoal: async () => ({ ...legacy, status: 'paused' }),
      }),
    } as unknown as MessageHandler;
    expect(await MessageHandler.prototype.hasActiveGoal.call(rpc, fixture.doc.sessionId)).toBe(
      false
    );
  });

  it('keeps goal queries current after goal commands, removal, copying and reopen', async () => {
    let fixture = await nativeFixture();
    const id = fixture.doc.sessionId;
    const goal = (threadId: string): SessionGoalMessage => ({
      type: 'goal',
      threadId,
      objective: 'Retain',
      status: 'active',
    });
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('goal-older'),
      items: [goal('older')],
    });
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('goal-newer'),
      items: [goal('newer')],
    });
    const assertCurrent = async () => {
      if (!fixture.backend.readLatestGoal) throw new Error('Missing Native goal query');
      expect(await fixture.backend.readLatestGoal()).toEqual(
        resolveLatestSessionGoalFromHistory(await fixture.backend.readHistory())
      );
    };
    await assertCurrent();
    await fixture.backend.applyHistoryAction({
      kind: 'clear-goal',
      threadId: 'newer',
      updatedAt: 1,
    });
    await assertCurrent();
    expect(await fixture.backend.readLatestGoal?.()).toMatchObject({
      threadId: 'newer',
      status: 'cleared',
    });
    await fixture.backend.applyHistoryAction({
      kind: 'upsert-goal',
      goal: { ...goal('newer'), status: 'paused' },
      fallback: nativeAssistant('fallback') as never,
    });
    await assertCurrent();
    const copy = await fixture.backend.captureForkSnapshot();
    const destination = await nativeFixture();
    await destination.backend.importForkHistory(copy, copy.history);
    expect(await destination.backend.readLatestGoal?.()).toMatchObject({
      threadId: 'newer',
      status: 'paused',
    });
    await fixture.close();
    fixture = await nativeFixture(id);
    await assertCurrent();
    await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'goal-newer' });
    await assertCurrent();
    expect(await fixture.backend.readLatestGoal?.()).toMatchObject({
      threadId: 'older',
      status: 'active',
    });
    await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'goal-older' });
    await assertCurrent();
    expect(await fixture.backend.readLatestGoal?.()).toBeNull();
  });

  it('retries goal inspection when an older goal changes in place between pages', async () => {
    let fixture = await nativeFixture();
    const id = fixture.doc.sessionId;
    const goal: SessionGoalMessage = {
      type: 'goal',
      threadId: 'raced',
      objective: 'Retain',
      status: 'paused',
    };
    await fixture.backend.appendHistoryTurn({ ...nativeAssistant('raced-goal'), items: [goal] });
    for (let i = 0; i < 45; i++)
      await fixture.backend.appendHistoryTurn(nativeUser(`raced-plain-${i}`));
    await fixture.close();
    await invalidateGoalIndex(id);
    fixture = await nativeFixture(id);
    const peer = await nativeFixture(fixture.doc.sessionId);
    const readPage = RoostDispatchIndex.prototype.range;
    let changed = false;
    vi.spyOn(RoostDispatchIndex.prototype, 'range').mockImplementation(async function (...args) {
      const page = await readPage.apply(this, args);
      if (!changed) {
        changed = true;
        await peer.backend.applyHistoryAction({
          kind: 'upsert-turn',
          turn: {
            ...nativeAssistant('raced-goal'),
            items: [{ ...goal, status: 'active' }],
          } as never,
        });
      }
      return page;
    });
    expect(await fixture.backend.readLatestGoal?.()).toEqual({ ...goal, status: 'active' });
    expect(changed).toBe(true);
    expect(await fixture.backend.readLatestGoal?.()).toEqual({ ...goal, status: 'active' });
  });

  it('rechecks the history generation when goal inspection races an index-only activation', async () => {
    const id = `native-goal-pointer-${nextOrdinal()}`;
    let client: RoostNativeClient | undefined;
    const onChanges = RoostNativeClient.prototype.onChanges;
    const capture = vi.spyOn(RoostNativeClient.prototype, 'onChanges').mockImplementation(function (
      ...args
    ) {
      client = this;
      return onChanges.apply(this, args);
    });
    const fixture = await nativeFixture(id);
    capture.mockRestore();
    if (!client) throw new Error('Expected Native history owner');
    for (let i = 0; i < 45; i++)
      await fixture.backend.appendHistoryTurn(nativeUser(`goal-pointer-old-${i}`));
    const goal: SessionGoalMessage = {
      type: 'goal',
      threadId: 'activated',
      objective: 'Keep active',
      status: 'active',
    };
    const seed = await loadRoostOwnerSeedLegacy(join(nativeDirectory, 'history.db'));
    const generation = new RoostHistoryGeneration(client, Identity.fromSeed(seed).owner(), id);
    await generation.replace(
      [{ ...nativeAssistant('goal-pointer-new'), items: [goal] }],
      'goal-pointer-stage'
    );
    const raw = client.stream(`lody-session:${id}`);
    const pointer = { table: 'lody_history_generation_v1', key: new TextEncoder().encode('next') };
    const [activation] = await raw.readIndex([pointer]);
    if (!activation) throw new Error('Expected staged activation');
    await raw.compareAndWriteIndex(
      [{ ...pointer, value: activation }],
      [{ ...pointer, value: null }]
    );
    await fixture.close();
    await invalidateGoalIndex(id);
    let armed = false;
    vi.spyOn(RoostNativeClient.prototype, 'onChanges').mockImplementation(
      function (stream, listener, options) {
        client = this;
        return onChanges.call(
          this,
          stream,
          (cursor, key) => {
            if (!armed) listener(cursor, key);
          },
          options
        );
      }
    );
    const reopened = await nativeFixture(id);
    await reopened.backend.flushLocalWrites();
    const readPage = NodeLodyHistory.prototype.readActiveBranchMembers;
    let switched = false;
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchMembers').mockImplementation(
      async function (...args) {
        const result = await readPage.apply(this, args);
        if (armed && !switched) {
          switched = true;
          const before = await this.observedEventCursor();
          await this.stream.compareAndWriteIndex(
            [{ ...pointer, value: null }],
            [{ ...pointer, value: activation }]
          );
          expect(await this.observedEventCursor()).toBe(before);
        }
        return result;
      }
    );
    armed = true;
    try {
      expect(await reopened.backend.readLatestGoal?.()).toEqual(goal);
      expect(switched).toBe(true);
      expect(await reopened.backend.readLatestGoal?.()).toEqual(goal);
    } finally {
      armed = false;
    }
  });

  it('does not advance a goal cache across a concurrent owner write', async () => {
    const first = await nativeFixture();
    await first.backend.appendHistoryTurn(nativeUser('concurrent-goal-u'));
    await first.backend.appendHistoryTurn({
      ...nativeAssistant('concurrent-goal-a'),
      finished: true,
      acpTurnId: 'concurrent-boundary',
    });
    await first.backend.appendHistoryTurn(nativeUser('concurrent-tail-u'));
    await first.backend.appendHistoryTurn({
      ...nativeAssistant('concurrent-tail-a'),
      items: [{ type: 'text', text: 'start' }],
    });
    // Prime an applied content/goal checkpoint, then race its reuse in the next
    // command. A matching cached cursor must not hide a subsequent peer event.
    await first.backend.applyAgentBatch({
      targetAssistantEntryId: 'concurrent-tail-a',
      operationIds: ['concurrent-goal-prime'],
      contents: [{ type: 'text', text: 'warm' }],
    });
    const peer = await nativeFixture(first.doc.sessionId);
    const original = RoostHistoryGeneration.prototype.commitPatches;
    let injected = false;
    const spy = vi
      .spyOn(RoostHistoryGeneration.prototype, 'commitPatches')
      .mockImplementation(async function (...args) {
        const result = await original.apply(this, args);
        if (!injected) {
          injected = true;
          expect(result.derivedIndexesApplied).toBe(true);
          await peer.backend.applyHistoryAction({
            kind: 'upsert-turn',
            turn: {
              ...nativeAssistant('concurrent-goal-a'),
              finished: true,
              acpTurnId: 'concurrent-boundary',
              items: [
                {
                  type: 'goal',
                  threadId: 'concurrent-goal',
                  objective: 'Do not discard',
                  status: 'active',
                },
              ],
            } as never,
          });
        }
        return result;
      });
    try {
      await first.backend.applyAgentBatch({
        targetAssistantEntryId: 'concurrent-tail-a',
        operationIds: ['concurrent-goal-append'],
        contents: [{ type: 'text', text: '🙂' }],
      });
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(
      await first.backend.replaceEditableTail({
        expectedUserTurnId: 'concurrent-tail-u',
        expectedForkTurnId: 'concurrent-boundary',
        replacement: nativeUser('concurrent-replacement') as never,
      })
    ).toEqual({ status: 'rejected', reason: { code: 'active_goal' } });
    expect((await first.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'concurrent-goal-u',
      'concurrent-goal-a',
      'concurrent-tail-u',
      'concurrent-tail-a',
    ]);
  });

  it('refreshes the same-session prefix edit after its committed activation loses the reply', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('lost-u'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('lost-a'));
    const original = RoostHistoryGeneration.prototype.replaceMembers;
    const spy = vi
      .spyOn(RoostHistoryGeneration.prototype, 'replaceMembers')
      .mockImplementationOnce(async function (...args) {
        await original.apply(this, args);
        throw new Error('Injected lost branch reply');
      });
    let result: Awaited<ReturnType<typeof fixture.backend.replaceEditableTail>>;
    try {
      result = await fixture.backend.replaceEditableTail({
        expectedUserTurnId: 'lost-u',
        expectedForkTurnId: undefined,
        replacement: nativeUser('lost-replacement') as never,
      });
    } finally {
      spy.mockRestore();
    }
    expect(result.status).toBe('indeterminate');
    expect(await fixture.backend.history.count()).toBe(1);
    expect(await fixture.backend.history.readAt(0)).toMatchObject({
      state: 'ready',
      turn: { id: 'lost-replacement' },
    });
    await fixture.backend.flushLocalWrites();
    expect(await fixture.backend.history.getPublication!()).toMatchObject({ historyCount: 1 });
    expect((await fixture.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'lost-replacement',
    ]);
  });

  it('keeps an import baseline with its native commit when the Loro cursor projection fails', async () => {
    const fixture = await nativeFixture();
    const entry = { ...nativeUser('import-u'), status: 'handled' as const, read: true };
    const hashes = [hashHistoryEntryForVersion(entry as never, 2)];
    const input: HistoryImportInput = {
      mode: 'initialize',
      replay: {
        history: [entry as never],
        turnHashes: hashes,
        replayDigest: hashText(hashes.join('\n')),
        hashVersion: 2,
        droppedNotifications: 0,
      },
    };
    const spy = vi
      .spyOn(fixture.doc, 'setExternalHistoryCursor')
      .mockRejectedValueOnce(new Error('Injected import cursor failure'));
    expect(await fixture.backend.applyHistoryImport(input)).toMatchObject({
      status: 'indeterminate',
    });
    spy.mockRestore();
    await fixture.close();
    const reopened = await nativeFixture(fixture.doc.sessionId);
    expect(
      await reopened.backend.applyHistoryImport({
        ...input,
        mode: 'refresh',
        externalHistory: {
          importedTurnCount: 1,
          importedTurnHashes: hashes,
          replayDigest: input.replay.replayDigest,
          hashVersion: 2,
        },
      })
    ).toMatchObject({ status: 'accepted', appended: 0 });
    expect(await reopened.backend.readHistory()).toMatchObject([{ id: 'import-u' }]);
    expect((await reopened.doc.getExternalHistoryCursor())?.importedTurnHashes).toEqual(hashes);
  });

  it('continues a permission-bearing assistant with sparse tool updates and text', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('live-permission-a'),
      items: [
        {
          type: 'tool_call',
          toolCallId: 'live-tool',
          status: 'pending',
          permissionRequest: {
            requestId: 'live-request',
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          },
        },
      ],
    });
    expect(
      await fixture.backend.respondPermission('live-request', {
        outcome: 'selected',
        optionId: 'allow',
      })
    ).toBe(true);
    const permissionCheckpoint = await fixture.backend.history.getCheckpoint!();
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: 'live-permission-a',
      notifications: [
        {
          sessionId: 'acp-test',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'live-tool',
            status: 'completed',
          },
        },
        {
          sessionId: 'acp-test',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'continued after approval' },
          },
        },
      ],
      operationIds: ['permission-tool-update', 'permission-text-update'],
    });
    const permissionChanges = await fixture.backend.history.readChanges!(permissionCheckpoint, {
      withPatches: true,
    });
    expect(permissionChanges.state).toBe('ready');
    if (permissionChanges.state !== 'ready') throw new Error('Expected permission changes');
    expect(permissionChanges.patches).toBeUndefined();
    expect(await fixture.backend.readTurn('live-permission-a')).toMatchObject({
      state: 'ready',
      turn: {
        finished: false,
        items: [
          {
            status: 'completed',
            permissionRequest: { outcome: { outcome: 'selected', optionId: 'allow' } },
          },
          { text: 'continued after approval' },
        ],
      },
    });
    await fixture.close();
    expect(
      await (await nativeFixture(fixture.doc.sessionId)).backend.readTurn('live-permission-a')
    ).toMatchObject({
      state: 'ready',
      turn: {
        items: [
          { permissionRequest: { outcome: { optionId: 'allow' } } },
          { text: 'continued after approval' },
        ],
      },
    });
  });

  it('keeps a sealed user status correction separate from ongoing assistant output, including reopen', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('u'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('a'));
    await fixture.backend.applyHistoryAction({ kind: 'user-status', turnId: 'u', status: 'seen' });
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'u',
      status: 'processing',
    });
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: 'a',
      contents: [{ type: 'text', text: 'continued' }],
      operationIds: ['status-output'],
    });
    expect(await fixture.backend.readHistory()).toMatchObject([
      { id: 'u', status: 'processing' },
      { id: 'a', items: [{ type: 'text', text: 'continued' }], finished: false },
    ]);
    await fixture.close();
    const reopened = await nativeFixture(fixture.doc.sessionId);
    expect(await reopened.backend.readHistory()).toMatchObject([
      { id: 'u', status: 'processing' },
      { id: 'a', items: [{ type: 'text', text: 'continued' }] },
    ]);
  });

  it('answers an older permission by request id and continues the current assistant', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('permission-a'),
      items: [
        {
          type: 'tool_call',
          toolCallId: 'tool',
          status: 'pending',
          permissionRequest: {
            requestId: 'native-request',
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          },
        },
      ],
    });
    await fixture.backend.appendHistoryTurn(nativeAssistant('current-a'));
    expect(
      await fixture.backend.respondPermission('native-request', {
        outcome: 'selected',
        optionId: 'allow',
      })
    ).toBe(true);
    expect(
      await fixture.backend.respondPermission('native-request', {
        outcome: 'selected',
        optionId: 'allow',
      })
    ).toBe(false);
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: 'current-a',
      contents: [{ type: 'text', text: 'current output' }],
      operationIds: ['permission-current-output'],
    });
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: 'permission-a',
      contents: [{ type: 'text', text: 'tool finished' }],
      operationIds: ['permission-late-output'],
    });
    expect(await fixture.backend.readTurn('permission-a')).toMatchObject({
      state: 'ready',
      turn: {
        items: [
          { permissionRequest: { outcome: { outcome: 'selected', optionId: 'allow' } } },
          { type: 'text', text: 'tool finished' },
        ],
      },
    });
    expect(await fixture.backend.readTurn('current-a')).toMatchObject({
      state: 'ready',
      turn: { finished: false, items: [{ text: 'current output' }] },
    });
  });

  it('copies a held source snapshot with a new Fork notice before target initialization', async () => {
    const source = await nativeFixture();
    const target = await nativeFixture();
    await source.backend.appendHistoryTurn(nativeUser('fork-u'));
    await target.backend.appendHistoryTurn({ ...nativeAssistant('target-init'), role: 'system' });
    const snapshot = await source.backend.captureForkSnapshot();
    await source.close();
    snapshot.history[0]!.items![0] = { type: 'text', text: 'authored copy' };
    await target.backend.importForkHistory(snapshot, [
      ...snapshot.history,
      {
        id: 'fork-origin',
        role: 'system',
        timestamp: '2026-10-09T00:00:00.000Z',
        items: [
          {
            type: 'system_notice',
            name: 'session_fork_origin',
            meta: {
              sourceSessionId: source.doc.sessionId,
              sourceTurnId: 'fork-u',
              sourceTitle: 'Source session',
            },
          },
        ],
        fileDiff: [],
      },
    ]);
    expect((await target.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'fork-u',
      'fork-origin',
      'target-init',
    ]);
    await expect(target.backend.importForkHistory(snapshot, snapshot.history)).rejects.toThrow(
      'copy_target_conflict'
    );
    await expect(
      target.backend.importForkHistory({ ...snapshot, storageSnapshot: { history: [] } }, [])
    ).rejects.toThrow('invalid_snapshot');
  });

  it('leaves the old branch intact if preparing a structural replacement fails', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('old-u'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('old-a'));
    const before = await fixture.backend.readHistory();
    const original = RoostNativeClient.prototype.request;
    let stages = 0;
    const spy = vi
      .spyOn(RoostNativeClient.prototype, 'request')
      .mockImplementation(async function (input, options) {
        if (input.method === 'writeBatch' && input.requireLocalInterval === true && ++stages === 2)
          throw new Error('Injected stage failure');
        return original.call(this, input, options);
      });
    await expect(
      fixture.backend.applyHistoryAction({
        kind: 'upsert-turn',
        turn: nativeUser('insert-u') as never,
        beforeTurnId: 'old-u',
      })
    ).rejects.toThrow('Injected stage failure');
    spy.mockRestore();
    expect(await fixture.backend.readHistory()).toEqual(before);
    await fixture.backend.applyHistoryAction({
      kind: 'upsert-turn',
      turn: nativeUser('insert-u') as never,
      beforeTurnId: 'old-u',
    });
    await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'old-u' });
    expect((await fixture.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'insert-u',
      'old-a',
    ]);
    await fixture.close();
    expect(
      (await (await nativeFixture(fixture.doc.sessionId)).backend.readHistory()).map(
        (entry) => entry.id
      )
    ).toEqual(['insert-u', 'old-a']);
  });

  it('refreshes count and position reads after a committed generation loses its reply', async () => {
    const source = await nativeFixture();
    for (const id of ['copied-one', 'copied-two', 'copied-three'])
      await source.backend.appendHistoryTurn(nativeUser(id));
    const snapshot = await source.backend.captureForkSnapshot();
    for (const reader of ['count', 'readAt', 'readDirectory'] as const) {
      const target = await nativeFixture();
      await target.backend.appendHistoryTurn(nativeUser('target-u'));
      await target.backend.appendHistoryTurn(nativeAssistant('target-a'));
      const original = RoostHistoryGeneration.prototype.replace;
      const spy = vi
        .spyOn(RoostHistoryGeneration.prototype, 'replace')
        .mockImplementationOnce(async function (...args) {
          await original.apply(this, args);
          throw new Error('Injected lost activation reply');
        });
      await expect(target.backend.importForkHistory(snapshot, snapshot.history)).rejects.toThrow(
        'Injected lost activation reply'
      );
      spy.mockRestore();
      if (reader === 'count') expect(await target.backend.history.count()).toBe(5);
      if (reader === 'readAt')
        expect(await target.backend.history.readAt(4)).toMatchObject({
          state: 'ready',
          turn: { id: 'target-a' },
        });
      if (reader === 'readDirectory')
        expect(await target.backend.history.readDirectory(4, 5)).toMatchObject([
          { position: 4, turnId: 'target-a' },
        ]);
      await target.backend.flushLocalWrites();
      expect(await target.backend.history.getPublication!()).toMatchObject({ historyCount: 5 });
      expect((await target.backend.readHistory()).map((entry) => entry.id)).toEqual([
        'copied-one',
        'copied-two',
        'copied-three',
        'target-u',
        'target-a',
      ]);
    }
  });

  it('persists sparse ACP tool updates and subsequent text together, including retry after reopen', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeAssistant('sparse-tools'));
    const checkpoint = await fixture.backend.history.getCheckpoint?.();
    const input = {
      targetAssistantEntryId: 'sparse-tools',
      notifications: [
        {
          sessionId: 'synthetic-acp',
          update: {
            sessionUpdate: 'tool_call' as const,
            toolCallId: 'synthetic-tool',
            title: 'Synthetic tool',
            status: 'in_progress' as const,
          },
        },
        {
          sessionId: 'synthetic-acp',
          update: {
            sessionUpdate: 'tool_call_update' as const,
            toolCallId: 'synthetic-tool',
            status: 'completed' as const,
          },
        },
        {
          sessionId: 'synthetic-acp',
          update: {
            sessionUpdate: 'agent_message_chunk' as const,
            content: { type: 'text' as const, text: 'Visible reply after tool' },
          },
        },
      ],
      operationIds: ['sparse-tool-start', 'sparse-tool-finish', 'sparse-text'],
    };
    await fixture.backend.applyAgentBatch(input);
    const expected = {
      state: 'ready',
      turn: {
        items: [
          { type: 'tool_call', toolCallId: 'synthetic-tool', status: 'completed' },
          { type: 'text', text: 'Visible reply after tool' },
        ],
      },
    };
    expect(await fixture.backend.readTurn('sparse-tools')).toMatchObject(expected);
    if (!checkpoint || !fixture.backend.history.readChanges)
      throw new Error('Expected incremental owner');
    expect(await fixture.backend.history.readChanges(checkpoint)).toMatchObject({
      state: 'ready',
      ids: ['sparse-tools'],
    });
    await fixture.backend.flushLocalWrites();
    const sessionId = fixture.doc.sessionId;
    await fixture.close();
    const reopened = await nativeFixture(sessionId);
    await reopened.backend.applyAgentBatch(input);
    expect(await reopened.backend.readTurn('sparse-tools')).toMatchObject(expected);
  });
});
