import { describe, expect, it } from 'vitest';
import type { SessionId, WorkspaceId } from '../src/ids';
import {
  projectTurnAttention,
  terminalNotificationSchema,
  turnOutcomeKey,
  type TurnOutcomeFact,
} from '../src/notifications';

const fact: TurnOutcomeFact = {
  scope: { workspaceId: 'workspace' as WorkspaceId, recipientId: 'user' },
  sessionId: 'session' as SessionId,
  turnId: 'turn',
  audience: { kind: 'user' },
  outcome: { kind: 'succeeded' },
};

describe('notification source policy', () => {
  it.each(['succeeded', 'failed', 'unknown'] as const)(
    'preserves %s as an actionable user result',
    (kind) => {
      const item = projectTurnAttention({ ...fact, outcome: { kind, code: 'synthetic' } });
      expect(item).toEqual({
        id: JSON.stringify(['turn', 'workspace', 'user', 'session', 'turn']),
        scope: fact.scope,
        source: { kind: 'session', sessionId: fact.sessionId, turnId: fact.turnId },
        outcome: kind,
      });
    }
  );
  it('skips cancelled, delegated and unknown-provenance results', () => {
    expect(projectTurnAttention({ ...fact, outcome: { kind: 'cancelled' } })).toBeNull();
    expect(
      projectTurnAttention({
        ...fact,
        audience: { kind: 'agent', sessionId: 'parent' as SessionId, turnId: 'parent-turn' },
      })
    ).toBeNull();
    expect(projectTurnAttention({ ...fact, audience: { kind: 'unknown' } })).toBeNull();
  });
  it('keeps the existing provider identity across outcome changes and separates recipient/source turns', () => {
    expect(projectTurnAttention({ ...fact, outcome: { kind: 'failed', code: 'error' } })?.id).toBe(
      turnOutcomeKey(fact)
    );
    expect(turnOutcomeKey({ ...fact, turnId: 'next' })).not.toBe(turnOutcomeKey(fact));
    expect(turnOutcomeKey({ ...fact, scope: { ...fact.scope, recipientId: 'other' } })).not.toBe(
      turnOutcomeKey(fact)
    );
  });
  it('validates the same additive projection shape used by the writer and reader', () => {
    const projection = {
      id: 'a42f1111-1111-4111-8111-111111111111',
      recipientId: 'user',
      turnId: 'turn',
      outcome: 'failed',
      createdAt: 100,
    };
    expect(terminalNotificationSchema.parse({ ...projection, futureField: 'ignored' })).toEqual(
      projection
    );
    for (const invalid of [
      { ...projection, outcome: 'cancelled' },
      { ...projection, id: 'invalid' },
      { ...projection, recipientId: '' },
    ]) {
      expect(terminalNotificationSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
