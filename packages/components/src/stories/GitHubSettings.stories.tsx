import type { Meta, StoryObj } from '@storybook/react';
import { useState, type ComponentProps } from 'react';
import { GitHubSettingsView } from '@/components/settings/github-settings-view';
import type { SettingsWorkspaceRepoWithStatus } from '@/components/settings/settings-data-cache';

/* Settings > GitHub, as the desktop overlay's right pane draws it: inside the
   `data-settings-surface` scope that maps `--card` to the settings material. */

const repo = (
  repoFullName: string,
  enabled: boolean,
  isPrivate = false
): SettingsWorkspaceRepoWithStatus => ({
  repoFullName,
  name: repoFullName.split('/')[1] ?? repoFullName,
  repositoryId: repoFullName.length,
  private: isPrivate,
  enabled,
});

const fewRepos = [
  repo('loro-dev/loro', true),
  repo('loro-dev/lody', true, true),
  repo('loro-dev/crdt-richtext', false),
  repo('LodyAI/acp-extension-core', true),
  repo('zxch3n/dotfiles', false, true),
];

const manyRepos = [
  ...fewRepos,
  repo('loro-dev/loro-prosemirror', false),
  repo('loro-dev/loro-codemirror', true),
  repo('loro-dev/loro-website', false),
  repo('LodyAI/lody-cloud', true, true),
  repo('LodyAI/acp-extension-kimi', false),
  repo('LodyAI/design-tokens', false, true),
  repo('zxch3n/blog', false),
];

type ViewProps = ComponentProps<typeof GitHubSettingsView>;

function Harness(props: Partial<ViewProps>) {
  const [repos, setRepos] = useState(props.repos ?? fewRepos);
  const [identityEnabled, setIdentityEnabled] = useState(props.identity?.enabled ?? true);
  return (
    <div
      data-settings-surface=""
      className="min-h-screen bg-background py-6"
      style={{ width: 860, paddingInline: 24 }}
    >
      <GitHubSettingsView
        canManage
        workspaceReady
        connecting={false}
        onConnect={() => {}}
        reposLoading={false}
        {...props}
        identity={{
          authorizationState: 'authorized',
          githubAccountId: '1',
          profile: { login: 'zxch3n', name: 'Zixuan Chen' },
          onAuthorize: () => {},
          ...props.identity,
          enabled: identityEnabled,
          onToggle: setIdentityEnabled,
        }}
        repos={repos}
        onToggleRepo={(name, enabled) =>
          setRepos((current) =>
            current.map((entry) => (entry.repoFullName === name ? { ...entry, enabled } : entry))
          )
        }
      />
    </div>
  );
}

const meta = {
  title: 'Settings/GitHubSettings',
  component: Harness,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Admin: Story = {};

export const ManyRepositories: Story = { args: { repos: manyRepos } };

export const Member: Story = { args: { canManage: false } };

export const AuthorizationNeeded: Story = {
  args: {
    identity: {
      enabled: true,
      authorizationState: 'missing',
      onToggle: () => {},
      onAuthorize: () => {},
    },
  },
};

export const IdentityOff: Story = {
  args: {
    identity: {
      enabled: false,
      authorizationState: 'missing',
      onToggle: () => {},
      onAuthorize: () => {},
    },
  },
};

export const NotInstalled: Story = { args: { repos: [] } };

export const Loading: Story = { args: { repos: [], reposLoading: true } };
