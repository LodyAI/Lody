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
});
