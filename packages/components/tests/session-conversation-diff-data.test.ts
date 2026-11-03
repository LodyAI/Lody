import { describe, expect, it } from 'vitest';
import { shouldStartSessionDiffLoads } from '../src/components/sessions/use-session-conversation-diff-data';

describe('shouldStartSessionDiffLoads', () => {
  const loadableInput = {
    useProviderDiff: true,
    waitForProviderDiff: false,
    loadPaused: false,
    fileDiffsPending: false,
    normalizedPathCount: 2,
    mode: 'conversation' as const,
    turnId: 'turn-1',
  };

  it('waits for conversation fileDiffs but not All Changes metadata', () => {
    // Regression: firing getDiff before the per-turn checkpoints arrive stores a
    // "requires a session-history fileDiff checkpoint" error for data that is in flight.
    expect(shouldStartSessionDiffLoads({ ...loadableInput, fileDiffsPending: true })).toBe(false);
    // All Changes reads the file-index currentChanges metadata directly; it must not wait for
    // session-history checkpoints.
    expect(
      shouldStartSessionDiffLoads({
        ...loadableInput,
        fileDiffsPending: true,
        mode: 'base',
        turnId: undefined,
      })
    ).toBe(true);
  });
});
