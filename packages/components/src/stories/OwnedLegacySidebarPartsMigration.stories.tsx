import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { File, MoreHorizontal, Plus } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from '@/ui/sidebar';

const styles = stylex.create({
  outer: { display: 'contents' },
  main: { padding: 16, minWidth: 0 },
  controls: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBlock: 12 },
  opaqueHeader: { display: 'grid', flexDirection: 'row', gap: 31, padding: 19 },
  opaqueFooter: { flexDirection: 'row', gap: 31, padding: 19 },
  opaqueButton: { width: 83, height: 43, padding: 17, borderRadius: 19 },
  slotChild: { width: 79, height: 41 },
  opaqueControl: { width: 111, height: 47 },
  opaqueSkeleton: { display: 'grid', height: 53, gap: 17, paddingInline: 19, borderRadius: 21 },
});

function Probe() {
  const { state, isMobile, openMobile } = useSidebar();
  return (
    <output
      data-sidebar-parts-state={state}
      data-sidebar-parts-mobile={String(isMobile)}
      data-sidebar-parts-open={String(openMobile)}
    >
      {state}
    </output>
  );
}

const paintPalette = {
  '--sidebar-background': '215 35% 28%',
  '--sidebar-foreground': '38 85% 72%',
  '--background': '198 45% 90%',
  '--input-field': '188 42% 76%',
} as CSSProperties;

function Fixture({
  opaque = false,
  palette = false,
  ancestorClassName,
}: {
  opaque?: boolean;
  palette?: boolean;
  ancestorClassName?: string;
}) {
  const [external, setExternal] = useState('none');
  const [event, setEvent] = useState('Ready');
  const opaqueClass = opaque ? stylex.props(styles.opaqueButton).className : undefined;
  return (
    <div
      className={['group', stylex.props(styles.outer).className, ancestorClassName]
        .filter(Boolean)
        .join(' ')}
      data-external-sidebar-group
      data-collapsible={external === 'icon' || external === 'offcanvas' ? external : undefined}
      data-variant={external === 'floating' ? 'floating' : undefined}
      data-side={external === 'right' ? 'right' : undefined}
    >
      <SidebarProvider
        data-sidebar-parts-fixture
        style={
          {
            '--sidebar-width': '16rem',
            '--sidebar-width-icon': '3rem',
            ...(palette ? paintPalette : {}),
          } as CSSProperties
        }
      >
        <Sidebar collapsible="icon">
          <SidebarHeader
            className={opaque ? stylex.props(styles.opaqueHeader).className : undefined}
          >
            <SidebarTrigger aria-label="Toggle parts sidebar" />
            <SidebarInput aria-label="Find synthetic item" placeholder="Find synthetic item" />
          </SidebarHeader>
          <SidebarSeparator />
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Synthetic files</SidebarGroupLabel>
              <SidebarGroupAction
                aria-label="Add synthetic group"
                onClick={() => setEvent('Group added')}
              >
                <Plus />
              </SidebarGroupAction>
              <SidebarGroupContent>
                <SidebarMenu>
                  {(['default', 'sm', 'lg'] as const).map((size) => (
                    <SidebarMenuItem key={size}>
                      <SidebarMenuButton
                        size={size}
                        isActive={size === 'sm'}
                        variant={size === 'lg' ? 'outline' : 'default'}
                        className={opaqueClass}
                        onClick={() => setEvent(size)}
                      >
                        <File />
                        <span>{size} synthetic item</span>
                      </SidebarMenuButton>
                      <SidebarMenuAction
                        aria-label={`Actions ${size}`}
                        showOnHover
                        onClick={() => setEvent(`Action ${size}`)}
                      >
                        <MoreHorizontal />
                      </SidebarMenuAction>
                      <SidebarMenuBadge>3</SidebarMenuBadge>
                    </SidebarMenuItem>
                  ))}
                  <SidebarMenuItem>
                    <SidebarMenuButton disabled>
                      <File />
                      <span>Disabled item</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild xstyle={opaque ? styles.slotChild : undefined}>
                      <a href="#synthetic-slot" onClick={(e) => e.preventDefault()}>
                        <File />
                        <span>Slot item</span>
                      </a>
                    </SidebarMenuButton>
                    <SidebarMenuSub>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton
                          href="#synthetic-child"
                          onClick={(e) => e.preventDefault()}
                          isActive
                        >
                          <File />
                          <span>Child item</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton
                          href="#synthetic-small"
                          onClick={(e) => e.preventDefault()}
                          size="sm"
                        >
                          <span>Small child</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter
            className={opaque ? stylex.props(styles.opaqueFooter).className : undefined}
          >
            Synthetic footer
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <div {...stylex.props(styles.main)}>
            <SidebarTrigger aria-label="Toggle parts from content" />
            <Probe />
            <div {...stylex.props(styles.controls)}>
              {['none', 'icon', 'offcanvas', 'floating', 'right'].map((value) => (
                <Button
                  key={value}
                  type="button"
                  data-external-sidebar-control={value}
                  onClick={() => setExternal(value)}
                >
                  {value}
                </Button>
              ))}
            </div>
            <output data-sidebar-parts-event>{event}</output>
            <p>
              The external generic group intentionally has no StyleX marker. Skeleton random-width
              states are outside this fixture.
            </p>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedLegacySidebarParts',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = { render: () => <Fixture /> };
export const OpaqueCallers: Story = { render: () => <Fixture opaque /> };

// These legal zero-specificity callers must not overturn the parts' own utilities.
export const ZeroSpecificityHeaderGap: Story = {
  render: () => <Fixture ancestorClassName="[:where(&)_:where([data-sidebar=header])]:gap-12" />,
};
export const ZeroSpecificityMenuWidth: Story = {
  render: () => <Fixture ancestorClassName="[:where(&)_:where([data-sidebar=menu-button])]:w-7" />,
};
export const ZeroSpecificityLabelHeight: Story = {
  render: () => <Fixture ancestorClassName="[:where(&)_:where([data-sidebar=group-label])]:h-12" />,
};

export const Palette: Story = { render: () => <Fixture palette /> };

function InputSkeletonFixture() {
  const [mounted, setMounted] = useState(false);
  const [event, setEvent] = useState('Ready');
  return (
    <SidebarProvider
      data-input-skeleton-fixture
      style={{ '--sidebar-width': '20rem', '--sidebar-width-icon': '3rem' } as CSSProperties}
    >
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarTrigger aria-label="Toggle input skeleton sidebar" />
          <SidebarInput
            aria-label="Plain synthetic input"
            placeholder="Plain input"
            onChange={(e) => setEvent('Input: ' + e.currentTarget.value)}
          />
          <SidebarInput
            aria-label="Leading caller synthetic input"
            placeholder="Leading input"
            leading={<File />}
            className="h-12 w-40"
          />
          <SidebarInput
            aria-label="Disabled opaque synthetic input"
            placeholder="Disabled input"
            disabled
            className={stylex.props(styles.opaqueControl).className}
          />
          <Button type="button" onClick={() => setMounted(true)} disabled={mounted}>
            Mount synthetic skeletons
          </Button>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Real Sidebar skeleton components</SidebarGroupLabel>
            <SidebarMenu>
              {mounted && (
                <>
                  <SidebarMenuItem>
                    <SidebarMenuSkeleton data-input-skeleton="plain" showIcon />
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuSkeleton
                      data-input-skeleton="utility"
                      className="grid h-12 gap-4 rounded-none px-5"
                    />
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuSkeleton
                      data-input-skeleton="opaque"
                      showIcon
                      className={stylex.props(styles.opaqueSkeleton).className}
                    />
                  </SidebarMenuItem>
                </>
              )}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <div {...stylex.props(styles.main)}>
          <SidebarTrigger aria-label="Open input skeleton sidebar" />
          <Probe />
          <output data-input-skeleton-event>{event}</output>
          <p>
            Skeleton widths use the component's real mount-time random input. The visual driver
            records its explicit synthetic input and restores the original random function
            immediately after mount.
          </p>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export const InputAndSkeleton: Story = { render: () => <InputSkeletonFixture /> };
