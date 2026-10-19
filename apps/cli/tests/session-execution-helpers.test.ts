import { describe, expect, it } from 'vitest';
import type { LocalProjectId } from '@lody/shared';

import { buildPrompt } from '../src/session/session-execution-helpers';

describe('session execution prompt helpers', () => {
  it('replaces detailed Lody MCP guidance with a concise reminder', () => {
    const prompt = buildPrompt('inspect the UI');

    expect(prompt).toBe(
      'inspect the UI\n\nUse the available Lody MCP tools when relevant; rely on their tool descriptions for complete, current capabilities and usage guidance.'
    );
  });

  it('keeps GitHub guidance without opting into first-task branch naming', () => {
    const prompt = buildPrompt('fix the bug', {
      kind: 'github',
      repoFullName: 'owner/repo',
      branch: 'feature',
    });

    expect(prompt).toContain("use GitHub's branch rename flow");
    expect(prompt).toContain('Use the available Lody MCP tools when relevant');
    expect(prompt).not.toContain('Before starting this task, rename the branch');
  });

  it('combines first-task instructions with task references and feedback context for local worktrees', () => {
    const prompt = buildPrompt(
      'Fix the checkout observer',
      { kind: 'local', localProjectId: 'local-1' as LocalProjectId, useWorktree: true },
      [
        {
          type: 'issue',
          number: 42,
          title: ' Checkout observer ',
          url: 'https://github.com/owner/repo/issues/42',
        },
      ],
      ' feedback-1 ',
      { branchToRename: 'lody/12345678-abc-2' }
    );

    expect(prompt).toContain(
      'Fix the checkout observer\n\n\n- issue#42: Checkout observer (https://github.com/owner/repo/issues/42)\n'
    );
    expect(prompt).toContain('The postId is feedback-1.');
    expect(prompt).toContain('git branch -m lody/12345678-abc-2 <name>');
    expect(prompt).not.toContain('inspect');
    expect(prompt).toContain(
      'Do not use main, master, or dev, include sensitive input, or force-overwrite an existing branch.'
    );
    expect(prompt).toContain('if renaming fails, report it briefly and continue the task.');
    expect(prompt).not.toContain('gh pr create');
  });
});
