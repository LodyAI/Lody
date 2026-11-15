import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { NodeLodyHistory } from '@loro-dev/roost/lody-history';
import {
  resolveLatestSessionGoalFromHistory,
  type SessionGoalMessage,
  type SessionId,
  SessionHistoryChangesSchema,
} from '@lody/shared';
import { MessageHandler } from '../src/lib/message-handler';
import {
  hashHistoryEntryForVersion,
  hashText,
  applySessionHistoryPatches,
  applyHistoryAction,
  type HistoryImportInput,
} from '@lody/shared/session-data';
import { decodeBatch, Identity } from '@loro-dev/roost';
import { RoostNativeClient, RoostHostError } from '@loro-dev/roost-node';
import { RoostHistoryGeneration } from '../src/session/roost-history-generation';
import { RoostDispatchIndex } from '../src/session/roost-dispatch-index';
import { readGoalProjection } from '../src/session/roost-goal-projection';
import { encodeRoostContent } from '../src/session/roost-history-port';
import { RoostHistoryHead } from '../src/session/roost-history-head';
import { loadRoostOwnerSeedLegacy } from '../src/session/roost-writer-identity';
import {
  coldHistoryHandlerFixture,
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
  it('keeps retained projections isolated and refreshes peer corrections before a local patch', async () => {
    let fixture = await nativeFixture();
    const id = fixture.doc.sessionId;
    const previous = {
      ...nativeAssistant('projection-old'),
      finished: true,
      items: [
        {
          type: 'tool_call' as const,
          toolCallId: 'retained-tool',
          status: 'completed' as const,
          rawOutput: { text: 'retained output 🙂'.repeat(128) },
        },
      ],
    };
    await fixture.backend.appendHistoryTurn(nativeUser('projection-u'));
    await fixture.backend.appendHistoryTurn(previous);
    await fixture.backend.appendHistoryTurn(nativeUser('projection-next-u'));
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('projection-active'),
      items: [{ type: 'text', text: 'start' }],
    });
    const snapshot = await fixture.backend.readHistory();
    const snapshotCopy = structuredClone(snapshot);
    const exposed = await fixture.backend.readTurn('projection-old');
    if (exposed.state !== 'ready') throw new Error('Expected retained turn');
    const tool = exposed.turn.items[0];
    if (tool?.type !== 'tool_call') throw new Error('Expected retained tool');
    tool.rawOutput = { text: 'caller mutation' };
    const append = (operationId: string, text: string) =>
      fixture.backend.applyAgentBatch({
        targetAssistantEntryId: 'projection-active',
        operationIds: [operationId],
        notifications: [
          {
            sessionId: 'synthetic-acp',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
          },
        ],
      });
    await append('projection-first', '🙂');
    await append('projection-first', '🙂');
    expect(snapshot).toEqual(snapshotCopy);
    expect(await fixture.backend.readTurn('projection-old')).toEqual({
      state: 'ready',
      turn: snapshotCopy[1],
    });
    expect(await fixture.backend.readTurn('projection-active')).toMatchObject({
      turn: { items: [{ type: 'text', text: 'start🙂' }] },
    });
    const activeSnapshot = await fixture.backend.readTurn('projection-active');
    if (activeSnapshot.state !== 'ready') throw new Error('Expected active turn');
    const activeText = activeSnapshot.turn.items[0];
    if (activeText?.type !== 'text') throw new Error('Expected active text');
    activeText.text = 'caller mutation of the active path';
    expect(await fixture.backend.readTurn('projection-active')).toMatchObject({
      turn: { items: [{ type: 'text', text: 'start🙂' }] },
    });

    const peer = await nativeFixture(id);
    await peer.backend.applyHistoryAction({
      kind: 'upsert-turn',
      turn: {
        ...previous,
        items: [...previous.items, { type: 'text', text: 'peer correction 漢字' }],
      } as never,
    });
    await append('projection-second', '漢字');
    const complete = await fixture.backend.readHistory();
    expect(complete.map((entry) => entry.id)).toEqual(snapshotCopy.map((entry) => entry.id));
    expect(complete[1]).toMatchObject({
      items: [...previous.items, { type: 'text', text: 'peer correction 漢字' }],
    });
    expect(complete[3]).toMatchObject({ items: [{ type: 'text', text: 'start🙂漢字' }] });
    expect(snapshot).toEqual(snapshotCopy);
    await peer.close();
    await fixture.close();
    fixture = await nativeFixture(id);
    expect(await fixture.backend.readHistory()).toEqual(complete);
  });

  it('serves certified text appends while body rereads are unavailable and reopens the same committed content', async () => {
    let fixture = await nativeFixture();
    const id = fixture.doc.sessionId;
    const turnId = 'certified-append';
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant(turnId),
      items: [
        {
          type: 'tool_call',
          toolCallId: 'retained',
          status: 'completed',
          rawOutput: { text: '🙂'.repeat(1024) },
        },
        { type: 'text', text: 'start' },
      ],
    });
    const before = await fixture.backend.readTurn(turnId);
    const beforeCopy = structuredClone(before);
    const reread = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages')
      .mockRejectedValue(new Error('Synthetic body reread unavailable'));
    try {
      for (const [i, text] of ['🙂', '漢字', '\n🚀'].entries()) {
        await fixture.backend.applyAgentBatch({
          targetAssistantEntryId: turnId,
          operationIds: [`certified-${i}`],
          contents: [{ type: 'text', text }],
        });
      }
      expect(await fixture.backend.readTurn(turnId)).toMatchObject({
        state: 'ready',
        turn: {
          items: [
            beforeCopy.state === 'ready' ? beforeCopy.turn.items[0] : {},
            { type: 'text', text: 'start🙂漢字\n🚀' },
          ],
        },
      });
      expect(before).toEqual(beforeCopy);
    } finally {
      reread.mockRestore();
    }
    await fixture.backend.applyHistoryAction({ kind: 'finish-assistant', turnId, endedAt: 42 });
    const complete = await fixture.backend.readHistory();
    await fixture.close();
    fixture = await nativeFixture(id);
    expect(await fixture.backend.readHistory()).toEqual(complete);
  });

  it('recovers atomically committed text, receipt and active goal after the Native reply is lost', async () => {
    let fixture = await nativeFixture();
    const id = fixture.doc.sessionId;
    const turnId = 'atomic-goal-a';
    await fixture.backend.appendHistoryTurn(nativeUser('atomic-goal-u'));
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant(turnId),
      acpTurnId: 'atomic-goal-boundary',
      items: [
        {
          type: 'goal',
          threadId: 'atomic-goal',
          objective: 'Preserve this goal',
          status: 'active',
        },
        { type: 'text', text: 'start' },
      ],
    });
    const input = {
      targetAssistantEntryId: turnId,
      operationIds: ['atomic-goal-append'],
      contents: [{ type: 'text' as const, text: '🙂' }],
    };
    const original = RoostNativeClient.prototype.request;
    let committed = false;
    const lost = vi
      .spyOn(RoostNativeClient.prototype, 'request')
      .mockImplementation(async function (...args) {
        const result = await original.apply(this, args);
        const command = args[0];
        if (!committed && command.method === 'writeBatch' && command.derivedIndexes) {
          const commit = result as Awaited<
            ReturnType<import('@loro-dev/roost-node').RoostNodeStream['writeBatch']>
          >;
          expect(commit.derivedIndexesApplied).toBe(true);
          const host = this.stream(command.stream);
          expect(await readGoalProjection(host, commit.through, 2)).toMatchObject({
            turnId,
            position: 1,
            goal: { threadId: 'atomic-goal', status: 'active' },
          });
          const receipts = command.indexPuts.map((put) => ({
            table: put.table,
            key: Buffer.from(put.keyHex, 'hex'),
          }));
          expect((await host.readIndex(receipts)).map((value) => value && [...value])).toEqual(
            command.indexPuts.map((put) => [...Buffer.from(put.valueHex, 'hex')])
          );
          committed = true;
          // Lose the real Native reply before the SDK adopts its checkpoint.
          throw new RoostHostError('unknownOutcome');
        }
        return result;
      });
    try {
      await expect(fixture.backend.applyAgentBatch(input)).rejects.toMatchObject({
        code: 'unknownOutcome',
      });
    } finally {
      lost.mockRestore();
    }
    expect(committed).toBe(true);
    await fixture.backend.applyAgentBatch(input);
    const complete = await fixture.backend.readHistory();
    expect(complete[1]?.items).toEqual([
      { type: 'goal', threadId: 'atomic-goal', objective: 'Preserve this goal', status: 'active' },
      { type: 'text', text: 'start🙂' },
    ]);
    expect(
      await fixture.backend.replaceEditableTail({
        expectedUserTurnId: 'atomic-goal-u',
        expectedForkTurnId: 'atomic-goal-boundary',
        replacement: nativeUser('atomic-goal-replacement') as never,
      })
    ).toMatchObject({ status: 'rejected', reason: { code: 'active_goal' } });
    await fixture.close();
    fixture = await nativeFixture(id);
    expect(await fixture.backend.readHistory()).toEqual(complete);
    await fixture.backend.applyAgentBatch(input);
    expect(await fixture.backend.readHistory()).toEqual(complete);
  });

  it('requires authoritative refresh for an uncertified commit and recovers its receipt without duplicating text', async () => {
    const fixture = await nativeFixture();
    const turnId = 'uncertified-append';
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant(turnId),
      items: [{ type: 'text', text: 'start' }],
    });
    const input = {
      targetAssistantEntryId: turnId,
      operationIds: ['uncertified-operation'],
      contents: [{ type: 'text' as const, text: '🙂' }],
    };
    const commit = RoostHistoryGeneration.prototype.commitPatches;
    const uncertified = vi
      .spyOn(RoostHistoryGeneration.prototype, 'commitPatches')
      .mockImplementationOnce(async function (...args) {
        return { ...(await commit.apply(this, args)), metadataAttached: false };
      });
    const reread = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages')
      .mockRejectedValue(new Error('Synthetic authoritative refresh failure'));
    try {
      await expect(fixture.backend.applyAgentBatch(input)).rejects.toThrow(
        'Synthetic authoritative refresh failure'
      );
    } finally {
      uncertified.mockRestore();
      reread.mockRestore();
    }
    await fixture.backend.applyAgentBatch(input);
    expect(await fixture.backend.readTurn(turnId)).toMatchObject({
      state: 'ready',
      turn: { items: [{ type: 'text', text: 'start🙂' }] },
    });
  });

  it('seals an installed primary without rereading the window and preserves its signed parent for the next turn', async () => {
    let fixture = await nativeFixture();
    const id = fixture.doc.sessionId;
    const finish = NodeLodyHistory.prototype.finish;
    let restoreWindow: (() => void) | undefined;
    const seal = vi
      .spyOn(NodeLodyHistory.prototype, 'finish')
      .mockImplementationOnce(async function (...args) {
        await finish.apply(this, args);
        const blocked = vi
          .spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage')
          .mockRejectedValue(new Error('Synthetic window reread unavailable'));
        restoreWindow = () => blocked.mockRestore();
      });
    try {
      await fixture.backend.appendHistoryTurn({
        ...nativeAssistant('single-seal'),
        finished: true,
        items: [{ type: 'text', text: 'sealed 🙂' }],
      });
    } finally {
      restoreWindow?.();
      seal.mockRestore();
    }
    await fixture.backend.appendHistoryTurn(nativeUser('after-single-seal'));
    const complete = await fixture.backend.readHistory();
    expect(complete.map((entry) => entry.id)).toEqual(['single-seal', 'after-single-seal']);
    expect(complete[0]).toMatchObject({
      finished: true,
      items: [{ type: 'text', text: 'sealed 🙂' }],
    });
    await fixture.close();
    fixture = await nativeFixture(id);
    expect(await fixture.backend.readHistory()).toEqual(complete);
  });

  it('reloads foreign branch work that arrives while sealing an installed primary', async () => {
    const fixture = await nativeFixture();
    const peer = await nativeFixture(fixture.doc.sessionId);
    const finish = NodeLodyHistory.prototype.finish;
    const seal = vi
      .spyOn(NodeLodyHistory.prototype, 'finish')
      .mockImplementationOnce(async function (...args) {
        await finish.apply(this, args);
        await peer.backend.appendHistoryTurn(nativeUser('foreign-after-seal'));
      });
    try {
      await fixture.backend.appendHistoryTurn({
        ...nativeAssistant('local-seal'),
        finished: true,
        items: [{ type: 'text', text: 'local content' }],
      });
      expect((await fixture.backend.readHistory()).map((entry) => entry.id)).toEqual([
        'local-seal',
        'foreign-after-seal',
      ]);
      await fixture.backend.appendHistoryTurn(nativeAssistant('local-after-foreign'));
      expect((await fixture.backend.readHistory()).map((entry) => entry.id)).toEqual([
        'local-seal',
        'foreign-after-seal',
        'local-after-foreign',
      ]);
    } finally {
      seal.mockRestore();
      await peer.close();
    }
  });

  it('transmits native streaming edits without resending an unchanged large tool result', async () => {
    const fixture = await coldHistoryHandlerFixture(1);
    const id = [...fixture.docs.keys()][0]!;
    try {
      await fixture.ready(id);
      const tool = {
        type: 'tool_call' as const,
        toolCallId: 'synthetic-large-tool',
        status: 'completed' as const,
        rawOutput: { text: 'unchanged tool result '.repeat(16384) },
      };
      const turn = {
        ...nativeAssistant('rpc-stream'),
        items: [tool, { type: 'text' as const, text: 'a🙂bc🚀d' }],
      };
      expect(
        await fixture.rpc.writeSessionHistoryForRpc(id, 'append', { entry: turn })
      ).toMatchObject({ success: true });
      const page = await fixture.rpc.readSessionHistoryForRpc(id, {
        kind: 'readLatestPage',
        limit: 40,
        withCheckpoint: true,
      });
      let checkpoint = (page.result as { checkpoint: string }).checkpoint;
      let reconstructed = page.pageTurns![0]!;
      let patchBytes = 0;
      let completeBytes = 0;
      for (let step = 0; step < 32; step++) {
        const items = [tool, { type: 'text' as const, text: `a🙂XYZ🚀d${'尾'.repeat(step + 1)}` }];
        expect(
          await fixture.rpc.writeSessionHistoryForRpc(id, 'apply_action', {
            action: { kind: 'assistant-items', turnId: turn.id, mode: 'replace', items },
          })
        ).toMatchObject({ success: true });
        const query = { checkpoint, includeBodiesFrom: 0 };
        const legacy = await fixture.rpc.readSessionHistoryForRpc(id, {
          kind: 'readChanges',
          ...query,
        });
        const response = await fixture.rpc.readSessionHistoryForRpc(
          id,
          step % 2
            ? { kind: 'watchChanges', waitMs: 0, ...query, withPatches: true }
            : { kind: 'readChanges', ...query, withPatches: true }
        );
        expect(response.success).toBe(true);
        const changes = SessionHistoryChangesSchema.parse(response.result);
        if (changes.state !== 'ready' || !changes.patches)
          throw new Error('Expected native patches');
        expect(changes.patches.baseCheckpoint).toBe(checkpoint);
        expect(changes.patches.turns.map((row) => row.turnId)).toEqual([turn.id]);
        expect(changes.bodies).toEqual({ changed: [], suffix: [] });
        reconstructed = applySessionHistoryPatches(
          reconstructed,
          changes.patches.turns[0]!.operations
        );
        const complete = SessionHistoryChangesSchema.parse(legacy.result);
        if (complete.state !== 'ready') throw new Error('Expected legacy complete response');
        expect(complete.patches).toBeUndefined();
        expect(complete.bodies?.changed).toEqual([reconstructed]);
        expect(reconstructed.items).toEqual(items);
        checkpoint = changes.checkpoint;
        patchBytes += Buffer.byteLength(JSON.stringify(response));
        completeBytes += Buffer.byteLength(JSON.stringify(legacy));
      }
      expect(patchBytes).toBeLessThan(32 * 4096);
      expect(patchBytes).toBeLessThan(completeBytes / 50);
      expect(
        await fixture.rpc.writeSessionHistoryForRpc(id, 'apply_action', {
          action: { kind: 'finish-assistant', turnId: turn.id, endedAt: 42 },
        })
      ).toMatchObject({ success: true });
      const sealed = SessionHistoryChangesSchema.parse(
        (
          await fixture.rpc.readSessionHistoryForRpc(id, {
            kind: 'readChanges',
            checkpoint,
            includeBodiesFrom: 0,
            withPatches: true,
          })
        ).result
      );
      expect(sealed).toMatchObject({
        state: 'ready',
        bodies: { changed: [{ finished: true, endedAt: 42 }] },
      });
      if (sealed.state !== 'ready') throw new Error('Expected sealed fallback');
      expect(sealed.patches).toBeUndefined();
      expect(
        await fixture.rpc.writeSessionHistoryForRpc(id, 'apply_action', {
          action: {
            kind: 'assistant-items',
            turnId: turn.id,
            mode: 'replace',
            items: [tool, { type: 'text', text: 'late state correction' }],
          },
        })
      ).toMatchObject({ success: true });
      const state = SessionHistoryChangesSchema.parse(
        (
          await fixture.rpc.readSessionHistoryForRpc(id, {
            kind: 'readChanges',
            checkpoint: sealed.checkpoint,
            includeBodiesFrom: 0,
            withPatches: true,
          })
        ).result
      );
      expect(state).toMatchObject({
        state: 'ready',
        bodies: { changed: [{ items: [tool, { type: 'text', text: 'late state correction' }] }] },
      });
      if (state.state !== 'ready') throw new Error('Expected state fallback');
      expect(state.patches).toBeUndefined();
      expect(
        (
          await fixture.rpc.readSessionHistoryForRpc(id, {
            kind: 'readChanges',
            checkpoint: 'unrecognized-checkpoint',
            withPatches: true,
          })
        ).result
      ).toMatchObject({ state: 'reset' });
    } finally {
      await fixture.close();
    }
  });

  it('recovers coalesced patches after reopen and projects derived fields through complete reads', async () => {
    let fixture = await nativeFixture();
    const initial = {
      ...nativeAssistant('reopened-patches'),
      items: [
        { type: 'text' as const, text: 'a🙂bc🚀d' },
        { type: 'text' as const, text: 'remove' },
      ],
    };
    await fixture.backend.appendHistoryTurn(initial);
    const checkpoint = await fixture.backend.history.getCheckpoint!();
    for (const items of [
      [{ type: 'text' as const, text: 'a🙂XYZ🚀d' }],
      [
        { type: 'text' as const, text: 'a🙂XYZ🚀d尾' },
        { type: 'text' as const, text: 'added' },
      ],
    ])
      await fixture.backend.applyHistoryAction({
        kind: 'assistant-items',
        turnId: initial.id,
        mode: 'replace',
        items,
      });
    const sessionId = fixture.doc.sessionId;
    await fixture.close();
    fixture = await nativeFixture(sessionId);
    const changes = await fixture.backend.history.readChanges!(checkpoint, { withPatches: true });
    if (changes.state !== 'ready' || !changes.patches)
      throw new Error('Expected reopened native patches');
    const expected = applySessionHistoryPatches(initial, changes.patches.turns[0]!.operations);
    expect(await fixture.backend.readTurn(initial.id)).toEqual({ state: 'ready', turn: expected });
    await fixture.backend.applyHistoryAction({
      kind: 'assistant-file-diff',
      turnId: initial.id,
      change: { kind: 'clear' },
    });
    const derived = await fixture.backend.history.readChanges!(changes.checkpoint, {
      withPatches: true,
    });
    expect(derived).toMatchObject({ state: 'ready', ids: [initial.id] });
    if (derived.state !== 'ready') throw new Error('Expected derived-field changes');
    expect(derived.patches).toBeUndefined();
    expect(await fixture.backend.readTurn(initial.id)).toMatchObject({
      state: 'ready',
      turn: { fileDiff: [] },
    });
  });

  it('preserves Unicode scalar edits and list changes through sealing and state correction', async () => {
    const fixture = await nativeFixture();
    const turn = {
      ...nativeAssistant('delta-unicode'),
      items: [
        { type: 'text' as const, text: 'a🙂bc🚀d' },
        { type: 'text' as const, text: 'unchanged' },
        { type: 'text' as const, text: 'removed' },
      ],
    };
    await fixture.backend.appendHistoryTurn(turn);
    let items = [{ type: 'text' as const, text: 'a🙂XYZ🚀d' }, turn.items[1]!];
    await fixture.backend.applyHistoryAction({
      kind: 'assistant-items',
      turnId: turn.id,
      mode: 'replace',
      items,
    });
    expect(await fixture.backend.readTurn(turn.id)).toMatchObject({
      state: 'ready',
      turn: { items },
    });
    items = [...items, { type: 'text' as const, text: 'added' }];
    await fixture.backend.applyHistoryAction({
      kind: 'assistant-items',
      turnId: turn.id,
      mode: 'replace',
      items,
    });
    await fixture.backend.applyHistoryAction({
      kind: 'finish-assistant',
      turnId: turn.id,
      endedAt: 42,
    });
    expect(await fixture.backend.readTurn(turn.id)).toMatchObject({
      state: 'ready',
      turn: { items, finished: true, endedAt: 42 },
    });
    // A sealed primary's first correction still uses its SDK state contract;
    // subsequent state edits can use the same atomic delta path.
    for (const text of ['state 🙂 text', 'state 😀 text']) {
      items = [{ type: 'text' as const, text }, turn.items[1]!];
      await fixture.backend.applyHistoryAction({
        kind: 'assistant-items',
        turnId: turn.id,
        mode: 'replace',
        items,
      });
      expect(await fixture.backend.readTurn(turn.id)).toMatchObject({
        state: 'ready',
        turn: { items, finished: true },
      });
    }
    await fixture.backend.flushLocalWrites();
    const id = fixture.doc.sessionId;
    await fixture.close();
    const reopened = await nativeFixture(id);
    expect(await reopened.backend.readTurn(turn.id)).toMatchObject({
      state: 'ready',
      turn: { items, finished: true, endedAt: 42 },
    });
  });

  it('reads legacy whole-message states across reopen and converts only the next mutation', async () => {
    let fixture = await nativeFixture();
    const turn = {
      ...nativeAssistant('legacy-state'),
      finished: true,
      items: [{ type: 'text' as const, text: 'sealed body' }],
    };
    await fixture.backend.appendHistoryTurn(turn);
    const legacy = { ...turn, items: [{ type: 'text' as const, text: 'legacy correction' }] };
    const batch = NodeLodyHistory.prototype.commitHistoryBatch;
    const previous = vi
      .spyOn(NodeLodyHistory.prototype, 'commitHistoryBatch')
      .mockImplementation(async function (batchId, commands, options) {
        return batch.call(
          this,
          batchId,
          commands.map((command) =>
            command.type === 'accept' && command.identity.segmentId.startsWith('state:')
              ? { ...command, content: encodeRoostContent(legacy) }
              : command
          ),
          options
        );
      });
    try {
      await fixture.backend.applyHistoryAction({
        kind: 'assistant-items',
        turnId: turn.id,
        mode: 'replace',
        items: legacy.items,
      });
    } finally {
      previous.mockRestore();
    }
    const sessionId = fixture.doc.sessionId;
    await fixture.close();
    fixture = await nativeFixture(sessionId);
    expect(await fixture.backend.readTurn(turn.id)).toMatchObject({ state: 'ready', turn: legacy });
    const items = [{ type: 'text' as const, text: 'next correction 🙂' }];
    await fixture.backend.applyHistoryAction({
      kind: 'assistant-items',
      turnId: turn.id,
      mode: 'replace',
      items,
    });
    await fixture.close();
    fixture = await nativeFixture(sessionId);
    expect(await fixture.backend.readTurn(turn.id)).toMatchObject({
      state: 'ready',
      turn: { ...legacy, items },
    });
  });

  it('keeps post-seal state updates bounded and recovers a lost first-state reply', async () => {
    const fixture = await nativeFixture();
    const untouched = 'sealed synthetic tool body '.repeat(16384);
    const tool = {
      type: 'tool_call' as const,
      toolCallId: 'large-tool',
      status: 'completed' as const,
      title: 'Synthetic tool',
      rawOutput: { text: untouched },
    };
    const turn = {
      ...nativeAssistant('sealed-state-budget'),
      items: [tool, { type: 'text' as const, text: 'base🙂' }],
    };
    let primaryId: Uint8Array | undefined;
    const accept = NodeLodyHistory.prototype.acceptToView;
    const capture = vi
      .spyOn(NodeLodyHistory.prototype, 'acceptToView')
      .mockImplementation(async function (...args) {
        const result = await accept.apply(this, args);
        if (args[0].input.businessId === turn.id) primaryId = result.turnId.slice();
        return result;
      });
    try {
      await fixture.backend.appendHistoryTurn(turn);
    } finally {
      capture.mockRestore();
    }
    if (!primaryId) throw new Error('Expected primary');
    await fixture.backend.applyHistoryAction({
      kind: 'finish-assistant',
      turnId: turn.id,
      endedAt: 42,
    });
    const updates = async () => {
      const dbPath = join(nativeDirectory, 'history.db');
      const seed = await loadRoostOwnerSeedLegacy(dbPath);
      const reader = new RoostNativeClient({
        dbPath,
        seed,
        allowedOwners: [Identity.fromSeed(seed).owner()],
        maxQueuedRequests: 32,
        maxQueuedBytes: 8 * 1024 * 1024,
      });
      try {
        await reader.ready;
        const stream = reader.stream(`lody-session:${fixture.doc.sessionId}`);
        const headers = await stream.latestTurnHeaders(256n);
        expect(headers.length).toBeLessThan(256);
        const rows: { key: Buffer; value: Buffer }[] = [];
        for (const header of headers) {
          expect(header.nextSeq).toBeLessThan(4096n);
          for (let seq = 0n; seq < header.nextSeq; seq++) {
            const value = Buffer.from(await stream.exportUpdates(header.turnId, seq, 1n));
            expect(decodeBatch(value)).toHaveLength(1);
            const key = Buffer.alloc(24);
            key.set(header.turnId);
            key.writeBigUInt64BE(seq, 16);
            rows.push({ key, value });
          }
        }
        return rows;
      } finally {
        await reader.close();
      }
    };
    const before = new Map((await updates()).map((row) => [row.key.toString('hex'), row.value]));
    expect(before.size).toBeGreaterThan(0);
    let items = turn.items;
    const batch = NodeLodyHistory.prototype.commitHistoryBatch;
    const lost = vi
      .spyOn(NodeLodyHistory.prototype, 'commitHistoryBatch')
      .mockImplementationOnce(async function (...args) {
        await batch.apply(this, args);
        throw new Error('Lost first-state reply');
      });
    items = [tool, { type: 'text', text: 'base🙂🚀' }];
    try {
      await expect(
        fixture.backend.applyHistoryAction({
          kind: 'assistant-items',
          turnId: turn.id,
          mode: 'replace',
          items,
        })
      ).rejects.toThrow('Lost first-state reply');
    } finally {
      lost.mockRestore();
    }
    expect(await fixture.backend.readTurn(turn.id)).toMatchObject({
      state: 'ready',
      turn: { items },
    });
    for (let step = 1; step < 32; step++) {
      items = [tool, { type: 'text', text: `base🙂${'🚀'.repeat(step + 1)}` }];
      await fixture.backend.applyHistoryAction({
        kind: 'assistant-items',
        turnId: turn.id,
        mode: 'replace',
        items,
      });
    }
    await fixture.backend.flushLocalWrites();
    const after = await updates();
    for (const row of after) {
      const old = before.get(row.key.toString('hex'));
      if (old) expect(row.value.equals(old)).toBe(true);
    }
    expect(after.filter((row) => before.has(row.key.toString('hex'))).length).toBe(before.size);
    const added = after.filter((row) => !before.has(row.key.toString('hex')));
    expect(added.length).toBeGreaterThan(0);
    expect(added.reduce((sum, row) => sum + row.value.length, 0)).toBeLessThan(128 * 1024);
    for (const row of added) {
      expect(row.key.subarray(0, 16).equals(Buffer.from(primaryId))).toBe(false);
      expect(row.value.length).toBeLessThan(16 * 1024);
    }
    const sessionId = fixture.doc.sessionId;
    await fixture.close();
    const reopened = await nativeFixture(sessionId);
    expect(await reopened.backend.readTurn(turn.id)).toMatchObject({
      state: 'ready',
      turn: { items, finished: true, endedAt: 42 },
    });
    expect((await reopened.backend.readHistory()).length).toBe(1);
  });

  it('observes owner checkpoints without holding the writer and closes waits on cancellation', async () => {
    const fixture = await nativeFixture();
    const history = fixture.backend.history;
    if (!history.getCheckpoint || !history.waitForChanges)
      throw new Error('Expected checkpoint watch');
    const checkpoint = await history.getCheckpoint();
    const original = history.getCheckpoint;
    let armed = Promise.withResolvers<void>();
    vi.spyOn(history, 'getCheckpoint').mockImplementation(async () => {
      const value = await original();
      armed.resolve();
      return value;
    });
    vi.useFakeTimers();
    const observed = history.waitForChanges(checkpoint, 15_000);
    await armed.promise;
    await fixture.backend.appendHistoryTurn(nativeUser('watched-owner-write'));
    await observed;
    const next = await original();
    expect(next).not.toBe(checkpoint);
    // The durable checkpoint covers a write between the initial read and watch admission.
    await history.waitForChanges(checkpoint, 15_000);
    expect(await history.readTurn('watched-owner-write')).toMatchObject({ state: 'ready' });
    armed = Promise.withResolvers<void>();
    const deadline = history.waitForChanges(next, 15_000);
    await armed.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    await deadline;
    armed = Promise.withResolvers<void>();
    const abort = new AbortController();
    const cancelled = history.waitForChanges(next, 15_000, abort.signal).catch((error) => error);
    await armed.promise;
    abort.abort();
    expect(await cancelled).toBeInstanceOf(Error);
    // An aborted viewer does not retire the shared writer or checkpoint reader.
    await fixture.backend.appendHistoryTurn(nativeUser('after-observer-abort'));
    expect(await history.readTurn('after-observer-abort')).toMatchObject({ state: 'ready' });
    const atClose = await original();
    armed = Promise.withResolvers<void>();
    const closing = history.waitForChanges(atClose, 15_000).catch((error) => error);
    await armed.promise;
    await fixture.close();
    expect(await closing).toBeInstanceOf(Error);
  });

  it('recovers missed logical edits and appends from an owner-issued checkpoint', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('catchup-user'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('catchup-assistant'));
    const history = fixture.backend.history;
    if (!history.getCheckpoint || !history.readChanges)
      throw new Error('Expected incremental owner');
    const checkpoint = await history.getCheckpoint();
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'catchup-user',
      status: 'seen',
    });
    await fixture.backend.appendHistoryTurn(nativeUser('catchup-next'));
    await fixture.backend.flushLocalWrites();
    const changes = await history.readChanges(checkpoint);
    expect(changes).toMatchObject({ state: 'ready', from: 2 });
    if (changes.state !== 'ready') throw new Error('Expected complete recovery');
    expect(changes.ids).toContain('catchup-user');
    expect(await history.readTurn('catchup-user')).toMatchObject({
      state: 'ready',
      turn: { status: 'seen' },
    });
    expect(await history.readAt(2)).toMatchObject({ state: 'ready', turn: { id: 'catchup-next' } });
    expect(await history.readChanges(changes.checkpoint)).toMatchObject({
      state: 'ready',
      ids: [],
    });
    expect(await history.readChanges('synthetic-foreign-checkpoint')).toMatchObject({
      state: 'reset',
    });
  });

  it('publishes logical corrections to observers and keeps streaming reads bounded', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('observed-u'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('observed-a'));
    const changes: unknown[] = [];
    const observation = fixture.backend.history.observe((change) => changes.push(change));
    await observation.initial;
    const full = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranch')
      .mockRejectedValue(new Error('Full hydration is forbidden'));
    const page = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranchPage')
      .mockRejectedValue(new Error('Streaming branch reload is forbidden'));
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'observed-u',
      status: 'seen',
    });
    await fixture.backend.applyAgentBatch({
      targetAssistantEntryId: 'observed-a',
      contents: [{ type: 'text', text: 'bounded output' }],
      operationIds: ['bounded-output'],
    });
    expect(await fixture.backend.readTurn('observed-a')).toMatchObject({
      state: 'ready',
      turn: { items: [{ text: 'bounded output' }] },
    });
    expect(changes).toEqual(
      expect.arrayContaining([
        { kind: 'changed', ids: ['observed-u'] },
        { kind: 'changed', ids: ['observed-a'] },
      ])
    );
    observation.unsubscribe();
    const observed = [...changes];
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'observed-u',
      status: 'processing',
    });
    expect(changes).toEqual(observed);
    full.mockRestore();
    page.mockRestore();
  });

  it('allows concurrent readers to follow an atomic generation and fences the old writer', async () => {
    const seed = new Uint8Array(32).fill(39);
    const owner = Identity.fromSeed(seed).owner();
    const client = new RoostNativeClient({
      dbPath: join(nativeDirectory, 'generation.db'),
      seed,
      allowedOwners: [owner],
      maxQueuedRequests: 32,
      maxQueuedBytes: 8 * 1024 * 1024,
    });
    try {
      await client.ready;
      const writer = new RoostHistoryGeneration(client, owner, 'generation-race');
      const reader = new RoostHistoryGeneration(client, owner, 'generation-race');
      const old = reader.history;
      await writer.replace([nativeUser('generation-u')], 'generation-replace');
      await Promise.all([reader.resolve(), reader.resolve(), reader.resolve()]);
      expect(
        (await reader.history.readActiveBranch('generation-race')).messages.map(
          (row) => row.businessId
        )
      ).toEqual(['generation-u']);
      await expect(
        old.acceptToView({
          viewId: 'generation-race',
          expectedRevision: 0n,
          expectedHead: null,
          operationId: 'old-writer',
          input: {
            kind: 'message',
            businessId: 'stale-u',
            segmentId: 'primary',
            parents: [],
            content: encodeRoostContent(nativeUser('stale-u')),
          },
        })
      ).rejects.toMatchObject({ code: 'stale' });
      const cursor = await reader.history.observedEventCursor();
      await reader.history.accept({
        kind: 'publication',
        businessId: 'generation-race',
        segmentId: 'newer',
        parents: [],
        content: encodeRoostContent(null),
      });
      await expect(reader.replace([], 'stale-generation', cursor)).rejects.toMatchObject({
        code: 'stale',
      });
      expect(
        (await reader.history.readActiveBranch('generation-race')).messages.map(
          (row) => row.businessId
        )
      ).toEqual(['generation-u']);
    } finally {
      await client.close();
    }
  });

  it('copies opaque stored values into an empty target without validating them as newly authored items', async () => {
    const id = `opaque-${nextOrdinal()}` as SessionId;
    const seed = await loadRoostOwnerSeedLegacy(join(nativeDirectory, 'history.db'));
    const owner = Identity.fromSeed(seed).owner();
    const client = new RoostNativeClient({
      dbPath: join(nativeDirectory, 'history.db'),
      seed,
      allowedOwners: [owner],
      maxQueuedRequests: 32,
      maxQueuedBytes: 8 * 1024 * 1024,
    });
    const opaque = {
      ...nativeUser('opaque-u'),
      extension: { version: 2 },
      items: [{ type: 'future_item', opaque: ['unchanged'] }],
    };
    try {
      await client.ready;
      await new RoostHistoryGeneration(client, owner, id).replace([opaque as never], 'stored-seed');
    } finally {
      await client.close();
    }
    const source = await nativeFixture(id);
    const target = await nativeFixture();
    const snapshot = await source.backend.captureForkSnapshot();
    await source.close();
    await target.backend.importForkHistory(snapshot, snapshot.history);
    expect(await target.backend.readHistory()).toEqual([opaque]);
    await target.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'opaque-u',
      status: 'seen',
    });
    expect(await target.backend.readHistory()).toMatchObject([
      { extension: opaque.extension, items: opaque.items, status: 'seen' },
    ]);
  });

  it.each([1, 3])(
    'never replays an applied append after %i publication CAS failures',
    async (failures) => {
      const fixture = await nativeFixture();
      await fixture.backend.appendHistoryTurn({
        ...nativeAssistant('publish-once'),
        finished: true,
        items: [{ type: 'text', text: 'base' }],
      });
      const publish = RoostHistoryHead.prototype.publish;
      let remaining = failures;
      const spy = vi.spyOn(RoostHistoryHead.prototype, 'publish').mockImplementation(function (
        ...args
      ) {
        if (remaining-- > 0)
          return Promise.reject(
            Object.assign(new Error('Synthetic publication race'), { code: 'stale' })
          );
        return publish.apply(this, args);
      });
      try {
        const append = fixture.backend.applyHistoryAction({
          kind: 'assistant-items',
          turnId: 'publish-once',
          mode: 'append',
          items: [{ type: 'text', text: 'once' }],
        });
        if (failures === 1) await append;
        else await expect(append).rejects.toMatchObject({ code: 'publication_stale' });
      } finally {
        spy.mockRestore();
      }
      const read = await fixture.backend.readTurn('publish-once');
      if (read.state !== 'ready') throw new Error('Committed body unavailable');
      expect(
        read.turn.items
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('')
      ).toBe('baseonce');
      expect(await fixture.backend.history.getPublication!()).toMatchObject({ historyCount: 1 });
    }
  );

  it('invalidates an older loaded page after another owner changes it without reading that page again', async () => {
    const id = `outside-window-${nextOrdinal()}`;
    const root = `lody-session:${id}`;
    const hint = Promise.withResolvers<void>();
    let after: bigint | undefined;
    let native!: RoostNativeClient;
    let tapped = false;
    const onChanges = RoostNativeClient.prototype.onChanges;
    const tap = vi
      .spyOn(RoostNativeClient.prototype, 'onChanges')
      .mockImplementation(function (stream, listener, options) {
        if (stream !== root || tapped) return onChanges.call(this, stream, listener, options);
        tapped = true;
        native = this;
        return onChanges.call(
          this,
          stream,
          (cursor, indexChange) => {
            listener(cursor, indexChange);
            if (after !== undefined && cursor !== null && cursor > after) hint.resolve();
          },
          options
        );
      });
    const source = await nativeFixture(id);
    tap.mockRestore();
    for (let i = 0; i < 45; i++) await source.backend.appendHistoryTurn(nativeUser(`outside-${i}`));
    await source.backend.history.readRange(0, 1);
    const changes: { kind: string; from?: number; ids?: readonly string[] }[] = [];
    const observation = source.backend.history.observe((change) => changes.push(change));
    await observation.initial;
    const events = await native.stream(root).eventsAfter(0n, 1000n);
    after = events.at(-1)?.cursor ?? 0n;
    const peer = await nativeFixture(id);
    try {
      await peer.backend.applyHistoryAction({
        kind: 'user-status',
        turnId: 'outside-0',
        status: 'seen',
      });
      await hint.promise;
      await source.backend.flushLocalWrites();
      expect(
        changes.some((change) =>
          change.kind === 'changed' ? change.ids?.includes('outside-0') : change.from === 0
        )
      ).toBe(true);
      expect(await source.backend.readTurn('outside-0')).toMatchObject({
        state: 'ready',
        turn: { status: 'seen' },
      });
    } finally {
      observation.unsubscribe();
      await peer.close();
      await source.close();
    }
  });

  it('does not replay an ordinary command after a committed content reply is superseded', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('commit-once'),
      items: [{ type: 'text', text: 'base' }],
    });
    const commit = RoostHistoryGeneration.prototype.commitPatches;
    const spy = vi
      .spyOn(RoostHistoryGeneration.prototype, 'commitPatches')
      .mockImplementationOnce(async function (...args) {
        await commit.apply(this, args);
        throw Object.assign(new Error('Synthetic projection supersession'), { code: 'stale' });
      });
    try {
      await expect(
        fixture.backend.applyHistoryAction({
          kind: 'assistant-items',
          turnId: 'commit-once',
          mode: 'append',
          items: [{ type: 'text', text: 'once' }],
        })
      ).rejects.toMatchObject({ code: 'write_stale' });
    } finally {
      spy.mockRestore();
    }
    const read = await fixture.backend.readTurn('commit-once');
    if (read.state !== 'ready') throw new Error('Committed body unavailable');
    expect(
      read.turn.items
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('')
    ).toBe('baseonce');
  });

  it('republishes a committed history correction after its Native head write fails', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('cursor-u'));
    await fixture.backend.appendHistoryTurn(nativeAssistant('cursor-a'));
    const before = await fixture.backend.history.getPublication!();
    const spy = vi
      .spyOn(RoostHistoryHead.prototype, 'publish')
      .mockRejectedValueOnce(new Error('Injected head failure'));
    await expect(
      fixture.backend.applyHistoryAction({
        kind: 'user-status',
        turnId: 'cursor-u',
        status: 'seen',
      })
    ).rejects.toThrow('Injected head failure');
    spy.mockRestore();
    await fixture.backend.applyHistoryAction({
      kind: 'user-status',
      turnId: 'cursor-u',
      status: 'seen',
    });
    expect(await fixture.backend.readTurn('cursor-u')).toMatchObject({
      state: 'ready',
      turn: { status: 'seen' },
    });
    expect((await fixture.backend.history.getPublication!()).historyRevision).toBeGreaterThan(
      before.historyRevision
    );
  });

  it('restores only the owned editable tail while retaining later appends and refuses concurrent edits', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('editable-u'));
    const result = await fixture.backend.replaceEditableTail({
      expectedUserTurnId: 'editable-u',
      expectedForkTurnId: undefined,
      replacement: nativeUser('replacement-u') as never,
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') throw new Error('Expected editable tail');
    await fixture.backend.appendHistoryTurn(nativeAssistant('later-a'));
    await result.rollback();
    expect((await fixture.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'editable-u',
      'later-a',
    ]);
    const conflict = await nativeFixture();
    await conflict.backend.appendHistoryTurn(nativeUser('conflict-u'));
    const conflicting = await conflict.backend.replaceEditableTail({
      expectedUserTurnId: 'conflict-u',
      expectedForkTurnId: undefined,
      replacement: nativeUser('changed-u') as never,
    });
    if (conflicting.status !== 'accepted') throw new Error('Expected editable tail');
    await conflict.backend.applyHistoryAction({
      kind: 'upsert-turn',
      turn: { ...nativeUser('changed-u'), items: [{ type: 'text', text: 'peer edit' }] } as never,
    });
    await expect(conflicting.rollback()).rejects.toThrow('rollback_conflict');
    expect(await conflict.backend.readTurn('changed-u')).toMatchObject({
      state: 'ready',
      turn: { items: [{ text: 'peer edit' }] },
    });
    const reused = await nativeFixture();
    await reused.backend.appendHistoryTurn(nativeUser('reused-u'));
    await reused.backend.appendHistoryTurn(nativeAssistant('reused-a'));
    const replaced = await reused.backend.replaceEditableTail({
      expectedUserTurnId: 'reused-u',
      expectedForkTurnId: undefined,
      replacement: nativeUser('reused-replacement') as never,
    });
    expect(replaced.status).toBe('accepted');
    await reused.backend.appendHistoryTurn({
      ...nativeAssistant('reused-a'),
      items: [{ type: 'text', text: 'new use of removed identity' }],
    });
    expect((await reused.backend.readHistory()).map((entry) => entry.id)).toEqual([
      'reused-replacement',
      'reused-a',
    ]);
    expect(await reused.backend.readTurn('reused-a')).toMatchObject({
      state: 'ready',
      turn: { items: [{ text: 'new use of removed identity' }] },
    });
  });

  it('rejects an edit for an older active goal and rebuilds an invalid derived cache', async () => {
    const fixture = await nativeFixture();
    await fixture.backend.appendHistoryTurn(nativeUser('goal-first-u'));
    await fixture.backend.appendHistoryTurn({
      ...nativeAssistant('goal-first-a'),
      finished: true,
      acpTurnId: 'goal-boundary',
      items: [{ type: 'goal', threadId: 'old-goal', objective: 'Keep working', status: 'active' }],
    });
    await fixture.backend.appendHistoryTurn(nativeUser('goal-tail-u'));
    for (let index = 0; index < 43; index += 1)
      await fixture.backend.appendHistoryTurn({
        ...nativeAssistant(`goal-tail-${index}`),
        finished: true,
      });
    const input = {
      expectedUserTurnId: 'goal-tail-u',
      expectedForkTurnId: 'goal-boundary',
      replacement: nativeUser('goal-replacement') as never,
    };
    const before = await fixture.backend.readHistory();
    const full = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranch')
      .mockRejectedValue(new Error('Cached guard must not scan'));
    try {
      expect(await fixture.backend.replaceEditableTail(input)).toEqual({
        status: 'rejected',
        reason: { code: 'active_goal' },
      });
    } finally {
      full.mockRestore();
    }
    const seed = await loadRoostOwnerSeedLegacy(join(nativeDirectory, 'history.db'));
    const client = new RoostNativeClient({
      dbPath: join(nativeDirectory, 'history.db'),
      seed,
      allowedOwners: [Identity.fromSeed(seed).owner()],
      maxQueuedRequests: 32,
      maxQueuedBytes: 8 * 1024 * 1024,
    });
    try {
      await client.ready;
      await client.stream(`lody-session:${fixture.doc.sessionId}`).writeBatch([], {
        indexPuts: [
          {
            table: 'lody_goal_projection_v1',
            key: new Uint8Array(),
            value: new TextEncoder().encode('{invalid'),
          },
        ],
      });
      expect(await fixture.backend.replaceEditableTail(input)).toEqual({
        status: 'rejected',
        reason: { code: 'active_goal' },
      });
      expect(await fixture.backend.readHistory()).toEqual(before);
    } finally {
      await client.close();
    }
  });

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
