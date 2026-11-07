import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { File } from 'lucide-react';
import {
  Sidebar,
  SidebarProvider,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
} from '@/ui/sidebar';
const storyCallerStyles = stylex.create({
  typographyOverride: {
    fontSize: 'var(--text-lg)',
    lineHeight: 'calc(var(--spacing) * 10)',
  },
  wildcard: {
    ':is(*) *': {
      fontSize: 'var(--text-lg)',
      lineHeight: 'calc(var(--spacing) * 10)',
    },
  },
  lowDefaults: {
    ':is(*) :where([data-type-part])': {
      fontSize: 'var(--text-lg)',
      lineHeight: 'calc(var(--spacing) * 10)',
    },
  },
});

type FontVars = CSSProperties & {
  '--text-sm'?: string;
  '--text-xs'?: string;
  '--text-sm--line-height'?: string;
  '--text-xs--line-height'?: string;
};
const vars: FontVars = {
  '--text-sm': '17px',
  '--text-xs': '11.5px',
  '--text-sm--line-height': '1.7',
  '--text-xs--line-height': '1.6',
};
const styles = stylex.create({
  outer: { padding: 16 },
  opaque: { fontSize: 24, lineHeight: '33px' },
  controls: { display: 'flex', gap: 8, marginBlock: 12 },
});
const stamp = (node: HTMLElement | null) => {
  if (node) node.dataset.typeRefTag = node.tagName;
};
const cases = [
  { key: 'default', size: 'default', variant: 'default' },
  { key: 'small', size: 'sm', variant: 'default' },
  { key: 'large', size: 'lg', variant: 'default' },
  { key: 'outline', size: 'default', variant: 'outline' },
  { key: 'null', size: null, variant: null },
  { key: 'disabled', size: 'default', variant: 'default' },
] as const;
function Fixture({ mode = 'natural' }: { mode?: string }) {
  const [active, setActive] = useState(false);
  const caller =
    mode === 'opaque'
      ? styles.opaque
      : mode === 'utility'
        ? storyCallerStyles.typographyOverride
        : undefined;
  const ancestor =
    mode === 'wildcard'
      ? stylex.props(storyCallerStyles.wildcard).className
      : mode === 'where'
        ? stylex.props(storyCallerStyles.lowDefaults).className
        : undefined;
  const local =
    mode === 'local-vars'
      ? vars
      : mode === 'inline'
        ? { fontSize: 19, lineHeight: '37px' }
        : undefined;
  const common = { xstyle: caller, style: local, ref: stamp };
  return (
    <div
      data-type-fixture={mode}
      data-type-active={String(active)}
      className={[stylex.props(styles.outer).className, ancestor].filter(Boolean).join(' ')}
      style={mode === 'ancestor-vars' ? vars : undefined}
    >
      <div {...stylex.props(styles.controls)}>
        <button type="button" data-type-toggle onClick={() => setActive((value) => !value)}>
          Toggle real active prop
        </button>
        <output>{active ? 'Active' : 'Inactive'}</output>
      </div>
      <SidebarProvider>
        <Sidebar collapsible="none">
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel data-type-part="label" {...common}>
                Synthetic label Mjgy012
              </SidebarGroupLabel>
              <SidebarGroupLabel asChild data-type-part="label-slot" {...common}>
                <span className={stylex.props(storyCallerStyles.typographyOverride).className}>
                  Actual Slot label
                </span>
              </SidebarGroupLabel>
              <SidebarGroupContent data-type-part="group-content" {...common}>
                <SidebarMenu>
                  {cases.map((item) => (
                    <SidebarMenuItem key={item.key}>
                      <SidebarMenuButton
                        data-type-part={'button-' + item.key}
                        size={item.size}
                        variant={item.variant}
                        disabled={item.key === 'disabled'}
                        isActive={active || item.key === 'small'}
                        {...common}
                      >
                        <File />
                        <span>{item.key} Mjgy012</span>
                      </SidebarMenuButton>
                      {item.key === 'default' && (
                        <SidebarMenuBadge data-type-part="badge" {...common}>
                          123
                        </SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  ))}
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild data-type-part="button-slot" {...common}>
                      <button
                        type="button"
                        className={stylex.props(storyCallerStyles.typographyOverride).className}
                      >
                        <File />
                        <span>Actual Slot button</span>
                      </button>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuSub>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton
                          data-type-part="sub-medium"
                          size="md"
                          href="#sidebar-type-medium"
                          onClick={(e) => e.preventDefault()}
                          isActive={active}
                          {...common}
                        >
                          <File />
                          <span>Medium Mjgy012</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton
                          data-type-part="sub-small"
                          size="sm"
                          href="#sidebar-type-small"
                          onClick={(e) => e.preventDefault()}
                          isActive={active}
                          {...common}
                        >
                          <File />
                          <span>Small Mjgy012</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild data-type-part="sub-slot" {...common}>
                          <a
                            href="#sidebar-type-slot"
                            className={stylex.props(storyCallerStyles.typographyOverride).className}
                            onClick={(e) => e.preventDefault()}
                          >
                            <File />
                            <span>Actual Slot anchor</span>
                          </a>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>
    </div>
  );
}
const meta = {
  title: 'Migration/OwnedLegacySidebarTypography',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Natural: Story = { args: { mode: 'natural' } };
export const Opaque: Story = { args: { mode: 'opaque' } };
export const Utility: Story = { args: { mode: 'utility' } };
export const Wildcard: Story = { args: { mode: 'wildcard' } };
export const Where: Story = { args: { mode: 'where' } };
export const AncestorVars: Story = { args: { mode: 'ancestor-vars' } };
export const LocalVars: Story = { args: { mode: 'local-vars' } };
export const Inline: Story = { args: { mode: 'inline' } };
