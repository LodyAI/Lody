import { describe, expect, it } from 'vitest';
import {
  getLegacyReadForSessionHistoryStatus,
  isSessionHistoryDelivered,
  isSessionHistoryPendingForDispatch,
  getPendingUserTurnActivationId,
  type SessionMeta,
} from '../src/schema';

describe('pending_apply session history status', () => {
  const entry = { role: 'user' as const, status: 'pending_apply' as const, read: false };

  it('is not delivered while waiting for steer acknowledgement', () => {
    expect(isSessionHistoryDelivered(entry)).toBe(false);
    expect(getLegacyReadForSessionHistoryStatus('pending_apply')).toBe(false);
  });

  it('is not eligible for ordinary queued dispatch', () => {
    expect(isSessionHistoryPendingForDispatch(entry)).toBe(false);
  });
});

it('keeps unknown delivery terminal for dispatch without claiming delivery', () => {
  const entry = { role: 'user' as const, status: 'delivery_unknown' as const, read: true };
  expect(isSessionHistoryDelivered(entry)).toBe(false);
  expect(isSessionHistoryPendingForDispatch(entry)).toBe(false);
});

it('retains refused-input activation without treating applied or unknown projections as sends', () => {
  const meta = {
    latestUserMsgId: 'newer',
    lastHandledUserMsgId: 'old',
    steerTurnStatuses: { refused: 'pending', applied: 'processing', uncertain: 'delivery_unknown' },
  } as SessionMeta;
  expect(getPendingUserTurnActivationId(meta)).toBe('newer');
  expect(getPendingUserTurnActivationId({ ...meta, settledActivationUserMsgId: 'newer' })).toBe(
    'refused'
  );
  expect(
    getPendingUserTurnActivationId({
      ...meta,
      settledActivationUserMsgId: 'newer',
      lastMissingHistoryUserMsgId: 'refused',
    })
  ).toBeUndefined();
});
