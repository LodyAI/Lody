import { colors as uiColors } from '@lody/ui/tokens/colors.stylex';
import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import {
  SidebarFilterPopover,
  type SidebarFilterMember,
} from '@/components/sidebar-filter-popover';
import { toggleTaskOwnerSelection } from '@/lib/session-visibility';
import { SidebarOwnerFilterBar } from '@/components/sidebar-owner-filter';
import type { SidebarChatScope, SidebarOrganizeMode } from '@/atoms/sidebar-state';
const storyLayoutStyles = stylex.create({
  caption: {
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    letterSpacing: 'var(--tracking-wide)',
    color: 'color-mix(in oklab, hsl(var(--sidebar-foreground-muted) / 1) 70%, transparent)',
    textTransform: 'uppercase',
  },
  canvas: {
    borderRadius: 'var(--radius-lg)',
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: 'color-mix(in oklab, hsl(var(--sidebar-border) / 1) 60%, transparent)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--background) / 1) 40%, transparent)',
    padding: 'calc(var(--spacing) * 3)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
  },
  label: {
    fontWeight: 'var(--font-weight-medium)',
  },
  caption2: {
    marginTop: 'calc(var(--spacing) * 3)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: 'hsl(var(--sidebar-foreground-muted) / 1)',
  },
});

const storyLayout = stylex.create({
  row: {
    display: 'flex',
    'min-height': '260px',
    'align-items': 'flex-end',
    gap: 'calc(var(--spacing) * 6)',
    'border-radius': 'var(--radius-2xl)',
    'background-color': 'hsl(var(--sidebar-background) / 1)',
    padding: 'calc(var(--spacing) * 6)',
    color: 'hsl(var(--sidebar-foreground) / 1)',
  },
  stack: {
    display: 'flex',
    flex: '1',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 2)',
  },
  label: {
    color: 'hsl(var(--sidebar-foreground-muted) / 1)',
  },
  section: {
    'margin-top': 'calc(var(--spacing) * 1)',
  },
  row2: {
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'flex-end',
  },
});

function FilterShell({
  organize: organizeArg,
  scope: scopeArg,
  defaultOpen,
  ownerOpen: ownerOpenArg,
  members,
  memberIds: memberIdsArg = [],
}: {
  organize: SidebarOrganizeMode;
  scope: SidebarChatScope;
  defaultOpen?: boolean;
  /** Open the Owner list with the menu. */
  ownerOpen?: boolean;
  members?: SidebarFilterMember[];
  memberIds?: string[];
}) {
  const [organize, setOrganize] = useState<SidebarOrganizeMode>(organizeArg);
  const [selection, setSelection] = useState<{
    scope: SidebarChatScope;
    memberIds: readonly string[];
  }>({ scope: scopeArg, memberIds: memberIdsArg });
  const scope = selection.scope;
  const setScope = (next: SidebarChatScope) => setSelection({ scope: next, memberIds: [] });
  const [open, setOpen] = useState(!!defaultOpen);
  const [ownerOpen, setOwnerOpen] = useState(!!ownerOpenArg);
  const currentUserId = members?.find((member) => member.isCurrentUser)?.userId;
  const [showUpdatedProjectNames, setShowUpdatedProjectNames] = useState(true);
  const [showBranchNames, setShowBranchNames] = useState(false);
  const [hideEmptyProjects, setHideEmptyProjects] = useState(true);

  return (
    <div {...stylex.props(storyLayout.row)}>
      <div {...stylex.props(storyLayout.stack)}>
        <div {...stylex.props(storyLayoutStyles.caption)}>State</div>
        <div {...stylex.props(storyLayoutStyles.canvas)}>
          <div>
            <span {...stylex.props(storyLayout.label)}>Organize:</span>{' '}
            <span {...stylex.props(storyLayoutStyles.label)}>{organize}</span>
          </div>
          <div {...stylex.props(storyLayout.section)}>
            <span {...stylex.props(storyLayout.label)}>Scope:</span>{' '}
            <span {...stylex.props(storyLayoutStyles.label)}>
              {scope}
              {selection.memberIds.length > 0 ? ` · ${selection.memberIds.join(', ')}` : ''}
            </span>
          </div>
          <div {...stylex.props(storyLayout.section)}>
            <span {...stylex.props(storyLayout.label)}>Project line:</span>{' '}
            <span {...stylex.props(storyLayoutStyles.label)}>
              {showUpdatedProjectNames ? 'on' : 'off'}
            </span>
          </div>
          <div {...stylex.props(storyLayout.section)}>
            <span {...stylex.props(storyLayout.label)}>Branch line:</span>{' '}
            <span {...stylex.props(storyLayoutStyles.label)}>{showBranchNames ? 'on' : 'off'}</span>
          </div>
          <div {...stylex.props(themeStyles.spaced)}>
            <span {...stylex.props(themeStyles.hint)}>Hide empty projects:</span>{' '}
            <span {...stylex.props(themeStyles.layout)}>{hideEmptyProjects ? 'on' : 'off'}</span>
          </div>
        </div>
        <p {...stylex.props(storyLayoutStyles.caption2)}>
          Click the filter icon to open the popover. Selections update the panel above.
        </p>
      </div>
      <div {...stylex.props(storyLayout.row2)}>
        <SidebarFilterPopover
          organize={organize}
          scope={scope}
          onOrganizeChange={setOrganize}
          onScopeChange={setScope}
          members={members}
          selectedMemberIds={selection.memberIds}
          onToggleMember={(userId) =>
            setSelection((prev) => toggleTaskOwnerSelection(prev, userId, currentUserId))
          }
          open={open}
          onOpenChange={setOpen}
          ownerOpen={ownerOpen}
          onOwnerOpenChange={setOwnerOpen}
          showUpdatedProjectNames={showUpdatedProjectNames}
          onShowUpdatedProjectNamesChange={setShowUpdatedProjectNames}
          showBranchNames={showBranchNames}
          onShowBranchNamesChange={setShowBranchNames}
          hideEmptyProjects={hideEmptyProjects}
          onHideEmptyProjectsChange={setHideEmptyProjects}
          {...(defaultOpen ? { side: 'top', align: 'end' } : null)}
        />
      </div>
    </div>
  );
}

const meta = {
  title: 'Sidebar/SidebarFilterPopover',
  component: FilterShell,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  args: {
    organize: 'workspace',
    scope: 'my',
  },
  argTypes: {
    organize: {
      control: 'inline-radio',
      options: ['workspace', 'updated'],
    },
    scope: {
      control: 'inline-radio',
      options: ['my', 'team'],
    },
  },
} satisfies Meta<typeof FilterShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const UpdatedMode: Story = {
  args: {
    organize: 'updated',
    scope: 'my',
  },
};

export const TeamScope: Story = {
  args: {
    organize: 'workspace',
    scope: 'team',
  },
};

const FIRST = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy'];
const LAST = ['Wang', 'Chen', 'Liu', 'Zhou', 'Lin'];
/** A 50-person workspace: you plus 49 synthetic teammates. */
const teamMembers: SidebarFilterMember[] = [
  { userId: 'u-me', name: 'Sam Lee', isCurrentUser: true },
  ...Array.from({ length: 49 }, (_, index) => ({
    userId: `u-${index}`,
    name: `${FIRST[index % FIRST.length]} ${LAST[Math.floor(index / FIRST.length) % LAST.length]}`,
  })),
];

/** The menu stays three task rows; the Owner row names who is chosen. */
export const OwnerFilterApplied: Story = {
  args: {
    organize: 'status',
    scope: 'team',
    members: teamMembers,
    memberIds: ['u-0', 'u-11', 'u-22'],
    defaultOpen: true,
  },
};

/** The Owner list in a 50-person team: search first, you on top, chosen people next. */
export const OwnerListLargeTeam: Story = {
  args: {
    organize: 'status',
    scope: 'team',
    members: teamMembers,
    memberIds: ['u-0', 'u-11', 'u-22'],
    defaultOpen: true,
    ownerOpen: true,
  },
};

function OwnerBarShell({ memberIds }: { memberIds: string[] }) {
  const [selected, setSelected] = useState<string[]>(memberIds);
  return (
    <div {...stylex.props(barStoryStyles.sidebar)}>
      <SidebarOwnerFilterBar
        members={teamMembers}
        selectedMemberIds={selected}
        onToggleMember={(id) =>
          setSelected((prev) =>
            prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]
          )
        }
        onClear={() => setSelected([])}
      />
    </div>
  );
}

const barStoryStyles = stylex.create({
  sidebar: {
    width: 260,
    paddingBlock: 'calc(var(--spacing) * 3)',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'hsl(var(--sidebar-background) / 1)',
    color: 'hsl(var(--sidebar-foreground) / 1)',
  },
});

/** The applied filter above the sidebar list, as Linear writes it. */
export const OwnerFilterBarOnePerson: StoryObj<typeof OwnerBarShell> = {
  render: () => <OwnerBarShell memberIds={['u-0']} />,
};

export const OwnerFilterBarSeveral: StoryObj<typeof OwnerBarShell> = {
  render: () => <OwnerBarShell memberIds={['u-0', 'u-11', 'u-22', 'u-33']} />,
};

const themeStyles = stylex.create({
  spaced: { marginTop: 'calc(var(--spacing) * 1)' },
  hint: { color: uiColors.secondaryLabel },
  layout: { fontWeight: 500 },
});
