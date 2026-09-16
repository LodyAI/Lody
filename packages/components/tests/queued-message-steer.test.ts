import { describe, expect, it } from 'vitest';
import type { SessionHistory } from '@lody/shared';
import {
  resolveQueuedUserHistoryEntry,
  shouldRequestNativeQueueSteer,
} from '../src/components/sessions/message-queue/queued-message-steer';

describe('shouldRequestNativeQueueSteer', () => {
  it.each([
    ['authoritative', { acknowledgedSteer: true }, true],
    ['authoritative', { acknowledgedSteer: false }, false],
    ['authoritative', undefined, false],
    ['provisional', { acknowledgedSteer: true }, false],
    ['unavailable', { acknowledgedSteer: true }, false],
  ] as const)('routes %s capability %o to native steer: %s', (authority, capability, expected) => {
    expect(shouldRequestNativeQueueSteer(authority, capability)).toBe(expected);
  });

  it('reuses queue admission instead of admitting a conflicting pending_apply turn', async () => {
    const entry = {
      id: 'queued-turn',
      role: 'user',
      timestamp: '2026-09-16T00:00:00Z',
    } as SessionHistory;
    const replacement = {
      ...entry,
      status: 'pending_apply',
    } as SessionHistory;

    await expect(
      resolveQueuedUserHistoryEntry({ read: async () => ({ entry }) }, 'queued-turn', async () => replacement)
    ).resolves.toBe(entry);
  });
});
