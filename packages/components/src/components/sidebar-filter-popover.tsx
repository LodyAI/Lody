import { type ReactElement, type ReactNode, useId, useState } from 'react';
import {
  Check,
  Clock,
  Eye,
  Folder,
  GitBranch,
  SlidersHorizontal,
  UserRound,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';
import { text } from '@lody/ui/tokens/scales.stylex';

const typography = stylex.create({
  option: { fontSize: text.subheadlineSize, lineHeight: text.subheadlineLeading },
});

import { Popover } from '@lody/ui/popover';
import { Button, type ButtonSize } from '@lody/ui/button';
import { menuSeparatorClassName, menuStyles } from '@/ui/menu-styles';
import { Switch } from '@lody/ui/switch';
import type { SidebarOrganizeMode } from '@/atoms/sidebar-state';
import type { SidebarChatScope } from '@/atoms/sidebar-state';
import { themeColors } from '../style/theme-colors.stylex';
import { themeRadius, themeSpace } from '../style/theme-scale.stylex';

const DARK_SCOPE =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';

const styles = stylex.create({
  /** A menu option: the row a person picks an option from. */
  option: {
    display: 'flex',
    minHeight: themeSpace[7],
    width: '100%',
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[1],
    textAlign: 'left',
    backgroundColor: {
      default: 'transparent',
      ':hover': {
        default: 'hsl(var(--foreground) / 0.05)',
        [DARK_SCOPE]: {
          '@media (hover: hover)': {
            default: '#ffffff1a',
            '@supports (color: color-mix(in lab, red, red))':
              'color-mix(in oklab, var(--color-white) 10%, transparent)',
          },
        },
      },
      ':focus-visible': {
        default: 'hsl(var(--foreground) / 0.05)',
        [DARK_SCOPE]: {
          default: '#ffffff1a',
          '@supports (color: color-mix(in lab, red, red))':
            'color-mix(in oklab, var(--color-white) 10%, transparent)',
        },
      },
    },
    color: {
      default: themeColors.popoverForeground,
      ':hover': themeColors.foreground,
      ':focus-visible': themeColors.foreground,
    },
  },
  optionIcon: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  optionSpacer: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
  },
  optionLabel: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
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
  triggerGlyph: {
    width: themeSpace[4],
    height: themeSpace[4],
  },
});

export type { SidebarOrganizeMode, SidebarChatScope };

export type SidebarFilterLabels = {
  triggerAriaLabel: string;
  organizeHeading: string;
  showHeading: string;
  detailsHeading: string;
  organizeProject: string;
  organizeUpdated: string;
  updatedProjectNames: string;
  showBranchNames: string;
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
  updatedProjectNames: 'Show Project',
  showBranchNames: 'Show Branch',
  showMyTasks: 'My Tasks',
  showAllTasks: 'All Tasks',
  emptyMyTasks: 'No tasks match this view',
  emptyMyTasksHint: 'Try showing every task in this workspace.',
  emptyAllTasks: 'No tasks yet',
  emptyAllTasksHint: 'Tasks in this workspace will appear here.',
  showAllTasksAction: 'Show all tasks',
};

export type SidebarFilterPopoverProps = {
  organize: SidebarOrganizeMode;
  scope: SidebarChatScope;
  onOrganizeChange?: (next: SidebarOrganizeMode) => void;
  onScopeChange?: (next: SidebarChatScope) => void;
  /** Whether Updated-mode rows show their project identity line. */
  showUpdatedProjectNames?: boolean;
  onShowUpdatedProjectNamesChange?: (next: boolean) => void;
  /** Whether rows with a branch show the branch segment on their meta line. */
  showBranchNames?: boolean;
  onShowBranchNamesChange?: (next: boolean) => void;
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
  const optionProps = stylex.props(styles.option, typography.option);
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={optionProps.className}
      onClick={onSelect}
    >
      <Icon {...stylex.props(styles.optionIcon)} strokeWidth={1.75} aria-hidden="true" />
      <span {...stylex.props(styles.optionLabel)}>{label}</span>
      {selected ? (
        <Check {...stylex.props(styles.optionIcon)} aria-hidden="true" />
      ) : (
        <span {...stylex.props(styles.optionSpacer)} aria-hidden="true" />
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
  kind: 'project' | 'branch';
}) {
  const switchId = useId();
  const labelProps = stylex.props(styles.switchLabel, typography.option);
  return (
    <div data-sidebar-filter-section-row="details" {...stylex.props(styles.switchRow)}>
      <Icon {...stylex.props(styles.optionIcon)} strokeWidth={1.75} aria-hidden="true" />
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
      />
    </div>
  );
}

export function SidebarFilterPopover({
  organize,
  scope,
  onOrganizeChange,
  onScopeChange,
  showUpdatedProjectNames = true,
  onShowUpdatedProjectNamesChange,
  showBranchNames = false,
  onShowBranchNamesChange,
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
              className={triggerClassName}
            >
              <SlidersHorizontal {...stylex.props(styles.triggerGlyph)} strokeWidth={1.5} />
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
        className={clsx('w-max min-w-[200px] gap-0 p-0.5', className)}
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
            selected={scope === 'team'}
            onSelect={() => handleScopeSelect('team')}
          />
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
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}

SidebarFilterPopover.displayName = 'SidebarFilterPopover';
