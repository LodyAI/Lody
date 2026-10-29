import type { Meta, StoryObj } from '@storybook/react';
import { Provider } from 'jotai';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import {
  AssistantTurnFooter,
  MessageRowView,
  SessionChatActionContext,
} from '@/components/ai-gui/view';
import { SessionPinContext } from '@/components/sessions/session-pin-context';
import { SettingsStoryProviders } from './settings-story-shell';
import { themeColors } from '../style/theme-colors.stylex';

const styles = stylex.create({
  frame: {
    padding: 16,
    maxWidth: 800,
    color: themeColors.foreground,
    backgroundColor: themeColors.background,
  },
  case: { marginBottom: 24 },
  receipt: { display: 'block', marginTop: 12, fontSize: 12, overflowWrap: 'anywhere' },
});
const sessionId = 'message-button-dimensions-session' as SessionId;
const ordinaryText = 'Synthetic instruction for message button dimensions.';
const longText = Array.from(
  { length: 22 },
  (_, i) => `Line ${i + 1}: preserve the existing renderer, behavior and local spacing contract.`
).join('\n');

function SyntheticClipboard({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [text, setText] = useState('');
  useEffect(() => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const clipboard: Pick<Clipboard, 'writeText'> = { writeText: async (value) => setText(value) };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    setReady(true);
    return () => {
      if (previous) Object.defineProperty(navigator, 'clipboard', previous);
      else Reflect.deleteProperty(navigator, 'clipboard');
    };
  }, []);
  return (
    <div data-synthetic-clipboard={text} data-clipboard-ready={ready}>
      {ready ? children : null}
      <output {...stylex.props(styles.receipt)}>
        Synthetic clipboard receiver: {text || 'empty'}
      </output>
    </div>
  );
}

function UserCase({ name = 'ordinary', long = false }: { name?: string; long?: boolean }) {
  const [pinned, setPinned] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [message, setMessage] = useState<SessionHistoryParsed>(() => ({
    id: `message-dimensions-${name}`,
    role: 'user',
    timestamp: '2026-10-22T08:00:00.000Z',
    read: true,
    items: [{ type: 'text', text: long ? longText : ordinaryText }],
  }));
  return (
    <section
      data-user-case={name}
      data-pinned={pinned ?? 'none'}
      data-saved={saved}
      {...stylex.props(styles.case)}
    >
      <SessionPinContext.Provider value={{ pinnedHistoryId: pinned, onPin: setPinned }}>
        <MessageRowView
          message={message}
          sessionId={sessionId}
          onEdit={async (_, edit) => {
            setSaved(edit.text);
            setMessage((previous) => ({ ...previous, items: [{ type: 'text', text: edit.text }] }));
            return true;
          }}
        />
      </SessionPinContext.Provider>
      <output {...stylex.props(styles.receipt)}>
        Pinned: {pinned ?? 'none'} · Saved: {saved || 'none'}
      </output>
    </section>
  );
}

const unfinished: SessionHistoryParsed = {
  id: 'message-dimensions-streaming',
  role: 'assistant',
  timestamp: '2026-10-22T08:00:00.000Z',
  read: true,
  finished: false,
  items: [{ type: 'text', text: 'Synthetic streaming response.' }],
};
const finished: SessionHistoryParsed = {
  ...unfinished,
  id: 'message-dimensions-finished',
  finished: true,
  items: [{ type: 'text', text: 'Synthetic finished response.' }],
};
function FooterCase() {
  const [contextReceipt, setContextReceipt] = useState('none');
  const [accentClicks, setAccentClicks] = useState(0);
  const [neutralClicks, setNeutralClicks] = useState(0);
  return (
    <div
      data-footer-fixture
      data-context-receipt={contextReceipt}
      data-accent-clicks={accentClicks}
      data-neutral-clicks={neutralClicks}
    >
      <section data-footer-case="streaming" {...stylex.props(styles.case)}>
        <SessionChatActionContext.Provider value={{ copyContext: setContextReceipt }}>
          <AssistantTurnFooter
            message={unfinished}
            sessionId={sessionId}
            showDuration={false}
            isTurnHovered
            isLatestTurn
          />
        </SessionChatActionContext.Provider>
      </section>
      <section data-footer-case="actions" {...stylex.props(styles.case)}>
        <AssistantTurnFooter
          message={finished}
          sessionId={sessionId}
          showDuration={false}
          isTurnHovered
          isLatestTurn
          assistantActions={[
            {
              id: 'accent',
              label: 'Apply synthetic action',
              tone: 'accent',
              disabled: accentClicks > 0,
              onClick: () => setAccentClicks((n) => n + 1),
            },
            {
              id: 'neutral',
              label: 'Review synthetic action',
              disabled: neutralClicks > 0,
              onClick: () => setNeutralClicks((n) => n + 1),
            },
          ]}
        />
      </section>
      <output {...stylex.props(styles.receipt)}>
        Context: {contextReceipt} · Accent: {accentClicks} · Neutral: {neutralClicks}
      </output>
    </div>
  );
}

function ScopeCase() {
  return (
    <div data-message-scopes style={{ '--spacing': '6px' } as CSSProperties}>
      <style>
        {
          '[data-message-scopes] [data-user-case="element"] [data-user-message-actions] button { --spacing: 5px; }'
        }
      </style>
      <UserCase name="outer" />
      <div style={{ '--spacing': '3px' } as CSSProperties}>
        <UserCase name="inner" />
        <UserCase name="element" />
      </div>
    </div>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div data-message-button-dimensions {...stylex.props(styles.frame)}>
      <SyntheticClipboard>{children}</SyntheticClipboard>
    </div>
  );
}
const meta = {
  title: 'Migration/OwnedMessageActionButtonDimensions',
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
export const UserActions: Story = {
  render: () => (
    <Frame>
      <UserCase />
    </Frame>
  ),
};
export const FooterActions: Story = {
  render: () => (
    <Frame>
      <FooterCase />
    </Frame>
  ),
};
export const LongUser: Story = {
  render: () => (
    <Frame>
      <UserCase name="long" long />
    </Frame>
  ),
};
export const ScopedActions: Story = {
  render: () => (
    <Frame>
      <ScopeCase />
    </Frame>
  ),
};
