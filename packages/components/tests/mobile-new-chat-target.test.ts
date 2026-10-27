import { describe, expect, it } from 'vitest';

import { resolveMobileNewChatTargetLabel } from '@/components/mobile/mobile-new-chat-target';

const labels = { chat: 'Chat', project: 'Select a project', repository: 'Repository' };

describe('resolveMobileNewChatTargetLabel', () => {
  it('shows the plain chat label when no project is involved', () => {
    expect(
      resolveMobileNewChatTargetLabel({
        contextType: 'chat',
        repoFullName: 'ignored/repo',
        projectName: 'ignored',
        labels,
      })
    ).toBe('Chat');
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
