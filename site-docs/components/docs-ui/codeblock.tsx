'use client';

import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import {
  CodeBlock as BehaviorCodeBlock,
  CodeBlockTab,
  CodeBlockTabs as BehaviorCodeBlockTabs,
  CodeBlockTabsList as BehaviorCodeBlockTabsList,
  CodeBlockTabsTrigger as BehaviorCodeBlockTabsTrigger,
  Pre as BehaviorPre,
} from 'fumadocs-ui/components/codeblock';
import type { ComponentProps } from 'react';
import '@site/app/reading-code.css';

const TAB_SCOPE = ':is([data-reading-code-tabs] *)';
const styles = stylex.create({
  figure: {
    position: 'relative',
    marginBlock: { default: 'calc(var(--spacing) * 4)', [TAB_SCOPE]: 0 },
    marginInline: { default: 0, [TAB_SCOPE]: -1 },
    marginBottom: { default: 'calc(var(--spacing) * 4)', [TAB_SCOPE]: -1 },
    backgroundColor: { default: 'var(--color-fd-card)', [TAB_SCOPE]: 'var(--color-fd-secondary)' },
    borderRadius: { default: 'var(--radius-xl)', [TAB_SCOPE]: 0 },
    borderBottomLeftRadius: {
      default: 'var(--radius-xl)',
      [TAB_SCOPE]: { default: 0, ':last-child': 'var(--radius-xl)' },
    },
    borderBottomRightRadius: {
      default: 'var(--radius-xl)',
      [TAB_SCOPE]: { default: 0, ':last-child': 'var(--radius-xl)' },
    },
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    boxShadow: '0 2px 4px 0 rgb(0 0 0 / .1), 0 1px 2px -1px rgb(0 0 0 / .1)',
    overflow: 'hidden',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    ':is([data-code-title]) > div:not([role="region"])': {
      display: 'flex',
      color: 'var(--color-fd-muted-foreground)',
      alignItems: 'center',
      gap: 'calc(var(--spacing) * 2)',
      height: 'calc(var(--spacing) * 9.5)',
      borderBottomWidth: 1,
      borderBottomStyle: 'solid',
      borderBottomColor: 'var(--color-fd-border)',
      paddingInline: 'calc(var(--spacing) * 4)',
    },
    ':is([data-code-title]) > div > figcaption': {
      flex: '1',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    ':is([data-code-title]) > div > div > svg': {
      width: 'calc(var(--spacing) * 3.5)',
      height: 'calc(var(--spacing) * 3.5)',
    },
  },
  shikiBackground: {
    backgroundColor: {
      default: 'var(--shiki-light-bg)',
      ':where(.dark, .dark *)': 'var(--shiki-dark-bg)',
    },
  },
  viewport: {
    fontSize: '0.8125rem',
    paddingBlock: 'calc(var(--spacing) * 3.5)',
    overflow: 'auto',
    maxHeight: 600,
    outlineStyle: { default: null, ':focus-visible': 'none' },
    boxShadow: { default: null, ':focus-visible': 'inset 0 0 0 2px var(--color-fd-ring)' },
    '::-webkit-scrollbar': { width: 5, height: 5 },
    '::-webkit-scrollbar-thumb': { borderRadius: 5, backgroundColor: 'var(--color-fd-border)' },
    '::-webkit-scrollbar-track': { backgroundColor: 'transparent' },
    '::-webkit-scrollbar-corner': { display: 'none' },
  },
  pre: {
    minWidth: '100%',
    width: 'max-content',
    ':is(*) > *': { display: 'flex', flexDirection: 'column' },
  },
  actions: {
    display: { default: 'block', ':empty': 'none' },
    ':is(*) > button': {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 'var(--radius-md)',
      padding: 'var(--spacing)',
      fontSize: 'var(--text-sm)',
      lineHeight: 'var(--text-sm--line-height)',
      fontWeight: 'var(--font-weight-medium)',
      transitionProperty:
        'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
      transitionDuration: '100ms',
      transitionTimingFunction: 'var(--default-transition-timing-function)',
    },
    ':is(*) > button:disabled': { pointerEvents: 'none', opacity: 0.5 },
    ':is(*) > button:focus-visible': {
      outlineStyle: 'none',
      boxShadow: '0 0 0 2px var(--color-fd-ring)',
    },
    ':is(*) > button[data-checked]': { color: 'var(--color-fd-accent-foreground)' },
    '@media (hover: hover)': {
      ':is(*) > button:hover': { color: 'var(--color-fd-accent-foreground)' },
    },
    ':is(*) > button svg': {
      width: 'calc(var(--spacing) * 4)',
      height: 'calc(var(--spacing) * 4)',
    },
  },
  headerActions: { marginInlineEnd: 'calc(var(--spacing) * -2)' },
  floatingActions: {
    position: 'absolute',
    top: 'calc(var(--spacing) * 2)',
    right: 'calc(var(--spacing) * 2)',
    zIndex: 2,
    backdropFilter: 'blur(var(--blur-lg))',
    borderRadius: 'var(--radius-lg)',
    color: 'var(--color-fd-muted-foreground)',
  },
  tabs: {
    backgroundColor: 'var(--color-fd-card)',
    borderRadius: 'var(--radius-xl)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    marginBlock: { default: 'calc(var(--spacing) * 4)', [TAB_SCOPE]: 0 },
  },
  tabsList: {
    display: 'flex',
    flexDirection: 'row',
    paddingInline: 'calc(var(--spacing) * 2)',
    overflowX: 'auto',
    color: 'var(--color-fd-muted-foreground)',
  },
  tab: {
    position: 'relative',
    display: 'inline-flex',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    textWrap: 'nowrap',
    alignItems: 'center',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    gap: 'calc(var(--spacing) * 2)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1.5)',
    color: {
      default: 'inherit',
      '@media (hover: hover)': { ':hover': 'var(--color-fd-accent-foreground)' },
    },
    '--code-tab-ink': 'transparent',
    ':is(*) svg': { width: 'calc(var(--spacing) * 3.5)', height: 'calc(var(--spacing) * 3.5)' },
    ':is(*) > div:first-child': {
      position: 'absolute',
      insetInline: 'calc(var(--spacing) * 2)',
      bottom: 0,
      height: 1,
      backgroundColor: 'var(--code-tab-ink)',
    },
  },
  selectedTab: { color: 'var(--color-fd-primary)', '--code-tab-ink': 'var(--color-fd-primary)' },
});

export function Pre({ className, ...props }: ComponentProps<typeof BehaviorPre>) {
  return <BehaviorPre {...props} className={clsx(stylex.props(styles.pre).className, className)} />;
}

export function CodeBlock({
  className,
  style,
  viewportProps = {},
  Actions,
  ...props
}: ComponentProps<typeof BehaviorCodeBlock>) {
  const sx = stylex.props(styles.figure, props.keepBackground && styles.shikiBackground);
  const viewport = stylex.props(styles.viewport);
  return (
    <BehaviorCodeBlock
      {...props}
      data-code-title={props.title ? '' : undefined}
      className={clsx(sx.className, className)}
      style={{ ...sx.style, ...style }}
      viewportProps={{
        ...viewportProps,
        className: clsx(viewport.className, viewportProps.className),
        style: { ...viewport.style, ...viewportProps.style },
      }}
      Actions={
        Actions ??
        (({ children }) => (
          <div
            {...stylex.props(
              styles.actions,
              props.title ? styles.headerActions : styles.floatingActions
            )}
          >
            {children}
          </div>
        ))
      }
    />
  );
}

export function CodeBlockTabs({
  className,
  ...props
}: ComponentProps<typeof BehaviorCodeBlockTabs>) {
  return (
    <BehaviorCodeBlockTabs
      {...props}
      data-reading-code-tabs=""
      className={(state) =>
        clsx(
          stylex.props(styles.tabs).className,
          typeof className === 'function' ? className(state) : className
        )
      }
    />
  );
}
export function CodeBlockTabsList({
  className,
  ...props
}: ComponentProps<typeof BehaviorCodeBlockTabsList>) {
  return (
    <BehaviorCodeBlockTabsList
      {...props}
      className={(state) =>
        clsx(
          stylex.props(styles.tabsList).className,
          typeof className === 'function' ? className(state) : className
        )
      }
    />
  );
}
export function CodeBlockTabsTrigger({
  className,
  ...props
}: ComponentProps<typeof BehaviorCodeBlockTabsTrigger>) {
  return (
    <BehaviorCodeBlockTabsTrigger
      {...props}
      className={(state) =>
        clsx(
          stylex.props(styles.tab, state.active && styles.selectedTab).className,
          typeof className === 'function' ? className(state) : className
        )
      }
    />
  );
}
export { CodeBlockTab };
