import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { File, MoreHorizontal } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from '@/ui/sidebar';

const styles = stylex.create({
  outer: { display: 'contents' },
  main: { padding: 16, minWidth: 0 },
  controls: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  opaque: { display: 'grid', width: 83, height: 43, padding: 17, gap: 19, borderRadius: 19 },
  inherited: { fontSize: 21, lineHeight: 1.8, fontWeight: 700 },
});

function Controls({ onExternal }: { onExternal: (value: string) => void }) {
  const { state, isMobile, openMobile, toggleSidebar } = useSidebar();
  return (
    <>
      <output
        data-sidebar-button-state={state}
        data-sidebar-button-mobile={String(isMobile)}
        data-sidebar-button-open={String(openMobile)}
      >
        {state}
      </output>
      <div {...stylex.props(styles.controls)}>
        <button type="button" data-sidebar-button-toggle onClick={toggleSidebar}>
          Toggle synthetic sidebar
        </button>
        {['none', 'icon', 'offcanvas', 'floating', 'right'].map((value) => (
          <button
            type="button"
            key={value}
            data-sidebar-button-external={value}
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
  const wildcard =
    mode === 'wildcard'
      ? '[&_*]:w-7 [&_*]:p-0 [&_*]:gap-1 [&_*]:rounded-none [&_*]:rotate-0'
      : mode === 'targeted'
        ? '[&_[data-sidebar=menu-button]]:w-7 [&_[data-sidebar=menu-button]]:p-0 [&_[data-sidebar=menu-button]]:gap-1 [&_[data-sidebar=menu-button]]:rounded-none [&_[data-sidebar=menu-button]]:block'
        : undefined;
  return (
    <div
      className={['group', stylex.props(styles.outer).className].join(' ')}
      data-sidebar-button-fixture={mode}
      data-collapsible={external === 'icon' || external === 'offcanvas' ? external : undefined}
      data-variant={external === 'floating' ? external : undefined}
      data-side={external === 'right' ? external : undefined}
      style={
        mode === 'scoped'
          ? ({ '--spacing': '6px', '--radius-md': '13px' } as CSSProperties)
          : undefined
      }
      dir={mode === 'scoped' ? 'rtl' : undefined}
    >
      <SidebarProvider
        className={mode === 'wildcard' ? wildcard : undefined}
        style={{ '--sidebar-width': '16rem', '--sidebar-width-icon': '3rem' } as CSSProperties}
      >
        <Sidebar collapsible="icon">
          <SidebarContent>
            <SidebarGroup
              className={mode === 'targeted' ? wildcard : stylex.props(styles.inherited).className}
            >
              <SidebarMenu>
                {(['default', 'sm', 'lg'] as const).map((size) => (
                  <SidebarMenuItem key={size}>
                    <SidebarMenuButton
                      data-case={size}
                      size={size}
                      variant={size === 'lg' ? 'outline' : 'default'}
                      isActive={size === 'sm'}
                      onClick={() => setEvent(size)}
                    >
                      <File />
                      <span>{size} synthetic item</span>
                    </SidebarMenuButton>
                    {size === 'default' && (
                      <SidebarMenuAction aria-label="Synthetic actions">
                        <MoreHorizontal />
                      </SidebarMenuAction>
                    )}
                  </SidebarMenuItem>
                ))}
                <SidebarMenuItem>
                  <SidebarMenuButton data-case="disabled" disabled>
                    Disabled item
                  </SidebarMenuButton>
                  <SidebarMenuButton data-case="aria-disabled" aria-disabled="true">
                    ARIA disabled item
                  </SidebarMenuButton>
                  <SidebarMenuButton data-case="empty-class" className="">
                    Empty caller class
                  </SidebarMenuButton>
                  <SidebarMenuButton data-case="tooltip" tooltip="Synthetic tooltip">
                    Tooltip item
                  </SidebarMenuButton>
                  <SidebarMenuButton
                    data-case="opaque"
                    className={stylex.props(styles.opaque).className}
                  >
                    Opaque caller
                  </SidebarMenuButton>
                  <SidebarMenuButton
                    data-case="tw-caller"
                    className="block h-10 w-20 gap-1 rounded-none p-0 text-right"
                  >
                    Utility caller
                  </SidebarMenuButton>
                  <SidebarMenuButton
                    data-case="inline"
                    style={{ width: 91, height: 45, padding: 3 }}
                  >
                    Inline caller
                  </SidebarMenuButton>
                  <SidebarMenuButton data-case="slot-tw" asChild>
                    <a href="#sidebar-slot" className="block h-10 w-20 gap-1 rounded-none p-0">
                      Slot utility child
                    </a>
                  </SidebarMenuButton>
                  <SidebarMenuButton data-case="slot-opaque" asChild>
                    <a href="#sidebar-opaque" {...stylex.props(styles.opaque)}>
                      Slot opaque child
                    </a>
                  </SidebarMenuButton>
                  <SidebarMenuButton data-case="slot-inline" asChild>
                    <a href="#sidebar-inline" style={{ width: 91, height: 45, padding: 3 }}>
                      Slot inline child
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <SidebarInset>
          <main {...stylex.props(styles.main)}>
            <Controls onExternal={setExternal} />
            <output data-sidebar-button-event>{event}</output>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedLegacySidebarButton',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Natural: Story = { args: { mode: 'natural' } };
export const Wildcard: Story = { args: { mode: 'wildcard' } };
export const Targeted: Story = { args: { mode: 'targeted' } };
export const Scoped: Story = { args: { mode: 'scoped' } };
