import { useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { PopupContainerProvider } from '@lody/ui/popup-container';
import { SidebarFilterPopover } from '@/components/sidebar-filter-popover';
import type { SidebarOrganizeMode } from '@/atoms/sidebar-state';
const storyCallerStyles = stylex.create({
  popupOverride: {
    width: '247px',
    'min-width': '233px',
    gap: 'calc(var(--spacing) * 5)',
  },
});

const callerStyles = stylex.create({ popup: { width: 273, minWidth: 241, gap: 13 } });

function Fixture({
  scope = 'global',
  caller = 'none',
  localSpacing = false,
}: {
  scope?: 'global' | 'dark' | 'light-exclusion';
  caller?: 'none' | 'utility' | 'opaque';
  localSpacing?: boolean;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [organize, setOrganize] = useState<SidebarOrganizeMode>('workspace');
  return (
    <div className={scope === 'global' ? undefined : 'dark-scope'}>
      <div
        ref={setHost}
        className={scope === 'light-exclusion' ? 'light-scope' : undefined}
        style={{
          minHeight: '100vh',
          ...(localSpacing ? ({ '--spacing': '6px' } as CSSProperties) : {}),
          ...(scope !== 'global' ? ({ '--color-white': '#ffdfc4' } as CSSProperties) : {}),
        }}
        data-sidebar-dark-fixture={scope}
      >
        <PopupContainerProvider container={host}>
          <SidebarFilterPopover
            className={
              caller === 'utility'
                ? stylex.props(storyCallerStyles.popupOverride).className
                : caller === 'opaque'
                  ? stylex.props(callerStyles.popup).className
                  : undefined
            }
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

export const UtilityCaller: Story = { args: { caller: 'utility' } };
export const OpaqueCaller: Story = { args: { caller: 'opaque' } };
export const LocalSpacing: Story = { args: { localSpacing: true } };
