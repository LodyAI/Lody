'use client';

import { Accordion as BaseAccordion } from '@base-ui/react/accordion';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { useCopyButton } from 'fumadocs-ui/utils/use-copy-button';
import { Check, ChevronRight, LinkIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';

const styles = stylex.create({
  root: {
    overflow: 'hidden',
    borderRadius: 'var(--radius-lg)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    backgroundColor: 'var(--color-fd-card)',
    ':is(*) > :not(:last-child)': {
      borderBottomStyle: 'solid',
      borderTopStyle: 'solid',
      borderTopWidth: 0,
      borderBottomWidth: '1px',
      borderColor: 'var(--color-fd-border)',
    },
  },
  header: {
    scrollMargin: 'calc(var(--spacing) * 24)',
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    color: 'var(--color-fd-card-foreground)',
    fontWeight: 'var(--font-weight-medium)',
    backgroundColor: { default: null, ':has(:focus-visible)': 'var(--color-fd-accent)' },
  },
  trigger: {
    display: 'flex',
    flex: '1 1 0%',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2.5)',
    textAlign: 'start',
    outlineStyle: { default: null, ':focus-visible': 'none' },
  },
  chevron: {
    width: 'calc(var(--spacing) * 4)',
    height: 'calc(var(--spacing) * 4)',
    flexShrink: 0,
    color: 'var(--color-fd-muted-foreground)',
    transitionProperty: 'transform, translate, scale, rotate',
    transitionDuration: '.2s',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    rotate: { default: 'none', ':is([data-docs-accordion-trigger][data-panel-open] *)': '90deg' },
  },
  panel: {
    height: {
      default: 'var(--accordion-panel-height)',
      ':is([data-ending-style])': 0,
      ':is([data-starting-style])': 0,
    },
    overflow: 'hidden',
    transitionProperty: 'height',
    transitionTimingFunction: 'var(--ease-out)',
    transitionDuration: 'var(--default-transition-duration)',
  },
  content: {
    paddingInline: 'calc(var(--spacing) * 4)',
    paddingBottom: 'calc(var(--spacing) * 2)',
    fontSize: '.9375rem',
    display: { default: 'block', ':is([hidden]:not([hidden="until-found"]))': 'none' },
    ':is(*) > :first-child': { marginTop: 0 },
    ':is(*) > :last-child': { marginBottom: 0 },
  },
  copy: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'var(--radius-md)',
    padding: 'calc(var(--spacing) * 2)',
    'margin-inline-end': 'calc(var(--spacing) * 2)',
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
      default: 'var(--color-fd-muted-foreground)',
      ':hover': { '@media (hover: hover)': 'var(--color-fd-accent-foreground)' },
    },
  },
  copyIcon: { width: 'calc(var(--spacing) * 3.5)', height: 'calc(var(--spacing) * 3.5)' },
});

export function Accordions({
  ref,
  className,
  defaultValue,
  style,
  xstyle,
  ...props
}: ComponentProps<typeof BaseAccordion.Root> & { xstyle?: stylex.StyleXStyles }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(defaultValue ?? []);
  const sx = stylex.props(styles.root, xstyle);
  useEffect(() => {
    const id = window.location.hash.substring(1);
    const element = rootRef.current;
    if (!element || id.length === 0) return;
    const selected = document.getElementById(id);
    if (!selected || !element.contains(selected)) return;
    const selectedValue = selected.getAttribute('data-accordion-value');
    if (selectedValue) setValue((previous) => [selectedValue, ...previous]);
  }, []);
  return (
    <BaseAccordion.Root
      ref={(node) => {
        rootRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      value={value}
      onValueChange={setValue}
      className={(state) =>
        clsx(sx.className, typeof className === 'function' ? className(state) : className)
      }
      style={
        sx.style
          ? (state) => ({ ...sx.style, ...(typeof style === 'function' ? style(state) : style) })
          : style
      }
      {...props}
    />
  );
}

function CopyButton({ id }: { id: string }) {
  const [checked, onClick] = useCopyButton(() => {
    const url = new URL(window.location.href);
    url.hash = id;
    return navigator.clipboard.writeText(url.toString());
  });
  return (
    <button type="button" aria-label="Copy Link" {...stylex.props(styles.copy)} onClick={onClick}>
      {checked ? (
        <Check {...stylex.props(styles.copyIcon)} />
      ) : (
        <LinkIcon {...stylex.props(styles.copyIcon)} />
      )}
    </button>
  );
}

export function Accordion({
  title,
  id,
  value = String(title),
  children,
  ...props
}: Omit<ComponentProps<typeof BaseAccordion.Item>, 'value' | 'title'> & {
  title: ReactNode;
  value?: string;
}) {
  return (
    <BaseAccordion.Item value={value} {...props}>
      <BaseAccordion.Header
        id={id}
        data-accordion-value={value}
        className={clsx('not-prose', stylex.props(styles.header).className)}
      >
        <BaseAccordion.Trigger data-docs-accordion-trigger {...stylex.props(styles.trigger)}>
          <ChevronRight {...stylex.props(styles.chevron)} />
          {title}
        </BaseAccordion.Trigger>
        {id ? <CopyButton id={id} /> : null}
      </BaseAccordion.Header>
      <BaseAccordion.Panel hiddenUntilFound {...stylex.props(styles.panel)}>
        <div {...stylex.props(styles.content)}>{children}</div>
      </BaseAccordion.Panel>
    </BaseAccordion.Item>
  );
}
