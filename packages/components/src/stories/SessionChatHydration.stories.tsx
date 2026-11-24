import * as stylex from '@stylexjs/stylex';
import { useMemo, useState, type ComponentProps, type CSSProperties } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import {
  collectConversationMessages,
  type ConversationMessage,
  type SessionHistory,
  type SessionHistoryParsed,
  type SessionId,
} from '@lody/shared';
import { buildChatStreamItems } from '@/components/ai-gui/build-chat-stream-items';
import {
  MessageSelectionContext,
  MessageSelectionOverlay,
  MessageSelectionToolbar,
  useMessageSelection,
} from '@/components/ai-gui/message-selection';
import {
  MessageRowView,
  SessionChatStreamView,
  type ChatStreamItem,
} from '@/components/ai-gui/view';
import { Button } from '@lody/ui/button';
import { clearSavedScrollStates, saveScrollState } from '@/lib/conversation-scroll/saved-state';
import { createConversationViewFromHistory, inQuestionFirstOrder } from '@/lib/conversation-view';

const migrationStyles = stylex.create({
  cachedOffset: { height: '400px', flexShrink: 0 },
  flexibleOffset: { minHeight: 0, flex: '1' },
});

const storyOverrides = stylex.create({ stream: { height: '100%' } });

const storyLayout = stylex.create({
  stack: {
    display: 'flex',
    height: '100vh',
    'flex-direction': 'column',
  },
  canvas: {
    'flex-shrink': '0',
    padding: 'calc(var(--spacing) * 2)',
  },
  frame: {
    'min-height': 'calc(var(--spacing) * 0)',
    flex: '1',
  },
});

const sessionId = 'hydration-regression' as SessionId;
const platform = createLocalPlatformProvider({
  session: createStaticStore({ status: 'unauthenticated' }),
  workspaces: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
});
const history: SessionHistoryParsed[] = [
  {
    id: 'first-user',
    role: 'user',
    timestamp: '2026-09-13T00:00:00.000Z',
    read: true,
    items: [{ type: 'text', text: 'The first user message must remain visible.' }],
  },
  {
    id: 'first-agent',
    role: 'assistant',
    timestamp: '2026-09-13T00:00:01.000Z',
    read: true,
    finished: true,
    items: [{ type: 'text', text: 'The agent reply must follow the user message.' }],
  },
];
const emptyItems: ChatStreamItem[] = [{ type: 'empty' }];
const loadedItems: ChatStreamItem[] = history.map((message, turnIndex) => ({
  type: 'message',
  turnIndex,
  sessionId,
  message,
}));

function HydrationStory({
  visibleLeadingContent = false,
  emptyHistory = emptyItems,
  agentActivityLabel,
  agentActivityTone,
  topInset = 0,
}: {
  visibleLeadingContent?: boolean;
  emptyHistory?: ChatStreamItem[];
  agentActivityLabel?: string;
  agentActivityTone?: ComponentProps<typeof SessionChatStreamView>['agentActivityTone'];
  topInset?: number;
}) {
  const [loaded, setLoaded] = useState(false);
  const [active, setActive] = useState(true);
  return (
    <PlatformContext.Provider value={platform}>
      <div {...stylex.props(storyLayout.stack)} data-testid="chat-hydration-story">
        <div {...stylex.props(storyLayout.canvas)}>
          <Button onClick={() => setLoaded(true)} disabled={loaded}>
            Load history
          </Button>
          {agentActivityLabel && (
            <Button onClick={() => setActive((value) => !value)}>Toggle activity</Button>
          )}
        </div>
        <div
          {...stylex.props(storyLayout.frame)}
          data-testid="chat-hydration-viewport"
          style={{ '--conversation-top-inset': `${topInset}px` } as CSSProperties}
        >
          <SessionChatStreamView
            sessionId={sessionId}
            xstyle={storyOverrides.stream}
            items={loaded ? loadedItems : emptyHistory}
            agentActivityLabel={active ? agentActivityLabel : null}
            agentActivityTone={agentActivityTone}
            // A non-null Fragment with no visible children is what the sharing
            // request container supplies to ordinary conversations.
            leadingContent={
              <>{visibleLeadingContent ? <div>Conversation provenance</div> : null}</>
            }
            emptyState={<></>}
            lastAssistantMessageId={loaded ? 'first-agent' : null}
            lastCompletedAssistantMessageId={loaded ? 'first-agent' : null}
            renderMessageRow={(props) => <MessageRowView {...props} />}
          />
        </div>
      </div>
    </PlatformContext.Provider>
  );
}

const meta = {
  title: 'Sessions/SessionChatHydration',
  component: HydrationStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof HydrationStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyLeadingContent: Story = {};
export const VisibleLeadingContent: Story = { args: { visibleLeadingContent: true } };
export const StartingActivity: Story = {
  args: { emptyHistory: [], agentActivityLabel: 'Starting…' },
};
export const PermissionActivity: Story = {
  args: {
    visibleLeadingContent: true,
    agentActivityLabel: 'Waiting for permission',
    agentActivityTone: 'warning',
  },
};
export const QuestionActivity: Story = {
  args: {
    ...PermissionActivity.args,
    agentActivityLabel: 'Waiting for your answer',
  },
};
export const MobileLeadingContent: Story = {
  args: { ...PermissionActivity.args, topInset: 64 },
};

/**
 * A cold mount with enough rows to expose estimated heights: the scroll engine
 * has no saved sizes, so every row starts at an estimate. With `cachedOffset`
 * the session reopens at a saved reading position (row `cold-4` at the top).
 */
function ColdTailStory({ cachedOffset = false }: { cachedOffset?: boolean }) {
  const [opened, setOpened] = useState(0);
  const items: ChatStreamItem[] = Array.from(
    { length: cachedOffset ? 30 : 1000 },
    (_, turnIndex) => ({
      type: 'message',
      turnIndex,
      sessionId,
      message: {
        id: `cold-${turnIndex}`,
        role: 'user',
        timestamp: '2026-09-13T00:00:00.000Z',
        items: [{ type: 'text', text: `Message ${turnIndex}` }],
      },
    })
  );
  return (
    <PlatformContext.Provider value={platform}>
      <div {...stylex.props(storyLayout.stack)}>
        <Button
          onClick={() => {
            // Every open is cold: saved sizes would warm initial estimates.
            clearSavedScrollStates();
            if (cachedOffset) {
              saveScrollState(sessionId, {
                formatVersion: 1,
                intent: {
                  kind: 'read',
                  anchor: {
                    kind: 'turn',
                    turnId: 'cold-4',
                    turnIndex: 4,
                    rowKey: 'cold-4',
                    item: null,
                    offsetPx: 0,
                  },
                  screenY: 0,
                },
                sizes: null,
              });
            }
            setOpened((n) => n + 1);
          }}
        >
          Open conversation
        </Button>
        <div
          {...stylex.props(
            cachedOffset ? migrationStyles.cachedOffset : migrationStyles.flexibleOffset
          )}
        >
          {opened > 0 && (
            <SessionChatStreamView
              key={opened}
              sessionId={sessionId}
              xstyle={storyOverrides.stream}
              items={items}
              showScrollToLatest={false}
              renderMessageRow={({ message }) => (
                <div
                  data-cold-tail={message.id === 'cold-999' ? '' : undefined}
                  style={{
                    minHeight: cachedOffset ? 300 : message.id === 'cold-999' ? 420 : 80,
                    padding: 16,
                  }}
                >
                  {message.id}
                </div>
              )}
            />
          )}
        </div>
      </div>
    </PlatformContext.Provider>
  );
}

export const ColdTail: Story = { render: () => <ColdTailStory /> };
export const ColdCachedOffset: Story = { render: () => <ColdTailStory cachedOffset /> };

const reversedStoredHistory: SessionHistory[] = [
  {
    id: 'previous',
    role: 'user',
    timestamp: '2026-11-24T11:55:00.000Z',
    read: true,
    fileDiff: [],
    items: [{ type: 'text', text: 'Synthetic earlier turn.' }],
  },
  {
    id: 'assistant:question',
    role: 'assistant',
    userTurnId: 'question',
    timestamp: '2026-11-24T11:57:25.711Z',
    read: true,
    fileDiff: [],
    finished: true,
    items: [{ type: 'text', text: 'Synthetic reply stored before its question.' }],
  },
  {
    id: 'question',
    role: 'user',
    timestamp: '2026-11-24T11:56:23.432Z',
    read: true,
    fileDiff: [],
    items: [{ type: 'text', text: 'Synthetic question synced after its reply.' }],
  },
];

const reversedSessionId = 'reversed-turn-order' as SessionId;

function ReversedTurnOrderStory() {
  const { items, lastAssistantMessageId, lastCompletedAssistantMessageId, candidates } =
    useMemo(() => {
      const view = createConversationViewFromHistory({
        sessionId: reversedSessionId,
        getHistory: () => reversedStoredHistory,
        subscribe: () => () => {},
      });
      const stream = buildChatStreamItems(view, reversedSessionId);
      return {
        ...stream,
        candidates: collectConversationMessages(inQuestionFirstOrder(reversedStoredHistory)),
      };
    }, []);
  const selection = useMessageSelection(reversedSessionId);
  const [selected, setSelected] = useState<ConversationMessage[]>([]);
  return (
    <PlatformContext.Provider value={platform}>
      <div {...stylex.props(storyLayout.stack)} data-testid="reversed-turn-order-story">
        <div {...stylex.props(storyLayout.canvas)}>
          <Button onClick={() => selection.start(candidates, setSelected)}>Start selection</Button>
          <output data-testid="selection-preview">
            {selected.map((message) => message.id).join(',')}
          </output>
        </div>
        <div {...stylex.props(storyLayout.frame)}>
          <MessageSelectionContext.Provider value={selection.context}>
            <SessionChatStreamView
              sessionId={reversedSessionId}
              xstyle={storyOverrides.stream}
              items={items}
              lastAssistantMessageId={lastAssistantMessageId}
              lastCompletedAssistantMessageId={lastCompletedAssistantMessageId}
              renderMessageRow={(props) => <MessageRowView {...props} />}
            />
            <MessageSelectionOverlay />
          </MessageSelectionContext.Provider>
          <MessageSelectionToolbar selection={selection} />
        </div>
      </div>
    </PlatformContext.Provider>
  );
}

export const ReversedTurnOrder: Story = { render: () => <ReversedTurnOrderStory /> };
