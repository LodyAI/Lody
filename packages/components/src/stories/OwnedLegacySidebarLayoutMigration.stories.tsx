import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { File } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from '@/ui/sidebar';
const storyCallerStyles = stylex.create({
  layoutOverride: {
    display: 'block',
    width: 'calc(var(--spacing) * 40)',
    'min-width': 'calc(var(--spacing) * 0)',
    gap: 'calc(var(--spacing) * 4)',
    overflow: 'visible',
    padding: 'calc(var(--spacing) * 0)',
  },
  wildcard: {
    ':is(*) *': {
      width: 'calc(var(--spacing) * 7)',
      'flex-direction': 'row',
      gap: 'calc(var(--spacing) * 1)',
      overflow: 'visible',
      padding: 'calc(var(--spacing) * 0)',
    },
  },
});

const styles = stylex.create({
  outer: { display: 'contents' },
  main: { padding: 16, minWidth: 0 },
  controls: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBlock: 16 },
  opaque: {
    display: 'grid',
    flexDirection: 'row',
    gap: 31,
    padding: 19,
    width: 183,
    minWidth: 39,
    overflowX: 'visible',
    alignItems: 'flex-end',
  },
});

function Controls({ onExternal }: { onExternal: (value: string) => void }) {
  const { state, isMobile, openMobile, toggleSidebar } = useSidebar();
  return (
    <>
      <output
        data-sidebar-layout-state={state}
        data-sidebar-layout-mobile={String(isMobile)}
        data-sidebar-layout-open={String(openMobile)}
      >
        {state}
      </output>
      <div {...stylex.props(styles.controls)}>
        <button type="button" data-sidebar-layout-toggle onClick={toggleSidebar}>
          Toggle synthetic layout
        </button>
        {['none', 'icon', 'offcanvas'].map((value) => (
          <button
            type="button"
            key={value}
            data-sidebar-layout-external={value}
            onClick={() => onExternal(value)}
          >
            Outer {value}
          </button>
        ))}
      </div>
    </>
  );
}

function Fixture({ mode = 'natural' }: { mode?: string }) {
  const [external, setExternal] = useState('none');
  const [event, setEvent] = useState('Ready');
  const caller =
    mode === 'opaque'
      ? styles.opaque
      : mode === 'utility'
        ? storyCallerStyles.layoutOverride
        : undefined;
  const local =
    mode === 'scoped'
      ? ({ '--spacing': '6px', '--radius-md': '13px' } as CSSProperties)
      : undefined;
  return (
    <div
      data-sidebar-layout-fixture={mode}
      className={['group', stylex.props(styles.outer).className].join(' ')}
      data-collapsible={external === 'none' ? undefined : external}
      dir={mode === 'scoped' ? 'rtl' : undefined}
    >
      <SidebarProvider
        className={
          mode === 'wildcard' ? stylex.props(storyCallerStyles.wildcard).className : undefined
        }
      >
        <Sidebar collapsible="icon">
          <SidebarHeader data-layout-part="header" xstyle={caller} style={local}>
            <span>Synthetic header</span>
            <span>Second header line</span>
          </SidebarHeader>
          <SidebarContent data-layout-part="content" xstyle={caller} style={local}>
            <SidebarGroup data-layout-part="group" xstyle={caller} style={local}>
              <SidebarMenu data-layout-part="menu" xstyle={caller} style={local}>
                <SidebarMenuItem>
                  <SidebarMenuButton data-layout-action="native" onClick={() => setEvent('Native')}>
                    <File />
                    <span>Synthetic native item</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    data-layout-action="slot"
                    asChild
                    onClick={() => setEvent('Slot')}
                  >
                    <a href="#sidebar-layout-slot" onClick={(e) => e.preventDefault()}>
                      <File />
                      <span>Synthetic Slot item</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton disabled>Disabled item</SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
            <p>Content after the group</p>
          </SidebarContent>
          <SidebarFooter data-layout-part="footer" xstyle={caller} style={local}>
            <span>Synthetic footer</span>
            <span>Second footer line</span>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset>
          <main {...stylex.props(styles.main)}>
            <Controls onExternal={setExternal} />
            <output data-sidebar-layout-event>{event}</output>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedLegacySidebarLayout',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Natural: Story = { args: { mode: 'natural' } };
export const Opaque: Story = { args: { mode: 'opaque' } };
export const Utility: Story = { args: { mode: 'utility' } };
export const Wildcard: Story = { args: { mode: 'wildcard' } };
export const Scoped: Story = { args: { mode: 'scoped' } };
