import { expect, it } from 'vitest';
import { turnNotificationAudience } from '../src/lib/notifications/turn-notification-audience';

it('uses exact author provenance, with no Session-parent inference', () => {
  expect(turnNotificationAudience(undefined)).toEqual({ kind: 'user' });
  expect(turnNotificationAudience({ v: 1, kind: 'human', userId: 'user-1' })).toEqual({
    kind: 'user',
  });
  expect(
    turnNotificationAudience({
      v: 1,
      kind: 'agent',
      sessionId: 'parent',
      turnId: 'parent-turn',
      name: 'Agent',
    })
  ).toEqual({ kind: 'agent', sessionId: 'parent', turnId: 'parent-turn' });
  expect(turnNotificationAudience({ v: 1, kind: 'system' })).toEqual({ kind: 'unknown' });
  expect(turnNotificationAudience({ kind: 'invalid' })).toEqual({ kind: 'unknown' });
});
