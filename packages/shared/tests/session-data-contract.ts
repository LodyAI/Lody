import { describe, expect, it } from 'vitest';
import type { SessionId } from '../src/ids';
import type { SessionHistory } from '../src/schema';
import type { SessionData, SessionWriteReceipt } from '../src/session-data';
import { clearField, setFieldTo } from '../src/session-data';

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
  peerAppend(turn: SessionHistory): void;
  /** Detached stored turns, newest last. */
  readStored(): SessionHistory[];
};

const sessionId = 'contract-session' as SessionId;

const userTurn = (turnId: string, text = 'hello'): SessionHistory => ({
  id: turnId,
  role: 'user',
  timestamp: '2026-01-01T00:00:00.000Z',
  items: [{ type: 'text', text }],
  fileDiff: [],
});

const assistantTurn = (turnId: string): SessionHistory => ({
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

      expect(data.history.count()).toBe(3);
      const read = await data.history.readTurn('b');
      expect(read.state).toBe('ready');
      if (read.state === 'ready') expect(read.turn.items?.[0]?.text).toBe('hello');

      const range = await data.history.readRange(1, 3);
      expect(range.map((entry) => (entry.state === 'ready' ? entry.turn.id : entry.state))).toEqual(
        ['b', 'c']
      );
      expect((await data.history.readTurn('missing')).state).toBe('missing');
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

    it('resumes an assistant turn by clearing only its terminal footprint', async () => {
      const harness = await create();
      const { data } = harness;
      await data.commands.appendTurn(assistantTurn('assistant-1'));
      harness.injectStoredField('assistant-1', 'legacyFlag', 'kept');

      const result = await data.commands.resumeAssistant('assistant-1');
      expect(result.status).toBe('accepted');

      const stored = harness.readStored().find((turn) => turn.id === 'assistant-1')!;
      expect(Object.hasOwn(stored, 'finished')).toBe(false);
      expect(Object.hasOwn(stored, 'endedAt')).toBe(false);
      expect(Object.hasOwn(stored, 'permissionWaitMs')).toBe(false);
      expect((stored as Record<string, unknown>).legacyFlag).toBe('kept');
      expect(stored.items?.[0]?.text).toBe('working');
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
      expect(Object.hasOwn(turn, 'finished')).toBe(false);
      expect(Object.hasOwn(turn, 'endedAt')).toBe(false);
      expect(Object.hasOwn(turn, 'permissionWaitMs')).toBe(false);
      expect((turn as Record<string, unknown>).legacyFlag).toBe('kept');
      // Reopening never overwrites existing provenance.
      expect(turn.userTurnId).toBe('user-1');
    });

    it('answers permissions by request id and rejects a scoped miss', async () => {
      const harness = await create();
      const { data } = harness;
      const withPermission = (turnId: string, requestId: string): SessionHistory => ({
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
        {
          turnId: 'assistant-2',
        }
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
      const item = stored.items?.[0];
      expect(item?.type === 'tool_call' && item.permissionRequest?.outcome?.outcome).toBe(
        'cancelled'
      );
    });

    it('rejects invalid input before storage changes', async () => {
      const harness = await create();
      const { data } = harness;
      await data.commands.appendTurn(userTurn('a'));
      const before = JSON.stringify(harness.readStored());

      const invalid = await data.commands.appendTurn({
        ...userTurn('b'),
        role: 'invalid',
      } as unknown as SessionHistory);
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
      const isVisible = (turn: SessionHistory) => turn.role !== 'system';

      const first = await data.history.readVisiblePage({ limit: 1, isVisible });
      expect(first.turns.map((turn) => turn.id)).toEqual(['t2']);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeDefined();

      const second = await data.history.readVisiblePage({
        limit: 1,
        cursor: first.nextCursor,
        isVisible,
      });
      expect(second.turns.map((turn) => turn.id)).toEqual(['t0']);
      expect(second.hasMore).toBe(false);

      // A tail of hidden turns must not be reported as an empty history.
      const tailHidden = await data.history.readVisiblePage({
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
