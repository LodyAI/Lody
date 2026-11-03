import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { PanelLeftIcon } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';

import { useIsMobile } from '@/hooks/use-mobile';
import { clsx } from 'clsx';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { field } from '@lody/ui/field/field.tokens.stylex';
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
  wrapper: {
    display: 'flex',
    width: '100%',
    minHeight: { default: '100svh', '@supports not (height: 1dvh)': '100vh' },
    backgroundColor: {
      default: null,
      ':has([data-variant="inset"])': 'hsl(var(--sidebar-background) / 1)',
    },
  },
  uncollapsed: {
    display: 'flex',
    height: '100%',
    width: 'var(--sidebar-width)',
    flexDirection: 'column',
    backgroundColor: 'hsl(var(--sidebar-background) / 1)',
  },
  mobilePanel: {
    backgroundColor: 'hsl(var(--sidebar-background) / 1)',
    width: 'var(--sidebar-width)',
    padding: 0,
    paddingInlineStart: 0,
    paddingInlineEnd: 0,
    paddingBlockStart: 0,
    paddingBlockEnd: 0,
  },
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
    transitionDuration: '.2s',
    transitionTimingFunction: 'linear',
  },
  gapClosed: { width: 0 },
  gapIcon: { width: 'var(--sidebar-width-icon)' },
  gapIconPadded: { width: 'calc(var(--sidebar-width-icon) + var(--spacing) * 4)' },
  gapRight: { rotate: '180deg' },
  container: {
    position: 'fixed',
    insetBlock: 0,
    zIndex: 10,
    display: { default: 'none', '@media (width >= 48rem)': 'flex' },
    height: {
      default: '100svh',
      '@supports not (height: 1dvh)': '100vh',
      ':is(html[data-desktop-devbar] #root *)': 'calc(100dvh - 28px)',
    },
    width: 'var(--sidebar-width)',
    transitionProperty: 'left,right,width',
    transitionDuration: '.2s',
    transitionTimingFunction: 'linear',
  },
  leading: { left: 0 },
  trailing: { right: 0 },
  offcanvasLeading: { left: 'calc(var(--sidebar-width) * -1)' },
  offcanvasTrailing: { right: 'calc(var(--sidebar-width) * -1)' },
  padding: { padding: 'calc(var(--spacing) * 2)' },
  containerIcon: { width: 'var(--sidebar-width-icon)' },
  containerIconPadded: { width: 'calc(var(--sidebar-width-icon) + var(--spacing) * 4 + 2px)' },
  borderLeading: { borderRightWidth: 1 },
  borderTrailing: { borderLeftWidth: 1 },
  inner: {
    backgroundColor: 'hsl(var(--sidebar-background) / 1)',
    display: 'flex',
    height: '100%',
    width: '100%',
    flexDirection: 'column',
  },
  floating: {
    borderColor: 'hsl(var(--sidebar-border) / 1)',
    borderWidth: 1,
    borderRadius: 'var(--radius-lg)',
    boxShadow: 'var(--shadow-xs)',
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
  rail: {
    position: 'absolute',
    insetBlock: 0,
    zIndex: 20,
    display: { default: 'none', '@media (width >= 40rem)': 'flex' },
    width: 'calc(var(--spacing) * 4)',
    translate: '-50% 0',
    transitionProperty: 'all',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'linear',
    right: {
      default: null,
      ':is([data-side="left"] *)': 'calc(var(--spacing) * -4)',
      ':is([data-side="left"][data-collapsible="offcanvas"] *)': 'calc(var(--spacing) * -2)',
    },
    left: {
      default: null,
      ':is([data-side="right"] *)': 0,
      ':is([data-side="right"][data-collapsible="offcanvas"] *)': 'calc(var(--spacing) * -2)',
    },
    cursor: {
      default: null,
      ':is([data-side="left"] *)': 'w-resize',
      ':is([data-side="right"] *)': 'e-resize',
      ':is([data-side="left"][data-state="collapsed"] *)': 'e-resize',
      ':is([data-side="right"][data-state="collapsed"] *)': 'w-resize',
    },
    backgroundColor: {
      default: null,
      ':is([data-collapsible="offcanvas"] *):hover': {
        '@media (hover: hover)': 'hsl(var(--sidebar-background) / 1)',
      },
    },
    '::after': {
      content: '""',
      position: 'absolute',
      insetBlock: 0,
      left: '50%',
      width: 2,
      backgroundColor: {
        default: null,
        ':hover': { '@media (hover: hover)': 'hsl(var(--sidebar-border) / 1)' },
      },
    },
  },
  railOffcanvas: {
    ':is([data-collapsible="offcanvas"] *)': { translate: '0 0' },
    '::after': { left: { default: null, ':is([data-collapsible="offcanvas"] *)': '100%' } },
  },
  inset: {
    position: 'relative',
    display: 'flex',
    width: '100%',
    flex: 1,
    flexDirection: 'column',
    backgroundColor: 'hsl(var(--background) / 1)',
    '@media (width >= 48rem)': {
      margin: { default: null, ':is([data-variant="inset"] ~ *)': 'calc(var(--spacing) * 2)' },
      marginLeft: {
        default: null,
        ':is([data-variant="inset"] ~ *)': 0,
        ':is([data-variant="inset"][data-state="collapsed"] ~ *)': 'calc(var(--spacing) * 2)',
      },
      borderRadius: { default: null, ':is([data-variant="inset"] ~ *)': 'var(--radius-xl)' },
      boxShadow: { default: null, ':is([data-variant="inset"] ~ *)': 'var(--shadow-xs)' },
    },
  },
  input: {
    height: 'calc(var(--spacing) * 8)',
    width: '100%',
    [field.background]: 'hsl(var(--input-field) / 1)',
    [field.well]: 'none',
    [field.ringWidth]: '0px',
  },
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'calc(var(--spacing) * 2)',
    padding: 'calc(var(--spacing) * 2)',
  },
  separator: { marginInline: 'calc(var(--spacing) * 2)', width: 'auto' },
  content: {
    display: 'flex',
    minHeight: 0,
    flex: 1,
    flexDirection: 'column',
    gap: 'calc(var(--spacing) * 2)',
    overflow: { default: 'auto', ':is([data-collapsible="icon"] *)': 'hidden' },
  },
  group: {
    position: 'relative',
    display: 'flex',
    width: '100%',
    minWidth: 0,
    flexDirection: 'column',
    padding: 'calc(var(--spacing) * 2)',
  },
  label: {
    display: 'flex',
    height: 'calc(var(--spacing) * 8)',
    flexShrink: 0,
    alignItems: 'center',
    borderRadius: 'var(--radius-md)',
    paddingInline: 'calc(var(--spacing) * 2)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    color: 'color-mix(in oklab, hsl(var(--sidebar-foreground) / 1) 70%, transparent)',
    transitionProperty: 'margin,opacity',
    transitionDuration: '.2s',
    transitionTimingFunction: 'linear',
    marginTop: { default: null, ':is([data-collapsible="icon"] *)': 'calc(var(--spacing) * -8)' },
    opacity: { default: null, ':is([data-collapsible="icon"] *)': 0 },
  },
  focus: {
    outlineStyle: 'none',
    boxShadow: { default: null, ':focus-visible': 'none' },
  },
  glyphs: {
    ':is(*) > svg:not([class*="size-"]):not([class*="h-"]):not([class*="w-"])': {
      width: 'calc(var(--spacing) * 4)',
      height: 'calc(var(--spacing) * 4)',
    },
    ':is(*) > svg': { flexShrink: 0 },
  },
  action: {
    position: 'absolute',
    aspectRatio: '1 / 1',
    width: 'calc(var(--spacing) * 5)',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'var(--radius-md)',
    padding: 0,
    color: {
      default: 'hsl(var(--sidebar-foreground) / 1)',
      ':hover': { '@media (hover: hover)': 'hsl(var(--sidebar-hover-foreground) / 1)' },
    },
    backgroundColor: {
      default: null,
      ':hover': { '@media (hover: hover)': 'hsl(var(--sidebar-hover) / 1)' },
    },
    transitionProperty: 'transform, translate, scale, rotate',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    display: { default: 'flex', ':is([data-collapsible="icon"] *)': 'none' },
    '::after': {
      content: '""',
      position: 'absolute',
      inset: 'calc(var(--spacing) * -2)',
      display: { default: null, '@media (width >= 48rem)': 'none' },
    },
  },
  groupAction: { top: 'calc(var(--spacing) * 3.5)', right: 'calc(var(--spacing) * 3)' },
  groupContent: {
    width: '100%',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
  },
  menu: {
    display: 'flex',
    width: '100%',
    minWidth: 0,
    flexDirection: 'column',
    gap: 'calc(var(--spacing) * 1)',
  },
  relative: { position: 'relative' },
  menuButton: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    overflow: 'hidden',
    borderRadius: 'var(--radius-md)',
    padding: 'calc(var(--spacing) * 2)',
    textAlign: 'left',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    transitionProperty: 'width,height,padding',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    backgroundColor: {
      default: null,
      ':hover': { '@media (hover: hover)': 'hsl(var(--sidebar-hover) / 1)' },
      ':active': 'hsl(var(--sidebar-hover) / 1)',
      ':is([data-active="true"])': 'hsl(var(--sidebar-selection) / 1)',
    },
    color: {
      default: null,
      ':hover': { '@media (hover: hover)': 'hsl(var(--sidebar-hover-foreground) / 1)' },
      ':active': 'hsl(var(--sidebar-hover-foreground) / 1)',
      ':is([data-active="true"])': 'hsl(var(--sidebar-selection-foreground) / 1)',
    },
    fontWeight: { default: null, ':is([data-active="true"])': 'var(--font-weight-medium)' },
    paddingRight: {
      default: null,
      ':is([data-sidebar="menu-item"]:has([data-sidebar="menu-action"]) *):not(:is([data-collapsible="icon"] *))':
        'calc(var(--spacing) * 8)',
    },
    ':is(*) > span:last-child': {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
  },
  disabled: {
    pointerEvents: { default: null, ':disabled': 'none', ':is([aria-disabled="true"])': 'none' },
    opacity: { default: null, ':disabled': 0.5, ':is([aria-disabled="true"])': 0.5 },
  },
  buttonDefault: { height: 'calc(var(--spacing) * 8)' },
  buttonSmall: {
    height: 'calc(var(--spacing) * 7)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
  },
  buttonLarge: { height: 'calc(var(--spacing) * 12)' },
  buttonIcon: {
    ':is([data-collapsible="icon"] *)': {
      width: 'calc(var(--spacing) * 8)',
      height: 'calc(var(--spacing) * 8)',
      padding: 'calc(var(--spacing) * 2)',
    },
  },
  buttonLargeIcon: { ':is([data-collapsible="icon"] *)': { padding: 0 } },
  outline: {
    backgroundColor: 'hsl(var(--background) / 1)',
    boxShadow: {
      default: '0 0 0 1px hsl(var(--sidebar-border))',
      ':focus-visible': '0 0 0 1px hsl(var(--sidebar-border))',
      ':hover': { '@media (hover: hover)': '0 0 0 1px hsl(var(--sidebar-hover))' },
    },
  },
  menuAction: {
    top: {
      default: 'calc(var(--spacing) * 1.5)',
      ':is([data-size="sm"] ~ *)': 'calc(var(--spacing) * 1)',
      ':is([data-size="lg"] ~ *)': 'calc(var(--spacing) * 2.5)',
    },
    right: 'calc(var(--spacing) * 1)',
    color: {
      default: null,
      ':is([data-sidebar="menu-button"]:hover ~ *)': {
        '@media (hover: hover)': 'hsl(var(--sidebar-hover-foreground) / 1)',
      },
    },
  },
  menuPosition: {
    top: {
      default: 'calc(var(--spacing) * 1.5)',
      ':is([data-size="sm"] ~ *)': 'calc(var(--spacing) * 1)',
      ':is([data-size="lg"] ~ *)': 'calc(var(--spacing) * 2.5)',
    },
    right: 'calc(var(--spacing) * 1)',
  },
  showOnHover: {
    opacity: {
      default: null,
      '@media (width >= 48rem)': {
        default: 0,
        ':is([data-sidebar="menu-item"]:focus-within *)': 1,
        ':is([data-sidebar="menu-item"]:hover *)': 1,
        ':is([data-state="open"])': 1,
      },
    },
    color: {
      default: null,
      ':is([data-active="true"] ~ *)': 'hsl(var(--sidebar-selection-foreground) / 1)',
    },
  },
  badge: {
    position: 'absolute',
    right: 'calc(var(--spacing) * 1)',
    display: { default: 'flex', ':is([data-collapsible="icon"] *)': 'none' },
    pointerEvents: 'none',
    height: 'calc(var(--spacing) * 5)',
    minWidth: 'calc(var(--spacing) * 5)',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'var(--radius-md)',
    paddingInline: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    fontVariantNumeric: 'tabular-nums',
    userSelect: 'none',
    color: {
      default: 'hsl(var(--sidebar-foreground) / 1)',
      ':is([data-sidebar="menu-button"]:hover ~ *)': {
        '@media (hover: hover)': 'hsl(var(--sidebar-hover-foreground) / 1)',
      },
      ':is([data-active="true"] ~ *)': 'hsl(var(--sidebar-selection-foreground) / 1)',
    },
  },
  skeleton: {
    display: 'flex',
    height: 'calc(var(--spacing) * 8)',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'var(--radius-md)',
    paddingInline: 'calc(var(--spacing) * 2)',
  },
  skeletonText: { maxWidth: 'var(--skeleton-width)', flex: 1 },
  sub: {
    display: { default: 'flex', ':is([data-collapsible="icon"] *)': 'none' },
    minWidth: 0,
    flexDirection: 'column',
    marginInline: 'calc(var(--spacing) * 3.5)',
    translate: '1px 0',
    gap: 'calc(var(--spacing) * 1)',
    borderLeftWidth: 1,
    borderColor: 'hsl(var(--sidebar-border) / 1)',
    paddingInline: 'calc(var(--spacing) * 2.5)',
    paddingBlock: 'calc(var(--spacing) * .5)',
  },
  subButton: {
    display: { default: 'flex', ':is([data-collapsible="icon"] *)': 'none' },
    height: 'calc(var(--spacing) * 7)',
    minWidth: 0,
    translate: '-1px 0',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    overflow: 'hidden',
    borderRadius: 'var(--radius-md)',
    paddingInline: 'calc(var(--spacing) * 2)',
    color: {
      default: 'hsl(var(--sidebar-foreground) / 1)',
      ':hover': { '@media (hover: hover)': 'hsl(var(--sidebar-hover-foreground) / 1)' },
      ':active': 'hsl(var(--sidebar-hover-foreground) / 1)',
      ':is([data-active="true"])': 'hsl(var(--sidebar-selection-foreground) / 1)',
    },
    backgroundColor: {
      default: null,
      ':hover': { '@media (hover: hover)': 'hsl(var(--sidebar-hover) / 1)' },
      ':active': 'hsl(var(--sidebar-hover) / 1)',
      ':is([data-active="true"])': 'hsl(var(--sidebar-selection) / 1)',
    },
    ':is(*) > svg': { color: 'hsl(var(--sidebar-hover-foreground) / 1)' },
    ':is(*) > span:last-child': {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
  },
  textSmall: { fontSize: 'var(--text-sm)', lineHeight: 'var(--text-sm--line-height)' },
  textExtraSmall: { fontSize: 'var(--text-xs)', lineHeight: 'var(--text-xs--line-height)' },
});

type SidebarStyleProps = {
  /** Additional styles compose after this part's defaults and variants. */
  xstyle?: stylex.StyleXStyles;
};

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
  xstyle,
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> &
  SidebarStyleProps & {
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
  // Descendants observe the same expanded/collapsed state.
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
          className={clsx(stylex.props(styles.wrapper, xstyle).className, className)}
          {...props}
        >
          {children}
        </div>
      </Tooltip.Provider>
    </SidebarContext.Provider>
  );
}

function Sidebar({
  xstyle,
  side = 'left',
  variant = 'sidebar',
  collapsible = 'offcanvas',
  className,
  children,
  ...props
}: React.ComponentProps<'div'> &
  SidebarStyleProps & {
    side?: 'left' | 'right';
    variant?: 'sidebar' | 'floating' | 'inset';
    collapsible?: 'offcanvas' | 'icon' | 'none';
  }) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();

  if (collapsible === 'none') {
    return (
      <div
        data-slot="sidebar"
        className={clsx(stylex.props(styles.uncollapsed, xstyle).className, className)}
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
          xstyle={styles.mobilePanel}
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
      className={stylex.props(styles.desktopFrame).className}
      data-state={state}
      data-collapsible={state === 'collapsed' ? collapsible : ''}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
    >
      {/* This is what handles the sidebar gap on desktop */}
      <div
        data-slot="sidebar-gap"
        className={
          stylex.props(
            styles.gap,
            side === 'right' && styles.gapRight,
            state === 'collapsed' &&
              (collapsible === 'offcanvas'
                ? styles.gapClosed
                : variant === 'floating' || variant === 'inset'
                  ? styles.gapIconPadded
                  : styles.gapIcon)
          ).className
        }
      />
      <div
        data-slot="sidebar-container"
        className={clsx(
          stylex.props(
            styles.container,
            side === 'left' ? styles.leading : styles.trailing,
            state === 'collapsed' &&
              collapsible === 'offcanvas' &&
              (side === 'left' ? styles.offcanvasLeading : styles.offcanvasTrailing),
            (variant === 'floating' || variant === 'inset') && styles.padding,
            state === 'collapsed' &&
              collapsible === 'icon' &&
              (variant === 'floating' || variant === 'inset'
                ? styles.containerIconPadded
                : styles.containerIcon),
            variant === 'sidebar' &&
              (side === 'left' ? styles.borderLeading : styles.borderTrailing),
            xstyle
          ).className,
          className
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className={
            stylex.props(styles.inner, variant === 'floating' && styles.floating).className
          }
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
      className={clsx(className)}
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

function SidebarRail({
  xstyle,
  className,
  ...props
}: React.ComponentProps<'button'> & SidebarStyleProps) {
  const { toggleSidebar } = useSidebar();

  return (
    <button
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      onClick={toggleSidebar}
      title="Toggle Sidebar"
      className={clsx(stylex.props(styles.rail, styles.railOffcanvas, xstyle).className, className)}
      {...props}
    />
  );
}

function SidebarInset({
  xstyle,
  className,
  ...props
}: React.ComponentProps<'main'> & SidebarStyleProps) {
  return (
    <main
      data-slot="sidebar-inset"
      className={clsx(stylex.props(styles.inset, xstyle).className, className)}
      {...props}
    />
  );
}

function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="sidebar-input"
      data-sidebar="input"
      controlHeight="calc(var(--spacing) * 8)"
      className={clsx(stylex.props(styles.input).className, className)}
      {...props}
    />
  );
}

function SidebarHeader({
  xstyle,
  className,
  ...props
}: React.ComponentProps<'div'> & SidebarStyleProps) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={clsx(stylex.props(styles.stack, xstyle).className, className)}
      {...props}
    />
  );
}

function SidebarFooter({
  xstyle,
  className,
  ...props
}: React.ComponentProps<'div'> & SidebarStyleProps) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={clsx(stylex.props(styles.stack, xstyle).className, className)}
      {...props}
    />
  );
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="sidebar-separator"
      data-sidebar="separator"
      xstyle={styles.separator}
      className={className}
      {...props}
    />
  );
}

function SidebarContent({
  xstyle,
  className,
  ...props
}: React.ComponentProps<'div'> & SidebarStyleProps) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={clsx(stylex.props(styles.content, xstyle).className, className)}
      {...props}
    />
  );
}

function SidebarGroup({
  xstyle,
  className,
  ...props
}: React.ComponentProps<'div'> & SidebarStyleProps) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={clsx(stylex.props(styles.group, xstyle).className, className)}
      {...props}
    />
  );
}

function SidebarGroupLabel({
  xstyle,
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'div'> & SidebarStyleProps & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'div';

  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={clsx(
        stylex.props(styles.label, styles.focus, styles.glyphs, xstyle).className,
        className
      )}
      {...props}
    />
  );
}

function SidebarGroupAction({
  xstyle,
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & SidebarStyleProps & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      data-slot="sidebar-group-action"
      data-sidebar="group-action"
      className={clsx(
        stylex.props(styles.action, styles.groupAction, styles.focus, styles.glyphs, xstyle)
          .className,
        className
      )}
      {...props}
    />
  );
}

function SidebarGroupContent({
  xstyle,
  className,
  ...props
}: React.ComponentProps<'div'> & SidebarStyleProps) {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={clsx(stylex.props(styles.groupContent, xstyle).className, className)}
      {...props}
    />
  );
}

function SidebarMenu({
  xstyle,
  className,
  ...props
}: React.ComponentProps<'ul'> & SidebarStyleProps) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={clsx(stylex.props(styles.menu, xstyle).className, className)}
      {...props}
    />
  );
}

function SidebarMenuItem({
  xstyle,
  className,
  ...props
}: React.ComponentProps<'li'> & SidebarStyleProps) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={clsx(stylex.props(styles.relative, xstyle).className, className)}
      {...props}
    />
  );
}

function SidebarMenuButton({
  xstyle,
  asChild = false,
  isActive = false,
  variant = 'default',
  size = 'default',
  tooltip,
  className,
  ...props
}: React.ComponentProps<'button'> &
  SidebarStyleProps & {
    asChild?: boolean;
    isActive?: boolean;
    tooltip?: string | React.ComponentProps<typeof Tooltip.Content>;
    variant?: 'default' | 'outline' | null;
    size?: 'default' | 'sm' | 'lg' | null;
  }) {
  const Comp = asChild ? Slot : 'button';
  const { isMobile, state } = useSidebar();

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={clsx(
        stylex.props(
          styles.menuButton,
          styles.focus,
          styles.glyphs,
          styles.disabled,
          variant === 'outline' && styles.outline,
          size === 'sm'
            ? styles.buttonSmall
            : size === 'lg'
              ? styles.buttonLarge
              : size === null
                ? null
                : styles.buttonDefault,
          styles.buttonIcon,
          size === 'lg' && styles.buttonLargeIcon,
          xstyle
        ).className,
        className
      )}
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
  xstyle,
  className,
  asChild = false,
  showOnHover = false,
  ...props
}: React.ComponentProps<'button'> &
  SidebarStyleProps & {
    asChild?: boolean;
    showOnHover?: boolean;
  }) {
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      data-slot="sidebar-menu-action"
      data-sidebar="menu-action"
      className={clsx(
        stylex.props(
          styles.action,
          styles.menuAction,
          styles.focus,
          styles.glyphs,
          showOnHover && styles.showOnHover,
          xstyle
        ).className,
        className
      )}
      {...props}
    />
  );
}

function SidebarMenuBadge({
  xstyle,
  className,
  ...props
}: React.ComponentProps<'div'> & SidebarStyleProps) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={clsx(stylex.props(styles.badge, styles.menuPosition, xstyle).className, className)}
      {...props}
    />
  );
}

function SidebarMenuSkeleton({
  xstyle,
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<'div'> &
  SidebarStyleProps & {
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
      className={clsx(stylex.props(styles.skeleton, xstyle).className, className)}
      {...props}
    >
      {showIcon && <Skeleton width={16} height={16} data-sidebar="menu-skeleton-icon" />}
      <Skeleton
        height={16}
        className={stylex.props(styles.skeletonText).className}
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

function SidebarMenuSub({
  xstyle,
  className,
  ...props
}: React.ComponentProps<'ul'> & SidebarStyleProps) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={clsx(stylex.props(styles.sub, xstyle).className, className)}
      {...props}
    />
  );
}

function SidebarMenuSubItem({
  xstyle,
  className,
  ...props
}: React.ComponentProps<'li'> & SidebarStyleProps) {
  return (
    <li
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={clsx(stylex.props(styles.relative, xstyle).className, className)}
      {...props}
    />
  );
}

function SidebarMenuSubButton({
  xstyle,
  asChild = false,
  size = 'md',
  isActive = false,
  className,
  ...props
}: React.ComponentProps<'a'> &
  SidebarStyleProps & {
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
      className={clsx(
        stylex.props(
          styles.subButton,
          styles.focus,
          styles.glyphs,
          styles.disabled,
          size === 'sm' ? styles.textExtraSmall : styles.textSmall,
          xstyle
        ).className,
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
