import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { File } from 'lucide-react';
import {
  Sidebar,
  SidebarProvider,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
} from '@/ui/sidebar';
const storyCallerStyles = stylex.create({
  enabledOverride: {
    'pointer-events': 'auto',
    opacity: '100%',
  },
  wildcardEnabled: {
    ':is(*) *': {
      'pointer-events': 'auto',
      opacity: '100%',
    },
  },
  targetedEnabled: {
    ':is(*) [data-state-part]': {
      'pointer-events': 'auto',
      opacity: '100%',
    },
  },
  lowDefaults: {
    ':is(*) :where([data-state-part])': {
      'pointer-events': 'auto',
      opacity: '100%',
    },
  },
});

const storyLayout = stylex.create({
  element: {
    pointerEvents: { default: 'auto', ':disabled': 'auto' },
    opacity: { default: 1, ':disabled': 1 },
  },
});

const styles = stylex.create({
  outer: { padding: 16 },
  opaque: { opacity: 1, pointerEvents: 'auto' },
  output: { display: 'block', marginBlock: 12 },
});
const ref = (node: HTMLElement | null) => {
  if (node) node.dataset.stateRefTag = node.tagName;
};
function Fixture({ mode = 'natural' }: { mode?: string }) {
  const [events, setEvents] = useState<string[]>([]);
  const caller =
    mode === 'opaque'
      ? styles.opaque
      : mode === 'utility'
        ? storyCallerStyles.enabledOverride
        : undefined;
  const ancestor =
    mode === 'wildcard'
      ? stylex.props(storyCallerStyles.wildcardEnabled).className
      : mode === 'targeted'
        ? stylex.props(storyCallerStyles.targetedEnabled).className
        : mode === 'where'
          ? stylex.props(storyCallerStyles.lowDefaults).className
          : undefined;
  const common = { xstyle: caller, ref };
  const event = (name: string) => () => setEvents((old) => [...old, name]);
  return (
    <div
      data-state-fixture={mode}
      className={[stylex.props(styles.outer).className, ancestor].filter(Boolean).join(' ')}
    >
      <output
        data-state-events={events.length}
        data-state-last={events.at(-1) ?? 'none'}
        {...stylex.props(styles.output)}
      >
        Events: {events.length}
      </output>
      <SidebarProvider>
        <Sidebar collapsible="none">
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      data-state-part="enabled"
                      onClick={event('enabled')}
                      {...common}
                    >
                      <File />
                      <span>Enabled button</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      data-state-part="native-disabled"
                      disabled
                      onClick={event('native-disabled')}
                      {...common}
                    >
                      <File />
                      <span>Disabled button</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      data-state-part="aria-button"
                      aria-disabled
                      onClick={event('aria-button')}
                      {...common}
                    >
                      <File />
                      <span>ARIA disabled button</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      data-state-part="aria-false"
                      aria-disabled={false}
                      onClick={event('aria-false')}
                      {...common}
                    >
                      <File />
                      <span>ARIA false button</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild {...common} xstyle={[caller, storyLayout.element]}>
                      <button
                        type="button"
                        data-state-part="slot-disabled"
                        disabled
                        onClick={event('slot-disabled')}
                      >
                        <File />
                        <span>Actual disabled Slot child</span>
                      </button>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuSub>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton
                          data-state-part="aria-anchor"
                          aria-disabled
                          href="#sidebar-state-aria"
                          onClick={(e) => {
                            e.preventDefault();
                            event('aria-anchor')();
                          }}
                          {...common}
                        >
                          <File />
                          <span>ARIA disabled anchor</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton
                          data-state-part="aria-anchor-false"
                          aria-disabled={false}
                          href="#sidebar-state-false"
                          onClick={(e) => {
                            e.preventDefault();
                            event('aria-anchor-false')();
                          }}
                          {...common}
                        >
                          <File />
                          <span>ARIA false anchor</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton
                          data-state-part="aria-anchor-absent"
                          href="#sidebar-state-empty"
                          onClick={(e) => {
                            e.preventDefault();
                            event('aria-anchor-empty')();
                          }}
                          {...common}
                        >
                          <File />
                          <span>Absent ARIA anchor</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton
                          asChild
                          {...common}
                          xstyle={[caller, storyLayout.element]}
                        >
                          <button
                            type="button"
                            data-state-part="sub-slot-disabled"
                            disabled
                            onClick={event('sub-slot-disabled')}
                          >
                            <File />
                            <span>Disabled SubButton Slot child</span>
                          </button>
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
  title: 'Migration/OwnedLegacySidebarDisabled',
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

export const Where: Story = { args: { mode: 'where' } };
