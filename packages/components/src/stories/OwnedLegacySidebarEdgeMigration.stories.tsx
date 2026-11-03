import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { File } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarProvider,
  SidebarRail,
  useSidebar,
} from '@/ui/sidebar';
const styles = stylex.create({
  outer: { position: 'relative' },
  content: { padding: 16 },
  controls: { display: 'flex', gap: 8 },
  opaque: {
    position: 'relative',
    width: 73,
    zIndex: 37,
    marginInline: 19,
    padding: 7,
    gap: 11,
    flexDirection: 'row',
  },
});
const ref = (node: HTMLElement | null) => {
  if (node) node.dataset.edgeRefTag = node.tagName;
};
function Controls({ onExternal }: { onExternal: (value: string) => void }) {
  const { state, isMobile, openMobile, toggleSidebar } = useSidebar();
  return (
    <>
      <output
        data-edge-state={state}
        data-edge-mobile={String(isMobile)}
        data-edge-open={String(openMobile)}
      >
        {state}
      </output>
      <div {...stylex.props(styles.controls)}>
        <button type="button" data-edge-toggle onClick={toggleSidebar}>
          Toggle synthetic edge
        </button>
        {['none', 'icon', 'offcanvas'].map((value) => (
          <button
            key={value}
            type="button"
            data-edge-external={value}
            onClick={() => onExternal(value)}
          >
            Outer {value}
          </button>
        ))}
      </div>
    </>
  );
}
function Fixture({ mode = 'natural', none = false }: { mode?: string; none?: boolean }) {
  const [external, setExternal] = useState('none');
  const scoped = mode === 'scoped',
    vertical = mode === 'vertical';
  const caller =
    mode === 'opaque'
      ? stylex.props(styles.opaque).className
      : mode === 'utility'
        ? 'relative w-9 z-0 mx-1 flex-row gap-3 px-1 py-1'
        : undefined;
  const ancestor =
    mode === 'wildcard'
      ? '[&_*]:w-7 [&_*]:min-w-0 [&_*]:relative [&_*]:z-0 [&_*]:gap-3 [&_*]:px-1 [&_*]:py-1 [&_*]:mx-1'
      : mode === 'targeted'
        ? '[&_[data-edge-part]]:w-7 [&_[data-edge-part]]:min-w-0 [&_[data-edge-part]]:relative [&_[data-edge-part]]:z-0 [&_[data-edge-part]]:gap-3 [&_[data-edge-part]]:px-1 [&_[data-edge-part]]:py-1 [&_[data-edge-part]]:mx-1'
        : undefined;
  return (
    <div
      data-edge-fixture={mode}
      className={['group', stylex.props(styles.outer).className, ancestor]
        .filter(Boolean)
        .join(' ')}
      data-side={scoped ? 'right' : 'left'}
      data-collapsible={external === 'none' ? undefined : external}
      dir={scoped || vertical ? 'rtl' : undefined}
      style={vertical ? { writingMode: 'vertical-rl' } : undefined}
    >
      <SidebarProvider
        style={
          scoped
            ? ({
                '--spacing': '6px',
                '--sidebar-width': '13rem',
                '--sidebar-width-icon': '4rem',
              } as CSSProperties)
            : undefined
        }
      >
        <Sidebar collapsible={none ? 'none' : 'icon'} side={scoped ? 'right' : 'left'}>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuSub data-edge-part="sub" className={caller} ref={ref}>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton
                          href="#sidebar-edge-native"
                          onClick={(event) => event.preventDefault()}
                        >
                          <File />
                          <span>Native synthetic child</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <a
                            data-edge-slot
                            href="#sidebar-edge-slot"
                            onClick={(event) => event.preventDefault()}
                          >
                            <File />
                            <span>Actual Slot child</span>
                          </a>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarRail data-edge-part="rail" className={caller} ref={ref} />
        </Sidebar>
        <SidebarInset>
          <div {...stylex.props(styles.content)}>
            <Controls onExternal={setExternal} />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
const meta = {
  title: 'Migration/OwnedLegacySidebarEdge',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Natural: Story = { args: { mode: 'natural' } };
export const NaturalNone: Story = { args: { mode: 'natural', none: true } };
export const Opaque: Story = { args: { mode: 'opaque' } };
export const Utility: Story = { args: { mode: 'utility' } };
export const Wildcard: Story = { args: { mode: 'wildcard' } };
export const Targeted: Story = { args: { mode: 'targeted' } };
export const Scoped: Story = { args: { mode: 'scoped' } };
export const Vertical: Story = { args: { mode: 'vertical' } };
