import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import Link from 'fumadocs-core/link';
import type { HTMLAttributes, ReactNode } from 'react';

const styles = stylex.create({
  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 'calc(var(--spacing) * 3)',
    containerType: 'inline-size',
  },
  card: {
    display: 'block',
    borderRadius: 'var(--radius-xl)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    backgroundColor: 'var(--color-fd-card)',
    padding: 'calc(var(--spacing) * 4)',
    color: 'var(--color-fd-card-foreground)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    gridColumn: { default: null, '@container (width < 32rem)': '1 / -1' },
  },
  link: {
    backgroundColor: {
      default: 'var(--color-fd-card)',
      ':hover': {
        '@media (hover: hover)': 'color-mix(in oklab, var(--color-fd-accent) 80%, transparent)',
      },
    },
  },
  icon: {
    marginBottom: 'calc(var(--spacing) * 2)',
    width: 'fit-content',
    boxShadow: 'var(--shadow-md)',
    borderRadius: 'var(--radius-lg)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    backgroundColor: 'var(--color-fd-muted)',
    padding: 'calc(var(--spacing) * 1.5)',
    color: 'var(--color-fd-muted-foreground)',
    ':is(*) svg': { width: 'calc(var(--spacing) * 4)', height: 'calc(var(--spacing) * 4)' },
  },
  title: {
    marginBottom: 'var(--spacing)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
  },
  description: {
    'margin-block': '0 !important',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'var(--color-fd-muted-foreground)',
  },
  content: {
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'var(--color-fd-muted-foreground)',
    display: { default: 'block', ':empty': 'none' },
    ':is(*) > :first-child': { marginTop: 0 },
    ':is(*) > :last-child': { marginBottom: 0 },
  },
});

export function Cards({
  className,
  xstyle,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { xstyle?: stylex.StyleXStyles }) {
  const sx = stylex.props(styles.cards, xstyle);
  return (
    <div
      {...props}
      {...sx}
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
    />
  );
}

export type CardProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  href?: string;
  external?: boolean;
  xstyle?: stylex.StyleXStyles;
};

export function Card({
  icon,
  title,
  description,
  children,
  className,
  xstyle,
  style,
  ...props
}: CardProps) {
  const As = props.href ? Link : 'div';
  const sx = stylex.props(styles.card, Boolean(props.href) && styles.link, xstyle);
  return (
    <As
      {...props}
      {...sx}
      data-card
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
    >
      {icon ? (
        <div
          {...stylex.props(styles.icon)}
          className={clsx('not-prose', stylex.props(styles.icon).className)}
        >
          {icon}
        </div>
      ) : null}
      <h3
        {...stylex.props(styles.title)}
        className={clsx('not-prose', stylex.props(styles.title).className)}
      >
        {title}
      </h3>
      {description ? <p {...stylex.props(styles.description)}>{description}</p> : null}
      <div {...stylex.props(styles.content)}>{children}</div>
    </As>
  );
}
