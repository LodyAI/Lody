import { type ReactNode, useId, useState } from 'react';
import { Check, Clock, Eye, Folder, UserRound, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { CarbonSettingsAdjust } from '@/components/icons/carbon-settings-adjust';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Button } from '@/ui/button';
import {
  menuGroupLabelClassName,
  menuSeparatorClassName,
  menuSurfaceClassName,
  menuSurfaceStyle,
} from '@/ui/menu-styles';
import { Switch } from '@/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
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
  trigger?: ReactNode;
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
  side = 'top',
  align = 'start',
}: SidebarFilterPopoverProps) {
  const merged = { ...defaultLabels, ...labels };
  const [open, setOpen] = useState(false);
  const [projectHintOpen, setProjectHintOpen] = useState(false);
  const sourceLabelsSwitchId = useId();
  const projectNamesAvailable = organize === 'updated';

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setProjectHintOpen(false);
  };

  const handleOrganizeSelect = (next: SidebarOrganizeMode) => {
    onOrganizeChange?.(next);
    setOpen(false);
  };
  const handleScopeSelect = (next: SidebarChatScope) => {
    onScopeChange?.(next);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
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
        )}
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={6}
        style={{ ...menuSurfaceStyle, animation: 'none' }}
        className={cn(
          'w-max min-w-[200px] border-0 bg-transparent p-1 shadow-none',
          menuSurfaceClassName,
          className
        )}
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
        <TooltipProvider delayDuration={300}>
          <Tooltip
            open={projectNamesAvailable ? false : projectHintOpen}
            onOpenChange={setProjectHintOpen}
          >
            <TooltipTrigger asChild>
              <div
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
                  className={cn(
                    'h-4 w-7 transition-colors',
                    'group-hover:data-[state=checked]:bg-primary/80',
                    'group-hover:data-[state=unchecked]:bg-muted-foreground/40',
                    '[&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3'
                  )}
                />
              </div>
            </TooltipTrigger>
            {!projectNamesAvailable ? (
              <TooltipContent side="right" sideOffset={8} className="max-w-48">
                {merged.updatedProjectNamesUnavailable}
              </TooltipContent>
            ) : null}
          </Tooltip>
        </TooltipProvider>
      </PopoverContent>
    </Popover>
  );
}

SidebarFilterPopover.displayName = 'SidebarFilterPopover';
