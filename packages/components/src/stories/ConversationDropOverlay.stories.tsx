import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';

import { WebChatLandingScreen } from '@/components/chat/web-chat-landing-screen';
import { ConversationDropOverlay } from '@/components/shared/conversation-drop-overlay';
const storyLayoutStyles = stylex.create({
  stack: {
    display: 'flex',
    'min-height': 'calc(var(--spacing) * 24)',
    'flex-direction': 'column',
    'justify-content': 'flex-end',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--foreground) / 1) 10%, transparent)',
    'background-color': 'hsl(var(--background) / 1)',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  frame: {
    height: '100dvh',
    'background-color': 'hsl(var(--background) / 1)',
    color: 'hsl(var(--foreground) / 1)',
  },
  frame2: {
    position: 'relative',
    'margin-inline': 'auto',
    height: '320px',
    width: '560px',
    'background-color': 'hsl(var(--background) / 1)',
    color: 'hsl(var(--foreground) / 1)',
  },
  canvas: {
    padding: 'calc(var(--spacing) * 8)',
  },
});

const meta = {
  title: 'Shared/ConversationDropOverlay',
  component: ConversationDropOverlay,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    active: true,
  },
} satisfies Meta<typeof ConversationDropOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

function LandingDropDemo({ dropKind }: { dropKind: 'session-mention' | 'files' }) {
  return (
    <div {...stylex.props(storyLayout.frame)}>
      <WebChatLandingScreen
        title="Let's ship something"
        dropActive
        dropKind={dropKind}
        composer={
          <div {...stylex.props(storyLayoutStyles.stack)}>
            Press &apos;/&apos; for commands, &apos;@&apos; for mentions.
          </div>
        }
      />
    </div>
  );
}

export const LandingSessionMention: Story = {
  globals: { theme: 'dark' },
  render: () => <LandingDropDemo dropKind="session-mention" />,
};

export const LandingFiles: Story = {
  globals: { theme: 'dark' },
  render: () => <LandingDropDemo dropKind="files" />,
};

function IsolatedDropDemo({ dropKind }: { dropKind: 'session-mention' | 'files' }) {
  return (
    <div {...stylex.props(storyLayout.frame2)}>
      <p {...stylex.props(storyLayout.canvas)}>Conversation</p>
      <ConversationDropOverlay active kind={dropKind} />
    </div>
  );
}

export const IsolatedSessionMention: Story = {
  render: () => <IsolatedDropDemo dropKind="session-mention" />,
};

export const IsolatedFiles: Story = {
  render: () => <IsolatedDropDemo dropKind="files" />,
};
