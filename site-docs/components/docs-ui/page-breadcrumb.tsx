import * as stylex from '@stylexjs/stylex';
import { getBreadcrumbItemsFromPath } from 'fumadocs-core/breadcrumb';
import Link from 'fumadocs-core/link';
import { useTreeContext, useTreePath } from 'fumadocs-ui/contexts/tree';
import type { BreadcrumbProps } from 'fumadocs-ui/layouts/docs/page';
import { ChevronRight } from 'lucide-react';
import { Fragment, useMemo } from 'react';

const styles = stylex.create({
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'var(--color-fd-muted-foreground)',
  },
  item: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  current: { color: 'var(--color-fd-primary)', fontWeight: 'var(--font-weight-medium)' },
  separator: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
  },
  link: {
    transitionProperty: 'opacity',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    transitionDuration: 'var(--default-transition-duration)',
    opacity: { default: null, ':hover': { default: null, '@media (hover: hover)': 0.8 } },
  },
});

export function DocsPageBreadcrumb({
  includeRoot,
  includeSeparator,
  includePage,
  className,
  style,
  ...props
}: BreadcrumbProps) {
  const path = useTreePath();
  const { root } = useTreeContext();
  const items = useMemo(
    () => getBreadcrumbItemsFromPath(root, path, { includePage, includeSeparator, includeRoot }),
    [includePage, includeRoot, includeSeparator, path, root]
  );
  if (items.length === 0) return null;
  const sx = stylex.props(styles.root);

  return (
    <div
      {...props}
      className={[sx.className, className].filter(Boolean).join(' ')}
      style={{ ...sx.style, ...style }}
    >
      {items.map((item, index) => (
        <Fragment key={index}>
          {index !== 0 && <ChevronRight {...stylex.props(styles.separator)} />}
          {item.url ? (
            <Link
              href={item.url}
              {...stylex.props(
                styles.item,
                index === items.length - 1 && styles.current,
                styles.link
              )}
            >
              {item.name}
            </Link>
          ) : (
            <span {...stylex.props(styles.item, index === items.length - 1 && styles.current)}>
              {item.name}
            </span>
          )}
        </Fragment>
      ))}
    </div>
  );
}
