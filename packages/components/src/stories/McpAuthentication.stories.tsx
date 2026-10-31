import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { McpAuthenticationView } from '@/components/settings/mcp-authentication-view';

const styles = stylex.create({ frame: { maxWidth: 560, padding: space[4] } });
const meta = {
  title: 'Settings/McpAuthentication',
  component: McpAuthenticationView,
  args: { client: { id: '', secret: '' }, onClientChange: () => {}, onAction: () => {} },
  decorators: [
    (Story) => (
      <div {...stylex.props(styles.frame)}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpAuthenticationView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unknown: Story = {};
export const Required: Story = {
  args: {
    status: {
      type: 'mcp/authentication',
      status: 'required',
      hasCredentials: false,
      reason: 'oauth_required',
    },
  },
};
export const Unsaved: Story = { args: { ...Required.args, disabled: true } };
export const Waiting: Story = {
  args: {
    status: {
      type: 'mcp/authentication',
      status: 'waiting',
      hasCredentials: false,
      attemptId: 'synthetic',
      authorizationUrl: 'https://issuer.example/authorize',
    },
  },
};
export const Authorized: Story = {
  args: {
    status: {
      type: 'mcp/authentication',
      status: 'authorized',
      hasCredentials: true,
      mode: 'oauth',
    },
  },
};
export const Expired: Story = {
  args: {
    status: {
      type: 'mcp/authentication',
      status: 'required',
      hasCredentials: false,
      reason: 'expired',
    },
  },
};
export const StorageUnavailable: Story = {
  args: {
    status: {
      type: 'mcp/authentication',
      status: 'error',
      hasCredentials: false,
      reason: 'storage_unavailable',
    },
  },
};
export const ManualStdio: Story = {
  args: {
    httpControls: false,
    status: {
      type: 'mcp/authentication',
      status: 'authorized',
      hasCredentials: true,
      mode: 'manual',
    },
  },
};
