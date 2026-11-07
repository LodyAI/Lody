import * as stylex from '@stylexjs/stylex';
import '@site/app/reading-prose.css';
import type { ComponentProps } from 'react';

const styles = stylex.create({
  title: {
    fontSize: '1.75em',
    fontWeight: 'var(--font-weight-semibold)',
  },
  description: {
    marginBottom: 'calc(var(--spacing) * 8)',
    fontSize: 'var(--text-lg)',
    lineHeight: 'var(--text-lg--line-height)',
    color: 'var(--color-fd-muted-foreground)',
  },
  body: {
    flex: '1',
    ':is(*) :where(hr + *, h2 + *, h3 + *, h4 + *):not(:where(.not-prose, .not-prose *))': {
      marginTop: 0,
    },
    ':is(*) > :first-child:not(:where(.not-prose, .not-prose *))': { marginTop: 0 },
    ':is(*) > :last-child:not(:where(.not-prose, .not-prose *))': { marginBottom: 0 },
  },
});

type TitleProps = ComponentProps<'h1'> & { xstyle?: stylex.StyleXStyles };
type DescriptionProps = ComponentProps<'p'> & { xstyle?: stylex.StyleXStyles };
type BodyProps = ComponentProps<'div'> & { xstyle?: stylex.StyleXStyles };

export function DocsTitle({ className, style, xstyle, ...props }: TitleProps) {
  const sx = stylex.props(styles.title, xstyle);
  return (
    <h1
      {...props}
      className={[sx.className, className].filter(Boolean).join(' ')}
      style={{ ...sx.style, ...style }}
    />
  );
}

export function DocsDescription({
  children,
  className,
  style,
  xstyle,
  ...props
}: DescriptionProps) {
  if (children === undefined) return null;
  const sx = stylex.props(styles.description, xstyle);
  return (
    <p
      {...props}
      className={[sx.className, className].filter(Boolean).join(' ')}
      style={{ ...sx.style, ...style }}
    >
      {children}
    </p>
  );
}

export function DocsBody({ className, style, xstyle, ...props }: BodyProps) {
  const sx = stylex.props(styles.body, xstyle);
  return (
    <div
      {...props}
      className={['reading-prose', sx.className, className].filter(Boolean).join(' ')}
      style={{ ...sx.style, ...style }}
    />
  );
}
