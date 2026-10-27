'use client';

import React, { useLayoutEffect, useRef } from 'react';
import { Fade } from '@/ui/blur-fade/blur-fade';
import { cn } from '@/lib/utils';

import { ChevronDown } from 'lucide-react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { Button } from '@lody/ui/button';
import { CopyButton } from './copy-button';
import { clamp } from '@/lib/clamp';
import * as stylex from '@stylexjs/stylex';
import { withClassName } from '@/lib/stylex';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeDuration,
  themeFontSize,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../style/theme-scale.stylex';

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
    transitionTimingFunction: 'var(--tw-ease, var(--default-transition-timing-function))',
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
  content: { position: 'relative', height: { default: null, ':is([data-state="closed"])': 0 } },
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
};

const CollapsibleCard = ({
  className,
  children,
  allowStickyChildren = false,
  ...props
}: CollapsibleCardProps) => {
  return (
    <Collapsible.Root
      {...props}
      // Keep the combined ring/shadow contract: cn lets caller shadows replace
      // shadow-none without an unlayered StyleX custom property masking them.
      className={cn(
        stylex.props(styles.card, !allowStickyChildren && styles.clipped).className,
        'shadow-none ring-0',
        className
      )}
    >
      {children}
    </Collapsible.Root>
  );
};

type CollapsibleCardHeaderProps = React.HTMLAttributes<HTMLDivElement> & {
  sticky?: boolean;
  position?: 'sticky' | 'absolute' | 'relative';
};

const CollapsibleCardHeader: React.FC<CollapsibleCardHeaderProps> = ({
  className,
  children,
  sticky = false,
  position,
  ...props
}) => {
  const headerPosition = position ?? (sticky ? 'sticky' : 'absolute');

  return (
    <Collapsible.Trigger asChild>
      <div
        {...props}
        className={cn(stylex.props(styles.header, styles[headerPosition]).className, className)}
      >
        <Button variant="ghost" aria-label="Toggle section" size="mini" icon>
          <ChevronDown
            className={cn(
              stylex.props(styles.glyph).className,
              '[[data-state=closed]_&]:-rotate-90'
            )}
            aria-hidden="true"
          />
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
    <div {...withClassName(stylex.props(styles.titleRow), 'group')}>
      <p {...p} className={cn(stylex.props(styles.title).className, className)}>
        {children}
      </p>
      {title && (
        <CopyButton
          value={title}
          className="opacity-0 group-hover:opacity-100 data-[state=copied]:opacity-100"
        />
      )}
    </div>
  );
};

type CollapsibleCardContentProps = React.HTMLAttributes<HTMLDivElement> & {
  showTopFade?: boolean;
  noInternalScroll?: boolean;
};

const CollapsibleCardContent: React.FC<CollapsibleCardContentProps> = ({
  className,
  showTopFade = true,
  noInternalScroll = false,
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

  return (
    <Collapsible.Content
      className={cn(
        stylex.props(styles.content, noInternalScroll ? styles.horizontalScroll : styles.clipped)
          .className,
        // When noInternalScroll is true, we need overflow-x-auto on Collapsible.Content
        // to allow horizontal scrolling. overflow-hidden would clip the scrollbar.
        // When collapsed (data-[state=closed]), we still need h-0 + overflow-hidden to hide content.
        'data-[state=open]:animate-collapsible-down',
        'data-[state=closed]:animate-collapsible-up'
      )}
    >
      <div
        {...props}
        ref={contentRef}
        className={cn(
          stylex.props(noInternalScroll ? styles.externalBody : styles.body).className,
          className
        )}
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
