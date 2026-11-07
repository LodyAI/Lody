import type { Meta, StoryObj } from '@storybook/react';
import { McpDefaultsRecovery } from '../components/chat/mcp-defaults-recovery';

const meta = {
  title: 'Chat/McpDefaultsRecovery',
  component: McpDefaultsRecovery,
  args: { onRetry: () => {}, onSendWithoutMcp: () => {} },
} satisfies Meta<typeof McpDefaultsRecovery>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Failed: Story = {};
export const Sending: Story = { args: { disabled: true } };
