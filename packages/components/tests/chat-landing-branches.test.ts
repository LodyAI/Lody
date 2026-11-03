import { describe, expect, it } from 'vitest';
import {
  createChatLandingBranchSnapshot,
  resolveChatLandingBranchSelection,
} from '../src/lib/chat-landing-branches';

describe('chat landing branches', () => {
  it('preserves the current branch when refreshed branches still include it', () => {
    const snapshot = createChatLandingBranchSnapshot(['main', 'release'], 'main');

    expect(resolveChatLandingBranchSelection(snapshot, 'release')).toBe('release');
  });

  it('falls back to a preferred available branch and clears selection for empty repositories', () => {
    expect(
      resolveChatLandingBranchSelection(
        createChatLandingBranchSnapshot(['release'], 'release'),
        'deleted'
      )
    ).toBe('release');
    expect(
      resolveChatLandingBranchSelection(createChatLandingBranchSnapshot([], null), 'main')
    ).toBeNull();
  });
});
