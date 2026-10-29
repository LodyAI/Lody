import { useState, type CSSProperties } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { PopupContainerProvider } from '@lody/ui/popup-container';
import { SidebarFilterPopover } from '@/components/sidebar-filter-popover';
import type { SidebarOrganizeMode } from '@/atoms/sidebar-state';

function Fixture({ scope = 'global' }: { scope?: 'global' | 'dark' | 'light-exclusion' }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [organize, setOrganize] = useState<SidebarOrganizeMode>('workspace');
  return (
    <div className={scope === 'global' ? undefined : 'dark-scope'}>
      <div
        ref={setHost}
        className={scope === 'light-exclusion' ? 'light-scope' : undefined}
        style={{
          minHeight: '100vh',
          ...(scope !== 'global' ? ({ '--color-white': '#ffdfc4' } as CSSProperties) : {}),
        }}
        data-sidebar-dark-fixture={scope}
      >
        <PopupContainerProvider container={host}>
          <SidebarFilterPopover
            organize={organize}
            scope="my"
            side="bottom"
            align="start"
            onOrganizeChange={setOrganize}
          />
        </PopupContainerProvider>
        <output data-sidebar-dark-selection>{organize}</output>
      </div>
    </div>
  );
}

const meta = {
  title: 'Sidebar/OwnedFilterDarkMigration',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Fixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Global: Story = {};
export const DarkScope: Story = { args: { scope: 'dark' } };
export const LightExclusion: Story = { args: { scope: 'light-exclusion' } };
