import type { Meta, StoryObj } from '@storybook/react';
import type { CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Sidebar, SidebarProvider, SidebarTrigger, useSidebar } from '@/ui/sidebar';
import { themeColors } from '../style/theme-colors.stylex';

const styles = stylex.create({
  content: { padding: 16, overflow: 'hidden', whiteSpace: 'nowrap' },
  heading: { marginBottom: 12, fontWeight: 600 },
  row: { paddingBlock: 8 },
  main: { flex: 1, minWidth: 0, padding: 20, color: themeColors.foreground },
  status: { display: 'block', marginTop: 16 },
  caller: { maxHeight: 'calc(100svh - 12px)', width: '14rem' },
});

function StateProbe() {
  const { state, isMobile, openMobile } = useSidebar();
  return (
    <output
      {...stylex.props(styles.status)}
      data-sidebar-fixture-state={state}
      data-sidebar-fixture-mobile={String(isMobile)}
      data-sidebar-fixture-open={String(openMobile)}
    >
      {isMobile ? (openMobile ? 'Mobile sidebar open' : 'Mobile sidebar closed') : state}
    </output>
  );
}

function SidebarFixture({
  side = 'left',
  variant = 'sidebar',
  collapsible = 'offcanvas',
  scoped = false,
}: {
  side?: 'left' | 'right';
  variant?: 'sidebar' | 'floating' | 'inset';
  collapsible?: 'offcanvas' | 'icon';
  scoped?: boolean;
}) {
  return (
    <SidebarProvider
      data-owned-sidebar-fixture
      style={
        scoped
          ? ({
              '--sidebar-width': '13rem',
              '--sidebar-background': '203 45% 87%',
              '--sidebar-foreground': '267 65% 24%',
            } as CSSProperties)
          : undefined
      }
    >
      <Sidebar
        side={side}
        variant={variant}
        collapsible={collapsible}
        className={scoped ? stylex.props(styles.caller).className : undefined}
      >
        <div {...stylex.props(styles.content)} data-owned-sidebar-content>
          <div {...stylex.props(styles.heading)}>Project navigation</div>
          <div {...stylex.props(styles.row)}>Recent conversations</div>
          <div {...stylex.props(styles.row)}>Files and changes</div>
          <div {...stylex.props(styles.row)}>A long navigation label that stays clipped</div>
          <SidebarTrigger aria-label="Close sidebar fixture" data-sidebar-fixture-close />
        </div>
      </Sidebar>
      <main {...stylex.props(styles.main)}>
        <SidebarTrigger aria-label="Toggle sidebar fixture" data-sidebar-fixture-toggle />
        <StateProbe />
      </main>
    </SidebarProvider>
  );
}

const meta = {
  title: 'Migration/OwnedLegacySidebar',
  component: SidebarFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SidebarFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OffcanvasLeft: Story = {};
export const IconLeft: Story = { args: { collapsible: 'icon' } };
export const FloatingRight: Story = { args: { side: 'right', variant: 'floating' } };
export const ScopedInset: Story = { args: { variant: 'inset', scoped: true } };
