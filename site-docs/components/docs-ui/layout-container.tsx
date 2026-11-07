import * as stylex from '@stylexjs/stylex';
import { useDocsLayout } from 'fumadocs-ui/layouts/docs';
import { useEffect, useState, type ComponentProps, type CSSProperties } from 'react';
import { TOC_LAYOUT_CLASS_NAME } from './page-toc';

const styles = stylex.create({
  container: {
    display: 'grid',
    ':is(*) .fd-page-tree-item-name': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 'var(--spacing)',
      width: '100%',
    },
    overflowX: 'clip',
    minHeight: 'var(--fd-docs-height)',
    '--fd-docs-height': '100dvh',
    '--fd-header-height': {
      default: '0px',
      ':has(#nd-subnav)': {
        default: null,
        '@media (width < 48rem)': 'calc(var(--spacing) * 14)',
      },
    },
    '--fd-sidebar-width': {
      default: '0px',
      ':has([data-sidebar-placeholder])': {
        default: null,
        '@media (min-width: 48rem)': '268px',
      },
    },
    transitionProperty: {
      default: null,
      ':is([data-column-changed="true"])': 'grid-template-columns',
    },
    transitionTimingFunction: {
      default: null,
      ':is([data-column-changed="true"])': 'var(--default-transition-timing-function)',
    },
    transitionDuration: {
      default: null,
      ':is([data-column-changed="true"])': 'var(--default-transition-duration)',
    },
  },
});

type LayoutStyle = CSSProperties & {
  '--fd-docs-row-1': string;
  '--fd-docs-row-2': string;
  '--fd-docs-row-3': string;
  '--fd-sidebar-col': string;
};

type Props = ComponentProps<'div'> & { xstyle?: stylex.StyleXStyles };

export function DocsLayoutContainer({ className, style, xstyle, ...props }: Props) {
  const { slots } = useDocsLayout();
  const { collapsed } = slots.sidebar?.useSidebar?.() ?? {};
  const [previousCollapsed, setPreviousCollapsed] = useState(collapsed);
  const isCollapseChanged = previousCollapsed !== collapsed;

  useEffect(() => {
    if (isCollapseChanged) setPreviousCollapsed(collapsed);
  }, [collapsed, isCollapseChanged]);

  // Responsive slots write these public dimensions. Reader fallbacks keep their
  // zero defaults from overriding those writers across CSS layers.
  const layoutStyle: LayoutStyle = {
    gridTemplate: `"sidebar sidebar header toc toc"
"sidebar sidebar toc-popover toc toc"
"sidebar sidebar main toc toc" 1fr / minmax(min-content, 1fr) var(--fd-sidebar-col) minmax(0, calc(var(--fd-layout-width,97rem) - var(--fd-sidebar-width,0px) - var(--fd-toc-width,0px))) var(--fd-toc-width,0px) minmax(min-content, 1fr)`,
    '--fd-docs-row-1': 'var(--fd-banner-height, 0px)',
    '--fd-docs-row-2': 'calc(var(--fd-docs-row-1) + var(--fd-header-height,0px))',
    '--fd-docs-row-3': 'calc(var(--fd-docs-row-2) + var(--fd-toc-popover-height,0px))',
    '--fd-sidebar-col': collapsed ? '0px' : 'var(--fd-sidebar-width,0px)',
  };
  const sx = stylex.props(styles.container, xstyle);

  return (
    <div
      id="nd-docs-layout"
      data-sidebar-collapsed={collapsed}
      data-column-changed={isCollapseChanged}
      {...props}
      className={[sx.className, TOC_LAYOUT_CLASS_NAME, className].filter(Boolean).join(' ')}
      style={{ ...sx.style, ...layoutStyle, ...style }}
    />
  );
}
