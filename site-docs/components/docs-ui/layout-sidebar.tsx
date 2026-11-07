'use client';

import { Collapsible } from '@base-ui/react/collapsible';
import { Popover } from '@base-ui/react/popover';
import { ScrollArea } from '@base-ui/react/scroll-area';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { usePathname } from 'fumadocs-core/framework';
import Link from 'fumadocs-core/link';
import {
  SidebarCollapseTrigger,
  SidebarContent as SidebarContentBehavior,
  SidebarDrawerOverlay,
  SidebarFolder,
  SidebarItem as SidebarItemBehavior,
  SidebarProvider,
  SidebarTrigger,
  useAutoScroll,
  useFolder,
  useFolderDepth,
  useSidebar,
} from 'fumadocs-ui/components/sidebar/base';
import { createLinkItemRenderer } from 'fumadocs-ui/components/sidebar/link-item';
import { createPageTreeRenderer } from 'fumadocs-ui/components/sidebar/page-tree';
import { useDocsLayout, type DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { SidebarProps } from 'fumadocs-ui/layouts/docs/slots/sidebar';
import { isLayoutTabActive, type LayoutTab, LinkItem } from 'fumadocs-ui/layouts/shared';
import { Check, ChevronDown, ChevronsUpDown, Languages, SidebarIcon } from 'lucide-react';
import {
  createElement,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';

const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const fadeOut = stylex.keyframes({ from: { opacity: 1 }, to: { opacity: 0 } });
const drawerIn = stylex.keyframes({
  from: { transform: 'translateX(var(--fd-sidebar-drawer-offset,100%))' },
});
const drawerOut = stylex.keyframes({
  to: { transform: 'translateX(var(--fd-sidebar-drawer-offset,100%))' },
});
const popoverIn = stylex.keyframes({ from: { opacity: 0, transform: 'scale(.9)' } });
const popoverOut = stylex.keyframes({ to: { opacity: 0, transform: 'scale(.9)' } });

const styles = stylex.create({
  placeholder: {
    position: 'sticky',
    top: 'var(--fd-docs-row-1)',
    zIndex: 20,
    gridArea: 'sidebar',
    pointerEvents: 'none',
    height: 'calc(var(--fd-docs-height) - var(--fd-docs-row-1))',
    display: { default: 'block', '@media (width < 48rem)': 'none' },
    ':is(*) > *': { pointerEvents: 'auto' },
  },
  hoverStrip: {
    position: 'absolute',
    'inset-inline-start': 0,
    'inset-block': 0,
    width: 'calc(var(--spacing) * 4)',
  },
  aside: {
    position: 'absolute',
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    'inset-inline-start': 0,
    'inset-block': 0,
    alignItems: 'flex-end',
    backgroundColor: 'var(--color-fd-card)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    'border-inline-end-width': 1,
    'border-inline-end-style': 'solid',
    'border-inline-end-color': 'var(--color-fd-border)',
    transitionDuration: '.25s',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    ':is(*) > *': { width: 'var(--fd-sidebar-width)' },
  },
  collapsed: {
    'inset-block': 'calc(var(--spacing) * 2)',
    borderRadius: 'var(--radius-xl)',
    transitionProperty: 'transform, translate, scale, rotate',
    width: 'var(--fd-sidebar-width)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    translate: {
      default: 'calc(var(--fd-sidebar-width) * -1) 0',
      ':where([dir="rtl"], [dir="rtl"] *)': '100% 0',
    },
  },
  hovered: {
    boxShadow: 'var(--shadow-lg)',
    translate: {
      default: 'calc(var(--spacing) * 2) 0',
      ':where([dir="rtl"], [dir="rtl"] *)': 'calc(var(--spacing) * -2) 0',
    },
  },
  changed: { transitionProperty: 'width, inset-block, translate, background-color' },
  collapsedPanel: {
    position: 'fixed',
    display: 'flex',
    top: 'calc(var(--spacing) * 4 + var(--fd-docs-row-3))',
    'inset-inline-start': 'calc(var(--spacing) * 4)',
    boxShadow: 'var(--shadow-lg)',
    transitionProperty: 'opacity',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    borderRadius: 'var(--radius-xl)',
    padding: 'calc(var(--spacing) * .5)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    backgroundColor: 'var(--color-fd-muted)',
    color: 'var(--color-fd-muted-foreground)',
    zIndex: 10,
    ':is(*) > button': { borderRadius: 'var(--radius-lg)' },
  },
  hiddenPanel: { pointerEvents: 'none', opacity: 0 },
  overlay: {
    position: 'fixed',
    zIndex: 40,
    inset: 0,
    backdropFilter: 'blur(var(--blur-xs))',
    animationName: {
      default: 'none',
      ':is([data-state="open"])': fadeIn,
      ':is([data-state="closed"])': fadeOut,
    },
    animationDuration: '.3s',
    animationTimingFunction: 'ease',
  },
  drawer: {
    position: 'fixed',
    fontSize: '.9375rem',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: 'var(--shadow-lg)',
    'border-inline-start-width': 1,
    'border-inline-start-style': 'solid',
    'border-inline-start-color': 'var(--color-fd-border)',
    'inset-inline-end': 0,
    'inset-block': 0,
    width: '85%',
    maxWidth: 380,
    zIndex: 40,
    backgroundColor: 'var(--color-fd-background)',
    '--fd-sidebar-drawer-offset': {
      default: '100%',
      ':where([dir="rtl"], [dir="rtl"] *)': '-100%',
    },
    animationName: {
      default: 'none',
      ':is([data-state="open"])': drawerIn,
      ':is([data-state="closed"])': drawerOut,
    },
    animationDuration: '.25s',
    animationTimingFunction: 'ease',
  },
  invisible: { visibility: 'hidden' },
  heading: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'calc(var(--spacing) * 3)',
    padding: 'calc(var(--spacing) * 4)',
    paddingBottom: 'calc(var(--spacing) * 2)',
  },
  titleRow: { display: 'flex' },
  mobileTitleRow: {
    display: 'flex',
    color: 'var(--color-fd-muted-foreground)',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  flexOne: { display: 'flex', flex: '1' },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'var(--radius-md)',
    padding: 'calc(var(--spacing) * 1.5)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: '.1s',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    pointerEvents: { default: null, ':disabled': 'none' },
    opacity: { default: null, ':disabled': 0.5 },
    outlineStyle: { default: null, ':focus-visible': 'none' },
    boxShadow: { default: null, ':focus-visible': '0 0 0 2px var(--color-fd-ring)' },
    backgroundColor: {
      default: null,
      ':hover': { '@media (hover: hover)': 'var(--color-fd-accent)' },
    },
    color: {
      default: null,
      ':hover': { '@media (hover: hover)': 'var(--color-fd-accent-foreground)' },
    },
    ':is(*) svg': { width: 'calc(var(--spacing) * 4.5)', height: 'calc(var(--spacing) * 4.5)' },
  },
  collapseButton: { marginBottom: 'auto', color: 'var(--color-fd-muted-foreground)' },
  mobileButton: { padding: 'calc(var(--spacing) * 2)' },
  viewportRoot: { minHeight: 0, flex: '1' },
  viewport: {
    width: '100%',
    height: '100%',
    borderRadius: 'inherit',
    padding: 'calc(var(--spacing) * 4)',
    overscrollBehavior: 'contain',
    maskImage:
      'linear-gradient(to bottom,transparent,white 12px,white calc(100% - 12px),transparent)',
  },
  scrollbar: {
    display: 'flex',
    userSelect: 'none',
    transitionProperty: 'opacity',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    height: '100%',
    width: 'calc(var(--spacing) * 1.5)',
  },
  scrollbarHidden: { opacity: 0 },
  thumb: {
    position: 'relative',
    flex: '1',
    borderRadius: 'calc(infinity * 1px)',
    backgroundColor: 'var(--color-fd-border)',
  },
  tree: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * .5)' },
  menuLast: { marginBottom: 'calc(var(--spacing) * 4)' },
  footer: {
    display: 'flex',
    flexDirection: 'column',
    padding: 'calc(var(--spacing) * 4)',
    paddingTop: 'calc(var(--spacing) * 2)',
  },
  mobileFooter: {
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: 'var(--color-fd-border)',
    ':empty': { display: 'none' },
  },
  iconLinks: {
    display: 'flex',
    color: 'var(--color-fd-muted-foreground)',
    alignItems: 'center',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    backgroundColor: 'color-mix(in oklab,var(--color-fd-secondary) 50%,transparent)',
    padding: 'calc(var(--spacing) * .5)',
    'padding-inline-end': 0,
    borderRadius: 'var(--radius-lg)',
    ':empty': { display: 'none' },
  },
  theme: {
    'padding-inline': 'var(--spacing)',
    'padding-block': 0,
    'border-block-width': 0,
    'border-inline-end-width': 0,
    borderRadius: 0,
    'margin-inline-start': 'auto',
    ':is(*) > *': { borderRadius: 'var(--radius-md)' },
  },
  mobileTheme: { padding: 0 },
  language: {
    color: 'var(--color-fd-muted-foreground)',
    textAlign: 'start',
    justifyContent: 'flex-start',
    backgroundColor: 'color-mix(in oklab,var(--color-fd-secondary) 50%,transparent)',
    marginBottom: 'calc(var(--spacing) * 2)',
  },
  languageIcon: { width: 'calc(var(--spacing) * 4.5)', height: 'calc(var(--spacing) * 4.5)' },
  languageChevron: {
    'margin-inline-start': 'auto',
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
  },
  item: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'var(--radius-lg)',
    padding: 'calc(var(--spacing) * 2)',
    textAlign: 'start',
    color: 'var(--color-fd-muted-foreground)',
    overflowWrap: 'anywhere',
    ':is(*) svg': {
      width: 'calc(var(--spacing) * 4)',
      height: 'calc(var(--spacing) * 4)',
      flexShrink: 0,
    },
  },
  itemInteractive: {
    transitionProperty: {
      default:
        'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
      ':hover': { '@media (hover: hover)': 'none' },
    },
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    backgroundColor: {
      default: null,
      ':hover': {
        '@media (hover: hover)': 'color-mix(in oklab,var(--color-fd-accent) 50%,transparent)',
      },
    },
    color: {
      default: 'var(--color-fd-muted-foreground)',
      ':hover': {
        '@media (hover: hover)':
          'color-mix(in oklab,var(--color-fd-accent-foreground) 80%,transparent)',
      },
    },
  },
  itemLink: {
    backgroundColor: {
      default: null,
      ':not([data-active="true"]):hover': {
        '@media (hover: hover)': 'color-mix(in oklab,var(--color-fd-accent) 50%,transparent)',
      },
      ':is([data-active="true"])': 'color-mix(in oklab,var(--color-fd-primary) 10%,transparent)',
    },
    color: {
      default: 'var(--color-fd-muted-foreground)',
      ':not([data-active="true"]):hover': {
        '@media (hover: hover)':
          'color-mix(in oklab,var(--color-fd-accent-foreground) 80%,transparent)',
      },
      ':is([data-active="true"])': 'var(--color-fd-primary)',
    },
    transitionProperty: {
      default:
        'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
      ':not([data-active="true"]):hover': { '@media (hover: hover)': 'none' },
    },
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
  },
  itemHighlight: {
    ':is([data-active="true"])::before': {
      content: '""',
      backgroundColor: 'var(--color-fd-primary)',
      position: 'absolute',
      width: 1,
      'inset-block': 'calc(var(--spacing) * 2.5)',
      'inset-inline-start': 'calc(var(--spacing) * 2.5)',
    },
  },
  fullWidth: { width: '100%' },
  separator: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    marginBottom: { default: 'calc(var(--spacing) * 1)', ':empty': 0 },
    'padding-inline': 'calc(var(--spacing) * 2)',
    marginTop: 'calc(var(--spacing) * 6)',
    ':is(*) svg': {
      width: 'calc(var(--spacing) * 4)',
      height: 'calc(var(--spacing) * 4)',
      flexShrink: 0,
    },
  },
  firstSeparator: { marginTop: { default: 'calc(var(--spacing) * 6)', ':first-child': 0 } },
  folderChevron: {
    'margin-inline-start': 'auto',
    transitionProperty: 'transform, translate, scale, rotate',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
  },
  closedChevron: { rotate: { default: '-90deg', ':where([dir="rtl"], [dir="rtl"] *)': '90deg' } },
  folderContent: {
    position: 'relative',
    display: { default: 'flex', ':is([hidden]:not([hidden="until-found"]))': 'none' },
    flexDirection: 'column',
    gap: 'calc(var(--spacing) * .5)',
    paddingTop: 'calc(var(--spacing) * .5)',
    overflow: 'hidden',
    height: {
      default: 'var(--collapsible-panel-height)',
      ':is([data-starting-style])': 0,
      ':is([data-ending-style])': 0,
    },
    opacity: { default: null, ':is([data-starting-style])': 0, ':is([data-ending-style])': 0 },
    transitionProperty: 'height, opacity',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
  },
  folderRail: {
    '::before': {
      content: '""',
      position: 'absolute',
      width: 1,
      'inset-block': 'var(--spacing)',
      backgroundColor: 'var(--color-fd-border)',
      'inset-inline-start': 'calc(var(--spacing) * 2.5)',
    },
  },
  tabTrigger: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'var(--radius-lg)',
    padding: 'calc(var(--spacing) * 2)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    textAlign: 'start',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    backgroundColor: {
      default: 'color-mix(in oklab,var(--color-fd-secondary) 50%,transparent)',
      ':hover': { '@media (hover: hover)': 'var(--color-fd-accent)' },
      ':is([data-state="open"])': 'var(--color-fd-accent)',
    },
    color: {
      default: 'var(--color-fd-secondary-foreground)',
      ':is([data-state="open"])': 'var(--color-fd-accent-foreground)',
    },
  },
  tabIcon: {
    width: {
      default: 'calc(var(--spacing) * 9)',
      '@media (min-width:48rem)': 'calc(var(--spacing) * 5)',
    },
    height: {
      default: 'calc(var(--spacing) * 9)',
      '@media (min-width:48rem)': 'calc(var(--spacing) * 5)',
    },
    flexShrink: 0,
    ':empty': { display: 'none' },
  },
  tabTitle: {
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
  },
  tabDescription: {
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'var(--color-fd-muted-foreground)',
    display: { default: 'block', ':empty': 'none', '@media (min-width:48rem)': 'none' },
  },
  tabChevron: {
    flexShrink: 0,
    'margin-inline-start': 'auto',
    width: 'calc(var(--spacing) * 4)',
    height: 'calc(var(--spacing) * 4)',
    color: 'var(--color-fd-muted-foreground)',
  },
  positioner: { zIndex: 50 },
  tabPopup: {
    zIndex: 50,
    transformOrigin: 'var(--transform-origin)',
    overflowY: 'auto',
    maxHeight: 'var(--available-height)',
    minWidth: 240,
    maxWidth: '98vw',
    width: 'var(--radix-popover-trigger-width)',
    borderRadius: 'var(--radius-xl)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    backgroundColor: 'color-mix(in oklab,var(--color-fd-popover) 60%,transparent)',
    backdropFilter: 'blur(var(--blur-lg))',
    padding: 'var(--spacing)',
    color: 'var(--color-fd-popover-foreground)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    boxShadow: 'var(--shadow-lg)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--spacing)',
    outlineStyle: { default: null, ':focus-visible': 'none' },
    animationName: {
      default: 'none',
      ':is([data-open])': popoverIn,
      ':is([data-closed])': popoverOut,
    },
    animationDuration: '.1s',
    animationTimingFunction: 'ease',
    '::-webkit-scrollbar': { width: 5, height: 5 },
    '::-webkit-scrollbar-thumb': { borderRadius: 5, backgroundColor: 'var(--color-fd-border)' },
    '::-webkit-scrollbar-track': { backgroundColor: 'transparent' },
    '::-webkit-scrollbar-corner': { display: 'none' },
  },
  tabOption: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'var(--radius-lg)',
    padding: 'calc(var(--spacing) * 1.5)',
    backgroundColor: {
      default: null,
      ':hover': { '@media (hover: hover)': 'var(--color-fd-accent)' },
    },
    color: {
      default: null,
      ':hover': { '@media (hover: hover)': 'var(--color-fd-accent-foreground)' },
    },
  },
  optionIcon: { marginBottom: { default: null, '@media (min-width:48rem)': 'auto' } },
  optionTitle: {
    fontSize: 'var(--text-sm)',
    lineHeight: 1,
    fontWeight: 'var(--font-weight-medium)',
  },
  optionDescription: {
    fontSize: '.8125rem',
    color: 'var(--color-fd-muted-foreground)',
    marginTop: 'var(--spacing)',
    ':empty': { display: 'none' },
  },
  optionCheck: {
    flexShrink: 0,
    'margin-inline-start': 'auto',
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    color: 'var(--color-fd-primary)',
  },
});

function itemOffset(depth: number) {
  return `calc(${2 + 3 * depth} * var(--spacing))`;
}

function SidebarItem({ className, style, ...props }: ComponentProps<typeof SidebarItemBehavior>) {
  const depth = useFolderDepth();
  const sx = stylex.props(styles.item, styles.itemLink, depth >= 1 && styles.itemHighlight);
  return (
    <SidebarItemBehavior
      {...props}
      className={clsx(sx.className, className)}
      style={{ ...sx.style, paddingInlineStart: itemOffset(depth), ...style }}
    />
  );
}
function SidebarSeparator({ className, style, ...props }: ComponentProps<'p'>) {
  const depth = useFolderDepth();
  const sx = stylex.props(styles.separator, depth === 0 && styles.firstSeparator);
  return (
    <p
      {...props}
      className={clsx(sx.className, className)}
      style={{ ...sx.style, paddingInlineStart: itemOffset(depth), ...style }}
    />
  );
}
function FolderChevron() {
  const { open } = useFolder()!;
  return (
    <ChevronDown data-icon {...stylex.props(styles.folderChevron, !open && styles.closedChevron)} />
  );
}
function SidebarFolderTrigger({
  className,
  style,
  children,
  ...props
}: ComponentProps<typeof Collapsible.Trigger>) {
  const { depth, collapsible } = useFolder()!;
  const sx = stylex.props(styles.item, collapsible && styles.itemInteractive, styles.fullWidth);
  const mergedStyle = (state: Collapsible.Trigger.State) => ({
    ...sx.style,
    paddingInlineStart: itemOffset(depth - 1),
    ...(typeof style === 'function' ? style(state) : style),
  });
  if (!collapsible) {
    const state = { disabled: false, open: true, transitionStatus: undefined };
    return createElement(
      'div',
      {
        ...props,
        className: clsx(
          sx.className,
          typeof className === 'function' ? className(state) : className
        ),
        style: mergedStyle(state),
      },
      children
    );
  }
  return (
    <Collapsible.Trigger
      {...props}
      className={(state) =>
        clsx(sx.className, typeof className === 'function' ? className(state) : className)
      }
      style={mergedStyle}
    >
      {children}
      <FolderChevron />
    </Collapsible.Trigger>
  );
}
function SidebarFolderLink({
  active = false,
  className,
  style,
  children,
  ref: refProp,
  ...props
}: ComponentProps<typeof Link> & { active?: boolean }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const { open, setOpen, collapsible, depth } = useFolder()!;
  const { prefetch } = useSidebar();
  useAutoScroll(active, ref);
  const sx = stylex.props(
    styles.item,
    styles.itemLink,
    depth > 1 && styles.itemHighlight,
    styles.fullWidth
  );
  return (
    <Link
      ref={(node) => {
        ref.current = node;
        if (typeof refProp === 'function') refProp(node);
        else if (refProp) refProp.current = node;
      }}
      data-active={active}
      onClick={(event) => {
        if (!collapsible) return;
        if (event.target instanceof Element && event.target.matches('[data-icon], [data-icon] *')) {
          setOpen(!open);
          event.preventDefault();
        } else setOpen(active ? !open : true);
      }}
      prefetch={prefetch}
      {...props}
      className={clsx(sx.className, className)}
      style={{ ...sx.style, paddingInlineStart: itemOffset(depth - 1), ...style }}
    >
      {children}
      {collapsible && <FolderChevron />}
    </Link>
  );
}
function SidebarFolderContent({ className, ...props }: ComponentProps<typeof Collapsible.Panel>) {
  const depth = useFolderDepth();
  const sx = stylex.props(styles.folderContent, depth === 1 && styles.folderRail);
  return (
    <Collapsible.Panel
      {...props}
      className={(state) =>
        clsx(sx.className, typeof className === 'function' ? className(state) : className)
      }
    />
  );
}
const treeComponents = {
  SidebarFolder,
  SidebarFolderContent,
  SidebarFolderLink,
  SidebarFolderTrigger,
  SidebarItem,
  SidebarSeparator,
};
const SidebarPageTree = createPageTreeRenderer(treeComponents);
const SidebarLinkItem = createLinkItemRenderer(treeComponents);

function SidebarViewport({ children }: { children: ReactNode }) {
  return (
    <ScrollArea.Root {...stylex.props(styles.viewportRoot)}>
      <ScrollArea.Viewport {...stylex.props(styles.viewport)}>{children}</ScrollArea.Viewport>
      <ScrollArea.Corner />
      <ScrollArea.Scrollbar
        orientation="vertical"
        className={(state) =>
          stylex.props(styles.scrollbar, !state.hovering && styles.scrollbarHidden).className
        }
      >
        <ScrollArea.Thumb {...stylex.props(styles.thumb)} />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
}
function SidebarContent({ ref: refProp, className, children, ...props }: ComponentProps<'aside'>) {
  const ref = useRef<HTMLElement>(null);
  const { slots } = useDocsLayout();
  return (
    <SidebarContentBehavior>
      {({ collapsed, hovered, ref: behaviorRef, ...pointerProps }) => (
        <>
          <div data-sidebar-placeholder {...stylex.props(styles.placeholder)}>
            {collapsed && <div {...stylex.props(styles.hoverStrip)} {...pointerProps} />}
            <aside
              id="nd-sidebar"
              ref={(node) => {
                ref.current = node;
                behaviorRef.current = node;
                if (typeof refProp === 'function') refProp(node);
                else if (refProp) refProp.current = node;
              }}
              data-collapsed={collapsed}
              data-hovered={collapsed && hovered}
              {...stylex.props(
                styles.aside,
                collapsed && styles.collapsed,
                collapsed && hovered && styles.hovered,
                !!ref.current &&
                  (ref.current.getAttribute('data-collapsed') === 'true') !== collapsed &&
                  styles.changed
              )}
              {...props}
              {...pointerProps}
              className={clsx(
                stylex.props(
                  styles.aside,
                  collapsed && styles.collapsed,
                  collapsed && hovered && styles.hovered,
                  !!ref.current &&
                    (ref.current.getAttribute('data-collapsed') === 'true') !== collapsed &&
                    styles.changed
                ).className,
                className
              )}
            >
              {children}
            </aside>
          </div>
          <div
            data-sidebar-panel
            {...stylex.props(styles.collapsedPanel, (!collapsed || hovered) && styles.hiddenPanel)}
          >
            <SidebarCollapseTrigger {...stylex.props(styles.button)}>
              <SidebarIcon />
            </SidebarCollapseTrigger>
            {slots.searchTrigger && <slots.searchTrigger.sm hideIfDisabled />}
          </div>
        </>
      )}
    </SidebarContentBehavior>
  );
}
function SidebarDrawer({ children }: { children: ReactNode }) {
  const { open, mode } = useSidebar();
  const [hidden, setHidden] = useState(!open);
  if (open && hidden) setHidden(false);
  if (mode !== 'drawer') return null;
  return (
    <>
      <SidebarDrawerOverlay {...stylex.props(styles.overlay)} />
      <aside
        id="nd-sidebar-mobile"
        data-state={open ? 'open' : 'closed'}
        {...stylex.props(styles.drawer, hidden && styles.invisible)}
        onAnimationEnd={() => {
          if (!open) flushSync(() => setHidden(true));
        }}
      >
        {children}
      </aside>
    </>
  );
}
function SidebarTabsDropdown({ tabs }: { tabs: LayoutTab[] }) {
  const [open, setOpen] = useState(false);
  const { closeOnRedirect } = useSidebar();
  const pathname = usePathname();
  const selected = useMemo(
    () =>
      tabs
        .slice()
        .reverse()
        .find((item) => isLayoutTabActive(item, pathname)),
    [tabs, pathname]
  );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {selected && (
        <Popover.Trigger {...stylex.props(styles.tabTrigger)}>
          <div {...stylex.props(styles.tabIcon)}>{selected.icon}</div>
          <div>
            <p {...stylex.props(styles.tabTitle)}>{selected.title}</p>
            <p {...stylex.props(styles.tabDescription)}>{selected.description}</p>
          </div>
          <ChevronsUpDown {...stylex.props(styles.tabChevron)} />
        </Popover.Trigger>
      )}
      <Popover.Portal>
        <Popover.Positioner
          align="center"
          side="bottom"
          sideOffset={4}
          {...stylex.props(styles.positioner)}
        >
          <Popover.Popup {...stylex.props(styles.tabPopup)}>
            {tabs.map((item) => {
              const active = selected?.url === item.url;
              if (!active && item.unlisted) return null;
              return (
                <Link
                  key={item.url}
                  href={item.url}
                  onClick={() => {
                    closeOnRedirect.current = false;
                    setOpen(false);
                  }}
                  {...item.props}
                  className={clsx(stylex.props(styles.tabOption).className, item.props?.className)}
                >
                  <div {...stylex.props(styles.tabIcon, styles.optionIcon)}>{item.icon}</div>
                  <div>
                    <p {...stylex.props(styles.optionTitle)}>{item.title}</p>
                    <p {...stylex.props(styles.optionDescription)}>{item.description}</p>
                  </div>
                  <Check {...stylex.props(styles.optionCheck, !active && styles.invisible)} />
                </Link>
              );
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
export function DocsSidebar({
  footer,
  banner,
  collapsible = true,
  components,
  ...rest
}: SidebarProps) {
  const {
    menuItems,
    slots,
    props: { tabs, nav, tabMode },
  } = useDocsLayout();
  const iconLinks = menuItems.filter((item) => item.type === 'icon');
  const menuLinks = menuItems.filter((item) => item.type !== 'icon');
  const viewport = (
    <SidebarViewport>
      <div {...stylex.props(styles.tree)}>
        {menuLinks.map((item, i) => (
          <SidebarLinkItem
            key={i}
            item={item}
            {...stylex.props(i === menuLinks.length - 1 && styles.menuLast)}
          />
        ))}
        <SidebarPageTree {...components} />
      </div>
    </SidebarViewport>
  );
  return (
    <>
      <SidebarContent {...rest}>
        <div {...stylex.props(styles.heading)}>
          <div {...stylex.props(styles.titleRow)}>
            {slots.navTitle && <slots.navTitle />}
            {nav?.children}
            {collapsible && (
              <SidebarCollapseTrigger {...stylex.props(styles.button, styles.collapseButton)}>
                <SidebarIcon />
              </SidebarCollapseTrigger>
            )}
          </div>
          {slots.searchTrigger && <slots.searchTrigger.full hideIfDisabled />}
          {tabs.length > 0 && tabMode === 'auto' && <SidebarTabsDropdown tabs={tabs} />}
          {banner}
        </div>
        {viewport}
        {(slots.languageSelect || iconLinks.length > 0 || slots.themeSwitch || footer) && (
          <div {...stylex.props(styles.footer)}>
            {slots.languageSelect && (
              <slots.languageSelect.root variant="secondary" {...stylex.props(styles.language)}>
                <Languages {...stylex.props(styles.languageIcon)} />
                <slots.languageSelect.text />
                <ChevronDown {...stylex.props(styles.languageChevron)} />
              </slots.languageSelect.root>
            )}
            <div {...stylex.props(styles.iconLinks)}>
              {iconLinks.map((item, i) => (
                <LinkItem
                  key={i}
                  item={item}
                  aria-label={item.label}
                  {...stylex.props(styles.button)}
                >
                  {item.icon}
                </LinkItem>
              ))}
              {slots.themeSwitch && <slots.themeSwitch {...stylex.props(styles.theme)} />}
            </div>
            {footer}
          </div>
        )}
      </SidebarContent>
      <SidebarDrawer>
        <div {...stylex.props(styles.heading)}>
          <div {...stylex.props(styles.mobileTitleRow)}>
            <div {...stylex.props(styles.flexOne)}>
              {iconLinks.map((item, i) => (
                <LinkItem
                  key={i}
                  item={item}
                  aria-label={item.label}
                  {...stylex.props(styles.button, styles.mobileButton)}
                >
                  {item.icon}
                </LinkItem>
              ))}
            </div>
            {slots.languageSelect && (
              <slots.languageSelect.root>
                <Languages {...stylex.props(styles.languageIcon)} />
                <slots.languageSelect.text />
              </slots.languageSelect.root>
            )}
            {slots.themeSwitch && <slots.themeSwitch {...stylex.props(styles.mobileTheme)} />}
            <SidebarTrigger {...stylex.props(styles.button, styles.mobileButton)}>
              <SidebarIcon />
            </SidebarTrigger>
          </div>
          {tabs.length > 0 && <SidebarTabsDropdown tabs={tabs} />}
          {banner}
        </div>
        {viewport}
        <div {...stylex.props(styles.footer, styles.mobileFooter)}>{footer}</div>
      </SidebarDrawer>
    </>
  );
}

export const DocsSidebarSlots = {
  provider: SidebarProvider,
  root: DocsSidebar,
  trigger: SidebarTrigger,
  useSidebar,
} satisfies NonNullable<NonNullable<ComponentProps<typeof DocsLayout>['slots']>['sidebar']>;
