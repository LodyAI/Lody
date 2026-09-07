import { describe, expect, it } from 'vitest';

import { buildPrompt } from '../src/session/session-execution-helpers';

describe('session execution prompt helpers', () => {
  it('preserves native Pi commands and gives model prompts only supported instructions', () => {
    const agent = { cliType: 'builtin' as const, agentType: 'pi' };
    const project = { kind: 'github' as const, repoFullName: 'owner/repo', branch: 'feature' };
    expect(buildPrompt('/stats', project, undefined, undefined, agent)).toBe('/stats');
    expect(buildPrompt('/ask-fixture hello', project, undefined, undefined, agent)).toBe(
      '/ask-fixture hello'
    );
    const prompt = buildPrompt('fix the bug', project, undefined, undefined, agent);
    expect(prompt).toContain('Name branches based on the task content');
    expect(prompt).not.toContain('Lody MCP');
  });

  it('replaces detailed Lody MCP guidance with a concise reminder', () => {
    const prompt = buildPrompt('inspect the UI');

    expect(prompt).toBe(
      'inspect the UI\n\nUse the available Lody MCP tools when relevant; rely on their tool descriptions for complete, current capabilities and usage guidance.'
    );
    expect(prompt).not.toContain('lody_upload_images');
    expect(prompt).not.toContain('lody_session_create');
  });

  it('keeps GitHub worktree instructions without detailed Lody MCP guidance', () => {
    const prompt = buildPrompt('fix the bug', {
      kind: 'github',
      repoFullName: 'owner/repo',
      branch: 'feature',
    });

    expect(prompt).toContain('Name branches based on the task content');
    expect(prompt).toContain('Use the available Lody MCP tools when relevant');
    expect(prompt).not.toContain('The "lody" MCP server provides tools');
    expect(prompt).not.toContain('lody_upload_images');
  });
});
