import type { Meta, StoryObj } from '@storybook/react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  collectConversationMessages,
  type ConversationMessage,
  type SessionId,
  type SessionMeta,
  type SessionHistoryInput,
} from '@lody/shared';
import { ImageIcon } from 'lucide-react';
import {
  MessageRowView,
  SessionChatStreamView,
  type ChatStreamItem,
} from '@/components/ai-gui/view';
import {
  MessageSelectionContext,
  MessageSelectionToolbar,
  useMessageSelection,
} from '@/components/ai-gui/message-selection';
import {
  SessionConversationPage,
  SessionConversationPageBody,
  SessionConversationPageHeader,
} from '@/components/sessions/session-conversation-page';
import { ChatShareImageDialog } from '@/components/sessions/chat-share-image-dialog';
import { Button } from '@/ui/button';

const sessionId = 'share-selection-story' as SessionId;
const session = {
  id: sessionId,
  title: 'Memoizing a filtered list',
  createdAt: '2026-09-07T12:00:00Z',
  cliType: 'builtin',
  agentType: 'claude',
} as SessionMeta;
const messages: ConversationMessage[] = [
  {
    id: 'user-1',
    role: 'user',
    text: 'Why does my list render again whenever I type in the search field?',
  },
  {
    id: 'assistant-1',
    role: 'assistant',
    text: 'The filter creates a new array on each render. Memoize the result and keep the row props stable.\n\n```tsx\nconst visibleItems = useMemo(\n  () => items.filter(item => item.name.includes(query)),\n  [items, query],\n);\n```',
  },
  { id: 'user-2', role: 'user', text: 'Can I memoize each row too?' },
  {
    id: 'assistant-2',
    role: 'assistant',
    text: 'Yes. Wrap the row component in `memo`, and pass stable props.\n\n1. Keep callbacks stable when needed.\n2. Use the item ID as its key.\n3. Profile again to check the result.',
  },
];

function SelectionHarness({ long = false }: { long?: boolean }) {
  const { t } = useTranslation();
  const selection = useMessageSelection(sessionId);
  const { start } = selection;
  const [preview, setPreview] = useState<ConversationMessage[] | null>(null);
  const [displayMessages] = useState(() =>
    long
      ? Array.from({ length: 12 }, (_, round) =>
          messages.map((message) => ({ ...message, id: `${round}-${message.id}` }))
        ).flat()
      : messages
  );
  const [items] = useState<ChatStreamItem[]>(() =>
    displayMessages.map((message, turnIndex) => ({
      turnIndex,
      type: 'message',
      sessionId,
      message: {
        id: message.id,
        role: message.role,
        timestamp: '2026-09-07T12:00:00Z',
        read: true,
        finished: true,
        modelInfo:
          message.role === 'assistant' ? { modelId: 'sonnet-4.5', name: 'Sonnet 4.5' } : undefined,
        items: [
          ...(message.role === 'assistant'
            ? [
                {
                  type: 'thought' as const,
                  text: 'Inspect the filter and the row props before choosing where to memoize.',
                },
                {
                  type: 'tool_call' as const,
                  toolCallId: `tool-${message.id}`,
                  title: 'Read list component',
                  kind: 'read' as const,
                  status: 'completed' as const,
                  content: [
                    {
                      type: 'content' as const,
                      content: {
                        type: 'text' as const,
                        text: 'const visibleItems = items.filter(item => item.name.includes(query));',
                      },
                    },
                  ],
                },
              ]
            : []),
          { type: 'text', text: message.text },
        ],
      },
    }))
  );
  const [candidates] = useState(() =>
    collectConversationMessages(
      items.flatMap((item) =>
        item.type === 'message' ? [item.message as unknown as SessionHistoryInput] : []
      )
    )
  );
  const confirm = useCallback((selected: ConversationMessage[]) => setPreview(selected), []);
  useEffect(() => {
    start(candidates, confirm);
  }, [start, candidates, confirm]);
  return (
    <SessionConversationPage
      className="h-dvh"
      headerSlot={
        <SessionConversationPageHeader
          titleSlot={session.title}
          endSlot={
            <Button variant="ghost" size="sm" onClick={() => selection.start(candidates, confirm)}>
              <ImageIcon className="size-4" />
              {t('sessions.shareImage.dialogTitle', 'Share as image')}
            </Button>
          }
        />
      }
      bodySlot={
        <SessionConversationPageBody
          streamSlot={
            <MessageSelectionContext.Provider value={selection.context}>
              <SessionChatStreamView
                sessionId={sessionId}
                items={items}
                className="h-full"
                renderMessageRow={({ message, sessionId: id }) => (
                  <MessageRowView message={message} sessionId={id} />
                )}
              />
            </MessageSelectionContext.Provider>
          }
          composerSlot={<MessageSelectionToolbar selection={selection} />}
        />
      }
      trailingSlot={
        <ChatShareImageDialog
          open={preview !== null}
          onOpenChange={(open) => {
            if (!open) setPreview(null);
          }}
          session={session}
          messages={preview ?? []}
        />
      }
    />
  );
}

const meta = {
  title: 'Sessions/ChatMessageSelection',
  component: SelectionHarness,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SelectionHarness>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const LongConversation: Story = { args: { long: true } };
