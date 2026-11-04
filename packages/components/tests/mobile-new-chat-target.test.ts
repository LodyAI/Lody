import { describe, expect, it } from 'vitest';

import { resolveMobileNewChatBranchLabel } from '@/components/mobile/mobile-new-chat-target';

describe('resolveMobileNewChatBranchLabel', () => {
  const local = {
    contextType: 'local' as const,
    currentBranch: 'lody:branch:local:main',
    selectedBranch: 'lody:branch:local:feature%2Fmobile',
    useWorktree: false,
    labels: { local: '本地', remote: '远程', placeholder: '分支' },
  };

  it('formats the checked-out branch for direct local use, independently of the worktree choice', () => {
    expect(resolveMobileNewChatBranchLabel(local)).toBe('main (本地)');
    expect(resolveMobileNewChatBranchLabel({ ...local, useWorktree: true })).toBe(
      'feature/mobile (本地)'
    );
  });

  it('formats remote worktree refs and leaves legacy branch names readable', () => {
    expect(
      resolveMobileNewChatBranchLabel({
        ...local,
        useWorktree: true,
        selectedBranch: 'lody:branch:remote:upstream:feature%2Fmobile',
      })
    ).toBe('upstream/feature/mobile (远程)');
    expect(resolveMobileNewChatBranchLabel({ ...local, currentBranch: 'main' })).toBe('main');
  });

  it('keeps GitHub branch names verbatim, even when they resemble a local selector', () => {
    expect(
      resolveMobileNewChatBranchLabel({
        ...local,
        contextType: 'github',
        selectedBranch: 'lody:branch:local:literal-name',
      })
    ).toBe('lody:branch:local:literal-name');
  });
});

const labels = {
  noProject: 'No project selected',
  project: 'Select a project',
  repository: 'Repository',
};
