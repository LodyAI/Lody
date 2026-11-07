import { describe, expect, it } from 'vitest';
import { applyTextRewrites, formatMessageQuote } from '@lody/shared';

import {
  buildPastedTextRewrites,
  getPastedTextClipboardTextForSelection,
  insertPastedTextDraft,
  isPastedTextTooLarge,
  restoreMessageQuoteDrafts,
} from '../src/lib/pasted-text-draft';
import {
  loadConversationQuoteDraft,
  saveConversationQuoteDraft,
} from '../src/lib/conversation-quote-draft';

/** What the send path does with these rewrites, so the test asserts that. */
const restoreToValue = (value: string, drafts: Parameters<typeof buildPastedTextRewrites>[0]) =>
  applyTextRewrites(value, buildPastedTextRewrites(drafts)).text;

describe('message quote snapshots', () => {
  it('does not alias different snapshots when imported quote ids collide', () => {
    const first = formatMessageQuote('First snapshot');
    const second = formatMessageQuote('Second snapshot');
    const text = first + '\n\n' + second;
    const restored = restoreMessageQuoteDrafts(text, [
      {
        start: 0,
        end: first.length,
        kind: 'message_quote',
        quoteVersion: 1,
        label: '[Quote A]',
        target: 'same-id',
      },
      {
        start: first.length + 2,
        end: text.length,
        kind: 'message_quote',
        quoteVersion: 1,
        label: '[Quote B]',
        target: 'same-id',
      },
    ]);
    expect(new Set(restored.drafts.map((draft) => draft.id)).size).toBe(2);
    expect(restored.drafts.map((draft) => draft.text)).toEqual([
      'First snapshot',
      'Second snapshot',
    ]);
    expect(
      applyTextRewrites(
        restored.text,
        buildPastedTextRewrites(restored.drafts, restored.text)
      ).text.trim()
    ).toBe(text);
  });
  it('preserves two excerpts and interleaved questions through storage and repeated editing', () => {
    const snapshot = '  原文 👩🏽‍💻\n\n> nested quote\n```ts\nconst n = 1;\n```\n';
    const first = insertPastedTextDraft({
      currentValue: 'Question A? ',
      pastedText: snapshot,
      displayText: '\u2007[Quote A]\u2007',
      id: 'a',
      selectionStart: 0,
      selectionEnd: 0,
      kind: 'message_quote',
    })!;
    const second = insertPastedTextDraft({
      currentValue: first.nextValue + 'Question B?',
      pastedText: 'Second snapshot',
      displayText: '\u2007[Quote B]\u2007',
      id: 'b',
      selectionStart: first.nextValue.length,
      selectionEnd: first.nextValue.length,
      kind: 'message_quote',
    })!;
    const drafts = [first.draft, second.draft];
    const expanded = applyTextRewrites(
      second.nextValue,
      buildPastedTextRewrites(drafts, second.nextValue)
    );
    expect(expanded.text.indexOf('Question A?')).toBeLessThan(
      expanded.text.indexOf('Second snapshot')
    );
    expect(expanded.text.indexOf('Second snapshot')).toBeLessThan(
      expanded.text.indexOf('Question B?')
    );
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    expect(saveConversationQuoteDraft(storage, 'draft', second.nextValue, drafts)).toBe(true);
    for (let count = 0; count < 3; count++) {
      const restored = loadConversationQuoteDraft(storage, 'draft')!;
      expect(restored.text).toBe(second.nextValue);
      expect(restored.drafts.map((draft) => draft.text)).toEqual([snapshot, 'Second snapshot']);
      const rewritten = applyTextRewrites(
        restored.text,
        buildPastedTextRewrites(restored.drafts, restored.text)
      );
      expect(rewritten.text).toBe(expanded.text);
      expect(saveConversationQuoteDraft(storage, 'draft', restored.text, restored.drafts)).toBe(
        true
      );
    }
    const damaged = {
      ...expanded,
      spans: expanded.spans!.map((span) => ({ ...span, quoteVersion: 9 })),
    };
    values.set('draft', JSON.stringify(damaged));
    expect(loadConversationQuoteDraft(storage, 'draft')).toEqual({
      text: expanded.text,
      drafts: [],
    });
    expect(restoreMessageQuoteDrafts('> ordinary Markdown', undefined)).toEqual({
      text: '> ordinary Markdown',
      drafts: [],
    });
  });

  it('keeps committed mention identities and pasted atoms around an inline quote', () => {
    const label = '\u2007[Quote]\u2007';
    const paste = '\u2007[Paste]\u2007';
    const text = `Before ${label} after @original-role ${paste}`;
    const quoteStart = text.indexOf(label);
    const pasteStart = text.indexOf(paste);
    const roleStart = text.indexOf('@original-role');
    const drafts = [
      {
        id: 'quote',
        text: 'Quote source\n\n</message-quote>',
        displayText: label,
        start: quoteStart,
        end: quoteStart + label.length,
        kind: 'message_quote' as const,
      },
      {
        id: 'paste',
        text: 'Pasted\nsource',
        displayText: paste,
        start: pasteStart,
        end: text.length,
      },
    ];
    const mentions = [
      {
        start: roleStart,
        end: roleStart + '@original-role'.length,
        value: 'stable-role-id',
        kind: 'agent_role' as const,
      },
    ];
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    expect(saveConversationQuoteDraft(storage, 'draft', text, drafts, mentions)).toBe(true);
    expect(loadConversationQuoteDraft(storage, 'draft')).toEqual({ text, drafts, mentions });
  });
});

describe('getPastedTextClipboardTextForSelection', () => {
  const firstLabel = '[Pasted 12 characters]';
  const secondLabel = '[Pasted 20 characters]';
  const prefix = 'Before ';
  const between = ' and ';
  const suffix = ' after';
  const value = `${prefix}${firstLabel}${between}${secondLabel}${suffix}`;
  const firstStart = prefix.length;
  const firstEnd = firstStart + firstLabel.length;
  const secondStart = firstEnd + between.length;
  const drafts = [
    {
      id: 'paste-1',
      text: 'first pasted\nbody',
      displayText: firstLabel,
      start: firstStart,
      end: firstEnd,
    },
    {
      id: 'paste-2',
      text: 'second pasted body',
      displayText: secondLabel,
      start: secondStart,
      end: secondStart + secondLabel.length,
    },
  ];

  it('treats a partially selected pasted draft as the full pasted content', () => {
    expect(
      getPastedTextClipboardTextForSelection({
        value,
        drafts,
        selectionStart: firstStart + '[Pasted'.length,
        selectionEnd: secondStart + '[Pasted'.length,
      })
    ).toBe('first pasted\nbody and second pasted body');
  });

  it('keeps native copy behavior when the selection does not include pasted drafts', () => {
    expect(
      getPastedTextClipboardTextForSelection({
        value,
        drafts,
        selectionStart: firstEnd,
        selectionEnd: secondStart,
      })
    ).toBeNull();
  });
});

describe('isPastedTextTooLarge', () => {
  it.each(['a', '日'])('converts %s text at 50,000 characters into a file', (character) => {
    expect(isPastedTextTooLarge(character.repeat(49_999))).toBe(false);
    expect(isPastedTextTooLarge(character.repeat(50_000))).toBe(true);
    expect(isPastedTextTooLarge(character.repeat(50_001))).toBe(true);
  });
});
