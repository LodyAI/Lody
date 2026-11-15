import { type SessionHistoryInput } from '@lody/shared';
import { Identity } from '@loro-dev/roost';
import { RoostNativeClient } from '@loro-dev/roost-node';
import { NodeLodyHistory } from '@loro-dev/roost/lody-history';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SessionDocument } from '../src/lib/loro/doc';
import { RoostDispatchIndex } from '../src/session/roost-dispatch-index';
import { RoostHistoryGeneration } from '../src/session/roost-history-generation';
import { loadRoostOwnerSeedLegacy } from '../src/session/roost-writer-identity';
import { dispatchEntry, selectDispatchHistory } from '../src/session/session-dispatch-history';
import { SessionDispatchWatcher } from '../src/session/session-dispatch-watcher';
import type { SessionExecutionService } from '../src/session/session-execution-service';
import { getDefaultLogger } from '../src/utils/logger';
import {
  nativeAssistant,
  nativeDirectory,
  nativeFixture,
  nativeUser,
  nextOrdinal,
  registerRoostNativeBackendSuite,
} from './roost-session-backend-test-helpers';

registerRoostNativeBackendSuite();
describe('Production Roost dispatch projection', () => {
  it('fences an index-only generation switch during positional hydration without caching the old page', async () => {
    const id = `native-position-pointer-${nextOrdinal()}`;
    const root = `lody-session:${id}`;
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
      await fixture.backend.appendHistoryTurn(nativeUser(`position-pointer-old-${i}`));
    await fixture.backend.flushLocalWrites();
    const seed = await loadRoostOwnerSeedLegacy(join(nativeDirectory, 'history.db'));
    const generation = new RoostHistoryGeneration(client, Identity.fromSeed(seed).owner(), id);
    const replacement = nativeUser('position-pointer-new');
    await generation.replace([replacement], 'position-pointer-activation');
    const raw = client.stream(root);
    const pointer = { table: 'lody_history_generation_v1', key: new TextEncoder().encode('next') };
    const [activation] = await raw.readIndex([pointer]);
    if (!activation) throw new Error('Expected staged activation proof');
    // Retain a real sealed activation, but defer its pointer until the read race.
    await raw.compareAndWriteIndex(
      [{ ...pointer, value: activation }],
      [{ ...pointer, value: null }]
    );
    await fixture.close();
    const prepared = await nativeFixture(id);
    await prepared.backend.readDispatchHistory([]);
    await prepared.close();
    let armed = false;
    vi.spyOn(RoostNativeClient.prototype, 'onChanges').mockImplementation(
      function (stream, listener, options) {
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
    const read = NodeLodyHistory.prototype.readActiveBranchMessages;
    let switched = false;
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages').mockImplementation(
      async function (...args) {
        const result = await read.apply(this, args);
        if (!switched) {
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
    expect(await reopened.backend.history.readRange(0, 1)).toMatchObject([
      { state: 'ready', turn: { id: replacement.id, items: replacement.items } },
    ]);
    expect(switched).toBe(true);
    expect(await reopened.backend.history.readRange(0, 1)).toMatchObject([
      { state: 'ready', turn: { id: replacement.id, items: replacement.items } },
    ]);
    armed = false;
  });

  it.each(['missing', 'wrong-position', 'uncertified', 'partial'] as const)(
    'preserves range semantics with a %s position index without forcing a rebuild',
    async (damage) => {
      const fixture = await nativeFixture();
      for (let i = 0; i < 45; i++)
        await fixture.backend.appendHistoryTurn(nativeUser(`position-fallback-${i}`));
      await fixture.backend.flushLocalWrites();
      const id = fixture.doc.sessionId;
      await fixture.close();
      const reopened = await nativeFixture(id);
      await reopened.backend.flushLocalWrites();
      vi.spyOn(RoostDispatchIndex.prototype, 'rebuild').mockRejectedValue(
        new Error('Range reads must not force a full-index rebuild')
      );
      if (damage === 'uncertified' || damage === 'partial') {
        vi.spyOn(RoostDispatchIndex.prototype, 'checkpoint').mockResolvedValue(undefined);
      } else {
        const range = RoostDispatchIndex.prototype.range;
        vi.spyOn(RoostDispatchIndex.prototype, 'range').mockImplementationOnce(async function (
          ...args
        ) {
          await this.host.compareAndWriteIndex(
            [],
            [
              {
                table: 'lody_dispatch_positions_v1',
                key: new Uint8Array(8),
                value:
                  damage === 'missing'
                    ? null
                    : new TextEncoder().encode(JSON.stringify('position-fallback-1')),
              },
            ]
          );
          return range.apply(this, args);
        });
      }
      if (damage === 'partial') {
        const page = NodeLodyHistory.prototype.readActiveBranchPage;
        vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage').mockImplementation(
          async function (...args) {
            const result = await page.apply(this, args);
            return args[1]?.from === 0 ? { ...result, complete: false, messages: [] } : result;
          }
        );
        await expect(reopened.backend.history.readRange(0, 2)).rejects.toThrow('incomplete');
        expect(await reopened.backend.readHistoryCount()).toBe(45);
        expect(await reopened.backend.history.readRange(44, 45)).toMatchObject([
          { state: 'ready', turn: { id: 'position-fallback-44' } },
        ]);
        return;
      }
      expect(await reopened.backend.history.readRange(0, 2)).toMatchObject([
        { state: 'ready', turn: { id: 'position-fallback-0' } },
        { state: 'ready', turn: { id: 'position-fallback-1' } },
      ]);
      expect(await reopened.backend.readHistoryCount()).toBe(45);
    }
  );

  it('dispatches an old pending input after reopen without materializing historical pages', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('old-pending-dispatch'));
    for (let i = 0; i < 44; i++)
      await fixture.backend.appendHistoryTurn({
        ...nativeUser(`settled-dispatch-${i}`),
        status: 'handled',
        read: true,
      });
    await fixture.backend.appendHistoryTurn(nativeUser('new-pending-dispatch'));
    await fixture.backend.flushLocalWrites();
    const full = await fixture.backend.readHistory();
    const id = fixture.doc.sessionId;
    await fixture.close();
    const reopened = await nativeFixture(id);
    await reopened.backend.flushLocalWrites();
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranch').mockRejectedValue(
      new Error('Full branch read forbidden')
    );
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage').mockRejectedValue(
      new Error('Historical page hydration forbidden')
    );
    const included = ['settled-dispatch-0'];
    const selected = await reopened.backend.readDispatchHistory(included);
    expect(selected).toEqual(selectDispatchHistory(full.map(dispatchEntry), included));
    selected[0]!.status = 'canceled';
    expect(await reopened.backend.readDispatchHistory(included)).toEqual(
      selectDispatchHistory(full.map(dispatchEntry), included)
    );
    const watcher = new SessionDispatchWatcher({
      logger: getDefaultLogger(),
      machineId: 'test-machine',
      workspaceId: 'test-workspace',
      workspaceDocument: { repo: reopened.repo },
      executionService: {
        reconcileSteerHistory: async () => {},
        tryAcquireSessionRewriteConflictLease: () => () => {},
        isInboxInputCanceled: () => false,
      } as unknown as SessionExecutionService,
      userResolver: { resolve: async () => undefined, clear: () => {} },
      canUseMachine: async () => ({ outcome: 'allowed' }),
    } as never);
    const check = (
      watcher as unknown as {
        checkHistoryAndQueue(
          doc: SessionDocument,
          meta: unknown
        ): Promise<{ turn: SessionHistoryInput | null }>;
      }
    ).checkHistoryAndQueue.bind(watcher);
    const result = await check(reopened.doc, await reopened.doc.getMetaState());
    expect(result.turn).toEqual(full.find((entry) => entry.id === 'old-pending-dispatch'));
    await reopened.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'old-pending-dispatch',
      status: 'handled',
    });
    expect((await check(reopened.doc, await reopened.doc.getMetaState())).turn?.id).toBe(
      'new-pending-dispatch'
    );
  });

  it('keeps completion evidence exact across finish, reopen and late state updates', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('dispatch-completion-user'));
    await fixture.backend.openAssistantTurn({
      turnId: 'dispatch-completion-assistant',
      userTurnId: 'dispatch-completion-user',
      timestamp: '2026-10-22T00:00:00.000Z',
    });
    await fixture.backend.applyHistoryAction({
      kind: 'finish-assistant',
      turnId: 'dispatch-completion-assistant',
      endedAt: 42,
    });
    expect(await fixture.backend.readDispatchHistory([])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'dispatch-completion-assistant',
          userTurnId: 'dispatch-completion-user',
          endedAt: 42,
        }),
      ])
    );
    await fixture.backend.openAssistantTurn({
      turnId: 'dispatch-completion-assistant',
      userTurnId: 'dispatch-completion-user',
      timestamp: '2026-10-22T00:00:00.000Z',
    });
    expect(
      (await fixture.backend.readDispatchHistory([])).some((entry) => entry.role === 'assistant')
    ).toBe(false);
    await fixture.backend.applyHistoryAction({
      kind: 'finish-assistant',
      turnId: 'dispatch-completion-assistant',
      endedAt: 84,
    });
    expect(await fixture.backend.readDispatchHistory([])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'dispatch-completion-assistant', endedAt: 84 }),
      ])
    );
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'dispatch-completion-user',
      status: 'handled',
    });
    expect(await fixture.backend.readDispatchHistory([])).toEqual([]);
    expect(await fixture.backend.readDispatchHistory(['dispatch-completion-user'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'dispatch-completion-user', status: 'handled' }),
        expect.objectContaining({ id: 'dispatch-completion-assistant', endedAt: 84 }),
      ])
    );
  });

  it('repairs a missing projection with bounded pages and never revives a removed branch', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('dispatch-removed'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('dispatch-removed-output'));
    expect(
      await fixture.backend.replaceEditableTail({
        expectedUserTurnId: 'dispatch-removed',
        expectedForkTurnId: undefined,
        replacement: nativeUser('dispatch-replacement') as never,
      })
    ).toMatchObject({ status: 'accepted' });
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranch').mockRejectedValue(
      new Error('Full branch read forbidden')
    );
    const missing = vi
      .spyOn(RoostDispatchIndex.prototype, 'checkpoint')
      .mockResolvedValueOnce(undefined);
    expect(
      (await fixture.backend.readDispatchHistory(['dispatch-removed'])).map((entry) => entry.id)
    ).toEqual(['dispatch-replacement']);
    missing.mockRestore();
    expect(await fixture.backend.readTurn('dispatch-removed')).toEqual({ state: 'missing' });
    expect((await fixture.backend.readDispatchHistory([])).map((entry) => entry.id)).toEqual([
      'dispatch-replacement',
    ]);
  });

  it('rejects stale index publication, refreshes another reader and repairs an interrupted build', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('dispatch-index-fence'));
    await fixture.backend.flushLocalWrites();
    const read = RoostDispatchIndex.prototype.read;
    let owner: RoostDispatchIndex | undefined;
    const capture = vi.spyOn(RoostDispatchIndex.prototype, 'read').mockImplementation(function (
      ...args
    ) {
      owner = this;
      return read.apply(this, args);
    });
    await fixture.backend.readDispatchHistory([]);
    capture.mockRestore();
    if (!owner) throw new Error('Expected dispatch projection owner');
    const old = owner.current();
    if (!old) throw new Error('Expected complete dispatch checkpoint');
    const observer = new RoostDispatchIndex(owner.host);
    const before = await observer.checkpoint(BigInt(old.header.cursor), old.header.count);
    if (!before) throw new Error('Expected second dispatch checkpoint');
    expect((await observer.read(before, []))[0]?.id).toBe('dispatch-index-fence');
    const stalePlan = await observer.plan(before, BigInt(before.header.cursor) + 1n, 1, [
      {
        before: dispatchEntry(nativeUser('dispatch-index-fence')),
        after: { id: 'dispatch-index-fence', role: 'user', status: 'processing', read: true },
      },
    ]);
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'dispatch-index-fence',
      status: 'handled',
    });
    await expect(observer.commit(stalePlan)).rejects.toMatchObject({ code: 'stale' });
    const current = owner.current();
    if (!current) throw new Error('Expected advanced dispatch checkpoint');
    const refreshed = await observer.checkpoint(BigInt(current.header.cursor), 1);
    if (!refreshed) throw new Error('Expected refreshed observer');
    expect(await observer.read(refreshed, ['dispatch-index-fence'])).toEqual([
      expect.objectContaining({ id: 'dispatch-index-fence', status: 'handled' }),
    ]);
    const stored = await fixture.backend.readHistory();
    const row = await owner.row('dispatch-index-fence', current);
    if (!row) throw new Error('Expected persisted dispatch row');
    await expect(
      owner.rebuild(
        BigInt(current.header.cursor),
        1,
        (async function* () {
          yield [row];
        })(),
        async () => {
          throw new Error('Synthetic interrupted projection build');
        }
      )
    ).rejects.toThrow('Synthetic interrupted projection build');
    await expect(observer.range(refreshed, 0, 1)).rejects.toMatchObject({ code: 'stale' });
    observer.forget();
    expect(await observer.checkpoint(BigInt(current.header.cursor), 1)).toBeUndefined();
    vi.spyOn(NodeLodyHistory.prototype, 'readActiveBranch').mockRejectedValue(
      new Error('Full branch repair forbidden')
    );
    expect(await fixture.backend.readDispatchHistory([])).toEqual([]);
    expect(await fixture.backend.readDispatchHistory(['dispatch-index-fence'])).toEqual([
      expect.objectContaining({ id: 'dispatch-index-fence', status: 'handled' }),
    ]);
    const rebuilt = await observer.checkpoint(BigInt(current.header.cursor), 1);
    if (!rebuilt) throw new Error('Expected rebuilt positional checkpoint');
    expect(await observer.range(rebuilt, 0, 1)).toEqual([row]);
    vi.restoreAllMocks();
    expect(await fixture.backend.readHistory()).toEqual(stored);
  });
});
