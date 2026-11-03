import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { MessageListErrorFallback } from '@/components/sessions/message-list-error-fallback';
const storyLayout = stylex.create({
  frame: {
    height: '420px',
    'background-color': 'hsl(var(--background) / 1)',
  },
});

const error = new TypeError('Failed to measure message');
error.stack = 'TypeError: Failed to measure message\n    at measureRow (view.tsx:42:7)';
const meta = {
  title: 'Sessions/MessageListErrorFallback',
  component: MessageListErrorFallback,
  args: {
    error,
    componentStack: '\n    at SessionChatStream\n    at SessionChatInterface',
    resetErrorBoundary: () => {},
  },
  decorators: [
    (Story) => (
      <div {...stylex.props(storyLayout.frame)}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MessageListErrorFallback>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
