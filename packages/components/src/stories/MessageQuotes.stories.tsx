import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { applyTextRewrites, reanchorMessageTextSpansForTrim, type SessionId } from '@lody/shared';
import { ChatComposer } from '@/components/chat/chat-composer';
import { MessageQuoteAction } from '@/components/ai-gui/message-quote-action';
import {
  MessageRowView,
  SessionChatStreamView,
  type ChatStreamItem,
} from '@/components/ai-gui/view';
import { wrapPastedTextChipLabel } from '@/components/mentions/mention-chips';
import {
  buildPastedTextRewrites,
  getPastedTextDraftsAfterInsertion,
  insertPastedTextDraft,
  type PastedTextDraft,
} from '@/lib/pasted-text-draft';
import { SettingsStoryProviders } from './settings-story-shell';

const styles = stylex.create({
  page: {
    height: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: colors.background,
  },
  stream: { flexGrow: 1, flexShrink: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
  composer: { padding: space[4], flexShrink: 0 },
});
const sessionId = 'message-quote-story' as SessionId;
const initialItems: ChatStreamItem[] = Array.from({ length: 12 }, (_, index) => ({
  type: 'message',
  sessionId,
  turnIndex: index,
  message: {
    id: `quote-source-${index}`,
    role: 'assistant',
    finished: true,
    timestamp: '2026-11-01T00:00:00Z',
    items: [
      {
        type: 'text',
        text: `Passage ${index}: Keep the reading position stable while selecting text and scrolling.\n\nA quote keeps a snapshot. Questions stay beside their corresponding excerpts.\n\n\`\`\`ts\nconst stable = true;\n\`\`\``,
      },
    ],
  },
}));

function QuoteHarness({ reject = false }: { reject?: boolean }) {
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState('Explain this passage: ');
  const [drafts, setDrafts] = useState<PastedTextDraft[]>([]);
  const [items, setItems] = useState(initialItems);
  useEffect(() => {
    const input = textarea.current;
    input?.setSelectionRange(input.value.length, input.value.length);
  }, []);
  return (
    <div {...stylex.props(styles.page)}>
      <div ref={setArea} {...stylex.props(styles.stream)}>
        <SessionChatStreamView
          sessionId={sessionId}
          items={items}
          renderMessageRow={({ message, sessionId: id }) => (
            <MessageRowView message={message} sessionId={id} />
          )}
        />
      </div>
      <MessageQuoteAction
        root={area}
        enabled
        onQuote={(text) => {
          const caret = textarea.current?.selectionEnd ?? value.length;
          const inserted = insertPastedTextDraft({
            currentValue: value,
            pastedText: text,
            displayText: wrapPastedTextChipLabel(
              `[Quote: ${text.replace(/\s+/g, ' ').slice(0, 32)}]`
            ),
            selectionStart: caret,
            selectionEnd: caret,
            kind: 'message_quote',
          });
          if (!inserted) return false;
          setValue(inserted.nextValue);
          setDrafts((current) =>
            getPastedTextDraftsAfterInsertion({
              drafts: current,
              draft: inserted.draft,
              editStart: inserted.draft.start,
              editEnd: inserted.draft.start,
            })
          );
          requestAnimationFrame(() => {
            textarea.current?.focus({ preventScroll: true });
            textarea.current?.setSelectionRange(inserted.draft.end, inserted.draft.end);
          });
          return true;
        }}
      />
      <div {...stylex.props(styles.composer)}>
        <ChatComposer
          variant="session"
          promptRows={2}
          draftKey="message-quotes"
          promptRef={textarea}
          promptValue={value}
          onPromptChange={setValue}
          pastedTextDrafts={drafts}
          onPastedTextDraftsChange={setDrafts}
          primaryAction={
            <Button
              onClick={() => {
                if (reject) return;
                const expanded = applyTextRewrites(value, buildPastedTextRewrites(drafts, value));
                const text = expanded.text.trim();
                const spans = reanchorMessageTextSpansForTrim(expanded.text, text, expanded.spans);
                setItems((current) => [
                  ...current,
                  {
                    type: 'message',
                    turnIndex: current.length,
                    sessionId,
                    message: {
                      id: `sent-${current.length}`,
                      role: 'user',
                      timestamp: '2026-11-01T00:00:00Z',
                      items: [{ type: 'text', text, spans }],
                    },
                  },
                ]);
                setValue('');
                setDrafts([]);
              }}
            >
              Send
            </Button>
          }
        />
      </div>
    </div>
  );
}

const meta = {
  title: 'Chat/MessageQuotes',
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <SettingsStoryProviders>
        <Story />
      </SettingsStoryProviders>
    ),
  ],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Inline: Story = { render: () => <QuoteHarness /> };
export const Rejected: Story = { render: () => <QuoteHarness reject /> };
