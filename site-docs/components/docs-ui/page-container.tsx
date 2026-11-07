import * as stylex from '@stylexjs/stylex';
import { useDocsPage } from 'fumadocs-ui/layouts/docs/page';
import type { ComponentProps } from 'react';

const styles = stylex.create({
  page: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    maxWidth: 900,
    marginInline: 'auto',
    gridArea: 'main',
    paddingInline: {
      default: 'calc(var(--spacing) * 4)',
      '@media (width >= 48rem)': 'calc(var(--spacing) * 6)',
      '@media (width >= 80rem)': 'calc(var(--spacing) * 8)',
    },
    'padding-block': 'calc(var(--spacing) * 6)',
    paddingTop: {
      default: null,
      '@media (width >= 48rem)': 'calc(var(--spacing) * 8)',
      '@media (width >= 80rem)': 'calc(var(--spacing) * 14)',
    },
    gap: 'calc(var(--spacing) * 4)',
  },
  full: { maxWidth: 1168 },
});

type Props = ComponentProps<'article'> & { xstyle?: stylex.StyleXStyles };

export function DocsPageContainer({ className, style, xstyle, ...props }: Props) {
  const {
    props: { full },
  } = useDocsPage();
  const sx = stylex.props(styles.page, full && styles.full, xstyle);
  return (
    <article
      id="nd-page"
      data-full={full}
      {...props}
      className={[sx.className, className].filter(Boolean).join(' ')}
      style={{ ...sx.style, ...style }}
    />
  );
}
