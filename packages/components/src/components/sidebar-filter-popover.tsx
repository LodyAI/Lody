import { type ReactElement, type ReactNode, useId, useState } from 'react';
import {
  Check,
  ChevronRight,
  UserCheck,
  CircleDot,
  Clock,
  Eye,
  Folder,
  FolderX,
  GitBranch,
  SlidersHorizontal,
  UserRound,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';

import { Popover } from '@lody/ui/popover';
import { Button, type ButtonSize } from '@lody/ui/button';
import { menuSeparatorClassName, menuStyles } from '@/ui/menu-styles';
import { Switch } from '@lody/ui/switch';
import type { SidebarOrganizeMode } from '@/atoms/sidebar-state';
import type { SidebarChatScope } from '@/atoms/sidebar-state';
import {
  OwnerFilterPopover,
  defaultOwnerFilterLabels,
  summarizeOwners,
  type OwnerFilterLabels,
  type SidebarFilterMember,
} from '@/components/sidebar-owner-filter';
import { themeColors } from '../style/theme-colors.stylex';
import { filterOptionStyles, filterOptionTypography } from './sidebar-filter-option-styles';
import { themeRadius, themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  content: {
    width: 'max-content',
    minWidth: 200,
    gap: 'calc(var(--spacing) * 0)',
    padding: 'calc(var(--spacing) * 0.5)',
  },
  /** The menu's pre-v2 rhythm, kept on purpose: a heading hugs the rows under
      it (6px above, 2px below) instead of taking a whole 28px row of its own. */
  sectionHeading: {
    minHeight: 0,
    paddingTop: themeSpace[1.5],
    paddingBottom: themeSpace[0.5],
    fontWeight: 400,
  },
  /** The switch counterpart of an option: the same row geometry. */
  switchRow: {
    display: 'flex',
    minHeight: themeSpace[7],
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[2],
    paddingBlock: '3px',
    color: themeColors.popoverForeground,
  },
  switchLabel: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    userSelect: 'none',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  triggerGlyph: { width: '14px', height: '14px' },
  triggerGlyphWrap: { position: 'relative', display: 'inline-flex' },
  /** Marks a trigger whose Tasks filter narrows to chosen people. */
  triggerActiveDot: {
    position: 'absolute',
    top: -2,
    right: -3,
    width: 6,
    height: 6,
    borderRadius: '50%',
    backgroundColor: themeColors.primary,
  },
  ownerSummary: {
    minWidth: 0,
    maxWidth: 120,
    flexShrink: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: themeColors.mutedForeground,
  },
  ownerSummaryCount: { flexShrink: 0, color: themeColors.mutedForeground },
});

export type { SidebarOrganizeMode, SidebarChatScope };

export type SidebarFilterLabels = {
  triggerAriaLabel: string;
  organizeHeading: string;
  showHeading: string;
  detailsHeading: string;
  organizeProject: string;
  organizeUpdated: string;
  organizeStatus: string;
  updatedProjectNames: string;
  showBranchNames: string;
  hideEmptyProjects: string;
  showMyTasks: string;
  showAllTasks: string;
  emptyMyTasks: string;
  emptyMyTasksHint: string;
  emptyAllTasks: string;
  emptyAllTasksHint: string;
  showAllTasksAction: string;
};

const defaultLabels: SidebarFilterLabels = {
  triggerAriaLabel: 'Filter sidebar',
  organizeHeading: 'View',
  showHeading: 'Tasks',
  detailsHeading: 'Details',
  organizeProject: 'Project',
  organizeUpdated: 'Updated',
  organizeStatus: 'Status',
  updatedProjectNames: 'Show Project',
  showBranchNames: 'Show Branch',
  hideEmptyProjects: 'Hide Empty Projects',
  showMyTasks: 'My Tasks',
  showAllTasks: 'All Tasks',
  emptyMyTasks: 'No tasks match this view',
  emptyMyTasksHint: 'Try showing every task in this workspace.',
  emptyAllTasks: 'No tasks yet',
  emptyAllTasksHint: 'Tasks in this workspace will appear here.',
  showAllTasksAction: 'Show all tasks',
};

export type { SidebarFilterMember };

export type SidebarFilterPopoverProps = {
  organize: SidebarOrganizeMode;
  scope: SidebarChatScope;
  onOrganizeChange?: (next: SidebarOrganizeMode) => void;
  onScopeChange?: (next: SidebarChatScope) => void;
  /** Workspace members the Owner list offers; the row shows only when there are two or more. */
  members?: readonly SidebarFilterMember[];
  /** People chosen in the team scope; empty means every owner. */
  selectedMemberIds?: readonly string[];
  /** Ticks or unticks one person without closing the menu. */
  onToggleMember?: (userId: string) => void;
  ownerLabels?: Partial<OwnerFilterLabels>;
  /** Controlled open state of the Owner list, so a shortcut can open it with the menu. */
  ownerOpen?: boolean;
  onOwnerOpenChange?: (open: boolean) => void;
  /** Whether Updated-mode rows show their project identity line. */
  showUpdatedProjectNames?: boolean;
  onShowUpdatedProjectNamesChange?: (next: boolean) => void;
  /** Whether rows with a branch show the branch segment on their meta line. */
  showBranchNames?: boolean;
  onShowBranchNamesChange?: (next: boolean) => void;
  /** Project view only: whether projects without Session rows are hidden.
      The switch renders only while {@link organize} is 'workspace'. */
  hideEmptyProjects?: boolean;
  onHideEmptyProjectsChange?: (next: boolean) => void;
  labels?: Partial<SidebarFilterLabels>;
  className?: string;
  triggerClassName?: string;
  /** Use the Button size contract so the hit box and corner radius stay aligned. */
  triggerSize?: ButtonSize;
  /** Render a custom trigger instead of the default IconButton-style filter button. */
  trigger?: ReactElement;
  /** Controlled open state. Provide both props when the trigger can remount at a
      different slot, so visibility survives the remount. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Where to anchor the popover. Defaults to top-start since the trigger lives in the footer. */
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
};

type MenuOptionProps = {
  label: string;
  icon: LucideIcon;
  selected: boolean;
  onSelect: () => void;
};

function MenuOption({ label, icon: Icon, selected, onSelect }: MenuOptionProps) {
  const optionProps = stylex.props(filterOptionStyles.option, filterOptionTypography.option);
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={optionProps.className}
      onClick={onSelect}
    >
      <Icon
        {...stylex.props(filterOptionStyles.optionIcon)}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span {...stylex.props(filterOptionStyles.optionLabel)}>{label}</span>
      {selected ? (
        <Check {...stylex.props(filterOptionStyles.optionIcon)} aria-hidden="true" />
      ) : (
        <span {...stylex.props(filterOptionStyles.optionSpacer)} aria-hidden="true" />
      )}
    </button>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  const headingProps = stylex.props(menuStyles.groupLabel, styles.sectionHeading);
  return <div className={headingProps.className}>{children}</div>;
}

// The switch counterpart of {@link MenuOption}: the same row geometry, with a
// persistent Switch instead of the mutually exclusive check. Toggling never
// closes the menu — these are display preferences, not navigation choices.
function SwitchRow({
  icon: Icon,
  label,
  checked,
  onCheckedChange,
  kind,
}: {
  icon: LucideIcon;
  label: string;
  checked: boolean;
  onCheckedChange?: (next: boolean) => void;
  /** Names the segment this switch controls, for tests and story asserts. */
  kind: 'project' | 'branch' | 'empty-projects';
}) {
  const switchId = useId();
  const labelProps = stylex.props(styles.switchLabel, filterOptionTypography.option);
  return (
    <div data-sidebar-filter-section-row="details" {...stylex.props(styles.switchRow)}>
      <Icon
        {...stylex.props(filterOptionStyles.optionIcon)}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <label htmlFor={switchId} className={labelProps.className}>
        {label}
      </label>
      <Switch
        id={switchId}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={label}
        data-sidebar-filter-switch=""
        data-sidebar-filter-project-names={kind === 'project' ? '' : undefined}
        data-sidebar-filter-branch-names={kind === 'branch' ? '' : undefined}
        data-sidebar-filter-hide-empty-projects={kind === 'empty-projects' ? '' : undefined}
      />
    </div>
  );
}

export function SidebarFilterPopover({
  organize,
  scope,
  onOrganizeChange,
  onScopeChange,
  members,
  selectedMemberIds = [],
  onToggleMember,
  ownerLabels,
  ownerOpen: controlledOwnerOpen,
  onOwnerOpenChange,
  showUpdatedProjectNames = true,
  onShowUpdatedProjectNamesChange,
  showBranchNames = false,
  onShowBranchNamesChange,
  hideEmptyProjects = true,
  onHideEmptyProjectsChange,
  labels,
  className,
  triggerClassName,
  triggerSize = 'small',
  trigger,
  open: controlledOpen,
  onOpenChange,
  side = 'top',
  align = 'start',
}: SidebarFilterPopoverProps) {
  const merged = { ...defaultLabels, ...labels };
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;

  const handleOpenChange = (next: boolean) => {
    setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const handleOrganizeSelect = (next: SidebarOrganizeMode) => {
    onOrganizeChange?.(next);
    handleOpenChange(false);
  };
  const mergedOwnerLabels = { ...defaultOwnerFilterLabels, ...ownerLabels };
  const [uncontrolledOwnerOpen, setUncontrolledOwnerOpen] = useState(false);
  const ownerOpen = controlledOwnerOpen ?? uncontrolledOwnerOpen;
  const setOwnerOpen = (next: boolean) => {
    setUncontrolledOwnerOpen(next);
    onOwnerOpenChange?.(next);
  };
  const ownerMembers = members && members.length > 1 ? members : null;
  const filtersByMember = scope === 'team' && selectedMemberIds.length > 0;
  // My Tasks is "Owner is you": the list shows you ticked, and ticking a
  // teammate from there keeps you (see `toggleTaskOwnerSelection`).
  const currentUserId = members?.find((member) => member.isCurrentUser)?.userId;
  const ownerSelectedIds =
    scope === 'my' ? (currentUserId ? [currentUserId] : []) : selectedMemberIds;
  const ownerSummary = filtersByMember ? summarizeOwners(members ?? [], selectedMemberIds) : null;
  const handleScopeSelect = (next: SidebarChatScope) => {
    onScopeChange?.(next);
    handleOpenChange(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        render={
          trigger ?? (
            <Button
              type="button"
              variant="ghost"
              size={triggerSize}
              icon
              aria-label={merged.triggerAriaLabel}
              data-state-open={open || undefined}
              data-filter-active={filtersByMember || undefined}
              className={triggerClassName}
            >
              <span {...stylex.props(styles.triggerGlyphWrap)}>
                <SlidersHorizontal {...stylex.props(styles.triggerGlyph)} strokeWidth={1.5} />
                {filtersByMember ? (
                  <span {...stylex.props(styles.triggerActiveDot)} aria-hidden="true" />
                ) : null}
              </span>
            </Button>
          )
        }
      />
      <Popover.Content
        side={side}
        align={align}
        sideOffset={6}
        // A panel sets its children apart with a gap; this is a menu, whose
        // sections are set apart by their headings and separators alone.
        xstyle={styles.content}
        className={className}
      >
        <div data-sidebar-filter-section="view">
          <SectionHeading>{merged.organizeHeading}</SectionHeading>
          <MenuOption
            label={merged.organizeProject}
            icon={Folder}
            selected={organize === 'workspace'}
            onSelect={() => handleOrganizeSelect('workspace')}
          />
          <MenuOption
            label={merged.organizeUpdated}
            icon={Clock}
            selected={organize === 'updated'}
            onSelect={() => handleOrganizeSelect('updated')}
          />
          <MenuOption
            label={merged.organizeStatus}
            icon={CircleDot}
            selected={organize === 'status'}
            onSelect={() => handleOrganizeSelect('status')}
          />
        </div>
        <div className={menuSeparatorClassName} aria-hidden="true" />
        <div data-sidebar-filter-section="tasks">
          <SectionHeading>{merged.showHeading}</SectionHeading>
          <MenuOption
            label={merged.showMyTasks}
            icon={UserRound}
            selected={scope === 'my'}
            onSelect={() => handleScopeSelect('my')}
          />
          <MenuOption
            label={merged.showAllTasks}
            icon={Users}
            selected={scope === 'team' && !filtersByMember}
            onSelect={() => handleScopeSelect('team')}
          />
          {ownerMembers ? (
            <OwnerFilterPopover
              members={ownerMembers}
              selectedMemberIds={ownerSelectedIds}
              onToggleMember={(userId) => onToggleMember?.(userId)}
              labels={ownerLabels}
              open={ownerOpen}
              onOpenChange={setOwnerOpen}
              openOnHover
              side="right"
              align="start"
              trigger={
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup="dialog"
                  data-sidebar-filter-owner-row=""
                  className={
                    stylex.props(filterOptionStyles.option, filterOptionTypography.option).className
                  }
                >
                  <UserCheck
                    {...stylex.props(filterOptionStyles.optionIcon)}
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span {...stylex.props(filterOptionStyles.optionLabel)}>
                    {mergedOwnerLabels.owner}
                  </span>
                  {ownerSummary ? (
                    // The first name plus a count: the row has room for one name,
                    // and the count must survive truncation.
                    <>
                      <span {...stylex.props(styles.ownerSummary)}>{ownerSummary.all[0]}</span>
                      {ownerSummary.all.length > 1 ? (
                        <span {...stylex.props(styles.ownerSummaryCount)}>
                          +{ownerSummary.all.length - 1}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                  <ChevronRight
                    {...stylex.props(filterOptionStyles.optionIcon)}
                    aria-hidden="true"
                  />
                </button>
              }
            />
          ) : null}
        </div>
        <div className={menuSeparatorClassName} aria-hidden="true" />
        <div data-sidebar-filter-section="details">
          <SectionHeading>{merged.detailsHeading}</SectionHeading>
          <SwitchRow
            icon={Eye}
            label={merged.updatedProjectNames}
            checked={showUpdatedProjectNames}
            onCheckedChange={onShowUpdatedProjectNamesChange}
            kind="project"
          />
          <SwitchRow
            icon={GitBranch}
            label={merged.showBranchNames}
            checked={showBranchNames}
            onCheckedChange={onShowBranchNamesChange}
            kind="branch"
          />
          {organize === 'workspace' ? (
            <SwitchRow
              icon={FolderX}
              label={merged.hideEmptyProjects}
              checked={hideEmptyProjects}
              onCheckedChange={onHideEmptyProjectsChange}
              kind="empty-projects"
            />
          ) : null}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}

SidebarFilterPopover.displayName = 'SidebarFilterPopover';
