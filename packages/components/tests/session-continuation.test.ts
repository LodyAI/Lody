import { describe, expect, it } from 'vitest';
import {
  describeSessionContinuation,
  type SessionContinuationView,
} from '../src/components/sessions/session-continuation';

const NOW = 1_700_000_000_000;

function view(patch: Partial<SessionContinuationView> = {}): SessionContinuationView {
  return {
    id: 'wait-1',
    reason: '等 CI 通过后继续',
    phase: 'waiting',
    ...patch,
  };
}

describe('describeSessionContinuation', () => {
  it('describes a healthy wait without claiming it is done', () => {
    const described = describeSessionContinuation(view({ nextCheckAt: NOW + 20_000 }), NOW);

    expect(described).toMatchObject({
      visible: true,
      tone: 'calm',
      title: '等 CI 通过后继续',
      detail: 'waiting',
      actions: { cancel: true, resume: false, askAgent: false },
    });
    if (!described.visible) throw new Error('expected a visible note');
    expect(described.nextCheck).toEqual({ kind: 'relative', unit: 'second', count: 20 });
  });

  it('turns a matched, queued continuation into an active note', () => {
    const described = describeSessionContinuation(
      view({ phase: 'matched', continuation: 'queued' }),
      NOW
    );

    expect(described).toMatchObject({
      visible: true,
      tone: 'active',
      detail: 'queued',
      actions: { cancel: true, resume: false, askAgent: false },
    });
  });

  it('makes a stopped continuation the attention state that offers resume', () => {
    const described = describeSessionContinuation(
      view({ phase: 'matched', continuation: 'blocked', block: 'stopped' }),
      NOW
    );

    expect(described).toMatchObject({
      visible: true,
      tone: 'attention',
      detail: 'blockedStopped',
      actions: { cancel: true, resume: true, askAgent: false },
    });
  });

  it('does not offer resume when a permission stands in the way', () => {
    const described = describeSessionContinuation(
      view({ phase: 'matched', continuation: 'blocked', block: 'permission' }),
      NOW
    );

    expect(described).toMatchObject({
      visible: true,
      tone: 'attention',
      detail: 'blockedPermission',
      actions: { cancel: true, resume: false, askAgent: false },
    });
  });

  it('keeps an offline wait calm and honest', () => {
    const described = describeSessionContinuation(
      view({ block: 'offline', nextCheckAt: NOW + 60_000 }),
      NOW
    );

    expect(described).toMatchObject({
      visible: true,
      tone: 'calm',
      detail: 'waitingOffline',
      actions: { cancel: true, resume: false, askAgent: false },
    });
  });

  it('asks the agent to look when repeated checks failed', () => {
    const described = describeSessionContinuation(view({ phase: 'failed' }), NOW);

    expect(described).toMatchObject({
      visible: true,
      tone: 'attention',
      detail: 'failed',
      actions: { cancel: true, resume: false, askAgent: true },
    });
  });

  it('never reports a completed or expired wait as an active note', () => {
    expect(describeSessionContinuation(view({ phase: 'expired' }), NOW)).toEqual({
      visible: false,
    });
    expect(
      describeSessionContinuation(view({ phase: 'matched', continuation: 'settled' }), NOW)
    ).toEqual({ visible: false });
    expect(describeSessionContinuation(view({ phase: 'cancelled' }), NOW)).toEqual({
      visible: false,
    });
  });

  it('does not invent delivery when the continuation state is unknown', () => {
    const described = describeSessionContinuation(
      view({ phase: 'matched', continuation: 'unknown' }),
      NOW
    );

    expect(described).toMatchObject({
      visible: true,
      tone: 'active',
      detail: 'deliveryUnknown',
      actions: { cancel: false, resume: false, askAgent: true },
    });
  });

  it('uses an absolute time beyond a day', () => {
    const at = NOW + 26 * 60 * 60_000;
    const described = describeSessionContinuation(view({ nextCheckAt: at }), NOW);

    if (!described.visible) throw new Error('expected a visible note');
    expect(described.nextCheck).toEqual({ kind: 'absolute', at });
  });

  it('falls back to a generic title when the agent gave no reason', () => {
    const described = describeSessionContinuation(view({ reason: '   ' }), NOW);

    expect(described).toMatchObject({ visible: true, title: null });
  });
});
