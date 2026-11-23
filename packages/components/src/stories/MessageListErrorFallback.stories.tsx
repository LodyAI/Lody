import type { Meta, StoryObj } from '@storybook/react-vite';
import { MessageListErrorFallback } from '@/components/sessions/message-list-error-fallback';

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
      <div className="h-[420px] bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MessageListErrorFallback>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
