'use client';

import React, { useLayoutEffect, useRef } from 'react';
import { Fade } from '@/ui/blur-fade/blur-fade';
import { cn } from '@/lib/utils';

import { ChevronDown } from 'lucide-react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { Button } from '@lody/ui/button';
import { CopyButton } from './copy-button';
import { clamp } from '@/lib/clamp';

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
      className={cn(
        // Default surface is bg-card; callers (e.g. DiffViewer) may override to
        // bg-background. Keep a single 1px border — no default shadow/ring, which
        // anti-aliases to a second gray at rounded corners on light canvases.
        'relative flex min-h-14 flex-col rounded-xl border border-border bg-card shadow-none ring-0',
        // When allowStickyChildren is true, we avoid setting any overflow on the card root
        // so that sticky children can stick relative to an outer scroll container.
        // Horizontal scrolling should be handled by inner content wrappers instead.
        !allowStickyChildren && 'overflow-hidden',
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
        className={cn(
          headerPosition === 'sticky' && 'sticky top-0 h-14 z-20',
          headerPosition === 'absolute' && 'absolute h-14 inset-x-4 z-20',
          headerPosition === 'relative' && 'relative h-14 z-20',
          'flex items-center gap-2 justify-between',
          className
        )}
      >
        <Button variant="ghost" aria-label="Toggle section" size="mini" icon>
          <ChevronDown
            className="h-4 w-4 transition-transform duration-200 [[data-state=closed]_&]:-rotate-90"
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
    <div className="flex items-center gap-2 group flex-1 min-w-0 overflow-hidden flex-end">
      <p
        {...p}
        className={cn('text-sm text-muted-foreground text-nowrap truncate min-w-0', className)}
      >
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
        'relative',
        // When noInternalScroll is true, we need overflow-x-auto on Collapsible.Content
        // to allow horizontal scrolling. overflow-hidden would clip the scrollbar.
        // When collapsed (data-[state=closed]), we still need h-0 + overflow-hidden to hide content.
        noInternalScroll
          ? 'overflow-x-auto data-[state=closed]:overflow-hidden'
          : 'overflow-hidden',
        'data-[state=open]:animate-collapsible-down',
        'data-[state=closed]:animate-collapsible-up data-[state=closed]:h-0'
      )}
    >
      <div
        {...props}
        ref={contentRef}
        className={cn(
          noInternalScroll ? 'pb-4' : 'max-h-[70svh] pt-14 pb-4 overflow-auto',
          className
        )}
        onScroll={noInternalScroll ? undefined : onScroll}
      />
      {showTopFade && !noInternalScroll && (
        <Fade
          ref={topFadeRef}
          background="var(--color-background)"
          className="inset-x-0 top-0 h-17 z-10 rounded-t-xl"
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
