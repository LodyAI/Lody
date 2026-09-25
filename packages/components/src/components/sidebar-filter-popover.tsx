import { type ReactElement, type ReactNode, useId, useState } from 'react';
import { Check, Clock, Eye, Folder, UserRound, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { CarbonSettingsAdjust } from '@/components/icons/carbon-settings-adjust';
import { cn } from '@/lib/utils';
import { Popover } from '@lody/ui/popover';
import { Button } from '@lody/ui/button';
import { menuGroupLabelClassName, menuSeparatorClassName } from '@/ui/menu-styles';
import { Switch } from '@lody/ui/switch';
import { Tooltip } from '@lody/ui/tooltip';
import type { SidebarOrganizeMode } from '@/atoms/sidebar-state';
import type { SidebarChatScope } from '@/atoms/sidebar-state';

export type { SidebarOrganizeMode, SidebarChatScope };

export type SidebarFilterLabels = {
  triggerAriaLabel: string;
  organizeHeading: string;
  showHeading: string;
  organizeProject: string;
  organizeUpdated: string;
  updatedProjectNames: string;
  updatedProjectNamesUnavailable: string;
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
  organizeProject: 'Project',
  organizeUpdated: 'Updated',
  updatedProjectNames: 'Show Project',
  updatedProjectNamesUnavailable: 'Available in Updated view',
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
  labels?: Partial<SidebarFilterLabels>;
  className?: string;
  triggerClassName?: string;
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
        'flex min-h-7 w-full select-none items-center gap-2 rounded-md px-2 py-1 text-left text-[0.9em] leading-tight text-popover-foreground',
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

function SectionHeading({ children }: { children: ReactNode }) {
  return <div className={menuGroupLabelClassName}>{children}</div>;
}

export function SidebarFilterPopover({
  organize,
  scope,
  onOrganizeChange,
  onScopeChange,
  showUpdatedProjectNames = true,
  onShowUpdatedProjectNamesChange,
  labels,
  className,
  triggerClassName,
  trigger,
  open: controlledOpen,
  onOpenChange,
  side = 'top',
  align = 'start',
}: SidebarFilterPopoverProps) {
  const merged = { ...defaultLabels, ...labels };
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const [projectHintOpen, setProjectHintOpen] = useState(false);
  const sourceLabelsSwitchId = useId();
  const projectNamesAvailable = organize === 'updated';

  const handleOpenChange = (next: boolean) => {
    setUncontrolledOpen(next);
    onOpenChange?.(next);
    if (!next) setProjectHintOpen(false);
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
      <Popover.Trigger render={trigger ?? (
          <Button
            type="button"
            variant="ghost"
            icon
            aria-label={merged.triggerAriaLabel}
            data-state-open={open || undefined}
            className={cn(
              // Match section-header muted chrome (Pinned / Chats); full
              // contrast on hover/open so the control still feels interactive.
              'h-7 w-7 rounded-md text-sidebar-foreground-muted',
              'hover:bg-sidebar-hover hover:text-sidebar-hover-foreground',
              'focus-visible:ring-1 focus-visible:ring-sidebar-ring/40',
              'data-[state=open]:bg-sidebar-hover data-[state=open]:text-sidebar-hover-foreground',
              triggerClassName
            )}
          >
            <CarbonSettingsAdjust className="h-4 w-4" />
          </Button>
        )}/>
      <Popover.Content
        side={side}
        align={align}
        sideOffset={6}
        className={cn('w-max min-w-[200px] p-1', className)}
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
        <Tooltip.Provider delay={300}>
          <Tooltip.Root
            open={projectNamesAvailable ? false : projectHintOpen}
            onOpenChange={setProjectHintOpen}
          >
            <Tooltip.Trigger render={<div
                data-sidebar-filter-section="display"
                data-disabled={projectNamesAvailable ? undefined : ''}
                aria-disabled={projectNamesAvailable ? undefined : true}
                tabIndex={projectNamesAvailable ? undefined : 0}
                onPointerDownCapture={(event) => {
                  if (projectNamesAvailable || event.pointerType !== 'touch') return;
                  event.preventDefault();
                  setProjectHintOpen((current) => !current);
                }}
                className={cn(
                  'group flex min-h-7 items-center gap-2 rounded-md px-2 py-[3px]',
                  projectNamesAvailable ? 'text-popover-foreground' : 'text-muted-foreground/55'
                )}
              >
                <Eye
                  className={cn(
                    'h-3.5 w-3.5 shrink-0',
                    projectNamesAvailable ? 'text-muted-foreground' : 'text-muted-foreground/55'
                  )}
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                <label
                  htmlFor={projectNamesAvailable ? sourceLabelsSwitchId : undefined}
                  className={cn(
                    'min-w-0 flex-1 select-none truncate text-[0.9em] leading-tight',
                    projectNamesAvailable ? 'cursor-pointer' : 'cursor-default'
                  )}
                >
                  {merged.updatedProjectNames}
                </label>
                <Switch
                  id={sourceLabelsSwitchId}
                  checked={showUpdatedProjectNames}
                  disabled={!projectNamesAvailable}
                  onCheckedChange={onShowUpdatedProjectNamesChange}
                  aria-label={merged.updatedProjectNames}
                  aria-description={
                    projectNamesAvailable ? undefined : merged.updatedProjectNamesUnavailable
                  }
                  data-sidebar-filter-project-names=""
                />
              </div>}/>
            {!projectNamesAvailable ? (
              <Tooltip.Content side="right" sideOffset={8} className="max-w-48">
                {merged.updatedProjectNamesUnavailable}
              </Tooltip.Content>
            ) : null}
          </Tooltip.Root>
        </Tooltip.Provider>
      </Popover.Content>
    </Popover.Root>
  );
}

SidebarFilterPopover.displayName = 'SidebarFilterPopover';
