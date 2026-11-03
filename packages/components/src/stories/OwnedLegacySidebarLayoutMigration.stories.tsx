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
      ? stylex.props(styles.opaque).className
      : mode === 'utility'
        ? 'block w-40 min-w-0 gap-4 overflow-visible p-0'
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
          mode === 'wildcard'
            ? '[&_*]:w-7 [&_*]:p-0 [&_*]:gap-1 [&_*]:flex-row [&_*]:overflow-visible'
            : undefined
        }
      >
        <Sidebar collapsible="icon">
          <SidebarHeader data-layout-part="header" className={caller} style={local}>
            <span>Synthetic header</span>
            <span>Second header line</span>
          </SidebarHeader>
          <SidebarContent data-layout-part="content" className={caller} style={local}>
            <SidebarGroup data-layout-part="group" className={caller} style={local}>
              <SidebarMenu data-layout-part="menu" className={caller} style={local}>
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
          <SidebarFooter data-layout-part="footer" className={caller} style={local}>
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
