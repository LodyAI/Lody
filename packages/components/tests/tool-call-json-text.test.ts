import { describe, expect, it } from 'vitest';

import { detectToolCallJsonText } from '../src/lib/tool-call-json-text';

describe('detectToolCallJsonText', () => {
  it('returns serialized tool input verbatim, preserving shell fragments math parsing ate', () => {
    // Real payload shape behind the mangled rendering: single-`$` math treated
    // `$(...)` spans as TeX and the `&` in `2>&1` was dropped on display.
    const command =
      'cd /repo/.worktree/pr13-dedup && git commit --amend --no-edit --reset-author ' +
      '-c user.name="$(git -C /repo config user.name)" ' +
      '-c user.email="$(git -C /repo config user.email)" 2>&1 | tail -1 && ' +
      "git log -1 --format='%h %an <%ae>'";
    const text = JSON.stringify({ command, timeout: 60 });

    expect(detectToolCallJsonText(text)).toBe(text);
  });

  it('never re-serializes: integer lexemes beyond 2^53 keep their exact digits', () => {
    // JSON.parse rounds these to ...776000 / ...000120 (sic); re-stringifying
    // would display an identifier the upstream tool never received.
    const text = '{"id":9223372036854775807,"snowflake":1737000000000000123}';
    expect(detectToolCallJsonText(text)).toBe(text);
  });

  it('never re-serializes: exponent and fractional forms stay as written', () => {
    const text = '{"big":1e10,"small":1E-7,"neg":-0.5}';
    expect(detectToolCallJsonText(text)).toBe(text);
  });

  it('returns a top-level JSON array verbatim', () => {
    expect(detectToolCallJsonText('[1, "two"]')).toBe('[1, "two"]');
  });

  it('trims surrounding whitespace but does not touch the payload', () => {
    expect(detectToolCallJsonText('  {"a":1}\n')).toBe('{"a":1}');
  });

  it('returns null for prose, keeping it on the Markdown path', () => {
    expect(detectToolCallJsonText('The price is $x$ plus $y$.')).toBeNull();
    expect(detectToolCallJsonText('See {the docs} for details.')).toBeNull();
  });

  it('returns null for JSON primitives', () => {
    expect(detectToolCallJsonText('"just a string"')).toBeNull();
    expect(detectToolCallJsonText('42')).toBeNull();
    expect(detectToolCallJsonText('null')).toBeNull();
  });

  it('returns null for text that only looks like JSON', () => {
    expect(detectToolCallJsonText('{not json}')).toBeNull();
    expect(detectToolCallJsonText('{"truncated":')).toBeNull();
    expect(detectToolCallJsonText('')).toBeNull();
    expect(detectToolCallJsonText('   ')).toBeNull();
  });
});
