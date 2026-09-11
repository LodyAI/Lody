import { describe, expect, it } from 'vitest';
import {
  hasLocalBranchNameConflict,
  resolveAvailableBranchName,
} from './branch-name-allocation';

describe('resolveAvailableBranchName', () => {
  it('adds increasing suffixes without reusing an existing branch', () => {
    expect(resolveAvailableBranchName('fix/branch-collision', ['fix/branch-collision'])).toBe(
      'fix/branch-collision-2'
    );
    expect(
      resolveAvailableBranchName('fix/branch-collision', [
        'fix/branch-collision',
        'fix/branch-collision-2',
      ])
    ).toBe('fix/branch-collision-3');
  });

  it('avoids git ref namespace collisions', () => {
    expect(hasLocalBranchNameConflict('feat/topic', ['feat/topic/child'])).toBe(true);
    expect(resolveAvailableBranchName('feat/topic', ['feat/topic/child'])).toBe('feat/topic-2');
    expect(hasLocalBranchNameConflict('feat/topic', ['feat'])).toBe(true);
    expect(resolveAvailableBranchName('feat/topic', ['feat'])).toBe('feat-2/topic');
  });

  it('keeps a suffixed generated branch within its length budget', () => {
    const desired = `fix/${'a'.repeat(46)}`;
    const result = resolveAvailableBranchName(desired, [desired], { maxLength: 50 });

    expect(result).toHaveLength(50);
    expect(result).toMatch(/-2$/);
  });
});
