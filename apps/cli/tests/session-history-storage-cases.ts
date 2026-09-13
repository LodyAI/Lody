import type { SessionAgentWrites } from '../src/lib/loro/session-agent-writes';
import { describe, expect, it } from 'vitest';
import type { SessionId } from '@lody/shared/ids';
import type { SessionTurn } from '@lody/shared/session-data';
import {
  pageVisibleTranscript,
  clearField,
  setFieldTo,
  type SessionData,
  type SessionSnapshot,
} from '@lody/shared/session-data';

/** Real stored-history regressions, including old data and concurrent edits. */
export type StoredHistoryFixture = {
  readonly data: SessionData & { commands: SessionData['commands'] & SessionAgentWrites };
  /** Inject a raw field into a stored turn, as legacy/unknown stored data. */
  injectStoredField(turnId: string, key: string, value: unknown): void;
  /** Inject a raw item into a stored turn, as a newer peer's opaque content. */
  injectStoredItem(turnId: string, item: unknown): void;
  /** A peer's independent field write through the shared writer rules. */
  peerSetField(turnId: string, key: string, value: unknown): void;
  /** A peer's independent append. */
  peerAppend(turn: SessionTurn): void;
  /** Detached stored turns, newest last. */
  readStored(): SessionTurn[];
};

const sessionId = 'contract-session' as SessionId;

const userTurn = (turnId: string, text = 'hello'): SessionTurn => ({
  id: turnId,
  role: 'user',
  timestamp: '2026-01-01T00:00:00.000Z',
  items: [{ type: 'text', text }],
  fileDiff: [],
});

const assistantTurn = (turnId: string): SessionTurn => ({
  id: turnId,
  role: 'assistant',
  userTurnId: 'user-1',
  timestamp: '2026-01-01T00:00:01.000Z',
  items: [{ type: 'text', text: 'working' }],
  fileDiff: [],
  finished: true,
  endedAt: 1234,
  permissionWaitMs: 50,
});

const textOf = (turn: SessionTurn | undefined): unknown =>
  Array.isArray(turn?.items) ? (turn.items[0] as { text?: unknown } | undefined)?.text : undefined;

export function runStoredHistoryCases(
  create: () => Promise<StoredHistoryFixture> | StoredHistoryFixture
): void {
  describe('stored history operations', () => {
    it('captures only the linked turn output and preserves observation order', async () => {
      const { data } = await create();
      await data.commands.appendTurn(userTurn('before'));
      await data.commands.appendTurn(userTurn('user-1'));
      await data.commands.appendTurn({ ...assistantTurn('unrelated'), userTurnId: 'before' });
      await data.commands.appendTurn({
        ...assistantTurn('a1'),
        finished: false,
        endedAt: undefined,
      });
      const first = data.history.readTurnOutput('user-1');
      await data.commands.setTurnField('a1', 'finished', setFieldTo(true));
      expect((await first).map((t) => t.id)).toEqual(['user-1', 'a1']);
      expect((await first)[1]?.finished).toBe(false);
      expect((await data.history.readTurnOutput('user-1'))[1]?.finished).toBe(true);
      expect(await data.history.readTurnOutput('missing')).toEqual([]);
      await data.commands.setTurnField('user-1', 'status', setFieldTo('failed'));
      await data.commands.appendTurn({
        id: 'failure',
        role: 'system',
        timestamp: '2026-01-01T00:00:02Z',
        items: [
          {
            type: 'system_notice',
            name: 'chat_failed',
            meta: { reason: 'acp_provider_overloaded', message: 'busy' },
          },
        ],
        fileDiff: [],
      });
      expect((await data.history.readTurnOutput('user-1')).map((t) => t.id)).toEqual([
        'user-1',
        'a1',
        'failure',
      ]);
    });

    it('reads turns by business id and raw range', async () => {
      const { data } = await create();
      await data.commands.appendTurn(userTurn('a'));
      await data.commands.appendTurn(userTurn('b'));
      await data.commands.appendTurn(userTurn('c'));

      expect(await data.history.count()).toBe(3);
      const read = await data.history.readTurn('b');
      expect(read.state).toBe('ready');
      if (read.state === 'ready') expect(textOf(read.turn)).toBe('hello');

      const range = await data.history.readRange(1, 3);
      expect(range.map((entry) => (entry.state === 'ready' ? entry.turn.id : entry.state))).toEqual(
        ['b', 'c']
      );
      expect((await data.history.readTurn('missing')).state).toBe('missing');
      expect((await data.history.readAt(9)).state).toBe('missing');
    });

    it('reads a shallow directory and observes changes gap-free', async () => {
      const harness = await create();
      const { data } = harness;
      await data.commands.appendTurn(userTurn('a'));
      await data.commands.appendTurn(userTurn('b'));

      const rows = await data.history.readDirectory(0, 2);
      expect(rows.map((row) => row.turnId)).toEqual(['a', 'b']);

      const changes: number[] = [];
      const observation = data.history.observe(() => changes.push(1));
      // The initial directory is taken at the same moment the listener is live.
      const initial = await observation.initial;
      expect(initial.map((row) => row.turnId)).toEqual(['a', 'b']);
      await data.commands.appendTurn(userTurn('c'));
      expect(changes.length).toBeGreaterThan(0);
      observation.unsubscribe();
      const observed = changes.length;
      await data.commands.appendTurn(userTurn('d'));
      expect(changes.length).toBe(observed);
    });

    it('reports the changed raw range on observe', async () => {
      const harness = await create();
      const { data } = harness;
      await data.commands.appendTurn(userTurn('a'));
      const ranges: { from?: number; to?: number }[] = [];
      const observation = data.history.observe((change) => {
        if (change.kind === 'changed') ranges.push({ from: change.from, to: change.to });
      });
      await observation.initial;
      await data.commands.appendTurn(userTurn('b'));
      expect(ranges.at(-1)).toEqual({ from: 1, to: 2 });
      observation.unsubscribe();
    });

    it('projects shallow directory facts without materializing the config body', async () => {
      const harness = await create();
      const { data } = harness;
      await data.commands.appendTurn({
        ...userTurn('cfg'),
        inputConfig: {
          prompt: 'SECRET PROMPT',
          inputBlocks: [{ type: 'text', text: 'SECRET BLOCK' }],
          cliType: 'builtin',
          agentType: 'codex',
          modelId: 'model-1',
          mcpServerIds: [],
          configOptionValues: { plan_mode: true },
        },
      } as unknown as SessionTurn);

      const [row] = await data.history.readDirectory(0, 1);
      expect(row?.state).toBe('ready');
      expect(row?.turnId).toBe('cfg');
      expect(row?.scalars).toMatchObject({ id: 'cfg', role: 'user' });
      expect(row?.inputConfig).toMatchObject({
        cliType: 'builtin',
        agentType: 'codex',
        modelId: 'model-1',
        mcpServerIds: [],
        configOptionValues: { plan_mode: true },
      });
      // The body-independent projection never carries the prompt or input blocks.
      expect(JSON.stringify(row?.inputConfig)).not.toContain('SECRET');
    });

    it('reads the whole stored history as one detached snapshot', async () => {
      const harness = await create();
      const { data } = harness;
      await data.commands.appendTurn(userTurn('a'));
      await data.commands.appendTurn(userTurn('b'));

      const all = await data.history.readAll();
      expect(all.map((turn) => turn.id)).toEqual(['a', 'b']);
      // Detached: mutating the returned rows cannot change stored history.
      (all[0] as unknown as { id: string }).id = 'mutated';
      const read = await data.history.readTurn('a');
      expect(read.state).toBe('ready');
    });

    it('sets and clears a field explicitly, preserving unknown stored fields', async () => {
      const harness = await create();
      const { data } = harness;
      await data.commands.appendTurn(userTurn('a'));
      harness.injectStoredField('a', 'legacyFlag', true);

      const set = await data.commands.setTurnField('a', 'status', setFieldTo('handled'));
      expect(set.status).toBe('accepted');

      let stored = harness.readStored().find((turn) => turn.id === 'a')!;
      expect(stored.status).toBe('handled');
      // The legacy field is not scrubbed by a new write to a different field.
      expect((stored as Record<string, unknown>).legacyFlag).toBe(true);

      const clear = await data.commands.setTurnField('a', 'status', clearField());
      expect(clear.status).toBe('accepted');
      stored = harness.readStored().find((turn) => turn.id === 'a')!;
      expect(Object.hasOwn(stored, 'status')).toBe(false);
      // A clear survives a JSON round-trip: absence, not an `undefined` property.
      const roundTripped = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
      expect(Object.hasOwn(roundTripped, 'status')).toBe(false);
      expect(roundTripped.legacyFlag).toBe(true);
    });

    it('marks a turn seen idempotently with the legacy read flag', async () => {
      const harness = await create();
      const { data } = harness;
      await data.commands.appendTurn(userTurn('a'));

      const first = await data.commands.markTurnSeen('a');
      expect(first.status).toBe('accepted');
      const stored = harness.readStored().find((turn) => turn.id === 'a')!;
      expect(stored.status).toBe('seen');
      expect(stored.read).toBe(true);

      // Idempotent, and a missing target is a validated rejection.
      expect((await data.commands.markTurnSeen('a')).status).toBe('accepted');
      expect((await data.commands.markTurnSeen('missing')).status).toBe('rejected');
    });

    it('refuses to regress an advanced status when marking seen', async () => {
      const harness = await create();
      const { data } = harness;
      await data.commands.appendTurn(userTurn('a'));
      // A concurrent writer advanced the turn after the reader observed pending.
      harness.peerSetField('a', 'status', 'processing');

      const result = await data.commands.markTurnSeen('a');
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason.code).toBe('conflict');
      const stored = harness.readStored().find((turn) => turn.id === 'a')!;
      expect(stored.status).toBe('processing');
      expect(stored.read).not.toBe(true);
    });

    it('resumes an assistant turn by clearing only its terminal footprint', async () => {
      const harness = await create();
      const { data } = harness;
      await data.commands.appendTurn(assistantTurn('assistant-1'));
      harness.injectStoredField('assistant-1', 'legacyFlag', 'kept');

      const result = await data.commands.openAssistantTurn({
        turnId: 'assistant-1',
        timestamp: '2026-01-01T00:00:00Z',
      });
      expect(result.status).toBe('accepted');

      const stored = harness.readStored().find((turn) => turn.id === 'assistant-1')!;
      expect(stored.finished).toBe(false);
      expect(Object.hasOwn(stored, 'endedAt')).toBe(false);
      expect(Object.hasOwn(stored, 'permissionWaitMs')).toBe(false);
      expect((stored as Record<string, unknown>).legacyFlag).toBe('kept');
      expect(textOf(stored)).toBe('working');
    });

    it('opens an assistant turn by creating or reopening it without duplicating', async () => {
      const harness = await create();
      const { data } = harness;

      const created = await data.commands.openAssistantTurn({
        turnId: 'assistant-new',
        userTurnId: 'user-1',
        timestamp: '2026-01-01T00:00:02.000Z',
      });
      expect(created.status).toBe('accepted');
      expect(harness.readStored().filter((turn) => turn.id === 'assistant-new')).toHaveLength(1);

      await data.commands.appendTurn(assistantTurn('assistant-1'));
      harness.injectStoredField('assistant-1', 'legacyFlag', 'kept');
      const reopened = await data.commands.openAssistantTurn({
        turnId: 'assistant-1',
        userTurnId: 'replacement-user',
        timestamp: '2026-01-01T00:00:03.000Z',
      });
      expect(reopened.status).toBe('accepted');

      const stored = harness.readStored();
      expect(stored.filter((turn) => turn.id === 'assistant-1')).toHaveLength(1);
      const turn = stored.find((candidate) => candidate.id === 'assistant-1')!;
      expect(turn.finished).toBe(false);
      expect(Object.hasOwn(turn, 'endedAt')).toBe(false);
      expect(Object.hasOwn(turn, 'permissionWaitMs')).toBe(false);
      expect((turn as Record<string, unknown>).legacyFlag).toBe('kept');
      // Reopening never overwrites existing provenance.
      expect(turn.userTurnId).toBe('user-1');
    });

    it('resolves a task proposal against the live notice and rejects a miss', async () => {
      const harness = await create();
      const { data } = harness;
      await data.commands.appendTurn({
        ...assistantTurn('assistant-1'),
        items: [
          {
            type: 'system_notice',
            name: 'task_proposal',
            meta: { proposalId: 'p1', title: 'Ship it' },
          },
        ],
      });

      const resolved = await data.commands.resolveTaskProposal('assistant-1', 'p1', {
        outcome: 'created',
        taskId: 'task-1',
      });
      expect(resolved.status).toBe('accepted');
      const stored = harness.readStored().find((turn) => turn.id === 'assistant-1')!;
      const item = (stored.items as Array<Record<string, unknown>> | undefined)?.[0];
      expect(
        item?.type === 'system_notice' && (item.meta as Record<string, unknown>)?.outcome
      ).toBe('created');
      expect(item?.type === 'system_notice' && (item.meta as Record<string, unknown>)?.taskId).toBe(
        'task-1'
      );
      // Unrelated fields survive the targeted edit.
      expect(stored.endedAt).toBe(1234);

      const missing = await data.commands.resolveTaskProposal('assistant-1', 'nope', {
        outcome: 'dismissed',
      });
      expect(missing.status).toBe('rejected');
    });

    it('answers permissions by request id and rejects a scoped miss', async () => {
      const harness = await create();
      const { data } = harness;
      const withPermission = (turnId: string, requestId: string): SessionTurn => ({
        ...assistantTurn(turnId),
        items: [
          {
            type: 'tool_call',
            toolCallId: turnId,
            status: 'pending',
            permissionRequest: { requestId, options: [] },
          },
        ],
      });
      await data.commands.appendTurn(withPermission('assistant-1', 'req-1'));
      await data.commands.appendTurn(withPermission('assistant-2', 'req-2'));

      const scopedMiss = await data.commands.respondPermission(
        'req-1',
        { outcome: 'cancelled' },
        { turnId: 'assistant-2' }
      );
      expect(scopedMiss.status).toBe('rejected');
      if (scopedMiss.status === 'rejected') expect(scopedMiss.reason.code).toBe('not_found');

      const answered = await data.commands.respondPermission(
        'req-1',
        { outcome: 'cancelled' },
        { turnId: 'assistant-1' }
      );
      expect(answered.status).toBe('accepted');
      const stored = harness.readStored().find((turn) => turn.id === 'assistant-1')!;
      const item = (stored.items as Array<Record<string, unknown>> | undefined)?.[0];
      const request = item?.permissionRequest as Record<string, unknown> | undefined;
      expect((request?.outcome as { outcome?: string } | undefined)?.outcome).toBe('cancelled');
    });

    it('applies a bound agent batch to its target turn and preserves the others', async () => {
      const harness = await create();
      const { data } = harness;
      await data.commands.appendTurn(assistantTurn('assistant-1'));
      await data.commands.appendTurn(assistantTurn('assistant-2'));
      const otherBefore = JSON.stringify(
        harness.readStored().find((turn) => turn.id === 'assistant-2')
      );

      const result = await data.commands.applyAgentBatch({
        notifications: [
          {
            sessionId: 'synthetic',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: ' streamed' },
            },
          },
        ] as never,
        targetAssistantEntryId: 'assistant-1',
        entryBound: true,
        createId: () => 'assistant-1',
        now: () => '2026-01-01T00:00:02.000Z',
      });
      expect(result.status).toBe('accepted');

      const target = harness.readStored().find((turn) => turn.id === 'assistant-1')!;
      expect(JSON.stringify(target.items)).toContain('streamed');
      expect(JSON.stringify(harness.readStored().find((turn) => turn.id === 'assistant-2'))).toBe(
        otherBefore
      );

      // A bound batch with no stored target still creates it under the bound id,
      // matching the historical targeted-then-create fallthrough.
      const created = await data.commands.applyAgentBatch({
        contents: [{ type: 'text', text: 'created' }] as never,
        targetAssistantEntryId: 'missing',
        entryBound: true,
        createId: () => 'missing',
        now: () => '2026-01-01T00:00:03.000Z',
      });
      expect(created.status).toBe('accepted');
      const createdRead = await data.history.readTurn('missing');
      expect(createdRead.state).toBe('ready');
      if (createdRead.state === 'ready') {
        expect(JSON.stringify(createdRead.turn.items)).toContain('created');
      }
    });

    it('replaces one known field without re-validating unchanged stored items', async () => {
      const harness = await create();
      const { data } = harness;
      await data.commands.appendTurn(assistantTurn('a'));
      // A newer peer's unknown item and a known item carrying a legacy extra
      // subfield: both are untouched by the replacement and must survive.
      const opaqueItems = [
        { type: 'future_item', futurePayload: 'opaque' },
        { type: 'text', text: 'legacy', legacyField: 7 },
      ];
      for (const item of opaqueItems) harness.injectStoredItem('a', item);

      const read = await data.history.readTurn('a');
      if (read.state !== 'ready') throw new Error('expected the appended turn');
      const result = await data.commands.replaceTurn('a', { ...read.turn, finished: false });
      expect(result.status).toBe('accepted');

      const stored = harness.readStored().find((turn) => turn.id === 'a')!;
      expect(stored.finished).toBe(false);
      expect(stored.items).toEqual([...(assistantTurn('a').items ?? []), ...opaqueItems]);

      // Control: a *changed* known item with an invalid field is still rejected,
      // and the stored turn is untouched.
      const rejectedResult = await data.commands.replaceTurn('a', {
        ...read.turn,
        items: [...(read.turn.items ?? []), { type: 'text', text: 42 }] as never,
      });
      expect(rejectedResult.status).toBe('rejected');
      expect(harness.readStored().find((turn) => turn.id === 'a')!.items).toEqual([
        ...(assistantTurn('a').items ?? []),
        ...opaqueItems,
      ]);
    });

    it('rejects invalid input before storage changes', async () => {
      const harness = await create();
      const { data } = harness;
      await data.commands.appendTurn(userTurn('a'));
      const before = JSON.stringify(harness.readStored());

      const invalid = await data.commands.appendTurn({
        ...userTurn('b'),
        role: 'invalid',
      } as unknown as SessionTurn);
      expect(invalid.status).toBe('rejected');

      const badField = await data.commands.setTurnField(
        'a',
        'finished',
        setFieldTo('yes' as unknown as boolean)
      );
      expect(badField.status).toBe('rejected');
      expect(JSON.stringify(harness.readStored())).toBe(before);
    });

    it('applies a conditional field write without overwriting a peer edit', async () => {
      const harness = await create();
      const { data } = harness;
      await data.commands.appendTurn(userTurn('a'));

      // Peer writes a different field and appends while our caller "holds" a read.
      harness.peerSetField('a', 'status', 'handled');
      harness.peerAppend(userTurn('peer'));

      const result = await data.commands.setTurnField('a', 'finished', setFieldTo(true));
      expect(result.status).toBe('accepted');

      const stored = harness.readStored();
      const a = stored.find((turn) => turn.id === 'a')!;
      expect(a.finished).toBe(true);
      expect(a.status).toBe('handled');
      expect(stored.some((turn) => turn.id === 'peer')).toBe(true);
    });

    it('pages the visible transcript by raw cursor without falsifying the tail', async () => {
      const harness = await create();
      const { data } = harness;
      for (const [index, turn] of [
        userTurn('u0'),
        { ...userTurn('s1'), role: 'system' as const },
        userTurn('u1'),
        { ...userTurn('s2'), role: 'system' as const },
        { ...userTurn('s3'), role: 'system' as const },
      ].entries()) {
        await data.commands.appendTurn({ ...turn, id: `t${index}` });
      }
      const isVisible = (turn: SessionTurn) => turn.role !== 'system';

      const first = await pageVisibleTranscript(data.history, { limit: 1, isVisible });
      expect(first.turns.map((turn) => turn.id)).toEqual(['t2']);
      expect(first.positions).toEqual([2]);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeDefined();

      const second = await pageVisibleTranscript(data.history, {
        limit: 1,
        cursor: first.nextCursor,
        isVisible,
      });
      expect(second.turns.map((turn) => turn.id)).toEqual(['t0']);
      expect(second.positions).toEqual([0]);
      expect(second.hasMore).toBe(false);

      // A tail of hidden turns must not be reported as an empty history.
      const tailHidden = await pageVisibleTranscript(data.history, {
        limit: 5,
        cursor: '1',
        isVisible: () => false,
      });
      expect(tailHidden.turns).toEqual([]);
      expect(tailHidden.hasMore).toBe(false);
    });

    it('refuses a forged stored-copy handle before writing', async () => {
      const { data, readStored } = await create();
      const forged = { history: [] } as unknown as SessionSnapshot;
      expect(await data.snapshots.copyFrom(forged, [])).toMatchObject({
        status: 'rejected',
        reason: { code: 'invalid_input' },
      });
      expect(readStored()).toEqual([]);
    });

    it('copies a cross-store selection, retaining opaque stored items and rejecting colliding ids', async () => {
      const sourceHarness = await create();
      const source = sourceHarness.data;
      const sourceSnapshots = source.snapshots;
      if (!sourceSnapshots) throw new Error('the backend must expose its snapshot service');

      await source.commands.appendTurn(userTurn('a'));
      await source.commands.appendTurn(userTurn('b'));
      // A stored item carries a legacy subfield the caller never authored.
      sourceHarness.injectStoredItem('a', { type: 'text', text: 'legacy', legacyField: 7 });
      const snapshot = await sourceSnapshots.capture();

      // read() is the handle's own full, detached read of the captured source:
      // it sees the stored content, and mutating one copy cannot change it.
      const captured = snapshot.history as SessionTurn[];
      expect(captured.map((turn) => turn.id)).toEqual(['a', 'b']);
      expect(captured[0]!.items).toEqual([
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'legacy', legacyField: 7 },
      ]);
      captured.push(userTurn('mutated'));
      expect(snapshot.history.map((turn) => turn.id)).toEqual(['a', 'b']);

      const targetHarness = await create();
      const target = targetHarness.data;
      await target.commands.appendTurn(userTurn('c')); // target initialization row

      // The business caller re-authors the selection without the opaque field.
      const selection: readonly SessionTurn[] = [
        {
          id: 'a',
          role: 'user',
          timestamp: '2026-01-01T00:00:00.000Z',
          items: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: 'legacy' },
          ],
          fileDiff: [],
        },
      ];
      expect(JSON.stringify(selection)).not.toContain('legacyField');

      // The fork flow: a target store copies a source store's snapshot. The
      // copy is prepended, the opaque subfield comes from the captured source,
      // the target's initialization row is retained and the source is untouched.
      const copied = await target.snapshots!.copyFrom(snapshot, selection);
      expect(copied.status).toBe('accepted');

      expect(targetHarness.readStored().map((turn) => turn.id)).toEqual(['a', 'c']);
      expect(targetHarness.readStored()[0]!.items).toEqual([
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'legacy', legacyField: 7 },
      ]);
      expect(sourceHarness.readStored().map((turn) => turn.id)).toEqual(['a', 'b']);

      // A colliding id in the target store is a validated pre-write rejection.
      const collision = await target.snapshots!.copyFrom(snapshot, selection);
      expect(collision.status).toBe('rejected');
      if (collision.status === 'rejected') expect(collision.reason.code).toBe('conflict');
      expect(targetHarness.readStored().map((turn) => turn.id)).toEqual(['a', 'c']);
    });

    it('replaces the editable tail, reports the previous user and compensates the range only', async () => {
      const harness = await create();
      const { data } = harness;

      await data.commands.appendTurn(userTurn('u1'));
      await data.commands.appendTurn({ ...assistantTurn('a1'), acpTurnId: 'provider-1' });
      await data.commands.appendTurn(userTurn('u2'));
      // Opaque stored content the current build never authored.
      harness.injectStoredItem('u1', { type: 'text', text: 'legacy', legacyField: 7 });
      harness.injectStoredItem('u2', { type: 'text', text: 'old', legacyField: 9 });

      const applied = await data.commands.replaceEditableTail({
        expectedUserTurnId: 'u2',
        expectedForkTurnId: 'provider-1',
        replacement: userTurn('u2-new', 'edited'),
      });
      expect(applied.status).toBe('accepted');
      if (applied.status !== 'accepted') return;
      expect(applied.previousUserTurnId).toBe('u1');
      expect(textOf(harness.readStored()[2])).toBe('edited');
      expect(harness.readStored().map((turn) => turn.id)).toEqual(['u1', 'a1', 'u2-new']);
      // The untouched prefix row keeps its opaque stored item.
      expect(harness.readStored()[0]!.items).toContainEqual({
        type: 'text',
        text: 'legacy',
        legacyField: 7,
      });

      // Compensation restores only the replaced range: a row appended after the
      // replacement survives the rollback, and the replaced row's opaque items
      // come back from the writer's captured stored values.
      await data.commands.appendTurn(userTurn('u3'));
      await applied.rollback();
      expect(harness.readStored().map((turn) => turn.id)).toEqual(['u1', 'a1', 'u2', 'u3']);
      expect(harness.readStored()[2]!.items).toContainEqual({
        type: 'text',
        text: 'old',
        legacyField: 9,
      });
    });

    it('rejects the compensation when the replaced range was edited by a peer', async () => {
      const harness = await create();
      const { data } = harness;

      await data.commands.appendTurn(userTurn('u1'));
      await data.commands.appendTurn({ ...assistantTurn('a1'), acpTurnId: 'provider-1' });
      await data.commands.appendTurn(userTurn('u2'));

      const applied = await data.commands.replaceEditableTail({
        expectedUserTurnId: 'u2',
        expectedForkTurnId: 'provider-1',
        replacement: userTurn('u2-new', 'edited'),
      });
      if (applied.status !== 'accepted') throw new Error('expected an accepted replacement');

      // A peer edit inside the replaced range invalidates the compensation: it
      // rejects instead of fabricating a restore over the peer's change.
      harness.peerSetField('u2-new', 'status', 'handled');
      await expect(applied.rollback()).rejects.toThrow();
      expect(harness.readStored().map((turn) => turn.id)).toEqual(['u1', 'a1', 'u2-new']);
      expect(harness.readStored()[2]!.status).toBe('handled');
    });

    it('refuses a tail replacement whose tail moved at commit time', async () => {
      const harness = await create();
      const { data } = harness;

      await data.commands.appendTurn(userTurn('u1'));
      await data.commands.appendTurn({ ...assistantTurn('a1'), acpTurnId: 'provider-1' });
      await data.commands.appendTurn(userTurn('u2'));
      // A concurrent append lands before the command runs; the store re-locates
      // the tail instead of trusting the caller's earlier resolution.
      await data.commands.appendTurn(userTurn('u2-concurrent'));

      const refused = await data.commands.replaceEditableTail({
        expectedUserTurnId: 'u2',
        expectedForkTurnId: 'provider-1',
        replacement: userTurn('u2-new', 'edited'),
      });
      expect(refused.status).toBe('rejected');
      if (refused.status === 'rejected') expect(refused.reason.code).toBe('stale_boundary');
      expect(harness.readStored().map((turn) => turn.id)).toEqual([
        'u1',
        'a1',
        'u2',
        'u2-concurrent',
      ]);
    });

    it('refuses a tail replacement whose provider boundary no longer matches', async () => {
      const harness = await create();
      const { data } = harness;

      await data.commands.appendTurn(userTurn('u1'));
      await data.commands.appendTurn({ ...assistantTurn('a1'), acpTurnId: 'provider-1' });
      await data.commands.appendTurn(userTurn('u2'));

      const refused = await data.commands.replaceEditableTail({
        expectedUserTurnId: 'u2',
        expectedForkTurnId: 'provider-other',
        replacement: userTurn('u2-new', 'edited'),
      });
      expect(refused.status).toBe('rejected');
      if (refused.status === 'rejected') expect(refused.reason.code).toBe('stale_boundary');
      expect(harness.readStored().map((turn) => turn.id)).toEqual(['u1', 'a1', 'u2']);
    });

    it('refuses a tail replacement while a session goal is active in history', async () => {
      const harness = await create();
      const { data } = harness;

      await data.commands.appendTurn({
        ...userTurn('u1'),
        items: [
          { type: 'text', text: 'hello' },
          { type: 'goal', threadId: 'thread-1', objective: 'ship it', status: 'active' },
        ],
      });
      await data.commands.appendTurn({ ...assistantTurn('a1'), acpTurnId: 'provider-1' });
      await data.commands.appendTurn(userTurn('u2'));

      const refused = await data.commands.replaceEditableTail({
        expectedUserTurnId: 'u2',
        expectedForkTurnId: 'provider-1',
        replacement: userTurn('u2-new', 'edited'),
      });
      expect(refused.status).toBe('rejected');
      if (refused.status === 'rejected') expect(refused.reason.code).toBe('active_goal');
      expect(harness.readStored().map((turn) => turn.id)).toEqual(['u1', 'a1', 'u2']);
    });

    it('consults the meta goal fallback when the history carries no goal item', async () => {
      const harness = await create();
      const { data } = harness;

      await data.commands.appendTurn(userTurn('u1'));
      await data.commands.appendTurn({ ...assistantTurn('a1'), acpTurnId: 'provider-1' });
      await data.commands.appendTurn(userTurn('u2'));

      const refused = await data.commands.replaceEditableTail({
        expectedUserTurnId: 'u2',
        expectedForkTurnId: 'provider-1',
        replacement: userTurn('u2-new', 'edited'),
        fallbackGoal: {
          type: 'goal',
          threadId: 'thread-1',
          objective: 'ship it',
          status: 'active',
        },
      });
      expect(refused.status).toBe('rejected');
      if (refused.status === 'rejected') expect(refused.reason.code).toBe('active_goal');
      expect(harness.readStored().map((turn) => turn.id)).toEqual(['u1', 'a1', 'u2']);
    });

    it('imports history in one bound block: write, stored baseline and cursor', async () => {
      const harness = await create();
      const { data } = harness;

      const imported = await data.commands.applyHistoryImport({
        mode: 'initialize',
        replay: {
          history: [userTurn('a'), userTurn('b')],
          turnHashes: ['hash-a', 'hash-b'],
          replayDigest: 'digest',
          droppedNotifications: 0,
        },
      });
      expect(imported.status).toBe('accepted');
      if (imported.status === 'accepted') expect(imported.appended).toBe(2);
      expect(harness.readStored().map((turn) => turn.id)).toEqual(['a', 'b']);
    });
  });
}

export { sessionId as storageSessionId };
