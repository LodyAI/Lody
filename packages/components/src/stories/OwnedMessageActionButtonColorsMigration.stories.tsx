import type { Meta, StoryObj } from '@storybook/react';
import { Provider } from 'jotai';
import { useEffect, useLayoutEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import {
  AssistantTurnFooter,
  MessageRowView,
  ProposedPlanBlock,
  SessionChatActionContext,
} from '@/components/ai-gui/view';
import { SessionPinContext } from '@/components/sessions/session-pin-context';
import { SettingsStoryProviders } from './settings-story-shell';
import { parentButtonTheme, parentInkTheme } from './message-action-colors-fixture.stylex';

const styles = stylex.create({
  frame: { padding: 20, maxWidth: 820 },
  section: { marginBottom: 24 },
  receipt: { display: 'block', fontSize: 12, overflowWrap: 'anywhere' },
});
const sessionId = 'message-action-colors-session' as SessionId;
const user: SessionHistoryParsed = {
  id: 'message-colors-user',
  role: 'user',
  timestamp: '2026-10-29T00:00:00.000Z',
  read: true,
  items: [{ type: 'text', text: 'Synthetic instruction for the real message actions.' }],
};
const assistant: SessionHistoryParsed = {
  ...user,
  id: 'message-colors-assistant',
  role: 'assistant',
  finished: true,
  items: [{ type: 'text', text: 'Synthetic response for the real footer actions.' }],
};

function Fixture({ scoped = false }: { scoped?: boolean }) {
  const [ready, setReady] = useState(false);
  const [pinnedHistoryId, onPin] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState('');
  const [contextId, setContextId] = useState('none');
  const [fork, setFork] = useState('none');
  useEffect(() => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const receiver: Pick<Clipboard, 'writeText'> = {
      writeText: async (value) => setClipboard(value),
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: receiver });
    setReady(true);
    return () => {
      if (previous) Object.defineProperty(navigator, 'clipboard', previous);
      else Reflect.deleteProperty(navigator, 'clipboard');
    };
  }, []);
  useLayoutEffect(() => {
    if (!ready || !scoped) return;
    const root = document.querySelector('[data-message-action-colors="scoped"]');
    for (const control of root?.querySelectorAll<HTMLElement>('button[data-variant="ghost"]') ??
      []) {
      control.style.setProperty('--foreground', '300 75% 45%');
      control.style.setProperty('--muted-foreground', '190 90% 25%');
      control.style.setProperty('--hover', '40 100% 60%');
      control.style.setProperty('--spacing', '5px');
      control.dataset.elementColorScope = 'ready';
    }
  }, [ready, scoped]);
  return (
    <div
      data-message-action-colors={scoped ? 'scoped' : 'default'}
      data-color-ready={ready}
      data-pinned={pinnedHistoryId ?? 'none'}
      data-copy={clipboard}
      data-context={contextId}
      data-fork={fork}
      {...stylex.props(styles.frame, scoped && parentButtonTheme, scoped && parentInkTheme)}
    >
      {ready ? (
        <SessionChatActionContext.Provider value={{ copyContext: setContextId }}>
          <section data-color-case="user" {...stylex.props(styles.section)}>
            <SessionPinContext.Provider value={{ pinnedHistoryId, onPin }}>
              <MessageRowView
                message={user}
                sessionId={sessionId}
                onEdit={() => Promise.resolve(true)}
              />
            </SessionPinContext.Provider>
          </section>
          <section data-color-case="streaming" {...stylex.props(styles.section)}>
            <AssistantTurnFooter
              message={{ ...assistant, id: 'message-colors-streaming', finished: false }}
              sessionId={sessionId}
              showDuration={false}
              isTurnHovered
              isLatestTurn
            />
          </section>
          <section data-color-case="finished" {...stylex.props(styles.section)}>
            <AssistantTurnFooter
              message={assistant}
              sessionId={sessionId}
              showDuration={false}
              isTurnHovered
              isLatestTurn
              isForking={fork !== 'none'}
              onFork={(id, destination) => setFork(`${id}:${destination}`)}
              forkWorktreeAvailability="available"
            />
          </section>
          <section data-color-case="plan" {...stylex.props(styles.section)}>
            <ProposedPlanBlock
              plan={{
                type: 'proposed_plan',
                turnId: 'message-colors-plan-turn',
                markdown:
                  '## Synthetic plan\n\nKeep existing message action colors and interactions.',
                status: 'completed',
                isLatest: true,
              }}
              messageId="message-colors-plan"
              itemIndex={0}
            />
          </section>
        </SessionChatActionContext.Provider>
      ) : null}
      <output {...stylex.props(styles.receipt)}>
        Clipboard: {clipboard || 'empty'} · Context: {contextId} · Fork: {fork}
      </output>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedMessageActionButtonColors',
  component: Fixture,
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
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Scoped: Story = { args: { scoped: true } };
