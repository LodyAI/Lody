import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import {
  GitHubPersonalIdentitySettingsCard,
  type GitHubPersonalIdentityAuthorizationState,
} from '@/components/settings/integrations-setting';
import { SettingsStoryProviders } from './settings-story-shell';

function IdentityFixture({
  scoped = false,
  authorizationState = 'missing',
  workspaceReady = true,
  initialAuthorizing = false,
}: {
  scoped?: boolean;
  authorizationState?: GitHubPersonalIdentityAuthorizationState;
  workspaceReady?: boolean;
  initialAuthorizing?: boolean;
}) {
  const [authorizing, setAuthorizing] = useState(initialAuthorizing);
  const [requests, setRequests] = useState(0);
  return (
    <div
      data-personal-identity-spinner
      data-authorizing={authorizing}
      data-authorization-state={authorizationState}
      data-workspace-ready={workspaceReady}
      data-authorization-requests={requests}
      style={
        {
          padding: 16,
          maxWidth: 720,
          ...(scoped ? { '--spacing': '6px' } : {}),
        } as CSSProperties
      }
    >
      <GitHubPersonalIdentitySettingsCard
        enabled
        authorizationState={authorizationState}
        workspaceReady={workspaceReady}
        authorizing={authorizing}
        onToggle={() => undefined}
        onAuthorize={() => {
          setRequests((value) => value + 1);
          setAuthorizing(true);
        }}
      />
      <output>{authorizing ? 'Synthetic authorization requested' : 'Ready'}</output>
    </div>
  );
}

const meta = {
  title: 'Migration/GitHubPersonalIdentitySpinner',
  component: IdentityFixture,
  parameters: { layout: 'fullscreen' },
  args: { authorizationState: 'missing', workspaceReady: true, initialAuthorizing: false },
  decorators: [
    (Story) => (
      <SettingsStoryProviders>
        <Story />
      </SettingsStoryProviders>
    ),
  ],
} satisfies Meta<typeof IdentityFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Authorizing: Story = {};
export const ScopedAuthorizing: Story = { args: { scoped: true } };

export const Expired: Story = { args: { authorizationState: 'expired' } };
export const WorkspaceNotReady: Story = { args: { workspaceReady: false } };
export const AlreadyAuthorizing: Story = { args: { initialAuthorizing: true } };
export const AuthorizedControl: Story = { args: { authorizationState: 'authorized' } };
