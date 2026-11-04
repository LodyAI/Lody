import { describe, expect, it } from 'vitest';
import type { SessionId } from '@lody/shared';
import { createTerminalNotificationConsumer } from '../src/lib/terminal-notification-consumer';

const sessionId = 'session-1' as SessionId;
const first = 'a42f1111-1111-4111-8111-111111111111';
const second = 'a42f1111-1111-4111-8111-222222222222';
const fact = {
  id: first,
  turnId: 'turn-1',
  recipientId: 'user-1',
  outcome: 'failed',
  createdAt: 100,
};
function setup(read: () => Promise<unknown> = async () => fact) {
  const shown: string[] = [];
  const errors: unknown[] = [];
  const consumer = createTerminalNotificationConsumer({
    recipientId: 'user-1',
    now: () => 200,
    read,
    show: async (_, notification) => {
      shown.push(notification.outcome);
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  return { consumer, shown, errors };
}
describe('desktop terminal consumer', () => {
  it('baselines startup and new/restored rows, consumes changed sources once', async () => {
    const { consumer, shown } = setup();
    await consumer.observe([{ id: sessionId }]);
    await consumer.observe([{ id: sessionId, notificationId: first }]);
    await consumer.observe([{ id: sessionId, notificationId: first }]);
    expect(shown).toEqual(['failed']);
    await consumer.observe([]);
    await consumer.observe([{ id: sessionId, notificationId: first }]);
    expect(shown).toEqual(['failed']);
    consumer.dispose();
    const restart = setup();
    await restart.consumer.observe([{ id: sessionId, notificationId: first }]);
    expect(restart.shown).toEqual([]);
    restart.consumer.dispose();
  });

  it.each([
    { ...fact, recipientId: 'someone-else' },
    { ...fact, id: second },
    { ...fact, outcome: 'cancelled' },
    { ...fact, createdAt: -60_000 },
    { ...fact, createdAt: 300 },
    undefined,
  ])('skips unauthorized, stale, malformed or mismatched projections', async (value) => {
    const { consumer, shown } = setup(async () => value);
    await consumer.observe([{ id: sessionId }]);
    await consumer.observe([{ id: sessionId, notificationId: first }]);
    expect(shown).toEqual([]);
    consumer.dispose();
  });

  it('fences an in-flight read on account/workspace teardown', async () => {
    let release!: (value: unknown) => void;
    const { consumer, shown } = setup(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    await consumer.observe([{ id: sessionId }]);
    const attempt = consumer.observe([{ id: sessionId, notificationId: first }]);
    consumer.dispose();
    release(fact);
    await attempt;
    expect(shown).toEqual([]);
  });
});
