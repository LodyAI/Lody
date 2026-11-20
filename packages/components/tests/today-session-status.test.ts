import { describe, expect, it } from 'vitest';
import type { SessionMeta, SessionStatus } from '@lody/shared';
import { todaySessionDisplay } from '../src/components/today/today-session-status';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const HOUR = 3_600_000;
const meta = (overrides: Partial<SessionMeta> & Record<string, unknown> = {}) =>
  ({
    id: 's1',
    title: 'Fix login',
    lastMessageAt: NOW - 4 * HOUR,
    lastReadAt: NOW - HOUR,
    ...overrides,
  }) as SessionMeta;
const show = (
  value: SessionMeta | undefined,
  live: SessionStatus | null = null,
  metaSettled = true
) => todaySessionDisplay({ meta: value, metaSettled, live, nowMs: NOW });
const statusOf = (value: SessionMeta, live: SessionStatus | null = null) => {
  const display = show(value, live);
  return display.state === 'ok' ? display.status : display.state;
};

describe('Today mention status', () => {
  it('waits for metadata before calling a conversation deleted', () => {
    expect(show(undefined, null, false).state).toBe('loading');
    expect(show(undefined).state).toBe('missing');
  });

  it('puts waiting above running, and running above Later, done and unread', () => {
    const snoozed = meta({ snoozedUntil: NOW + 2 * HOUR, lastReadAt: 0 });
    expect(statusOf(snoozed, { type: 'requestPermission' })).toBe('waiting');
    expect(statusOf(snoozed, { type: 'running' } as SessionStatus)).toBe('running');
    expect(statusOf(meta({ isArchived: true }), { type: 'running' } as SessionStatus)).toBe(
      'running'
    );
  });

  it('shows Later with the sidebar countdown, hiding unread while snoozed', () => {
    const display = show(meta({ snoozedUntil: NOW + 2 * HOUR, lastReadAt: 0 }));
    expect(display).toMatchObject({ status: 'later', group: 'later', snoozeCountdown: '2h' });
  });

  it('marks archived and settled conversations done, and a newer message reopens a settled one', () => {
    expect(statusOf(meta({ isArchived: true }))).toBe('done');
    expect(statusOf(meta({ settledAt: NOW - 2 * HOUR }))).toBe('done');
    expect(statusOf(meta({ settledAt: NOW - 5 * HOUR }))).toBe('idle');
  });

  it('shows unread except for agent-managed conversations, and idle otherwise', () => {
    const unread = { lastReadAt: NOW - 5 * HOUR };
    expect(show(meta(unread))).toMatchObject({ status: 'unread', unread: true });
    expect(show(meta({ ...unread, agentManaged: true }))).toMatchObject({
      status: 'idle',
      unread: false,
    });
    expect(show(meta())).toMatchObject({ status: 'idle', group: 'focus', unread: false });
  });
});
