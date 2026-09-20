import { describe, expect, it } from 'vitest';
import { getExpandedClipboardTextForSelection } from '../src/lib/composer-clipboard';
import { buildSessionMentionPrompt } from '../src/components/mentions/mention-session-source';

describe('getExpandedClipboardTextForSelection', () => {
  const sessionId = 'ses_abc';
  const slug = '@crdt-cleanup';
  const prefix = 'See ';
  const suffix = ' please';
  const value = `${prefix}${slug}${suffix}`;
  const sessionStart = prefix.length;
  const sessionEnd = sessionStart + slug.length;
  const replacement = buildSessionMentionPrompt({
    sessionId,
    title: 'CRDT cleanup',
  });
  const rewrites = [
    {
      start: sessionStart,
      end: sessionEnd,
      replacement,
      span: { kind: 'session' as const, label: 'crdt-cleanup', target: sessionId },
    },
  ];

  it('expands a session mention when the selection covers it', () => {
    expect(
      getExpandedClipboardTextForSelection({
        value,
        selectionStart: 0,
        selectionEnd: value.length,
        rewrites,
      })
    ).toBe(`${prefix}${replacement}${suffix}`);
  });

  it('expands the full session rewrite even when only part of the slug is selected', () => {
    expect(
      getExpandedClipboardTextForSelection({
        value,
        selectionStart: sessionStart + 1,
        selectionEnd: sessionEnd - 1,
        rewrites,
      })
    ).toBe(replacement);
  });

  it('keeps native copy when the selection does not intersect an expanding rewrite', () => {
    expect(
      getExpandedClipboardTextForSelection({
        value,
        selectionStart: 0,
        selectionEnd: prefix.length,
        rewrites,
      })
    ).toBeNull();
  });

  it('ignores verbatim rewrites that have no replacement', () => {
    expect(
      getExpandedClipboardTextForSelection({
        value: '@README.md',
        selectionStart: 0,
        selectionEnd: '@README.md'.length,
        rewrites: [
          {
            start: 0,
            end: '@README.md'.length,
            span: { kind: 'file', label: '@README.md', target: 'README.md' },
          },
        ],
      })
    ).toBeNull();
  });
});
