import { describe, expect, it } from 'vitest';
import { applyTextRewrites, formatMessageQuote } from '@lody/shared';

import {
  arePastedTextDraftsEqual,
  buildPastedTextRewrites,
  createPastedTextFile,
  getPastedTextCharacterCount,
  getPastedTextDraftsAfterInsertion,
  getPastedTextLineCount,
  getPastedTextClipboardTextForSelection,
  insertPastedTextDraft,
  isLargePastedText,
  isPastedTextTooLarge,
  PASTED_TEXT_FILE_MIN_CHAR_COUNT,
  normalizePastedTextDraft,
  sanitizePastedTextDrafts,
  shouldCapturePastedTextDraft,
  updatePastedTextDraftContent,
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

describe('shouldCapturePastedTextDraft', () => {
  it('captures text only when it exceeds 1024 characters', () => {
    expect(shouldCapturePastedTextDraft('a'.repeat(1024))).toBe(false);
    expect(shouldCapturePastedTextDraft('a'.repeat(1025))).toBe(true);
    expect(
      shouldCapturePastedTextDraft(
        Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')
      )
    ).toBe(false);
  });
});

describe('createPastedTextFile', () => {
  it('keeps the clipboard bytes in a plain-text attachment', async () => {
    const text = '前缀\r\nlog line\n';
    const file = createPastedTextFile(text);

    expect(file.name).toBe('pasted-text.txt');
    expect(file.type).toBe('text/plain');
    expect(file.size).toBe(new TextEncoder().encode(text).length);
    await expect(file.text()).resolves.toBe(text);
  });
});

describe('getPastedTextDraftsAfterInsertion', () => {
  const existingDraft = {
    id: 'old-paste',
    text: 'old text',
    displayText: '[Pasted 8 characters]',
    start: 'Error '.length,
    end: 'Error '.length + '[Pasted 8 characters]'.length,
  };

  it('removes drafts covered by a full replacement paste', () => {
    const nextDraft = {
      id: 'new-paste',
      text: 'new text',
      displayText: '[Pasted 8 characters]',
      start: 0,
      end: '[Pasted 8 characters]'.length,
    };

    expect(
      getPastedTextDraftsAfterInsertion({
        drafts: [existingDraft],
        draft: nextDraft,
        editStart: 0,
        editEnd: 'Error [Pasted 8 characters], help'.length,
      })
    ).toEqual([nextDraft]);
  });

  it('shifts drafts after an insertion point', () => {
    const insertedDraft = {
      id: 'prefix-paste',
      text: 'prefix',
      displayText: '[Pasted 6 characters]',
      start: 0,
      end: '[Pasted 6 characters]'.length,
    };

    expect(
      getPastedTextDraftsAfterInsertion({
        drafts: [existingDraft],
        draft: insertedDraft,
        editStart: 0,
        editEnd: 0,
      })
    ).toEqual([
      insertedDraft,
      {
        ...existingDraft,
        start: existingDraft.start + insertedDraft.displayText.length,
        end: existingDraft.end + insertedDraft.displayText.length,
      },
    ]);
  });
});

describe('updatePastedTextDraftContent', () => {
  it('updates pasted text content, replaces the inline label, and shifts later drafts', () => {
    const prefix = 'First ';
    const oldLabel = '[Pasted 10 characters]';
    const nextLabel = '[Pasted 5 characters]';
    const middle = ' then ';
    const secondLabel = '[Pasted 20 characters]';
    const currentValue = `${prefix}${oldLabel}${middle}${secondLabel}`;
    const firstStart = prefix.length;
    const firstEnd = firstStart + oldLabel.length;
    const secondStart = firstEnd + middle.length;

    expect(
      updatePastedTextDraftContent({
        currentValue,
        drafts: [
          {
            id: 'paste-1',
            text: 'alpha beta',
            displayText: oldLabel,
            start: firstStart,
            end: firstEnd,
          },
          {
            id: 'paste-2',
            text: 'second pasted content',
            displayText: secondLabel,
            start: secondStart,
            end: secondStart + secondLabel.length,
          },
        ],
        draftId: 'paste-1',
        text: 'gamma',
        displayText: nextLabel,
      })
    ).toEqual({
      nextValue: `${prefix}${nextLabel}${middle}${secondLabel}`,
      nextDrafts: [
        {
          id: 'paste-1',
          text: 'gamma',
          displayText: nextLabel,
          start: firstStart,
          end: firstStart + nextLabel.length,
        },
        {
          id: 'paste-2',
          text: 'second pasted content',
          displayText: secondLabel,
          start: secondStart - 1,
          end: secondStart - 1 + secondLabel.length,
        },
      ],
    });
  });

  it('keeps a newline inserted at the end of an edited draft', () => {
    expect(
      updatePastedTextDraftContent({
        currentValue: 'See [Pasted 5 characters] please',
        drafts: [
          {
            id: 'paste-1',
            text: 'alpha',
            displayText: '[Pasted 5 characters]',
            start: 'See '.length,
            end: 'See '.length + '[Pasted 5 characters]'.length,
          },
        ],
        draftId: 'paste-1',
        text: 'alpha\n',
        displayText: '[Pasted 5 characters]',
      })
    ).toEqual({
      nextValue: 'See [Pasted 5 characters] please',
      nextDrafts: [
        {
          id: 'paste-1',
          text: 'alpha\n',
          displayText: '[Pasted 5 characters]',
          start: 'See '.length,
          end: 'See '.length + '[Pasted 5 characters]'.length,
        },
      ],
    });
  });
});

describe('buildPastedTextRewrites', () => {
  it('restores full pasted text into the visible inline prompt', () => {
    expect(
      restoreToValue('Error [Pasted 10 characters], please help', [
        {
          id: 'paste-1',
          text: 'alpha\nbeta',
          displayText: '[Pasted 10 characters]',
          start: 'Error '.length,
          end: 'Error '.length + '[Pasted 10 characters]'.length,
        },
      ])
    ).toBe('Error alpha\nbeta, please help');
  });

  it('preserves edited leading and trailing line breaks when restoring', () => {
    expect(
      restoreToValue('Before [Pasted 5 characters] after', [
        {
          id: 'paste-1',
          text: '\nalpha\n',
          displayText: '[Pasted 5 characters]',
          start: 'Before '.length,
          end: 'Before '.length + '[Pasted 5 characters]'.length,
        },
      ])
    ).toBe('Before \nalpha\n after');
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

  it('expands every pasted draft intersecting the copied selection', () => {
    expect(
      getPastedTextClipboardTextForSelection({
        value,
        drafts,
        selectionStart: prefix.length,
        selectionEnd: value.length - suffix.length,
      })
    ).toBe('first pasted\nbody and second pasted body');
  });

  it('preserves normal selected text around pasted drafts', () => {
    expect(
      getPastedTextClipboardTextForSelection({
        value,
        drafts,
        selectionStart: 0,
        selectionEnd: value.length,
      })
    ).toBe('Before first pasted\nbody and second pasted body after');
  });

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

describe('sanitizePastedTextDrafts', () => {
  it('drops invalid entries and normalizes surviving drafts without trimming text', () => {
    expect(
      sanitizePastedTextDrafts([
        {
          id: 'paste-1',
          text: '  alpha\r\nbeta  \n',
          displayText: '[Pasted 10 characters]',
          start: 5,
          end: 27,
        },
        { id: 'bad-entry', text: 'missing range' },
      ])
    ).toEqual([
      {
        id: 'paste-1',
        text: '  alpha\nbeta  \n',
        displayText: '[Pasted 10 characters]',
        start: 5,
        end: 27,
      },
    ]);
  });

  it('preserves whitespace-only draft text while the inline token still exists', () => {
    expect(
      sanitizePastedTextDrafts([
        {
          id: 'paste-empty',
          text: '   ',
          displayText: '[Pasted 0 characters]',
          start: 0,
          end: '[Pasted 0 characters]'.length,
        },
      ])
    ).toEqual([
      {
        id: 'paste-empty',
        text: '   ',
        displayText: '[Pasted 0 characters]',
        start: 0,
        end: '[Pasted 0 characters]'.length,
      },
    ]);
  });
});

describe('normalizePastedTextDraft', () => {
  it('normalizes CRLF line endings', () => {
    expect(normalizePastedTextDraft('a\r\nb\r\n')).toBe('a\nb\n');
  });
});

describe('isLargePastedText', () => {
  it('treats text over 1024 characters as large', () => {
    expect(isLargePastedText('a'.repeat(1025))).toBe(true);
  });

  it('does not treat text at or below 1024 characters as large', () => {
    expect(isLargePastedText('a'.repeat(1024))).toBe(false);
    expect(
      isLargePastedText(Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n'))
    ).toBe(false);
  });
});

describe('isPastedTextTooLarge', () => {
  it.each(['a', '日'])('converts %s text at 50,000 characters into a file', (character) => {
    expect(isPastedTextTooLarge(character.repeat(49_999))).toBe(false);
    expect(isPastedTextTooLarge(character.repeat(50_000))).toBe(true);
    expect(isPastedTextTooLarge(character.repeat(50_001))).toBe(true);
  });

  it('measures the normalized, trimmed text the draft would store', () => {
    const padding = ' '.repeat(1024);
    const body = 'a'.repeat(PASTED_TEXT_FILE_MIN_CHAR_COUNT - 1);
    expect(isPastedTextTooLarge(`${padding}${body}${padding}`)).toBe(false);
    expect(isPastedTextTooLarge(`${padding}${body}b${padding}`)).toBe(true);
    // CRLF counts as one normalized newline, rather than two characters.
    expect(isPastedTextTooLarge(`${body.slice(0, -2)}\r\nb`)).toBe(false);
    expect(isPastedTextTooLarge(`${body.slice(0, -1)}\r\nb`)).toBe(true);
  });
});

describe('pasted text summaries', () => {
  it('reports characters and lines from normalized content', () => {
    const text = '  first line\r\nsecond line\r\n\r\nthird line  ';
    expect(getPastedTextCharacterCount(text)).toBe('first line\nsecond line\n\nthird line'.length);
    expect(getPastedTextLineCount(text)).toBe(4);
  });
});

describe('insertPastedTextDraft', () => {
  it('replaces the active selection with an inline pasted-text label', () => {
    expect(
      insertPastedTextDraft({
        currentValue: 'Report: replace me please',
        pastedText: '  alpha\nbeta  ',
        displayText: '[Pasted 10 characters]',
        id: 'paste-1',
        selectionStart: 'Report: '.length,
        selectionEnd: 'Report: replace me please'.length,
      })
    ).toEqual({
      nextValue: 'Report: [Pasted 10 characters]',
      draft: {
        id: 'paste-1',
        text: 'alpha\nbeta',
        displayText: '[Pasted 10 characters]',
        start: 'Report: '.length,
        end: 'Report: '.length + '[Pasted 10 characters]'.length,
      },
    });
  });
});

describe('arePastedTextDraftsEqual', () => {
  it('compares complete draft identity and ranges', () => {
    const draft = {
      id: 'paste-1',
      text: 'alpha',
      displayText: '[Pasted 5 characters]',
      start: 6,
      end: 27,
    };

    expect(arePastedTextDraftsEqual([draft], [draft])).toBe(true);
    expect(arePastedTextDraftsEqual([draft], [{ ...draft, end: draft.end + 1 }])).toBe(false);
  });
});
