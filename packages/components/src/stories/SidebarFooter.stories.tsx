import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { LoroSidebar, type LoroSidebarProps } from '@/components/loro-sidebar';
import lodyLogo from '@/assets/lody-icon.png';

const meta = {
  title: 'Components/SidebarFooter',
  component: LoroSidebar,
  parameters: { layout: 'fullscreen' },
  args: {
    workspaceName: 'Wibus Studio',
    userEmail: 'demo@example.com',
    workspaces: [
      { id: 'studio', name: 'Wibus Studio', logo: lodyLogo },
      { id: 'demo', name: 'Demo workspace' },
    ],
    currentWorkspaceId: 'studio',
    repoSections: [],
    chats: [],
    connectionUiState: 'online',
    defaultWidth: 332,
    onSettingsClicked: () => {},
  },
  render: (args) => <FooterScene {...args} />,
} satisfies Meta<typeof LoroSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

function FooterScene(args: LoroSidebarProps) {
  const [activeNav, setActiveNav] = useState(args.activeNav ?? 'home');
  const [workspaceId, setWorkspaceId] = useState(args.currentWorkspaceId);
  const workspace = args.workspaces.find((item) => item.id === workspaceId);
  return (
    <div style={{ height: 420 }}>
      <LoroSidebar
        {...args}
        workspaceName={workspace?.name ?? args.workspaceName}
        currentWorkspaceId={workspaceId}
        activeNav={activeNav}
        onWorkspaceSelected={setWorkspaceId}
        onHomeClicked={() => setActiveNav('home')}
        onArchiveClicked={() => setActiveNav('archive')}
      />
    </div>
  );
}

export const Default: Story = {};

export const LongName: Story = {
  args: {
    workspaces: [
      { id: 'studio', name: 'A workspace with a long name that needs truncation', logo: lodyLogo },
    ],
    defaultWidth: 240,
  },
};

export const Syncing: Story = { args: { workspaceSyncing: true } };

export const LocalIdentity: Story = { args: { workspaceSwitcherEnabled: false } };
