import type { Meta, StoryObj } from '@storybook/react';
import type { CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import {
  ChatShareCard,
  type ChatShareCardBackdrop,
  type ChatShareCardDestination,
  type ChatShareCardMessage,
} from '@/components/share-card/chat-share-card';

const styles = stylex.create({ frame: { padding: 16 } });

const messages: ChatShareCardMessage[] = [
  { id: 'share-layout-user', role: 'user', text: 'Explain this small example.' },
  {
    id: 'share-layout-assistant',
    role: 'assistant',
    text: 'A short reply with **emphasis** and `inline code`.\n\n```ts\nconst answer = 42;\n```',
  },
];

function ShareCardFixture({
  destination = 'chat',
  theme = 'light',
  backdrop = 'lody',
  mat = 16,
  title = 'Conversation export',
  empty = false,
  spacing,
}: {
  destination?: ChatShareCardDestination;
  theme?: 'light' | 'dark';
  backdrop?: ChatShareCardBackdrop;
  mat?: number;
  title?: string;
  empty?: boolean;
  spacing?: string;
}) {
  return (
    <div
      {...stylex.props(styles.frame)}
      data-owned-share-layout
      data-share-destination={destination}
      data-share-palette={theme}
      data-share-spacing={spacing}
      style={spacing ? ({ '--spacing': spacing } as CSSProperties) : undefined}
    >
      <ChatShareCard
        destination={destination}
        theme={theme}
        backdrop={backdrop}
        mat={mat}
        title={title}
        messages={empty ? [] : messages}
        meta={{
          name: 'Example Agent',
          params: ['Example model', '~42 tokens'],
          date: '2026-10-22',
        }}
      />
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedShareCardLayout',
  component: ShareCardFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ShareCardFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ChatLight: Story = {};
export const ChatDark: Story = { args: { theme: 'dark', backdrop: 'welcome', mat: 12 } };
export const PostLight: Story = { args: { destination: 'post', backdrop: 'aurora', mat: 24 } };
export const PostDark: Story = {
  args: { destination: 'post', theme: 'dark', backdrop: 'ocean', mat: 24 },
};
export const FlushUntitled: Story = { args: { backdrop: 'sunset', mat: 0, title: '' } };
export const EmptyNoBackdrop: Story = {
  args: { destination: 'post', theme: 'dark', backdrop: 'none', mat: 96, empty: true },
};
export const LongTitleWideMat: Story = {
  args: {
    destination: 'post',
    backdrop: 'lody',
    mat: 96,
    title:
      'A deliberately long conversation title that wraps across several lines and preserves the original two line clamp without changing the card measure',
  },
};
export const LocalSpacing: Story = {
  args: { theme: 'dark', backdrop: 'welcome', mat: 16, spacing: '6px' },
};
