import * as stylex from '@stylexjs/stylex';
import { usePathname } from 'fumadocs-core/framework';
import Link from 'fumadocs-core/link';
import { useI18n } from 'fumadocs-ui/contexts/i18n';
import type { FooterProps } from 'fumadocs-ui/layouts/docs/page';
import { useFooterItems } from 'fumadocs-ui/utils/use-footer-items';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo } from 'react';

const styles = stylex.create({
  root: { containerType: 'inline-size', display: 'grid', gap: 'calc(var(--spacing) * 4)' },
  single: { gridTemplateColumns: 'repeat(1, minmax(0, 1fr))' },
  paired: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'var(--radius-lg)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border, currentColor)',
    padding: 'calc(var(--spacing) * 4)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    transitionDuration: 'var(--default-transition-duration)',
    backgroundColor: {
      default: null,
      ':hover': {
        default: null,
        '@media (hover: hover)': 'color-mix(in oklab, var(--color-fd-accent) 80%, transparent)',
      },
    },
    color: {
      default: null,
      ':hover': { default: null, '@media (hover: hover)': 'var(--color-fd-accent-foreground)' },
    },
    gridColumn: { default: null, '@container (width < 32rem)': '1 / -1' },
  },
  next: { textAlign: 'end' },
  heading: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    fontWeight: 'var(--font-weight-medium)',
  },
  reversed: { flexDirection: 'row-reverse' },
  icon: {
    marginInline: 'calc(var(--spacing) * -1)',
    width: 'calc(var(--spacing) * 4)',
    height: 'calc(var(--spacing) * 4)',
    flexShrink: 0,
    rotate: { default: null, ':is(:where(:dir(rtl), [dir="rtl"], [dir="rtl"] *))': '180deg' },
  },
  description: {
    color: 'var(--color-fd-muted-foreground)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

function normalizedPath(path: string) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

export function DocsPageFooter({ items, children, className, style, ...props }: FooterProps) {
  const footerList = useFooterItems();
  const pathname = usePathname();
  const { previous, next } = useMemo(() => {
    if (items) return items;
    const index = footerList.findIndex(
      (item) => normalizedPath(item.url) === normalizedPath(pathname)
    );
    if (index === -1) return {};
    return { previous: footerList[index - 1], next: footerList[index + 1] };
  }, [footerList, items, pathname]);
  const sx = stylex.props(styles.root, previous && next ? styles.paired : styles.single);

  return (
    <>
      <div
        {...props}
        className={[sx.className, className].filter(Boolean).join(' ')}
        style={{ ...sx.style, ...style }}
      >
        {previous && <FooterItem item={previous} next={false} />}
        {next && <FooterItem item={next} next />}
      </div>
      {children}
    </>
  );
}

function FooterItem({
  item,
  next,
}: {
  item: NonNullable<NonNullable<FooterProps['items']>['previous']>;
  next: boolean;
}) {
  const { text } = useI18n();
  const Icon = next ? ChevronRight : ChevronLeft;

  return (
    <Link href={item.url} {...stylex.props(styles.item, next && styles.next)}>
      <div {...stylex.props(styles.heading, next && styles.reversed)}>
        <Icon {...stylex.props(styles.icon)} />
        <p>{item.name}</p>
      </div>
      <p {...stylex.props(styles.description)}>
        {item.description ?? (next ? text.nextPage : text.previousPage)}
      </p>
    </Link>
  );
}
