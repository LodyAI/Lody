import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { CircleCheck, CircleX, Info, Lightbulb, TriangleAlert } from 'lucide-react';
import type { ComponentProps, CSSProperties, ReactNode } from 'react';

const styles = stylex.create({
  container: {
    display: 'flex',
    gap: 'calc(var(--spacing) * 2)',
    'margin-block': 'calc(var(--spacing) * 4)',
    borderRadius: 'var(--radius-xl)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    backgroundColor: 'var(--color-fd-card)',
    'padding-block': 'calc(var(--spacing) * 3)',
    'padding-inline-end': 'calc(var(--spacing) * 3)',
    'padding-inline-start': 'var(--spacing)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'var(--color-fd-card-foreground)',
    boxShadow: 'var(--shadow-md)',
  },
  rail: {
    width: 'calc(var(--spacing) * .5)',
    backgroundColor: 'color-mix(in oklab, var(--callout-color) 50%, transparent)',
    borderRadius: 'var(--radius-sm)',
  },
  icon: {
    width: 'calc(var(--spacing) * 5)',
    height: 'calc(var(--spacing) * 5)',
    'margin-inline-end': 'calc(var(--spacing) * -.5)',
    fill: 'var(--callout-color)',
    color: 'var(--color-fd-card)',
  },
  idea: { color: 'var(--callout-color)' },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'calc(var(--spacing) * 2)',
    minWidth: 0,
    flex: '1 1 0%',
  },
  title: { fontWeight: 'var(--font-weight-medium)', 'margin-block': '0 !important' },
  description: {
    color: 'var(--color-fd-muted-foreground)',
    display: { default: 'block', ':empty': 'none' },
    ':is(*) > :first-child': { marginTop: 0 },
    ':is(*) > :last-child': { marginBottom: 0 },
  },
});

export type CalloutType = 'info' | 'warn' | 'warning' | 'tip' | 'error' | 'success' | 'idea';
export type CalloutContainerProps = ComponentProps<'div'> & {
  type?: CalloutType;
  icon?: ReactNode;
  xstyle?: stylex.StyleXStyles;
};

const icons = {
  info: Info,
  warning: TriangleAlert,
  error: CircleX,
  success: CircleCheck,
  idea: Lightbulb,
};

export function CalloutContainer({
  type: inputType = 'info',
  icon,
  children,
  className,
  style,
  xstyle,
  ...props
}: CalloutContainerProps) {
  const type = inputType === 'warn' ? 'warning' : inputType === 'tip' ? 'info' : inputType;
  const Icon = icons[type];
  const sx = stylex.props(styles.container, xstyle);
  return (
    <div
      {...props}
      {...sx}
      className={clsx(sx.className, className)}
      style={
        {
          '--callout-color': `var(--color-fd-${type}, var(--color-fd-muted))`,
          ...sx.style,
          ...style,
        } as CSSProperties
      }
    >
      <div role="none" {...stylex.props(styles.rail)} />
      {icon ??
        (Icon ? <Icon {...stylex.props(styles.icon, type === 'idea' && styles.idea)} /> : null)}
      <div {...stylex.props(styles.content)}>{children}</div>
    </div>
  );
}

export function CalloutTitle({ className, ...props }: ComponentProps<'p'>) {
  const sx = stylex.props(styles.title);
  return <p {...props} {...sx} className={clsx(sx.className, className)} />;
}

export function CalloutDescription({ className, ...props }: ComponentProps<'div'>) {
  const sx = stylex.props(styles.description);
  return <div {...props} {...sx} className={clsx(sx.className, className)} />;
}

export function Callout({
  children,
  title,
  ...props
}: Omit<CalloutContainerProps, 'title'> & { title?: ReactNode }) {
  return (
    <CalloutContainer {...props}>
      {title && <CalloutTitle>{title}</CalloutTitle>}
      <CalloutDescription>{children}</CalloutDescription>
    </CalloutContainer>
  );
}
