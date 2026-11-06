'use client';

import React, { useLayoutEffect, useRef } from 'react';
import { Fade } from '@/ui/blur-fade/blur-fade';
import { clsx } from 'clsx';

import { ChevronDown } from 'lucide-react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { Button } from '@lody/ui/button';
import { CopyButton } from './copy-button';
import { clamp } from '@/lib/clamp';
import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeDuration,
  themeFontSize,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../style/theme-scale.stylex';

const expand = stylex.keyframes({
  from: { height: 0 },
  to: { height: 'var(--radix-collapsible-content-height)' },
});
const collapse = stylex.keyframes({
  from: { height: 'var(--radix-collapsible-content-height)' },
  to: { height: 0 },
});

const styles = stylex.create({
  card: {
    position: 'relative',
    display: 'flex',
    minHeight: themeSpace[14],
    flexDirection: 'column',
    borderRadius: themeRadius.xl,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: themeColors.border,
    backgroundColor: themeColors.card,
    boxShadow: 'none',
  },
  clipped: { overflow: 'hidden' },
  header: {
    height: themeSpace[14],
    zIndex: 20,
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
    justifyContent: 'space-between',
  },
  sticky: { position: 'sticky', top: 0 },
  absolute: { position: 'absolute', insetInline: themeSpace[4] },
  relative: { position: 'relative' },
  glyph: {
    height: themeSpace[4],
    width: themeSpace[4],
    transitionProperty: 'transform, translate, scale, rotate',
    transitionDuration: themeDuration[200],
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    rotate: { default: null, ':is([data-state="closed"] *)': '-90deg' },
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minWidth: 0,
    overflow: 'hidden',
  },
  title: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
    textWrap: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
  content: {
    position: 'relative',
    height: { default: null, ':is([data-state="closed"])': 0 },
    animationName: {
      default: null,
      ':is([data-state="open"])': expand,
      ':is([data-state="closed"])': collapse,
    },
    animationDuration: '.2s',
    animationTimingFunction: 'ease-out',
  },
  copy: {
    opacity: {
      default: 0,
      ':is([data-collapsible-title-row]:hover *)': { default: null, '@media (hover: hover)': 1 },
      ':is([data-state="copied"])': 1,
    },
  },
  horizontalScroll: {
    overflowX: 'auto',
    overflow: { default: null, ':is([data-state="closed"])': 'hidden' },
  },
  body: {
    maxHeight: '70svh',
    paddingTop: themeSpace[14],
    paddingBottom: themeSpace[4],
    overflow: 'auto',
  },
  externalBody: { paddingBottom: themeSpace[4] },
  fade: {
    insetInline: 0,
    top: 0,
    height: 'calc(var(--spacing) * 17)',
    zIndex: 10,
    borderTopLeftRadius: themeRadius.xl,
    borderTopRightRadius: themeRadius.xl,
  },
});

type CollapsibleCardProps = Collapsible.CollapsibleProps & {
  /** When true, removes overflow-hidden to allow sticky children to work with outer scroll containers */
  allowStickyChildren?: boolean;
  xstyle?: stylex.StyleXStyles;
};

const CollapsibleCard = ({
  className,
  xstyle,
  children,
  allowStickyChildren = false,
  ...props
}: CollapsibleCardProps) => {
  const sx = stylex.props(styles.card, !allowStickyChildren && styles.clipped, xstyle);
  return (
    <Collapsible.Root
      {...props}
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...props.style } : props.style}
    >
      {children}
    </Collapsible.Root>
  );
};

type CollapsibleCardHeaderProps = React.HTMLAttributes<HTMLDivElement> & {
  sticky?: boolean;
  position?: 'sticky' | 'absolute' | 'relative';
  xstyle?: stylex.StyleXStyles;
};

const CollapsibleCardHeader: React.FC<CollapsibleCardHeaderProps> = ({
  className,
  children,
  sticky = false,
  xstyle,
  position,
  ...props
}) => {
  const headerPosition = position ?? (sticky ? 'sticky' : 'absolute');
  const sx = stylex.props(styles.header, styles[headerPosition], xstyle);

  return (
    <Collapsible.Trigger asChild>
      <div
        {...props}
        className={clsx(sx.className, className)}
        style={sx.style ? { ...sx.style, ...props.style } : props.style}
      >
        <Button variant="ghost" aria-label="Toggle section" size="mini" icon>
          <ChevronDown {...stylex.props(styles.glyph)} aria-hidden="true" />
        </Button>
        {children}
      </div>
    </Collapsible.Trigger>
  );
};

const CollapsibleCardTitle: React.FC<
  React.HTMLAttributes<HTMLSpanElement> & { title?: string }
> = ({ className, title, children, ...p }) => {
  return (
    <div {...stylex.props(styles.titleRow)} data-collapsible-title-row>
      <p {...p} className={clsx(stylex.props(styles.title).className, className)}>
        {children}
      </p>
      {title && <CopyButton value={title} xstyle={styles.copy} />}
    </div>
  );
};

type CollapsibleCardContentProps = React.HTMLAttributes<HTMLDivElement> & {
  showTopFade?: boolean;
  noInternalScroll?: boolean;
  xstyle?: stylex.StyleXStyles;
  containerXstyle?: stylex.StyleXStyles;
};

const CollapsibleCardContent: React.FC<CollapsibleCardContentProps> = ({
  className,
  showTopFade = true,
  noInternalScroll = false,
  xstyle,
  containerXstyle,
  ...props
}) => {
  const topFadeRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (contentRef.current) {
      if (showTopFade && contentRef.current.scrollTop > 0 && topFadeRef.current) {
        topFadeRef.current.style.opacity = '1';
      }
    }
  }, [showTopFade]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const opacityTop = clamp(e.currentTarget.scrollTop / 15, [0, 1]);
    if (showTopFade && topFadeRef.current) {
      topFadeRef.current.style.opacity = String(opacityTop);
    }
  }

  const containerStyles = stylex.props(
    styles.content,
    noInternalScroll ? styles.horizontalScroll : styles.clipped,
    containerXstyle
  );
  const bodyStyles = stylex.props(noInternalScroll ? styles.externalBody : styles.body, xstyle);
  return (
    <Collapsible.Content className={containerStyles.className} style={containerStyles.style}>
      <div
        {...props}
        ref={contentRef}
        className={clsx(bodyStyles.className, className)}
        style={xstyle ? { ...bodyStyles.style, ...props.style } : props.style}
        onScroll={noInternalScroll ? undefined : onScroll}
      />
      {showTopFade && !noInternalScroll && (
        <Fade
          ref={topFadeRef}
          background="var(--color-background)"
          {...stylex.props(styles.fade)}
          side="top"
          blur="4px"
          stop="60%"
          style={{
            opacity: 0,
          }}
        />
      )}
    </Collapsible.Content>
  );
};

export { CollapsibleCard, CollapsibleCardHeader, CollapsibleCardTitle, CollapsibleCardContent };
