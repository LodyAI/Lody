import {
  applyTextRewrites,
  formatMessageQuote,
  type MessageContent,
  buildConversationMarkdown,
} from '@lody/shared';
import { buildPastedTextRewrites } from '../src/lib/pasted-text-draft';
import { describe, expect, it } from 'vitest';
import {
  getCopyTextFromMessageItems,
  getTextContentFromMessageItems,
  getMessageQuoteEditDraft,
  USER_TEXT_RENDER_CHAR_LIMIT,
  getUserTextRenderSlice,
} from '../src/components/ai-gui/message-copy';
import {
  openReaderView,
  buildFixtureHistory,
  buildSessionDoc,
  createManualIdle,
  FIXTURE_SESSION_ID,
} from './conversation-view-fixtures';
import { conversationCopyRange } from '../src/lib/conversation-copy-range';
import { readConversationCopySource } from '../src/lib/conversation-copy-source';
import type { SessionDocStore, WorkspaceRuntime } from '../src/atoms/runtime';

describe('message-copy', () => {
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
        applyTextRewrites(restored.text, buildPastedTextRewrites(restored.drafts, restored.text))
          .text
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
});

describe('user-text-render-slice', () => {
  /**
   * The collapsed slice is the one place a chip has to survive truncation, and
   * the one place it could not: a paste is only captured above
   * `LARGE_PASTED_TEXT_MIN_CHAR_COUNT`, which is already larger than the render
   * budget, so charging it by its raw length made the failure total rather than
   * occasional.
   */
  describe('getUserTextRenderSlice with spans', () => {
    const blob = 'x'.repeat(4000);
    const text = `look at this ${blob} and tell me why`;
    const span = {
      start: 'look at this '.length,
      end: 'look at this '.length + blob.length,
      kind: 'pasted_text' as const,
      label: 'Pasted 4,000 chars',
    };

    it('keeps the paste whole and charges only its label, so the chip survives', () => {
      const slice = getUserTextRenderSlice(text, [span]);

      expect(slice.spans).toHaveLength(1);
      // The region is intact, so the chip has something to cover and expanding
      // still reveals the blob.
      expect(slice.text.slice(slice.spans![0]!.start, slice.spans![0]!.end)).toBe(blob);
      // And the rest of the sentence fits, because the blob cost 18 not 4000.
      expect(slice.text).toContain('and tell me why');
      expect(slice.isTruncated).toBe(false);
    });

    it('drops a span it cannot reach rather than cutting into it', () => {
      const prose = 'y'.repeat(USER_TEXT_RENDER_CHAR_LIMIT + 100);
      const late = `${prose} ${blob}`;
      const slice = getUserTextRenderSlice(late, [
        {
          start: prose.length + 1,
          end: prose.length + 1 + blob.length,
          kind: 'pasted_text',
          label: 'Pasted',
        },
      ]);
      expect(slice.isTruncated).toBe(true);
      expect(slice.spans ?? []).toHaveLength(0);
      expect(slice.text).not.toContain(blob);
    });

    it('does not let newlines inside a span consume the line budget', () => {
      const lines = `${'a\n'.repeat(30)}`;
      const withSpan = `intro ${lines} outro`;
      const slice = getUserTextRenderSlice(withSpan, [
        { start: 6, end: 6 + lines.length, kind: 'pasted_text', label: 'Pasted' },
      ]);
      // Thirty newlines are one chip, not thirty lines against a limit of ten.
      expect(slice.text).toContain('outro');
      expect(slice.isTruncated).toBe(false);
    });
  });
});

describe('conversation-copy-range', () => {
  describe('conversationCopyRange', () => {
    const history = [{ id: 'user' }, { id: 'assistant' }, { id: 'later' }];
    it('includes the selected user or assistant and excludes all later messages', async () => {
      expect(conversationCopyRange(history, 'user')).toEqual([history[0]]);
      expect(conversationCopyRange(history, 'assistant')).toEqual(history.slice(0, 2));
      expect(conversationCopyRange(history)).toEqual(history);
    });
    it('does not silently copy everything when the boundary is missing', async () => {
      expect(() => conversationCopyRange(history, 'deleted')).toThrow();
    });
  });

  describe('complete async history reads', () => {
    it.each([false, true])(
      'binds export to the owning runtime store (old view: %s)',
      async (old) => {
        const oldDoc = buildSessionDoc(buildFixtureHistory(1), 1);
        const currentDoc = buildSessionDoc(buildFixtureHistory(2), 2);
        const oldView = await openReaderView(oldDoc, { sessionId: FIXTURE_SESSION_ID });
        const currentView = await openReaderView(currentDoc, { sessionId: FIXTURE_SESSION_ID });
        let leased = false;
        const runtime: Pick<WorkspaceRuntime, 'withSessionStore'> = {
          withSessionStore: async (sessionId, read) => {
            expect(sessionId).toBe(FIXTURE_SESSION_ID);
            leased = true;
            try {
              return await read({ history: currentView } as SessionDocStore);
            } finally {
              leased = false;
            }
          },
        };
        try {
          const reading = readConversationCopySource(
            runtime,
            FIXTURE_SESSION_ID,
            old ? oldView : currentView
          );
          if (old) await expect(reading).rejects.toThrow('Copy source changed');
          else {
            const history = await reading;
            expect(history).toEqual(currentDoc.getList('history').toJSON());
            expect(history).not.toEqual(oldDoc.getList('history').toJSON());
          }
          expect(leased).toBe(false);
        } finally {
          oldView.dispose();
          currentView.dispose();
          oldDoc.free();
          currentDoc.free();
        }
      }
    );
    it('exports one authoritative snapshot even if history changes or the view closes', async () => {
      const doc = buildSessionDoc(buildFixtureHistory(6));
      const view = await openReaderView(doc, {
        sessionId: FIXTURE_SESSION_ID,
        tailKeep: 0,
        scheduleIdle: createManualIdle().scheduleIdle,
      });
      const expected = doc.getList('history').toJSON();
      const reading = view.readAll();
      doc.getList('history').delete(0, 1);
      doc.commit();
      view.dispose();
      const history = await reading;
      expect(history).toEqual(expected);
      expect(buildConversationMarkdown({ history }).stats.entryCount).toBe(expected.length);
      doc.free();
    });
  });
});
