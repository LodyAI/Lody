import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import { LoroSidebar } from '@/components/loro-sidebar';

function FooterFixture({ scoped = false }: { scoped?: boolean }) {
  const [activeNav, setActiveNav] = useState<'home' | 'archive'>('home');
  const [lastAction, setLastAction] = useState('none');
  return (
    <div style={scoped ? ({ '--spacing': '6px' } as CSSProperties) : undefined}>
      <div
        data-owned-footer-dimensions
        data-scoped={String(scoped)}
        style={{ height: 420, ...(scoped ? { '--spacing': '5px' } : {}) } as CSSProperties}
      >
        <LoroSidebar
          workspaceName="Migration workspace"
          userEmail="fixture@example.com"
          workspaces={[{ id: 'fixture', name: 'Migration workspace' }]}
          currentWorkspaceId="fixture"
          repoSections={[]}
          chats={[]}
          connectionUiState="online"
          defaultWidth={332}
          activeNav={activeNav}
          onArchiveClicked={() => setActiveNav('archive')}
          onHomeClicked={() => setActiveNav('home')}
          onSettingsClicked={() => setLastAction('settings')}
          onDocsClicked={() => setLastAction('docs')}
        />
      </div>
      <output data-footer-fixture-state={`${activeNav}:${lastAction}`}>
        {activeNav}:{lastAction}
      </output>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedSidebarFooterDimensions',
  component: FooterFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof FooterFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Scoped: Story = { args: { scoped: true } };
