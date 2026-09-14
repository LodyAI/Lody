import { describe, expect, it } from 'vitest';

import { formatToolCallJsonText } from '../src/lib/tool-call-json-text';

describe('formatToolCallJsonText', () => {
  it('formats serialized tool input verbatim, preserving shell fragments math parsing ate', () => {
    // Real payload shape behind the mangled rendering: single-`$` math treated
    // `$(...)` spans as TeX and the `&` in `2>&1` was dropped on display.
    const command =
      'cd /repo/.worktree/pr13-dedup && git commit --amend --no-edit --reset-author ' +
      '-c user.name="$(git -C /repo config user.name)" ' +
      '-c user.email="$(git -C /repo config user.email)" 2>&1 | tail -1 && ' +
      "git log -1 --format='%h %an <%ae>'";
    const text = JSON.stringify({ command, timeout: 60 });

    const formatted = formatToolCallJsonText(text);

    expect(formatted).not.toBeNull();
    expect(formatted).toContain('$(git -C /repo config user.name)');
    expect(formatted).toContain('$(git -C /repo config user.email)');
    expect(formatted).toContain('2>&1');
    expect(formatted).toContain('%h %an <%ae>');
    expect(formatted).toContain('"timeout": 60');
  });

  it('pretty-prints the payload over multiple lines', () => {
    const formatted = formatToolCallJsonText('{"a":1,"b":{"c":2}}');
    expect(formatted).toBe('{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}');
  });

  it('formats a top-level JSON array', () => {
    expect(formatToolCallJsonText('[1, "two"]')).toBe('[\n  1,\n  "two"\n]');
  });

  it('returns null for prose, keeping it on the Markdown path', () => {
    expect(formatToolCallJsonText('The price is $x$ plus $y$.')).toBeNull();
    expect(formatToolCallJsonText('See {the docs} for details.')).toBeNull();
  });

  it('returns null for JSON primitives', () => {
    expect(formatToolCallJsonText('"just a string"')).toBeNull();
    expect(formatToolCallJsonText('42')).toBeNull();
    expect(formatToolCallJsonText('null')).toBeNull();
  });

  it('returns null for text that only looks like JSON', () => {
    expect(formatToolCallJsonText('{not json}')).toBeNull();
    expect(formatToolCallJsonText('{"truncated":')).toBeNull();
    expect(formatToolCallJsonText('')).toBeNull();
    expect(formatToolCallJsonText('   ')).toBeNull();
  });
});
