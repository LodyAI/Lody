'use client';

// Popover presentation adapted from Fumadocs 16.8.12, copyright (c) 2023 Fuma.
// SPDX-License-Identifier: MIT. Scrollspy and track geometry remain in Fumadocs.
import { Collapsible } from '@base-ui/react/collapsible';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import * as CoreTOC from 'fumadocs-core/toc';
import { useItems, useTOCItems } from 'fumadocs-ui/components/toc';
import * as NormalTOC from 'fumadocs-ui/components/toc/default';
import * as ClerkTOC from 'fumadocs-ui/components/toc/clerk';
import { useI18n } from 'fumadocs-ui/contexts/i18n';
import { useTreePath } from 'fumadocs-ui/contexts/tree';
import { useDocsLayout } from 'fumadocs-ui/layouts/docs';
import type { TOCProps, TOCPopoverProps } from 'fumadocs-ui/layouts/docs/page/slots/toc';
import { ChevronDown, Text } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';

const layoutStyles = stylex.create({
  dimensions: {
    '--fd-toc-width': { default: null, '@media (min-width: 80rem)': { ':has(#nd-toc)': '268px' } },
    '--fd-toc-popover-height': {
      default: null,
      '@media (width < 80rem)': { ':has([data-toc-popover])': 'calc(var(--spacing) * 10)' },
    },
  },
});

/** Applied to the layout owner so these public dimensions reach its grid. */
export const TOC_LAYOUT_CLASS_NAME = stylex.props(layoutStyles.dimensions).className;

const styles = stylex.create({
  main: {
    position: 'sticky',
    top: 'var(--fd-docs-row-1)',
    height: 'calc(var(--fd-docs-height) - var(--fd-docs-row-1))',
    display: { default: 'flex', '@media (width < 80rem)': 'none' },
    flexDirection: 'column',
    gridArea: 'toc',
    width: 'var(--fd-toc-width)',
    paddingTop: 'calc(var(--spacing) * 12)',
    paddingInlineEnd: 'calc(var(--spacing) * 4)',
    paddingBottom: 'calc(var(--spacing) * 2)',
  },
  title: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    fontSize: 'var(--text-sm, 0.875rem)',
    lineHeight: 'var(--text-sm--line-height, calc(1.25 / 0.875))',
    color: 'var(--color-fd-muted-foreground)',
  },
  glyph: { width: 'calc(var(--spacing) * 4)', height: 'calc(var(--spacing) * 4)' },
  scroll: {
    position: 'relative',
    minHeight: 0,
    fontSize: 'var(--text-sm, 0.875rem)',
    lineHeight: 'var(--text-sm--line-height, calc(1.25 / 0.875))',
    marginInlineStart: '1px',
    overflow: 'auto',
    scrollbarWidth: 'none',
    maskImage:
      'linear-gradient(to bottom, transparent, white 16px, white calc(100% - 16px), transparent)',
    paddingBlock: 'calc(var(--spacing) * 3)',
  },
  normalScroll: {
    ':is(*) > div': { position: 'relative' },
    ':is(*) > div > div:first-child:not(:only-child)': {
      position: 'absolute',
      insetBlock: 0,
      insetInlineStart: 0,
      backgroundColor: 'var(--color-fd-primary)',
      width: '1px',
      transitionProperty: 'clip-path',
      transitionDuration: 'var(--default-transition-duration, 150ms)',
      transitionTimingFunction: 'var(--default-transition-timing-function)',
    },
  },
  normalList: {
    display: 'flex',
    flexDirection: 'column',
    borderInlineStartWidth: 1,
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: 'color-mix(in oklab, var(--color-fd-foreground) 10%, transparent)',
  },
  empty: {
    borderRadius: 'var(--radius-lg)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    backgroundColor: 'var(--color-fd-card)',
    padding: 'calc(var(--spacing) * 3)',
    fontSize: 'var(--text-xs, 0.75rem)',
    lineHeight: 'var(--text-xs--line-height, calc(1 / 0.75))',
    color: 'var(--color-fd-muted-foreground)',
  },
  link: {
    paddingBlock: 'calc(var(--spacing) * 1.5)',
    paddingTop: { default: 'calc(var(--spacing) * 1.5)', ':first-child': 0 },
    paddingBottom: { default: 'calc(var(--spacing) * 1.5)', ':last-child': 0 },
    fontSize: 'var(--text-sm, 0.875rem)',
    lineHeight: 'var(--text-sm--line-height, calc(1.25 / 0.875))',
    color: {
      default: 'var(--color-fd-muted-foreground)',
      ':is([data-active="true"])': 'var(--color-fd-primary)',
      '@media (hover: hover)': {
        ':hover': 'var(--color-fd-accent-foreground)',
        ':is([data-active="true"]):hover': 'var(--color-fd-primary)',
      },
    },
    scrollMargin: 'calc(var(--spacing) * 4)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: 'var(--default-transition-duration, 150ms)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    overflowWrap: 'anywhere',
  },
  firstLink: { paddingTop: 0 },
  lastLink: { paddingBottom: 0 },
  depthTwo: { paddingInlineStart: 'calc(var(--spacing) * 3)' },
  depthThree: { paddingInlineStart: 'calc(var(--spacing) * 6)' },
  depthFour: { paddingInlineStart: 'calc(var(--spacing) * 8)' },
  clerkList: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    ':is(*) > div:has(> svg)': {
      position: 'absolute',
      top: 0,
      insetInlineStart: 0,
      transformOrigin: 'center',
    },
    ':is(*) > div:has(> svg):dir(rtl)': { scale: '-1 1' },
    ':is(*) > div > svg': {
      position: 'absolute',
      transitionProperty: 'clip-path',
      transitionDuration: 'var(--default-transition-duration, 150ms)',
      transitionTimingFunction: 'var(--default-transition-timing-function)',
    },
    ':is(*) > div > svg > path': { stroke: 'var(--color-fd-primary)' },
    ':is(*) > div > svg circle': { fill: 'var(--color-fd-primary)' },
    ':is(*) > div > svg text': {
      fill: 'var(--color-fd-primary-foreground)',
      fontWeight: 'var(--font-weight-medium, 500)',
      fontSize: 'var(--text-xs, 0.75rem)',
      lineHeight: 1,
      fontFamily: 'var(--font-mono)',
    },
    ':is(*) > div > svg text:dir(rtl)': { scale: '-1 1' },
    ':is(*) > div:has(> svg) > div': {
      position: 'absolute',
      left: 0,
      width: 'calc(var(--spacing) * 1)',
      height: 'calc(var(--spacing) * 1)',
      backgroundColor: 'var(--color-fd-primary)',
      borderRadius: 'calc(infinity * 1px)',
      offsetDistance: 'var(--offset-distance, 0)',
      opacity: 'var(--opacity, 0)',
      transitionProperty: 'opacity, offset-distance',
      transitionDuration: 'var(--default-transition-duration, 150ms)',
      transitionTimingFunction: 'var(--default-transition-timing-function)',
    },
  },
  clerkLink: {
    position: 'relative',
    ':is(*) > svg': {
      position: 'absolute',
      top: 'calc(var(--spacing) * -1.5)',
      insetInlineStart: 0,
      bottom: 0,
      height: 'calc(100% + var(--spacing) * 1.5)',
      zIndex: -1,
    },
    ':is(*) > svg:dir(rtl)': { scale: '-1 1' },
    ':is(*) > svg path': {
      stroke: 'color-mix(in oklab, var(--color-fd-foreground) 10%, transparent)',
    },
    ':is(*) > svg line': {
      stroke: 'color-mix(in oklab, var(--color-fd-foreground) 10%, transparent)',
    },
    ':is(*) > svg circle': { fill: 'var(--color-fd-muted)' },
    ':is(*) > svg text': {
      fill: 'var(--color-fd-muted-foreground)',
      fontWeight: 'var(--font-weight-medium, 500)',
      fontSize: 'var(--text-xs, 0.75rem)',
      lineHeight: 1,
      fontFamily: 'var(--font-mono)',
    },
    ':is(*) > svg text:dir(rtl)': { scale: '-1 1' },
  },
  clerkCorner: {
    ':is(*) > svg': { height: '100%', bottom: 'calc(var(--spacing) * 1.5)' },
  },
  popover: {
    position: 'sticky',
    top: 'var(--fd-docs-row-2)',
    zIndex: 10,
    gridArea: 'toc-popover',
    height: 'var(--fd-toc-popover-height)',
    display: { default: 'block', '@media (min-width: 80rem)': 'none' },
  },
  popoverHeader: {
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: 'var(--color-fd-border)',
    backdropFilter: 'blur(var(--blur-sm, 8px))',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: 'var(--default-transition-duration, 150ms)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
  },
  opaqueHeader: {
    backgroundColor: 'color-mix(in oklab, var(--color-fd-background) 80%, transparent)',
  },
  openHeader: { boxShadow: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-lg)' },
  trigger: {
    display: 'flex',
    width: '100%',
    height: 'calc(var(--spacing) * 10)',
    alignItems: 'center',
    fontSize: 'var(--text-sm, 0.875rem)',
    lineHeight: 'var(--text-sm--line-height, calc(1.25 / 0.875))',
    color: 'var(--color-fd-muted-foreground)',
    gap: 'calc(var(--spacing) * 2.5)',
    paddingInline: {
      default: 'calc(var(--spacing) * 4)',
      '@media (min-width: 48rem)': 'calc(var(--spacing) * 6)',
    },
    paddingBlock: 'calc(var(--spacing) * 2.5)',
    textAlign: 'start',
    outlineStyle: { default: null, ':focus-visible': 'none' },
    ':is(*) svg': { width: 'calc(var(--spacing) * 4)', height: 'calc(var(--spacing) * 4)' },
  },
  progress: { flexShrink: 0 },
  openProgress: { color: 'var(--color-fd-primary)' },
  progressTrack: { stroke: 'color-mix(in oklab, currentColor 25%, transparent)' },
  progressValue: {
    transitionProperty: 'all',
    transitionDuration: 'var(--default-transition-duration, 150ms)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
  },
  labels: {
    display: 'grid',
    flex: '1',
    ':is(*) > *': { marginBlock: 'auto', gridRowStart: 1, gridColumnStart: 1 },
  },
  pageLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    transitionProperty: 'opacity, translate, color',
    transitionDuration: 'var(--default-transition-duration, 150ms)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
  },
  openLabel: { color: 'var(--color-fd-foreground)' },
  hiddenPageLabel: { opacity: 0, translate: '0 -100%', pointerEvents: 'none' },
  itemLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    transitionProperty: 'opacity, translate',
    transitionDuration: 'var(--default-transition-duration, 150ms)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
  },
  hiddenItemLabel: { opacity: 0, translate: '0 100%', pointerEvents: 'none' },
  chevron: {
    flexShrink: 0,
    transitionProperty: 'transform, translate, scale, rotate',
    transitionDuration: 'var(--default-transition-duration, 150ms)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    marginInline: 'calc(var(--spacing) * 0.5)',
  },
  openChevron: { rotate: '180deg' },
  panel: {
    overflow: 'hidden',
    display: { default: null, ':is([hidden]:not([hidden="until-found"]))': 'none' },
    height: {
      default: 'var(--collapsible-panel-height)',
      ':is([data-starting-style])': 0,
      ':is([data-ending-style])': 0,
    },
    opacity: { default: 1, ':is([data-starting-style])': 0, ':is([data-ending-style])': 0 },
    transitionProperty: 'height, opacity',
    transitionDuration: 'var(--default-transition-duration, 150ms)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
  },
  panelBody: {
    display: 'flex',
    flexDirection: 'column',
    paddingInline: {
      default: 'calc(var(--spacing) * 4)',
      '@media (min-width: 48rem)': 'calc(var(--spacing) * 6)',
    },
    maxHeight: '50vh',
  },
});

function ScrollViewport({ children, mode }: { children: ReactNode; mode: 'normal' | 'clerk' }) {
  const viewRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={viewRef} {...stylex.props(styles.scroll, mode === 'normal' && styles.normalScroll)}>
      <CoreTOC.ScrollProvider containerRef={viewRef}>{children}</CoreTOC.ScrollProvider>
    </div>
  );
}

function EmptyTOC() {
  const { text } = useI18n();
  return <div {...stylex.props(styles.empty)}>{text.tocNoHeadings}</div>;
}

function TOCList({
  mode,
  list,
  onClickItem,
}: {
  mode: 'normal' | 'clerk';
  list?: TOCProps['list'];
  onClickItem?: () => void;
}) {
  const items = useTOCItems();
  if (mode === 'clerk') {
    const { className, ...props } = list ?? {};
    return (
      <ClerkTOC.TOCItems
        {...props}
        className={clsx(stylex.props(styles.clerkList).className, className)}
      >
        {items.length === 0 && <EmptyTOC />}
        {items.map((item, index) => {
          const next = items[index + 1];
          const line = (depth: number) => (depth <= 2 ? 8 : depth === 3 ? 16 : 24);
          return (
            <ClerkTOC.TOCItem
              key={item.url}
              item={item}
              onClick={onClickItem}
              className={
                stylex.props(
                  styles.link,
                  styles.clerkLink,
                  index === 0 && styles.firstLink,
                  index === items.length - 1 && styles.lastLink,
                  next != null && line(item.depth) !== line(next.depth) && styles.clerkCorner
                ).className
              }
            />
          );
        })}
      </ClerkTOC.TOCItems>
    );
  }
  const { className, ...props } = list ?? {};
  return (
    <NormalTOC.TOCItems
      {...props}
      className={clsx(stylex.props(styles.normalList).className, className)}
    >
      {items.length === 0 && <EmptyTOC />}
      {items.map((item) => (
        <NormalTOC.TOCItem
          key={item.url}
          item={item}
          onClick={onClickItem}
          className={
            stylex.props(
              styles.link,
              item.depth <= 2
                ? styles.depthTwo
                : item.depth === 3
                  ? styles.depthThree
                  : styles.depthFour
            ).className
          }
        />
      ))}
    </NormalTOC.TOCItems>
  );
}

export function DocsPageTOC({ container, header, footer, style = 'normal', list }: TOCProps) {
  const { text } = useI18n();
  const sx = stylex.props(styles.main);
  return (
    <div
      id="nd-toc"
      {...container}
      className={clsx(sx.className, container?.className)}
      style={{ ...sx.style, ...container?.style }}
    >
      {header}
      <h3 id="toc-title" {...stylex.props(styles.title)}>
        <Text {...stylex.props(styles.glyph)} />
        {text.toc}
      </h3>
      <ScrollViewport mode={style}>
        <TOCList mode={style} list={list} />
      </ScrollViewport>
      {footer}
    </div>
  );
}

function ProgressCircle({ value, open }: { value: number; open: boolean }) {
  const radius = 18 / 2 - 1.5;
  const circumference = 2 * Math.PI * radius;
  const normalized = Math.min(1, Math.max(0, value));
  const circleProps = { cx: 9, cy: 9, r: radius, fill: 'none', strokeWidth: 1.5 };
  return (
    <svg
      role="progressbar"
      viewBox="0 0 18 18"
      aria-valuenow={normalized}
      aria-valuemin={0}
      aria-valuemax={1}
      {...stylex.props(styles.progress, open && styles.openProgress)}
      style={{ width: 18, height: 18 }}
    >
      <circle {...circleProps} {...stylex.props(styles.progressTrack)} />
      <circle
        {...circleProps}
        stroke="currentColor"
        strokeDasharray={circumference}
        strokeDashoffset={circumference - normalized * circumference}
        strokeLinecap="round"
        transform="rotate(-90 9 9)"
        {...stylex.props(styles.progressValue)}
      />
    </svg>
  );
}

function PopoverTrigger({
  open,
  ...props
}: NonNullable<TOCPopoverProps['trigger']> & { open: boolean }) {
  const { text } = useI18n();
  const items = useItems();
  const selectedIdx = items.findIndex((item) => item.active);
  let lastActiveIdx = -1;
  for (let index = 0; index < items.length; index++) {
    if (items[index].active) lastActiveIdx = index;
  }
  const path = useTreePath().at(-1);
  const showItem = selectedIdx !== -1 && !open;
  const sx = stylex.props(styles.trigger);
  return (
    <Collapsible.Trigger
      {...props}
      data-toc-popover-trigger=""
      className={clsx(sx.className, props.className)}
      style={{ ...sx.style, ...props.style }}
    >
      <ProgressCircle value={(lastActiveIdx + 1) / Math.max(1, items.length)} open={open} />
      <span {...stylex.props(styles.labels)}>
        <span
          {...stylex.props(
            styles.pageLabel,
            open && styles.openLabel,
            showItem && styles.hiddenPageLabel
          )}
        >
          {path?.name ?? text.toc}
        </span>
        <span {...stylex.props(styles.itemLabel, !showItem && styles.hiddenItemLabel)}>
          {items[selectedIdx]?.original.title}
        </span>
      </span>
      <ChevronDown {...stylex.props(styles.chevron, open && styles.openChevron)} />
    </Collapsible.Trigger>
  );
}

export function DocsPageTOCPopover({
  container,
  trigger,
  content,
  header,
  footer,
  style = 'normal',
  list,
}: TOCPopoverProps) {
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const { isNavTransparent } = useDocsLayout();
  const onClickOutside = useEffectEvent((event: MouseEvent) => {
    if (!open || !(event.target instanceof HTMLElement)) return;
    if (ref.current && !ref.current.contains(event.target)) setOpen(false);
  });
  useEffect(() => {
    window.addEventListener('click', onClickOutside);
    return () => window.removeEventListener('click', onClickOutside);
  }, []);
  const sx = stylex.props(styles.popover);
  const panel = stylex.props(styles.panel);
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      data-toc-popover=""
      {...container}
      className={clsx(sx.className, container?.className)}
      style={{ ...sx.style, ...container?.style }}
    >
      <header
        ref={ref}
        {...stylex.props(
          styles.popoverHeader,
          (!isNavTransparent || open) && styles.opaqueHeader,
          open && styles.openHeader
        )}
      >
        <PopoverTrigger {...trigger} open={open} />
        <Collapsible.Panel
          data-toc-popover-content=""
          {...content}
          className={clsx(panel.className, content?.className)}
          style={{ ...panel.style, ...content?.style }}
        >
          <div {...stylex.props(styles.panelBody)}>
            {header}
            <ScrollViewport mode={style}>
              <TOCList mode={style} list={list} onClickItem={() => setOpen(false)} />
            </ScrollViewport>
            {footer}
          </div>
        </Collapsible.Panel>
      </header>
    </Collapsible.Root>
  );
}
