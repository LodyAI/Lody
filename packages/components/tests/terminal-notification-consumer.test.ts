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

  it('does not retry a failed read when the same index is observed again', async () => {
    let reads = 0;
    const { consumer, shown, errors } = setup(async () => {
      reads++;
      throw new Error('offline');
    });
    await consumer.observe([{ id: sessionId }]);
    await consumer.observe([{ id: sessionId, notificationId: first }]);
    await consumer.observe([{ id: sessionId, notificationId: first }]);
    expect({ shown, reads, errors: errors.map(String) }).toEqual({
      shown: [],
      reads: 1,
      errors: ['Error: offline'],
    });
    consumer.dispose();
  });
  it('bounds reads across overlapping observations and drops overload without replay', async () => {
    const releases: Array<(value: unknown) => void> = [];
    const { consumer, shown } = setup(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        })
    );
    const entries = Array.from({ length: 5 }, (_, index) => ({
      id: `session-${index}` as SessionId,
    }));
    await consumer.observe(entries);
    const firstBatch = consumer.observe(
      entries.map((entry, index) => ({ ...entry, notificationId: index < 4 ? first : undefined }))
    );
    await consumer.observe(entries.map((entry) => ({ ...entry, notificationId: first })));
    expect(releases).toHaveLength(4);
    releases.forEach((release) => release(fact));
    await firstBatch;
    await consumer.observe(entries.map((entry) => ({ ...entry, notificationId: first })));
    expect(shown).toHaveLength(4);
    expect(releases).toHaveLength(4);
    consumer.dispose();
  });
});
