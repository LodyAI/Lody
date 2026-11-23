import type { Meta, StoryObj } from '@storybook/react';

import { WebChatLandingScreen } from '@/components/chat/web-chat-landing-screen';
import { ConversationDropOverlay } from '@/components/shared/conversation-drop-overlay';

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
    <div className="h-dvh bg-background text-foreground">
      <WebChatLandingScreen
        title="Let's ship something"
        dropActive
        dropKind={dropKind}
        composer={
          <div className="flex min-h-24 flex-col justify-end rounded-xl border border-foreground/[0.10] bg-background px-3 py-2 text-sm text-muted-foreground">
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
    <div className="relative mx-auto h-[320px] w-[560px] bg-background text-foreground">
      <p className="p-8">Conversation</p>
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
