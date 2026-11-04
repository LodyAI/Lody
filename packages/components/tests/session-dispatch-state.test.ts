import { describe, expect, it } from 'vitest';

import {
  hasUnstartedTrailingUserTurn,
  isUnstartedTrailingDispatchPreStart,
  UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS,
} from '../src/lib/session-dispatch-state';

const userTurn = (status?: string, read?: boolean) => ({
  role: 'user' as const,
  ...(status !== undefined ? { status: status as never } : {}),
  ...(read !== undefined ? { read } : {}),
});

const userTurnAt = (timestamp: string, status = 'pending') => ({
  role: 'user' as const,
  status: status as never,
  timestamp,
});

const assistantTurn = () => ({ role: 'assistant' as const });

describe('hasUnstartedTrailingUserTurn', () => {
  it('maps legacy read=false to pending', () => {
    expect(hasUnstartedTrailingUserTurn([userTurn(undefined, false)])).toBe(true);
  });

  it('stops reporting once the CLI takes ownership (processing)', () => {
    expect(hasUnstartedTrailingUserTurn([userTurn('processing')])).toBe(false);
  });

  it('ignores steer-owned pending_apply guides', () => {
    expect(hasUnstartedTrailingUserTurn([userTurn('pending_apply')])).toBe(false);
  });

  it('ignores pending user turns that are no longer trailing', () => {
    // A completed conversation always ends with an assistant/terminal entry;
    // an older stuck 'pending' entry must not resurrect the starting label.
    expect(hasUnstartedTrailingUserTurn([userTurn('pending'), assistantTurn()])).toBe(false);
  });
});

describe('isUnstartedTrailingDispatchPreStart', () => {
  const dispatchedAt = Date.parse('2026-07-23T00:00:00.000Z');

  it('is optimistic within the timeout window', () => {
    const now = dispatchedAt + UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS - 1;
    expect(isUnstartedTrailingDispatchPreStart([userTurnAt('2026-07-23T00:00:00.000Z')], now)).toBe(
      true
    );
  });

  it('expires once the timeout elapses without CLI presence (no longer sticks)', () => {
    const now = dispatchedAt + UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS + 1;
    expect(isUnstartedTrailingDispatchPreStart([userTurnAt('2026-07-23T00:00:00.000Z')], now)).toBe(
      false
    );
  });

  it('never shows pre-start for a turn without a usable timestamp', () => {
    expect(isUnstartedTrailingDispatchPreStart([userTurn('pending')], dispatchedAt)).toBe(false);
  });
});
