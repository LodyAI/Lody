import { type ComponentPropsWithoutRef, type ReactNode, forwardRef, useState } from 'react';
import { Check, Clock, Folder, UserRound, Users } from 'lucide-react';
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
import type { SidebarOrganizeMode } from '@/atoms/sidebar-state';
import type { SidebarChatScope } from '@/atoms/sidebar-state';

export type { SidebarOrganizeMode, SidebarChatScope };

export type SidebarFilterLabels = {
  triggerAriaLabel: string;
  organizeHeading: string;
  showHeading: string;
  organizeWorkspace: string;
  organizeUpdated: string;
  showMyTasks: string;
  showAllTasks: string;
};

const defaultLabels: SidebarFilterLabels = {
  triggerAriaLabel: 'Filter sidebar',
  organizeHeading: 'Organize',
  showHeading: 'Show',
  organizeWorkspace: 'Workspace',
  organizeUpdated: 'Updated',
  showMyTasks: 'My Tasks',
  showAllTasks: 'All Tasks',
};

export type SidebarFilterPopoverProps = {
  organize: SidebarOrganizeMode;
  scope: SidebarChatScope;
  onOrganizeChange?: (next: SidebarOrganizeMode) => void;
  onScopeChange?: (next: SidebarChatScope) => void;
  labels?: Partial<SidebarFilterLabels>;
  className?: string;
  triggerClassName?: string;
  /** Render a custom trigger instead of the default IconButton-style filter button. */
  trigger?: ReactNode;
  /** Where to anchor the popover. Defaults to top-start since the trigger lives in the footer. */
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
};

type RowProps = {
  label: string;
  icon: LucideIcon;
  selected: boolean;
  onSelect: () => void;
} & Omit<ComponentPropsWithoutRef<'button'>, 'onClick' | 'children'>;

const FilterRow = forwardRef<HTMLButtonElement, RowProps>(function FilterRow(
  { label, icon: Icon, selected, onSelect, className, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={cn(
        'flex w-full min-h-7 select-none items-center gap-2 rounded-md px-2 py-1 text-left text-[0.9em] leading-tight',
        'text-popover-foreground',
        'hover:bg-foreground/[0.05] hover:text-foreground',
        'focus-visible:bg-foreground/[0.05] focus-visible:text-foreground focus-visible:outline-hidden',
        'dark:hover:bg-white/[0.10] dark:focus-visible:bg-white/[0.10]',
        className
      )}
      onClick={onSelect}
      {...rest}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
});

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className={cn(menuGroupLabelClassName, 'normal-case tracking-normal')}>{children}</div>
  );
}

export function SidebarFilterPopover({
  organize,
  scope,
  onOrganizeChange,
  onScopeChange,
  labels,
  className,
  triggerClassName,
  trigger,
  side = 'top',
  align = 'start',
}: SidebarFilterPopoverProps) {
  const merged = { ...defaultLabels, ...labels };
  const [open, setOpen] = useState(false);

  const handleOrganizeSelect = (next: SidebarOrganizeMode) => {
    onOrganizeChange?.(next);
    setOpen(false);
  };
  const handleScopeSelect = (next: SidebarChatScope) => {
    onScopeChange?.(next);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
          'w-max min-w-44 border-0 bg-transparent p-0.5 shadow-none',
          menuSurfaceClassName,
          className
        )}
      >
        <SectionHeading>{merged.organizeHeading}</SectionHeading>
        <FilterRow
          label={merged.organizeWorkspace}
          icon={Folder}
          selected={organize === 'workspace'}
          onSelect={() => handleOrganizeSelect('workspace')}
        />
        <FilterRow
          label={merged.organizeUpdated}
          icon={Clock}
          selected={organize === 'updated'}
          onSelect={() => handleOrganizeSelect('updated')}
        />
        <div className={menuSeparatorClassName} aria-hidden="true" />
        <SectionHeading>{merged.showHeading}</SectionHeading>
        <FilterRow
          label={merged.showMyTasks}
          icon={UserRound}
          selected={scope === 'my'}
          onSelect={() => handleScopeSelect('my')}
        />
        <FilterRow
          label={merged.showAllTasks}
          icon={Users}
          selected={scope === 'team'}
          onSelect={() => handleScopeSelect('team')}
        />
      </PopoverContent>
    </Popover>
  );
}

SidebarFilterPopover.displayName = 'SidebarFilterPopover';
