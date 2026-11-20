import { describe, expect, it } from 'vitest';
import type { SessionMeta, SessionStatus } from '@lody/shared';
import { todaySessionDisplay } from '../src/components/today/today-session-status';

const meta = (overrides: Partial<SessionMeta> & Record<string, unknown> = {}) =>
  ({
    id: 's1',
    title: 'Fix login',
    lastMessageAt: Date.parse('2026-11-20T08:00:00.000Z'),
    ...overrides,
  }) as SessionMeta;

describe('Today session node status', () => {
  it('waits for metadata before calling a session deleted', () => {
    expect(todaySessionDisplay({ meta: undefined, metaSettled: false, live: null }).state).toBe(
      'loading'
    );
    expect(todaySessionDisplay({ meta: undefined, metaSettled: true, live: null }).state).toBe(
      'missing'
    );
  });

  it('shows waiting and running from live presence, like the sidebar', () => {
    const permission: SessionStatus = { type: 'requestPermission' };
    expect(
      todaySessionDisplay({ meta: meta(), metaSettled: true, live: permission })
    ).toMatchObject({
      state: 'ok',
      title: 'Fix login',
      waiting: true,
      working: true,
      done: false,
    });
  });

  it('marks archived and settled sessions done, and a newer message reopens a settled one', () => {
    expect(
      todaySessionDisplay({ meta: meta({ isArchived: true }), metaSettled: true, live: null }).done
    ).toBe(true);
    const settledAt = Date.parse('2026-11-20T09:00:00.000Z');
    expect(
      todaySessionDisplay({ meta: meta({ settledAt }), metaSettled: true, live: null }).done
    ).toBe(true);
    expect(
      todaySessionDisplay({
        meta: meta({ settledAt, lastMessageAt: Date.parse('2026-11-20T10:00:00.000Z') }),
        metaSettled: true,
        live: null,
      }).done
    ).toBe(false);
  });

  it('hides unread for agent-managed sessions', () => {
    const unread = {
      lastMessageAt: Date.parse('2026-11-20T10:00:00.000Z'),
      lastReadAt: Date.parse('2026-11-20T09:00:00.000Z'),
    };
    expect(todaySessionDisplay({ meta: meta(unread), metaSettled: true, live: null }).unread).toBe(
      true
    );
    expect(
      todaySessionDisplay({
        meta: meta({ ...unread, agentManaged: true }),
        metaSettled: true,
        live: null,
      }).unread
    ).toBe(false);
  });
});
