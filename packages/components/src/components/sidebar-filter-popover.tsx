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
import * as stylex from '@stylexjs/stylex';
import { text } from '@lody/ui/tokens/scales.stylex';

const typography = stylex.create({
  option: { fontSize: text.subheadlineSize, lineHeight: text.subheadlineLeading },
});

import { cn } from '@/lib/utils';
import { Popover } from '@lody/ui/popover';
import { Button, type ButtonSize } from '@lody/ui/button';
import { menuGroupLabelClassName, menuSeparatorClassName } from '@/ui/menu-styles';
import { Switch } from '@lody/ui/switch';
import type { SidebarOrganizeMode } from '@/atoms/sidebar-state';
import type { SidebarChatScope } from '@/atoms/sidebar-state';

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
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={cn(
        'flex min-h-7 w-full select-none items-center gap-2 rounded-md px-2 py-1 text-left text-popover-foreground',
        stylex.props(typography.option).className,
        'hover:bg-foreground/[0.05] hover:text-foreground',
        'focus-visible:bg-foreground/[0.05] focus-visible:text-foreground focus-visible:outline-hidden',
        'dark:hover:bg-white/[0.10] dark:focus-visible:bg-white/[0.10]'
      )}
      onClick={onSelect}
    >
      <Icon
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}

// The menu's pre-v2 rhythm, kept on purpose: a heading hugs the rows under it
// (6px above, 2px below) instead of taking a whole 28px row of its own.
function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className={cn(menuGroupLabelClassName, 'min-h-0 pb-0.5 pt-1.5 font-normal')}>
      {children}
    </div>
  );
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
  return (
    <div
      data-sidebar-filter-section-row="details"
      className="flex min-h-7 items-center gap-2 rounded-md px-2 py-[3px] text-popover-foreground"
    >
      <Icon
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <label
        htmlFor={switchId}
        className={cn(
          'min-w-0 flex-1 select-none truncate cursor-pointer',
          stylex.props(typography.option).className
        )}
      >
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
              <SlidersHorizontal className="h-4 w-4" strokeWidth={1.5} />
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
        className={cn('w-max min-w-[200px] gap-0 p-0.5', className)}
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
