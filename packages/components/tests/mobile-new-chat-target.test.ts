import { describe, expect, it } from 'vitest';

import {
  resolveMobileNewChatBranchLabel,
  resolveMobileNewChatTargetLabel,
} from '@/components/mobile/mobile-new-chat-target';

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

  it('uses the placeholder while the relevant ref is unavailable', () => {
    expect(resolveMobileNewChatBranchLabel({ ...local, currentBranch: null })).toBe('分支');
    expect(
      resolveMobileNewChatBranchLabel({ ...local, useWorktree: true, selectedBranch: null })
    ).toBe('分支');
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

describe('resolveMobileNewChatTargetLabel', () => {
  it('shows the no-project label when no project is involved', () => {
    expect(
      resolveMobileNewChatTargetLabel({
        contextType: 'chat',
        repoFullName: 'ignored/repo',
        projectName: 'ignored',
        labels,
      })
    ).toBe('No project selected');
  });

  it('shows the selected local project name', () => {
    expect(
      resolveMobileNewChatTargetLabel({ contextType: 'local', projectName: 'blog', labels })
    ).toBe('blog');
  });

  it('shows the selected repository full name', () => {
    expect(
      resolveMobileNewChatTargetLabel({
        contextType: 'github',
        repoFullName: 'loro-dev/lody',
        labels,
      })
    ).toBe('loro-dev/lody');
  });

  it('falls back to the context placeholder for an empty or blank selection', () => {
    expect(
      resolveMobileNewChatTargetLabel({ contextType: 'local', projectName: '  ', labels })
    ).toBe('Select a project');
    expect(
      resolveMobileNewChatTargetLabel({ contextType: 'local', projectName: null, labels })
    ).toBe('Select a project');
    expect(resolveMobileNewChatTargetLabel({ contextType: 'github', labels })).toBe('Repository');
  });
});
