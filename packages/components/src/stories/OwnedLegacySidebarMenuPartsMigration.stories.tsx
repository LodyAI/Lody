import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { File, MoreHorizontal, Plus } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarInset,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  useSidebar,
} from '@/ui/sidebar';

const styles = stylex.create({
  outer: { display: 'contents' },
  main: { padding: 16, minWidth: 0 },
  controls: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBlock: 16 },
  opaquePaint: {
    color: '#d13f22',
    backgroundColor: '#f5d76e',
    padding: 11,
    justifyContent: 'flex-end',
    aspectRatio: 'auto',
    pointerEvents: 'auto',
  },
  opaque: {
    display: 'grid',
    position: 'relative',
    top: 0,
    right: 0,
    width: 43,
    height: 41,
    minWidth: 37,
    padding: 9,
    gap: 13,
    borderRadius: 17,
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    flexShrink: 1,
    aspectRatio: 'auto',
    pointerEvents: 'auto',
  },
});

const paintPalette = {
  '--sidebar-background': '215 35% 28%',
  '--sidebar-foreground': '38 85% 72%',
  '--background': '198 45% 90%',
  '--input-field': '188 42% 76%',
} as CSSProperties;
const paintSubtree = {
  '--sidebar-background': '282 24% 29%',
  '--sidebar-foreground': '141 72% 31%',
  '--background': '42 74% 87%',
  '--input-field': '36 78% 79%',
} as CSSProperties;

const scopedStyle: CSSProperties & { '--spacing': string; '--radius-md': string } = {
  '--spacing': '6px',
  '--radius-md': '13px',
};
const stampRef = (node: HTMLElement | null) => {
  if (node) node.dataset.menuRefTag = node.tagName;
};

function Controls({
  onExternal,
  onActive,
  onOpen,
}: {
  onExternal: (value: string) => void;
  onActive: () => void;
  onOpen: () => void;
}) {
  const { state, isMobile, openMobile, toggleSidebar } = useSidebar();
  return (
    <>
      <output
        data-sidebar-menu-state={state}
        data-sidebar-menu-mobile={String(isMobile)}
        data-sidebar-menu-open={String(openMobile)}
      >
        {state}
      </output>
      <div {...stylex.props(styles.controls)}>
        <button type="button" data-sidebar-menu-toggle onClick={toggleSidebar}>
          Toggle synthetic menu
        </button>
        {['none', 'icon', 'offcanvas'].map((value) => (
          <button
            type="button"
            key={value}
            data-sidebar-menu-external={value}
            onClick={() => onExternal(value)}
          >
            Outer {value}
          </button>
        ))}
        <button type="button" data-sidebar-menu-control="active" onClick={onActive}>
          Toggle active item
        </button>
        <button type="button" data-sidebar-menu-control="open" onClick={onOpen}>
          Toggle action state
        </button>
      </div>
    </>
  );
}

function Fixture({ mode = 'natural' }: { mode?: string }) {
  const [external, setExternal] = useState('none');
  const [active, setActive] = useState(false);
  const [open, setOpen] = useState(false);
  const [event, setEvent] = useState('Ready');
  const paint = mode.startsWith('paint-');
  const caller =
    mode === 'paint-opaque'
      ? stylex.props(styles.opaquePaint).className
      : mode === 'paint-named'
        ? 'bg-transparent text-red-500 p-2 justify-end aspect-auto pointer-events-auto'
        : mode === 'paint-arbitrary'
          ? '[background-color:rgb(241,203,171)] [color:rgb(17,93,41)] [padding:9px] [justify-content:flex-end] [aspect-ratio:auto] [pointer-events:auto]'
          : mode === 'opaque'
            ? stylex.props(styles.opaque).className
            : mode === 'utility'
              ? 'relative top-0 right-0 block aspect-auto h-10 w-10 min-w-10 items-end justify-end gap-4 rounded-none p-0'
              : undefined;
  const local =
    mode === 'paint-subtree'
      ? paintSubtree
      : mode === 'paint-spacing-initial'
        ? ({ '--spacing': 'initial' } as CSSProperties)
        : mode === 'scoped'
          ? scopedStyle
          : undefined;
  const rootClass =
    mode === 'paint-zero'
      ? '[:where(&)_:where([data-menu-part])]:bg-red-500 [:where(&)_:where([data-menu-part])]:text-yellow-500 [:where(&)_:where([data-menu-part])]:p-2 [:where(&)_:where([data-menu-part])]:justify-end [:where(&)_:where([data-menu-part])]:aspect-auto [:where(&)_:where([data-menu-part])]:pointer-events-auto'
      : mode === 'wildcard'
        ? '[&_*]:w-7 [&_*]:p-0 [&_*]:gap-1 [&_*]:rounded-none'
        : mode === 'targeted'
          ? '[&_[data-menu-part]]:w-7 [&_[data-menu-part]]:h-10 [&_[data-menu-part]]:min-w-10 [&_[data-menu-part]]:p-0 [&_[data-menu-part]]:gap-1 [&_[data-menu-part]]:rounded-none [&_[data-menu-part]]:top-0 [&_[data-menu-part]]:right-0'
          : undefined;
  const common = { className: caller, style: local, ref: stampRef };
  return (
    <div
      data-sidebar-menu-fixture={mode}
      className={['group', stylex.props(styles.outer).className].join(' ')}
      data-collapsible={external === 'none' ? undefined : external}
      data-menu-active={String(active)}
      data-menu-action-open={String(open)}
      dir={mode === 'scoped' ? 'rtl' : undefined}
    >
      <SidebarProvider
        className={rootClass}
        style={mode === 'paint-palette' ? paintPalette : undefined}
      >
        <Sidebar
          collapsible="icon"
          className={paint ? caller : undefined}
          style={paint ? local : undefined}
        >
          <SidebarContent>
            <SidebarGroup>
              {paint && (
                <SidebarInput
                  data-menu-part="input-paint"
                  aria-label="Synthetic paint input"
                  placeholder="Synthetic paint input"
                  {...common}
                  onChange={(e) => setEvent('Input: ' + e.currentTarget.value)}
                />
              )}
              <SidebarGroupLabel data-menu-part="label-native" {...common}>
                <File /> Native group
              </SidebarGroupLabel>
              <SidebarGroupAction
                data-menu-part="group-action-native"
                aria-label="Native group action"
                onClick={() => setEvent('Native group')}
                {...common}
              >
                <Plus />
              </SidebarGroupAction>
              <SidebarMenu>
                {(['default', 'sm', 'lg'] as const).flatMap((size) => [
                  <SidebarMenuItem key={size + '-action'} data-menu-row={'action-' + size}>
                    <SidebarMenuButton
                      data-menu-button={size}
                      size={size}
                      isActive={active || size === 'sm'}
                    >
                      <File /> <span>{size} action row</span>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      data-menu-part={'menu-action-' + size}
                      showOnHover
                      data-state={open ? 'open' : undefined}
                      aria-label={size + ' native action'}
                      onClick={() => setEvent(size + ' action')}
                      {...common}
                    >
                      <MoreHorizontal />
                    </SidebarMenuAction>
                  </SidebarMenuItem>,
                  <SidebarMenuItem key={size + '-badge'}>
                    <SidebarMenuButton size={size} isActive={active || size === 'sm'}>
                      <File /> <span>{size} badge row</span>
                    </SidebarMenuButton>
                    <SidebarMenuBadge data-menu-part={'badge-' + size} {...common}>
                      3
                    </SidebarMenuBadge>
                  </SidebarMenuItem>,
                ])}
                <SidebarMenuItem>
                  <SidebarMenuSub>
                    {(['sm', 'md'] as const).map((size) => (
                      <SidebarMenuSubItem key={size}>
                        <SidebarMenuSubButton
                          data-menu-part={'sub-' + size}
                          size={size}
                          isActive={active || size === 'sm'}
                          href="#sidebar-menu-sub"
                          onClick={(e) => e.preventDefault()}
                          {...common}
                        >
                          <File /> <span>{size} child row</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel data-menu-part="label-slot" asChild {...common}>
                <span data-menu-slot-child className="block h-4 rounded-none px-0">
                  <File /> Slot group
                </span>
              </SidebarGroupLabel>
              <SidebarGroupAction
                data-menu-part="group-action-slot"
                asChild
                aria-label="Slot group action"
                {...common}
              >
                <a
                  data-menu-slot-child
                  href="#sidebar-menu-group"
                  className="relative top-0 right-0 block aspect-auto w-4 rounded-none p-2"
                  onClick={(e) => e.preventDefault()}
                >
                  <Plus />
                </a>
              </SidebarGroupAction>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive={active}>Slot action row</SidebarMenuButton>
                  <SidebarMenuAction
                    data-menu-part="menu-action-slot"
                    asChild
                    showOnHover
                    data-state={open ? 'open' : undefined}
                    aria-label="Slot menu action"
                    {...common}
                  >
                    <a
                      data-menu-slot-child
                      href="#sidebar-menu-action"
                      className="relative top-0 right-0 block aspect-auto w-4 rounded-none p-2"
                      onClick={(e) => e.preventDefault()}
                    >
                      <MoreHorizontal />
                    </a>
                  </SidebarMenuAction>
                  <SidebarMenuBadge
                    data-menu-part="badge-inline"
                    style={{ height: 39, minWidth: 19, padding: 3, pointerEvents: 'auto' }}
                    ref={stampRef}
                  >
                    7
                  </SidebarMenuBadge>
                  <SidebarMenuSub>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton data-menu-part="sub-slot" asChild {...common}>
                        <a
                          data-menu-last-slot
                          data-menu-slot-child
                          href="#sidebar-menu-slot"
                          className="block h-4 min-w-10 gap-4 overflow-visible rounded-none px-0"
                          onClick={(e) => {
                            e.preventDefault();
                            setEvent('Slot child');
                          }}
                        >
                          <File /> <span>Slot child row</span>
                        </a>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  </SidebarMenuSub>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <SidebarInset
          data-menu-part={paint ? 'inset-paint' : undefined}
          className={paint ? caller : undefined}
          style={paint ? local : undefined}
        >
          <main {...stylex.props(styles.main)}>
            <Controls
              onExternal={setExternal}
              onActive={() => setActive((value) => !value)}
              onOpen={() => setOpen((value) => !value)}
            />
            <output data-sidebar-menu-event>{event}</output>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedLegacySidebarMenuParts',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Natural: Story = { args: { mode: 'natural' } };
export const Opaque: Story = { args: { mode: 'opaque' } };
export const Utility: Story = { args: { mode: 'utility' } };
export const Wildcard: Story = { args: { mode: 'wildcard' } };
export const Targeted: Story = { args: { mode: 'targeted' } };
export const Scoped: Story = { args: { mode: 'scoped' } };

export const PaintPalette: Story = { args: { mode: 'paint-palette' } };

export const PaintSubtree: Story = { args: { mode: 'paint-subtree' } };

export const PaintNamed: Story = { args: { mode: 'paint-named' } };

export const PaintArbitrary: Story = { args: { mode: 'paint-arbitrary' } };

export const PaintZero: Story = { args: { mode: 'paint-zero' } };

export const PaintOpaque: Story = { args: { mode: 'paint-opaque' } };

export const PaintSpacingInitial: Story = { args: { mode: 'paint-spacing-initial' } };
