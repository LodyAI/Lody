import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionHistoryParsed } from '@lody/shared';
import {
  OUTLINE_PREVIEW_MAX_LENGTH,
  OUTLINE_TITLE_MAX_LENGTH,
  buildConversationOutline,
  reuseConversationOutline,
  type ConversationOutlineSource,
} from '../src/lib/conversation-outline';

let nextId = 0;

const message = (
  role: 'user' | 'assistant' | 'system',
  items: unknown[],
  overrides: Partial<SessionHistoryParsed> = {}
): ConversationOutlineSource => {
  nextId += 1;
  return {
    type: 'message',
    message: {
      id: `msg-${nextId}`,
      role,
      items,
      timestamp: '2026-08-19T00:00:00.000Z',
      ...overrides,
    } as unknown as SessionHistoryParsed,
  };
};

const text = (value: string) => ({ type: 'text', text: value });
const thought = (value: string) => ({ type: 'thought', text: value });

beforeEach(() => {
  nextId = 0;
});

describe('buildConversationOutline', () => {
  it('makes one entry per round and takes the preview from the round’s first agent prose', () => {
    const outline = buildConversationOutline([
      message('user', [text('Add a rail to the session view')]),
      message('assistant', [text('Here is the plan for the rail.')]),
      message('assistant', [text('And here is the follow-up.')]),
      message('user', [text('Ship it')]),
      message('assistant', [text('Shipped.')]),
    ]);

    expect(outline).toHaveLength(2);
    expect(outline[0]).toMatchObject({
      title: 'Add a rail to the session view',
      preview: 'Here is the plan for the rail.',
    });
    expect(outline[1]).toMatchObject({ title: 'Ship it', preview: 'Shipped.' });
  });

  it('anchors each entry at the index of the message its round starts at', () => {
    const outline = buildConversationOutline([
      message('user', [text('first')]),
      message('assistant', [text('a')]),
      message('assistant', [text('b')]),
      message('user', [text('second')]),
    ]);

    expect(outline.map((entry) => entry.messageIndex)).toEqual([0, 3]);
  });

  it('strips markdown and collapses newlines so a title stays one line', () => {
    const outline = buildConversationOutline([
      message('user', [text('## Fix the **bug**\n\nin `view.tsx`')]),
    ]);

    expect(outline[0]?.title).toBe('Fix the bug in view.tsx');
  });

  it('leaves the preview empty while a round has produced no agent prose yet', () => {
    const outline = buildConversationOutline([
      message('user', [text('Start working')]),
      message('assistant', [thought('planning…')]),
    ]);

    expect(outline[0]?.preview).toBe('');
  });

  it('opens a round for content that precedes the first user message', () => {
    const outline = buildConversationOutline([
      message('assistant', [text('Scheduled run starting.')]),
      message('user', [text('Thanks')]),
    ]);

    expect(outline).toHaveLength(2);
    expect(outline[0]).toMatchObject({
      startsWithAgent: true,
      title: 'Scheduled run starting.',
      preview: 'Scheduled run starting.',
    });
    expect(outline[1]?.startsWithAgent).toBe(false);
  });

  it('skips non-message items', () => {
    const outline = buildConversationOutline([
      { type: 'empty' },
      message('user', [text('hello')]),
      { type: 'empty' },
    ]);

    expect(outline).toHaveLength(1);
    expect(outline[0]?.messageIndex).toBe(1);
  });

  it('returns nothing for an empty conversation', () => {
    expect(buildConversationOutline([])).toEqual([]);
  });

  describe('truncation', () => {
    it('truncates the title by code point and marks it with an ellipsis', () => {
      const long = 'a'.repeat(OUTLINE_TITLE_MAX_LENGTH + 20);
      const outline = buildConversationOutline([message('user', [text(long)])]);
      const title = outline[0]?.title ?? '';

      expect(Array.from(title)).toHaveLength(OUTLINE_TITLE_MAX_LENGTH + 1);
      expect(title.endsWith('…')).toBe(true);
    });

    it('counts CJK characters individually rather than by UTF-16 length', () => {
      const cjk = '中'.repeat(OUTLINE_TITLE_MAX_LENGTH);
      const outline = buildConversationOutline([message('user', [text(cjk)])]);

      expect(outline[0]?.title).toBe(cjk);
    });

    it('does not split a surrogate pair', () => {
      const emoji = '🎉'.repeat(OUTLINE_TITLE_MAX_LENGTH + 5);
      const outline = buildConversationOutline([message('user', [text(emoji)])]);
      const title = outline[0]?.title ?? '';

      expect(title).not.toContain('�');
      expect(Array.from(title)).toHaveLength(OUTLINE_TITLE_MAX_LENGTH + 1);
    });

    it('truncates the preview at its own, longer limit', () => {
      const long = 'b'.repeat(OUTLINE_PREVIEW_MAX_LENGTH + 100);
      const outline = buildConversationOutline([
        message('user', [text('go')]),
        message('assistant', [text(long)]),
      ]);

      expect(Array.from(outline[0]?.preview ?? '')).toHaveLength(OUTLINE_PREVIEW_MAX_LENGTH + 1);
    });

    it('reads only a bounded prefix of a long answer, so cost does not scale with it', () => {
      // The guard that matters for streaming: markdown cleanup must never run
      // over a whole multi-KB answer. A marker past the read window proves the
      // tail was never inspected.
      const answer = `${'c'.repeat(5_000)}MARKER`;
      const outline = buildConversationOutline([
        message('user', [text('go')]),
        message('assistant', [text(answer)]),
      ]);

      expect(outline[0]?.preview).not.toContain('MARKER');
    });
  });

  describe('weight', () => {
    it('grows with the amount of prose in the round', () => {
      const short = buildConversationOutline([
        message('user', [text('hi')]),
        message('assistant', [text('ok')]),
      ]);
      const long = buildConversationOutline([
        message('user', [text('hi')]),
        message('assistant', [text('x'.repeat(9_000))]),
      ]);

      expect(short[0]?.weight).toBe(0);
      expect(long[0]?.weight).toBeGreaterThan(short[0]?.weight ?? 0);
    });

    it('accumulates across every message in the round, not just the first', () => {
      // Stated as a comparison rather than a fixed bucket, so recalibrating the
      // thresholds against real sessions cannot silently invalidate the claim.
      const half = 'y'.repeat(600);
      const oneReply = buildConversationOutline([
        message('user', [text('hi')]),
        message('assistant', [text(half)]),
      ]);
      const twoReplies = buildConversationOutline([
        message('user', [text('hi')]),
        message('assistant', [text(half)]),
        message('assistant', [text(half)]),
      ]);

      expect(twoReplies[0]?.weight).toBeGreaterThan(oneReply[0]?.weight ?? 0);
    });

    it('ignores non-prose items so a tool-heavy turn is not maxed out', () => {
      const outline = buildConversationOutline([
        message('user', [text('hi')]),
        message('assistant', [
          { type: 'tool_call', toolCallId: 't1', title: 'z'.repeat(50_000) },
          text('done'),
        ]),
      ]);

      expect(outline[0]?.weight).toBe(0);
    });
  });
});

describe('reuseConversationOutline', () => {
  const items = [message('user', [text('hello')]), message('assistant', [text('hi there')])];

  it('hands back the previous array when nothing visible changed', () => {
    const first = buildConversationOutline(items);
    const second = buildConversationOutline(items);

    expect(second).not.toBe(first);
    expect(reuseConversationOutline(first, second)).toBe(first);
  });

  it('hands back the new array when a round changed', () => {
    const first = buildConversationOutline(items);
    const second = buildConversationOutline([...items, message('user', [text('next')])]);

    expect(reuseConversationOutline(first, second)).toBe(second);
  });

  it('hands back the new array when a preview filled in', () => {
    const before = buildConversationOutline([message('user', [text('go')])]);
    const after = buildConversationOutline([
      before[0]
        ? ({
            type: 'message',
            message: {
              id: before[0].key,
              role: 'user',
              items: [text('go')],
              timestamp: '2026-08-19T00:00:00.000Z',
            },
          } as unknown as ConversationOutlineSource)
        : message('user', [text('go')]),
      message('assistant', [text('answer')]),
    ]);

    expect(reuseConversationOutline(before, after)).toBe(after);
  });

  it('treats a missing previous outline as a change', () => {
    const next = buildConversationOutline(items);
    expect(reuseConversationOutline(undefined, next)).toBe(next);
  });
});

describe('summary stability while streaming', () => {
  it('keeps a summary stable once its source text filled the read window', () => {
    // A streaming turn replaces its message OBJECT on every delta, so object
    // identity cannot carry a cache across deltas. Stability comes from the
    // bounded prefix instead: past the read window, more tokens cannot change
    // what the summary is derived from.
    const messageId = 'streaming-1';
    const makeItem = (body: string): ConversationOutlineSource => ({
      type: 'message',
      message: {
        id: messageId,
        role: 'assistant',
        items: [text(body)],
        timestamp: '2026-08-19T00:00:00.000Z',
      } as unknown as SessionHistoryParsed,
    });

    const first = buildConversationOutline([makeItem('d'.repeat(1_000))]);
    const grown = buildConversationOutline([makeItem(`${'d'.repeat(1_000)}${'e'.repeat(1_000)}`)]);

    expect(grown[0]?.preview).toBe(first[0]?.preview);
  });

  it('still grows a summary that has not filled the read window', () => {
    const messageId = 'streaming-2';
    const makeItem = (body: string): ConversationOutlineSource => ({
      type: 'message',
      message: {
        id: messageId,
        role: 'assistant',
        items: [text(body)],
        timestamp: '2026-08-19T00:00:00.000Z',
      } as unknown as SessionHistoryParsed,
    });

    const first = buildConversationOutline([makeItem('short')]);
    const grown = buildConversationOutline([makeItem('short but then longer')]);

    expect(first[0]?.preview).toBe('short');
    expect(grown[0]?.preview).toBe('short but then longer');
  });
});

describe('buildConversationOutline with placeholders', () => {
  const placeholder = (
    role: 'user' | 'assistant',
    summary?: { headText: string; textChars: number; thoughtChars?: number }
  ): ConversationOutlineSource => {
    nextId += 1;
    return {
      type: 'placeholder',
      row: {
        id: `row-${nextId}`,
        role,
        timestamp: '2026-08-19T00:00:00.000Z',
        ...(summary
          ? {
              summary: {
                itemCount: 1,
                textChars: summary.textChars,
                thoughtChars: summary.thoughtChars ?? 0,
                headText: summary.headText,
                activity: {
                  commandCount: 0,
                  editFileCount: 0,
                  readFileCount: 0,
                  searchCount: 0,
                  failedCount: 0,
                },
                editedPaths: [],
              },
            }
          : {}),
      },
    };
  };

  it('titles and previews rounds from sealed summaries and weighs them by textChars', () => {
    const outline = buildConversationOutline([
      placeholder('user', { headText: '# Fix the **flaky** test', textChars: 24 }),
      placeholder('assistant', { headText: 'Looking at the test now.', textChars: 4_000 }),
      placeholder('user'),
      message('assistant', [text('Hydrated reply')]),
    ]);
    expect(outline).toHaveLength(2);
    expect(outline[0]).toMatchObject({
      title: 'Fix the flaky test',
      preview: 'Looking at the test now.',
      weight: 3,
      startsWithAgent: false,
    });
    // A placeholder without a summary keeps an empty title until hydrated.
    expect(outline[1]).toMatchObject({ title: '', preview: 'Hydrated reply' });
  });
});
