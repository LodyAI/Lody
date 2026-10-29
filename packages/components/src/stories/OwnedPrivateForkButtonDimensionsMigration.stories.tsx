import type { Meta, StoryObj } from '@storybook/react';
import { Provider } from 'jotai';
import { useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import {
  AssistantTurnFooter,
  MessageRowView,
  SessionChatActionContext,
} from '@/components/ai-gui/view';
import { SettingsStoryProviders } from './settings-story-shell';
import { themeColors } from '../style/theme-colors.stylex';

const styles = stylex.create({
  frame: {
    padding: 20,
    minHeight: 480,
    maxWidth: 800,
    color: themeColors.foreground,
    backgroundColor: themeColors.background,
  },
  surface: { paddingTop: 64, paddingBottom: 64 },
  receipt: { display: 'block', marginBottom: 16, fontSize: 12, overflowWrap: 'anywhere' },
});
const sessionId = 'private-fork-dimensions-session' as SessionId;
const userMessage: SessionHistoryParsed = {
  id: 'private-fork-user',
  role: 'user',
  timestamp: '2026-10-22T08:00:00.000Z',
  read: true,
  items: [{ type: 'text', text: 'Synthetic user turn with its real context menu.' }],
};
const finished: SessionHistoryParsed = {
  id: 'private-fork-footer',
  role: 'assistant',
  timestamp: '2026-10-22T08:00:00.000Z',
  read: true,
  finished: true,
  items: [{ type: 'text', text: 'Synthetic completed response for the real footer.' }],
};

function ForkCase({
  instance,
  caller,
  initiallyForking = false,
}: {
  instance: string;
  caller: 'user' | 'footer';
  initiallyForking?: boolean;
}) {
  const [contextId, setContextId] = useState('none');
  const [forkChoice, setForkChoice] = useState('none');
  const [forking, setForking] = useState(initiallyForking);
  const [opened, setOpened] = useState(0);
  return (
    <section
      data-fork-instance={instance}
      data-fork-caller={caller}
      data-context-id={contextId}
      data-fork-choice={forkChoice}
      data-forking={forking}
      data-opened={opened}
    >
      <SessionChatActionContext.Provider value={{ copyContext: setContextId }}>
        <div {...stylex.props(styles.surface)}>
          {caller === 'user' ? (
            <MessageRowView message={userMessage} sessionId={sessionId} />
          ) : (
            <AssistantTurnFooter
              message={finished}
              sessionId={sessionId}
              showDuration={false}
              isTurnHovered
              isLatestTurn
              isForking={forking}
              forkWorktreeAvailability="available"
              onForkWorktreeMenuOpen={() => setOpened((n) => n + 1)}
              onFork={(id, destination) => {
                setForkChoice(`${id}:${destination}`);
                setForking(true);
              }}
            />
          )}
        </div>
      </SessionChatActionContext.Provider>
      <output {...stylex.props(styles.receipt)}>
        Caller: {caller} · Context: {contextId} · Fork: {forkChoice} · Forking: {String(forking)}
      </output>
    </section>
  );
}
function Fixture({
  caller = 'user',
  forking = false,
  scoped = false,
}: {
  caller?: 'user' | 'footer';
  forking?: boolean;
  scoped?: boolean;
}) {
  return (
    <div data-private-fork-dimensions {...stylex.props(styles.frame)}>
      {scoped ? (
        <div style={{ '--spacing': '6px' } as CSSProperties}>
          <style>
            {'[data-fork-instance="element"] button[aria-label="Fork session"] { --spacing: 5px; }'}
          </style>
          <ForkCase caller="footer" instance="outer" />
          <div style={{ '--spacing': '3px' } as CSSProperties}>
            <ForkCase caller="user" instance="inner" />
            <ForkCase caller="footer" instance="element" />
          </div>
        </div>
      ) : (
        <ForkCase caller={caller} instance="primary" initiallyForking={forking} />
      )}
    </div>
  );
}
const meta = {
  title: 'Migration/OwnedPrivateForkButtonDimensions',
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
export const UserCaller: Story = { args: { caller: 'user' } };
export const FooterCaller: Story = { args: { caller: 'footer' } };
export const ForkingFooter: Story = { args: { caller: 'footer', forking: true } };
export const ScopedCallers: Story = { args: { scoped: true } };
