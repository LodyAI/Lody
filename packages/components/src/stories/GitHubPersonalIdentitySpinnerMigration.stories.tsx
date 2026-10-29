import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import { GitHubPersonalIdentitySettingsCard } from '@/components/settings/integrations-setting';
import { SettingsStoryProviders } from './settings-story-shell';

function IdentityFixture({ scoped = false }: { scoped?: boolean }) {
  const [authorizing, setAuthorizing] = useState(false);
  return (
    <div
      data-personal-identity-spinner
      data-authorizing={authorizing}
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
        authorizationState="missing"
        authorizing={authorizing}
        onToggle={() => undefined}
        onAuthorize={() => setAuthorizing(true)}
      />
      <output>{authorizing ? 'Synthetic authorization requested' : 'Ready'}</output>
    </div>
  );
}

const meta = {
  title: 'Migration/GitHubPersonalIdentitySpinner',
  component: IdentityFixture,
  parameters: { layout: 'fullscreen' },
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
