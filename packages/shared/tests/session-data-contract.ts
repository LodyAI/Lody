import { describe, expect, it } from 'vitest';
import type { SessionId } from '../src/ids';
import type { SessionTurn } from '../src/session-data';
import {
  pageVisibleTranscript,
  clearField,
  setFieldTo,
  type SessionData,
  type SessionWriteReceipt,
} from '../src/session-data';

/**
 * The consumer contract for `SessionData`. Every implementation must satisfy it;
 * the Loro adapter and the independent in-memory double both run it, which is
 * what proves session business code does not depend on Loro/CID/offset details.
 *
 * The harness exposes raw escape hatches so a test can model an older peer or a
 * concurrent writer without going through the command port.
 */
export type SessionDataHarness = {
  readonly data: SessionData;
  /** Inject a raw field into a stored turn, as legacy/unknown stored data. */
  injectStoredField(turnId: string, key: string, value: unknown): void;
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

const acceptedReceipt = (
  result: Awaited<ReturnType<SessionData['commands']['appendTurn']>>
): SessionWriteReceipt => {
  if (result.status !== 'accepted') throw new Error(`expected accepted, got ${result.status}`);
  return result.receipt;
};

export function runSessionDataContract(
  name: string,
  create: () => Promise<SessionDataHarness> | SessionDataHarness
): void {
  describe(`${name}: session data contract`, () => {
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

    it('resumes an assistant turn by clearing only its terminal footprint', async () => {
      const harness = await create();
      const { data } = harness;
      await data.commands.appendTurn(assistantTurn('assistant-1'));
      harness.injectStoredField('assistant-1', 'legacyFlag', 'kept');

      const result = await data.commands.resumeAssistant('assistant-1');
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

    it('keeps local acceptance separate from durability', async () => {
      const harness = await create();
      const { data } = harness;
      const result = await data.commands.appendTurn(userTurn('a'));
      const receipt = acceptedReceipt(result);
      await expect(data.durability.waitDurable(receipt)).resolves.toBeUndefined();
      expect((await data.history.readTurn('a')).state).toBe('ready');
    });
  });
}

export { sessionId as contractSessionId };
