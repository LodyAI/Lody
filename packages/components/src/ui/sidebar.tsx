import {
  sidebarDockFrameClass,
  sidebarInputGeometryClass,
  sidebarMenuSkeletonLayoutClass,
  sidebarLeadingZeroClass,
  sidebarTrailingZeroClass,
  sidebarUncollapsedGeometryClass,
  sidebarVariableWidthClass,
  sidebarRailGeometryClass,
} from '@/style/legacy-defaults.stylex';
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, VariantProps } from 'class-variance-authority';
import { PanelLeftIcon } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import {
  sidebarFlexClass,
  sidebarWidthClass,
  sidebarItemsCenterClass,
  sidebarRelativeClass,
  sidebarMinWidthClass,
  sidebarColumnClass,
  sidebarGapClass,
  sidebarOverflowClass,
  sidebarInsetLayoutClass,
  sidebarStackLayoutClass,
  sidebarContentLayoutClass,
  sidebarGroupLayoutClass,
  sidebarMenuLayoutClass,
  sidebarLabelShrinkClass,
  sidebarHeightEightClass,
  sidebarHeightSevenClass,
  sidebarHeightTwelveClass,
  sidebarHeightFiveClass,
  sidebarCornerMediumClass,
  sidebarMenuButtonLayoutClass,
  sidebarPaddingClass,
  sidebarSurfaceClass,
  sidebarPageFillClass,
  sidebarFieldFillClass,
  sidebarInkClass,
  sidebarPaddingZeroClass,
  sidebarJustifyClass,
  sidebarSquareClass,
  sidebarPointerNoneClass,
  acpMediumWeightClass,
} from '@/style/legacy-defaults.stylex';

import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Separator } from '@lody/ui/separator';
import { Drawer } from '@lody/ui/drawer';
import { Skeleton } from '@lody/ui/skeleton';
import { Tooltip } from '@lody/ui/tooltip';

const SIDEBAR_COOKIE_NAME = 'sidebar_state';
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_WIDTH = '16rem';
const SIDEBAR_WIDTH_MOBILE = '18rem';
const SIDEBAR_WIDTH_ICON = '3rem';

const styles = stylex.create({
  mobileColumn: { display: 'flex', height: '100%', width: '100%', flexDirection: 'column' },
  desktopFrame: {
    color: 'hsl(var(--sidebar-foreground) / 1)',
    display: { default: 'none', '@media (width >= 48rem)': 'block' },
  },
  gap: {
    position: 'relative',
    backgroundColor: 'transparent',
    width: 'var(--sidebar-width)',
    transitionProperty: 'width',
    '--tw-duration': '.2s',
    transitionDuration: '.2s',
    '--tw-ease': 'linear',
    transitionTimingFunction: 'linear',
  },
  triggerGlyph: { width: 'calc(var(--spacing) * 4)', height: 'calc(var(--spacing) * 4)' },
  accessibleLabel: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
  inner: {
    backgroundColor: 'hsl(var(--sidebar-background) / 1)',
    display: 'flex',
    height: '100%',
    width: '100%',
    flexDirection: 'column',
  },
});

type SidebarContextProps = {
  state: 'expanded' | 'collapsed';
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.');
  }

  return context;
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(defaultOpen);
  const open = openProp ?? _open;
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === 'function' ? value(open) : value;
      if (setOpenProp) {
        setOpenProp(openState);
      } else {
        _setOpen(openState);
      }

      // This sets the cookie to keep the sidebar state.
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
    },
    [setOpenProp, open]
  );

  // Helper to toggle the sidebar.
  const toggleSidebar = React.useCallback(() => {
    return isMobile
      ? setOpenMobile((currentOpen) => !currentOpen)
      : setOpen((currentOpen) => !currentOpen);
  }, [isMobile, setOpen, setOpenMobile]);

  // The app-level `sidebar.toggle` command is owned by `use-keyboard-navigation.ts`
  // (the real sidebar). This primitive only exposes `toggleSidebar` via context for its
  // own trigger button — it deliberately does NOT register a command, so reviving this
  // (currently unused) shadcn sidebar can't double-register the shortcut.

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? 'expanded' : 'collapsed';

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
    }),
    [state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar]
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <Tooltip.Provider delay={500}>
        <div
          data-slot="sidebar-wrapper"
          style={
            {
              '--sidebar-width': SIDEBAR_WIDTH,
              '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          className={cn(
            'group/sidebar-wrapper has-data-[variant=inset]:bg-sidebar',
            sidebarFlexClass,
            'min-h-svh',
            sidebarWidthClass,
            className
          )}
          {...props}
        >
          {children}
        </div>
      </Tooltip.Provider>
    </SidebarContext.Provider>
  );
}

function Sidebar({
  side = 'left',
  variant = 'sidebar',
  collapsible = 'offcanvas',
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  side?: 'left' | 'right';
  variant?: 'sidebar' | 'floating' | 'inset';
  collapsible?: 'offcanvas' | 'icon' | 'none';
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();

  if (collapsible === 'none') {
    return (
      <div
        data-slot="sidebar"
        className={cn(
          sidebarSurfaceClass,
          sidebarFlexClass,
          sidebarUncollapsedGeometryClass,
          sidebarColumnClass,
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }

  if (isMobile) {
    return (
      <Drawer.Root
        side={side === 'left' ? 'start' : 'end'}
        open={openMobile}
        onOpenChange={setOpenMobile}
        {...props}
      >
        <Drawer.Content
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          // The sidebar is its own surface with its own fill and its own
          // scrolling column, so it takes the panel without the panel's padding
          // and without the cross: the way out is the overlay or the trigger.
          closeButton={false}
          className={`${sidebarSurfaceClass} ${sidebarVariableWidthClass} ${sidebarPaddingZeroClass}`}
          style={
            {
              '--sidebar-width': SIDEBAR_WIDTH_MOBILE,
            } as React.CSSProperties
          }
          side={side === 'left' ? 'start' : 'end'}
        >
          <Drawer.Header visuallyHidden>
            <Drawer.Title>Sidebar</Drawer.Title>
            <Drawer.Description>Displays the mobile sidebar.</Drawer.Description>
          </Drawer.Header>
          <div {...stylex.props(styles.mobileColumn)}>{children}</div>
        </Drawer.Content>
      </Drawer.Root>
    );
  }

  return (
    <div
      className={cn('group peer', stylex.props(styles.desktopFrame).className)}
      data-state={state}
      data-collapsible={state === 'collapsed' ? collapsible : ''}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
    >
      {/* This is what handles the sidebar gap on desktop */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          stylex.props(styles.gap).className,
          'group-data-[collapsible=offcanvas]:w-0',
          'group-data-[side=right]:rotate-180',
          variant === 'floating' || variant === 'inset'
            ? 'group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]'
            : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon)'
        )}
      />
      <div
        data-slot="sidebar-container"
        className={cn(
          `${sidebarDockFrameClass} h-svh ${sidebarVariableWidthClass} transition-[left,right,width] duration-200 ease-linear md:flex`,
          side === 'left'
            ? `${sidebarLeadingZeroClass} group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]`
            : `${sidebarTrailingZeroClass} group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]`,
          // Adjust the padding for floating and inset variants.
          variant === 'floating' || variant === 'inset'
            ? `${sidebarPaddingClass} group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]`
            : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l',
          className
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className={cn(
            stylex.props(styles.inner).className,
            'group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:shadow-xs'
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar();

  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="small"
      icon
      className={cn(className)}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      <PanelLeftIcon {...stylex.props(styles.triggerGlyph)} />
      <span {...stylex.props(styles.accessibleLabel)}>Toggle Sidebar</span>
    </Button>
  );
}

function SidebarRail({ className, ...props }: React.ComponentProps<'button'>) {
  const { toggleSidebar } = useSidebar();

  return (
    <button
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      onClick={toggleSidebar}
      title="Toggle Sidebar"
      className={cn(
        `hover:after:bg-sidebar-border ${sidebarRailGeometryClass} -translate-x-1/2 transition-all ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] sm:flex`,
        'in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize',
        '[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize',
        'hover:group-data-[collapsible=offcanvas]:bg-sidebar group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full',
        '[[data-side=left][data-collapsible=offcanvas]_&]:-right-2',
        '[[data-side=right][data-collapsible=offcanvas]_&]:-left-2',
        className
      )}
      {...props}
    />
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<'main'>) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        sidebarPageFillClass,
        sidebarInsetLayoutClass,
        'md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-xs md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2',
        className
      )}
      {...props}
    />
  );
}

function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="sidebar-input"
      data-sidebar="input"
      className={cn(`${sidebarInputGeometryClass} ${sidebarFieldFillClass} shadow-none`, className)}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn(sidebarStackLayoutClass, className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn(sidebarStackLayoutClass, className)}
      {...props}
    />
  );
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="sidebar-separator"
      data-sidebar="separator"
      className={cn('mx-2 w-auto', className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        sidebarContentLayoutClass,
        'overflow-auto group-data-[collapsible=icon]:overflow-hidden',
        className
      )}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn(sidebarGroupLayoutClass, className)}
      {...props}
    />
  );
}

function SidebarGroupLabel({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'div';

  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        'text-sidebar-foreground/70 ring-sidebar-ring',
        sidebarFlexClass,
        `${sidebarHeightEightClass}`,
        sidebarLabelShrinkClass,
        sidebarItemsCenterClass,
        `${sidebarCornerMediumClass} px-2 text-xs ${acpMediumWeightClass} outline-hidden transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 [&>svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-4 [&>svg]:shrink-0`,
        'group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0',
        className
      )}
      {...props}
    />
  );
}

function SidebarGroupAction({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      data-slot="sidebar-group-action"
      data-sidebar="group-action"
      className={cn(
        `${sidebarInkClass} ring-sidebar-ring hover:bg-sidebar-hover hover:text-sidebar-hover-foreground absolute top-3.5 right-3`,
        sidebarFlexClass,
        `${sidebarSquareClass} w-5`,
        sidebarItemsCenterClass,
        `${sidebarJustifyClass} ${sidebarCornerMediumClass} ${sidebarPaddingZeroClass} outline-hidden transition-transform focus-visible:ring-2 [&>svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-4 [&>svg]:shrink-0`,
        // Increases the hit area of the button on mobile.
        'after:absolute after:-inset-2 md:after:hidden',
        'group-data-[collapsible=icon]:hidden',
        className
      )}
      {...props}
    />
  );
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn(sidebarWidthClass, 'text-sm', className)}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn(sidebarMenuLayoutClass, 'gap-1', className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn('group/menu-item', sidebarRelativeClass, className)}
      {...props}
    />
  );
}

const sidebarMenuButtonVariants = cva(
  `peer/menu-button ${sidebarMenuButtonLayoutClass} ${sidebarCornerMediumClass} ${sidebarPaddingClass} text-left text-sm outline-hidden ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:ring-2 active:bg-sidebar-hover active:text-sidebar-hover-foreground disabled:pointer-events-none disabled:opacity-50 group-has-data-[sidebar=menu-action]/menu-item:pr-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-selection data-[active=true]:font-medium data-[active=true]:text-sidebar-selection-foreground data-[state=open]:hover:bg-sidebar-hover data-[state=open]:hover:text-sidebar-hover-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [&>span:last-child]:truncate [&>svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-4 [&>svg]:shrink-0`,
  {
    variants: {
      variant: {
        default: 'hover:bg-sidebar-hover hover:text-sidebar-hover-foreground',
        outline:
          `${sidebarPageFillClass} shadow-[0_0_0_1px_hsl(var(--sidebar-border))] hover:bg-sidebar-hover hover:text-sidebar-hover-foreground hover:shadow-[0_0_0_1px_hsl(var(--sidebar-hover))]`,
      },
      size: {
        default: `${sidebarHeightEightClass} text-sm`,
        sm: `${sidebarHeightSevenClass} text-xs`,
        lg: `${sidebarHeightTwelveClass} text-sm group-data-[collapsible=icon]:p-0!`,
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant = 'default',
  size = 'default',
  tooltip,
  className,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof Tooltip.Content>;
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const Comp = asChild ? Slot : 'button';
  const { isMobile, state } = useSidebar();

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  );

  if (!tooltip) {
    return button;
  }

  if (typeof tooltip === 'string') {
    tooltip = {
      children: tooltip,
    };
  }

  return (
    <Tooltip.Root>
      <Tooltip.Trigger delay={500} render={button}/>
      <Tooltip.Content
        side="right"
        align="center"
        hidden={state !== 'collapsed' || isMobile}
        {...tooltip}
      />
    </Tooltip.Root>
  );
}

function SidebarMenuAction({
  className,
  asChild = false,
  showOnHover = false,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean;
  showOnHover?: boolean;
}) {
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      data-slot="sidebar-menu-action"
      data-sidebar="menu-action"
      className={cn(
        `${sidebarInkClass} ring-sidebar-ring hover:bg-sidebar-hover hover:text-sidebar-hover-foreground peer-hover/menu-button:text-sidebar-hover-foreground absolute top-1.5 right-1`,
        sidebarFlexClass,
        `${sidebarSquareClass} w-5`,
        sidebarItemsCenterClass,
        `${sidebarJustifyClass} ${sidebarCornerMediumClass} ${sidebarPaddingZeroClass} outline-hidden transition-transform focus-visible:ring-2 [&>svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-4 [&>svg]:shrink-0`,
        // Increases the hit area of the button on mobile.
        'after:absolute after:-inset-2 md:after:hidden',
        'peer-data-[size=sm]/menu-button:top-1',
        'peer-data-[size=default]/menu-button:top-1.5',
        'peer-data-[size=lg]/menu-button:top-2.5',
        'group-data-[collapsible=icon]:hidden',
        showOnHover &&
          'peer-data-[active=true]/menu-button:text-sidebar-selection-foreground group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 md:opacity-0',
        className
      )}
      {...props}
    />
  );
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        `${sidebarInkClass} ${sidebarPointerNoneClass} absolute right-1`,
        sidebarFlexClass,
        `${sidebarHeightFiveClass} min-w-5`,
        sidebarItemsCenterClass,
        `${sidebarJustifyClass} ${sidebarCornerMediumClass} px-1 text-xs ${acpMediumWeightClass} tabular-nums select-none`,
        'peer-hover/menu-button:text-sidebar-hover-foreground peer-data-[active=true]/menu-button:text-sidebar-selection-foreground',
        'peer-data-[size=sm]/menu-button:top-1',
        'peer-data-[size=default]/menu-button:top-1.5',
        'peer-data-[size=lg]/menu-button:top-2.5',
        'group-data-[collapsible=icon]:hidden',
        className
      )}
      {...props}
    />
  );
}

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<'div'> & {
  showIcon?: boolean;
}) {
  // Random width between 50 to 90%.
  const width = React.useMemo(() => {
    return `${Math.floor(Math.random() * 40) + 50}%`;
  }, []);

  return (
    <div
      data-slot="sidebar-menu-skeleton"
      data-sidebar="menu-skeleton"
      className={cn(sidebarMenuSkeletonLayoutClass, className)}
      {...props}
    >
      {showIcon && <Skeleton width={16} height={16} data-sidebar="menu-skeleton-icon" />}
      <Skeleton
        height={16}
        className="max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={
          {
            '--skeleton-width': width,
          } as React.CSSProperties
        }
      />
    </div>
  );
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        'border-sidebar-border mx-3.5',
        sidebarFlexClass,
        sidebarMinWidthClass,
        'translate-x-px',
        sidebarColumnClass,
        'gap-1 border-l px-2.5 py-0.5',
        'group-data-[collapsible=icon]:hidden',
        className
      )}
      {...props}
    />
  );
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={cn('group/menu-sub-item', sidebarRelativeClass, className)}
      {...props}
    />
  );
}

function SidebarMenuSubButton({
  asChild = false,
  size = 'md',
  isActive = false,
  className,
  ...props
}: React.ComponentProps<'a'> & {
  asChild?: boolean;
  size?: 'sm' | 'md';
  isActive?: boolean;
}) {
  const Comp = asChild ? Slot : 'a';

  return (
    <Comp
      data-slot="sidebar-menu-sub-button"
      data-sidebar="menu-sub-button"
      data-size={size}
      data-active={isActive}
      className={cn(
        `${sidebarInkClass} ring-sidebar-ring hover:bg-sidebar-hover hover:text-sidebar-hover-foreground active:bg-sidebar-hover active:text-sidebar-hover-foreground [&>svg]:text-sidebar-hover-foreground`,
        sidebarFlexClass,
        sidebarHeightSevenClass,
        sidebarMinWidthClass,
        '-translate-x-px',
        sidebarItemsCenterClass,
        sidebarGapClass,
        sidebarOverflowClass,
        `${sidebarCornerMediumClass} px-2 outline-hidden focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-4 [&>svg]:shrink-0`,
        'data-[active=true]:bg-sidebar-selection data-[active=true]:text-sidebar-selection-foreground',
        size === 'sm' && 'text-xs',
        size === 'md' && 'text-sm',
        'group-data-[collapsible=icon]:hidden',
        className
      )}
      {...props}
    />
  );
}

export {
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
};
