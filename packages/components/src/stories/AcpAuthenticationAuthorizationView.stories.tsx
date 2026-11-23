import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';

import { AcpAuthenticationAuthorizationView } from '@/components/settings/acp-authentication-panel';
const storyLayout = stylex.create({
  frame: {
    width: '520px',
    'max-width': 'calc(100vw - 2rem)',
  },
});

const meta = {
  title: 'Settings/AcpAuthenticationAuthorizationView',
  component: AcpAuthenticationAuthorizationView,
  decorators: [
    (Story) => (
      <div {...stylex.props(storyLayout.frame)}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'centered' },
  args: {
    authorizationCode: '',
    authorizationCodeSubmitted: false,
    submittingAuthorizationCode: false,
    userCodeCopied: false,
    onOpenAuthorization: () => {},
    onCopyUserCode: () => {},
    onAuthorizationCodeChange: () => {},
    onSubmitAuthorizationCode: () => {},
  },
} satisfies Meta<typeof AcpAuthenticationAuthorizationView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ChatGPTDeviceCode: Story = {
  args: {
    provider: 'ChatGPT',
    authorization: {
      authorizationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'DQGR-SB46E',
      expiresInSeconds: 900,
    },
  },
};

export const ClaudeBrowserFallback: Story = {
  args: {
    provider: 'Claude',
    authorization: {
      authorizationUrl: 'https://claude.com/cai/oauth/authorize?code=true',
      acceptsAuthorizationCode: true,
    },
  },
};
