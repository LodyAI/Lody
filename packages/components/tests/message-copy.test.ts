import { applyTextRewrites, formatMessageQuote, type MessageContent } from '@lody/shared';
import { buildPastedTextRewrites } from '../src/lib/pasted-text-draft';
import { describe, expect, it } from 'vitest';
import {
  getCopyTextFromMessageItems,
  getTextContentFromMessageItems,
  getMessageQuoteEditDraft,
} from '../src/components/ai-gui/message-copy';

const text = (value: string): MessageContent => ({ type: 'text', text: value });

describe('getTextContentFromMessageItems', () => {
  it('restores quote atoms across several text blocks without changing execution text', () => {
    const quote = formatMessageQuote('Source\n\n```ts\nconst n = 1;\n```');
    const items: MessageContent[] = [
      text('Question before'),
      {
        type: 'text',
        text: quote + '\n\nQuestion after',
        spans: [
          {
            start: 0,
            end: quote.length,
            kind: 'message_quote',
            quoteVersion: 1,
            label: '[Quote]',
            target: 'source-quote',
          },
        ],
      },
    ];
    const restored = getMessageQuoteEditDraft(items);
    expect(restored.drafts).toHaveLength(1);
    expect(restored.text.slice(restored.drafts[0]!.start, restored.drafts[0]!.end)).toContain(
      '[Quote]'
    );
    expect(
      applyTextRewrites(restored.text, buildPastedTextRewrites(restored.drafts, restored.text)).text
    ).toBe(getTextContentFromMessageItems(items));
  });
});

describe('getCopyTextFromMessageItems', () => {
  it('normalizes copied session references without changing edit-and-resend content', () => {
    const items = [text('See [Old](session://child)')];
    expect(getCopyTextFromMessageItems(items, 'ws_1')).toBe(
      'See [Old](lody://session/child?workspace=ws_1)'
    );
    expect(getTextContentFromMessageItems(items)).toBe('See [Old](session://child)');
  });
  const rolePrompt = '[Agent Role: Reviewer (agentRoleId: role-1)]';
  const roleMessage: MessageContent = {
    type: 'text',
    text: `please ${rolePrompt} on this diff`,
    spans: [
      {
        start: 7,
        end: 7 + rolePrompt.length,
        kind: 'agent_role',
        label: 'Code-Reviewer',
        target: 'role-1',
      },
    ],
  };

  it('copies a role mention as the chip the reader sees', () => {
    expect(getCopyTextFromMessageItems([roleMessage])).toBe('please @Code-Reviewer on this diff');
  });

  it('leaves edit-and-resend reading the text the agent actually received', () => {
    // Same items, different question: the composer needs the rewritten form,
    // because a `@token` with no committed range would be sent as a word.
    expect(getTextContentFromMessageItems([roleMessage])).toContain(rolePrompt);
  });

  it('keeps every other span expanded, including a pasted blob', () => {
    const pasted: MessageContent = {
      type: 'text',
      text: 'here: the whole pasted log',
      spans: [{ start: 6, end: 26, kind: 'pasted_text', label: 'Pasted 4,182 chars' }],
    };
    expect(getCopyTextFromMessageItems([pasted])).toBe('here: the whole pasted log');
  });
});
