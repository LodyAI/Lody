import type { Meta, StoryObj } from '@storybook/react';
import { Provider } from 'jotai';
import { useMemo, useState } from 'react';
import { MessageCircle, Play } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { button as buttonTokens } from '@lody/ui/button/button.tokens.stylex';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import {
  AssistantTurnFooter,
  MessageRowView,
  SessionChatStreamView,
  type AssistantMessageAction,
  type ChatStreamItem,
} from '@/components/ai-gui/view';
import { SettingsStoryProviders } from './settings-story-shell';

const styles = stylex.create({
  frame: { padding: 16, maxWidth: 800 },
  stream: { height: 420 },
  receipt: { display: 'block', marginTop: 12, fontSize: 12 },
  reader: {
    display: 'block',
    width: buttonTokens.gap,
    height: buttonTokens.paddingXSmall,
    backgroundColor: 'currentColor',
  },
});
const sessionId = 'assistant-action-ink-migration' as SessionId;
const message: SessionHistoryParsed = {
  id: 'assistant-action-ink-turn',
  role: 'assistant',
  timestamp: '2026-10-22T08:00:00.000Z',
  finished: true,
  read: true,
  items: [{ type: 'text', text: 'A synthetic plan is ready for a decision.' }],
};
const items: ChatStreamItem[] = [{ type: 'message', sessionId, message, turnIndex: 0 }];
function PendingIcon({ className }: { className?: string }) {
  return <Spinner className={className} />;
}
function TokenReaderIcon({ className }: { className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <i data-action-token-reader {...stylex.props(styles.reader)} />
    </span>
  );
}
function Scene({
  reader = false,
  initialPending = false,
  caller = 'none',
  long = false,
}: {
  reader?: boolean;
  initialPending?: boolean;
  caller?: 'none' | 'low' | 'unlayered';
  long?: boolean;
}) {
  const [pending, setPending] = useState(initialPending);
  const [accentClicks, setAccentClicks] = useState(0);
  const [secondaryClicks, setSecondaryClicks] = useState(0);
  const actions = useMemo<AssistantMessageAction[]>(
    () => [
      {
        id: 'accent',
        label: pending
          ? 'Applying synthetic action'
          : long
            ? 'Implement the complete synthetic plan'
            : 'Apply synthetic action',
        tone: 'accent',
        icon: reader ? TokenReaderIcon : pending ? PendingIcon : Play,
        disabled: pending,
        onClick: () => {
          setAccentClicks((n) => n + 1);
          setPending(true);
        },
      },
      {
        id: 'secondary',
        label: long ? 'Continue discussing the synthetic plan' : 'Discuss synthetic action',
        icon: reader ? TokenReaderIcon : MessageCircle,
        disabled: pending,
        onClick: () => setSecondaryClicks((n) => n + 1),
      },
    ],
    [pending, reader, long]
  );
  const publicClass =
    caller === 'low'
      ? '[:where(&)_:where(button)]:text-sky-600 [:where(&)_:where(button)]:hover:text-sky-700'
      : 'owned-assistant-action-unlayered';
  return (
    <section
      data-assistant-action-fixture
      data-reader={reader}
      data-caller={caller}
      data-pending={pending}
      data-accent-clicks={accentClicks}
      data-secondary-clicks={secondaryClicks}
      {...stylex.props(styles.frame)}
    >
      {caller === 'unlayered' ? (
        <style>
          {
            ':where(.owned-assistant-action-unlayered button) { color: rgb(210 44 88); } :where(.owned-assistant-action-unlayered button:hover) { color: rgb(22 160 60); }'
          }
        </style>
      ) : null}
      {caller === 'none' ? (
        <AssistantTurnFooter
          message={message}
          sessionId={sessionId}
          showDuration={false}
          isTurnHovered
          isLatestTurn
          assistantActions={actions}
        />
      ) : (
        <div {...stylex.props(styles.stream)}>
          <SessionChatStreamView
            sessionId={sessionId}
            items={items}
            assistantActions={actions}
            assistantActionsMessageId={message.id}
            lastAssistantMessageId={message.id}
            className={publicClass}
            renderMessageRow={({ message: row, sessionId: id }) => (
              <MessageRowView message={row} sessionId={id} />
            )}
          />
        </div>
      )}
      <output {...stylex.props(styles.receipt)}>
        Accent {accentClicks}; secondary {secondaryClicks}; pending {String(pending)}
      </output>
      <button data-reset-actions onClick={() => setPending(false)}>
        Complete synthetic pending
      </button>
    </section>
  );
}
const meta = {
  title: 'Migration/OwnedAssistantActionInk',
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <Provider>
        <SettingsStoryProviders>
          <Story />
        </SettingsStoryProviders>
      </Provider>
    ),
  ],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const GlyphActions: Story = { render: () => <Scene /> };
export const PendingActions: Story = { render: () => <Scene initialPending /> };
export const ReaderActions: Story = { render: () => <Scene reader /> };
export const LongActions: Story = { render: () => <Scene long /> };
export const StreamCallerLow: Story = { render: () => <Scene caller="low" /> };
export const StreamCallerUnlayered: Story = { render: () => <Scene caller="unlayered" /> };
