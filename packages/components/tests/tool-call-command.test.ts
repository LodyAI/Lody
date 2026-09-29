import { describe, expect, it } from 'vitest';

import {
  extractFencedToolText,
  formatToolCommand,
  isToolCommandEcho,
  isToolSearchTitle,
} from '../src/components/ai-gui/tool-call-command';

describe('formatToolCommand', () => {
  it('unwraps a shell that only carries the script', () => {
    expect(formatToolCommand({ command: '/bin/bash', args: ['-lc', 'git status && ls'] })).toBe(
      'git status && ls'
    );
    expect(formatToolCommand({ command: 'zsh', args: ['-l', '-c', 'pnpm test'] })).toBe(
      'pnpm test'
    );
  });

  it('quotes an argument a shell would split', () => {
    expect(formatToolCommand({ command: 'rg', args: ['-n', 'foo bar', "it's"] })).toBe(
      `rg -n 'foo bar' 'it'\\''s'`
    );
    expect(formatToolCommand({ command: 'bash', args: ['script.sh'] })).toBe('bash script.sh');
  });

  it('shortens the session worktree root the way titles do', () => {
    expect(
      formatToolCommand({
        command: 'cd /home/u/.lody/worktrees/0f8fad5b-d9cb-469f-a165-70867728950e && ls',
      })
    ).toBe('cd . && ls');
  });
});

describe('isToolCommandEcho', () => {
  it('matches the command restated as text, fenced or reflowed', () => {
    expect(isToolCommandEcho('```sh\ngit status\n```', ['git status'])).toBe(true);
    expect(isToolCommandEcho('`git  status`', ['git status'])).toBe(true);
    expect(isToolCommandEcho('Checked the tree', ['git status'])).toBe(false);
    expect(isToolCommandEcho('', [''])).toBe(false);
  });
});

describe('extractFencedToolText', () => {
  it('returns the body of exactly one fence', () => {
    expect(extractFencedToolText('```\nline 1\nline 2\n```')).toBe('line 1\nline 2');
    expect(extractFencedToolText('text\n```\ncode\n```')).toBeNull();
  });
});

describe('isToolSearchTitle', () => {
  it('recognizes the tool search title variants', () => {
    expect(isToolSearchTitle('ToolSearch')).toBe(true);
    expect(isToolSearchTitle('Tool Search')).toBe(true);
    expect(isToolSearchTitle('TaskStop')).toBe(false);
    expect(isToolSearchTitle(undefined)).toBe(false);
  });
});
