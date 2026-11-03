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
  SidebarMenuButton,
  SidebarMenuBadge,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  useSidebar,
} from '@/ui/sidebar';

const styles = stylex.create({
  outer: { display: 'contents' },
  content: { padding: 16, minWidth: 0 },
  controls: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBlock: 16 },
  opaque: {
    position: 'absolute',
    display: 'grid',
    flexDirection: 'row',
    width: 173,
    height: 47,
    minHeight: 31,
    top: 7,
    right: 9,
    zIndex: 37,
  },
});
const scopedStyle: CSSProperties & {
  '--sidebar-width': string;
  '--sidebar-width-icon': string;
  '--spacing': string;
} = { '--sidebar-width': '13rem', '--sidebar-width-icon': '4rem', '--spacing': '6px' };
const stampRef = (node: HTMLElement | null) => {
  if (node) node.dataset.frameRefTag = node.tagName;
};

function Controls({
  calls,
  controlled,
  onParent,
  onExternal,
}: {
  calls: number;
  controlled: boolean;
  onParent: () => void;
  onExternal: (value: string) => void;
}) {
  const { state, isMobile, openMobile, toggleSidebar } = useSidebar();
  return (
    <>
      <output
        data-frame-state={state}
        data-frame-mobile={String(isMobile)}
        data-frame-open={String(openMobile)}
        data-frame-controlled={String(controlled)}
        data-frame-calls={String(calls)}
      >
        {state}
      </output>
      <div {...stylex.props(styles.controls)}>
        <button type="button" data-frame-toggle onClick={toggleSidebar}>
          Toggle synthetic frame
        </button>
        {['none', 'icon', 'offcanvas'].map((value) => (
          <button
            type="button"
            key={value}
            data-frame-external={value}
            onClick={() => onExternal(value)}
          >
            Outer {value}
          </button>
        ))}
        {controlled && (
          <button type="button" data-frame-parent onClick={onParent}>
            Toggle parent prop
          </button>
        )}
      </div>
    </>
  );
}

function Fixture({ mode = 'natural', none = false }: { mode?: string; none?: boolean }) {
  const [external, setExternal] = useState('none');
  const [open, setOpen] = useState(true);
  const [calls, setCalls] = useState(0);
  const controlled = mode === 'scoped';
  const caller =
    mode === 'opaque'
      ? stylex.props(styles.opaque).className
      : mode === 'utility'
        ? 'relative block h-auto min-h-0 w-40 flex-row'
        : undefined;
  const ancestor =
    mode === 'wildcard'
      ? '[&_*]:w-7 [&_*]:min-h-0 [&_*]:relative [&_*]:z-0'
      : mode === 'targeted'
        ? '[&_[data-frame-part]]:w-7 [&_[data-frame-part]]:min-h-0 [&_[data-frame-part]]:relative [&_[data-frame-part]]:z-0'
        : undefined;
  const common = { className: caller, ref: stampRef };
  return (
    <div
      data-frame-fixture={mode}
      data-frame-none={String(none)}
      className={['group', stylex.props(styles.outer).className, ancestor]
        .filter(Boolean)
        .join(' ')}
      data-collapsible={external === 'none' ? undefined : external}
      dir={controlled ? 'rtl' : undefined}
    >
      <SidebarProvider
        data-frame-part="provider"
        {...common}
        style={controlled ? scopedStyle : undefined}
        open={controlled ? open : undefined}
        onOpenChange={
          controlled
            ? (value) => {
                setOpen(value);
                setCalls((count) => count + 1);
              }
            : undefined
        }
      >
        <Sidebar
          data-frame-part="sidebar"
          collapsible={none ? 'none' : 'icon'}
          variant={controlled ? 'floating' : 'inset'}
          side={controlled ? 'right' : 'left'}
          {...common}
          ref={undefined}
        >
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent data-frame-part="group-content" {...common}>
                <SidebarMenu>
                  <SidebarMenuItem data-frame-part="item" {...common}>
                    <SidebarMenuButton>
                      <File />
                      <span>Synthetic frame item</span>
                    </SidebarMenuButton>
                    <SidebarMenuBadge>2</SidebarMenuBadge>
                    <SidebarMenuSub>
                      <SidebarMenuSubItem data-frame-part="sub-item" {...common}>
                        <SidebarMenuSubButton asChild>
                          <a
                            data-frame-slot
                            href="#sidebar-frame-child"
                            onClick={(e) => e.preventDefault()}
                          >
                            <File />
                            <span>Actual Slot child</span>
                          </a>
                        </SidebarMenuSubButton>
                        <SidebarMenuBadge style={{ top: 0 }}>3</SidebarMenuBadge>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <SidebarInset data-frame-part="inset" {...common}>
          <div {...stylex.props(styles.content)}>
            <Controls
              calls={calls}
              controlled={controlled}
              onParent={() => setOpen((value) => !value)}
              onExternal={setExternal}
            />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedLegacySidebarFrame',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Natural: Story = { args: { mode: 'natural' } };
export const NaturalNone: Story = { args: { mode: 'natural', none: true } };
export const Opaque: Story = { args: { mode: 'opaque' } };
export const OpaqueNone: Story = { args: { mode: 'opaque', none: true } };
export const Utility: Story = { args: { mode: 'utility' } };
export const UtilityNone: Story = { args: { mode: 'utility', none: true } };
export const Wildcard: Story = { args: { mode: 'wildcard' } };
export const WildcardNone: Story = { args: { mode: 'wildcard', none: true } };
export const Targeted: Story = { args: { mode: 'targeted' } };
export const TargetedNone: Story = { args: { mode: 'targeted', none: true } };
export const Scoped: Story = { args: { mode: 'scoped' } };
export const ScopedNone: Story = { args: { mode: 'scoped', none: true } };
