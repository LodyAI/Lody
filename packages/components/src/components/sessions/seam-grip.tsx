import { cn } from '@/lib/utils';

/**
 * What a session resize handle shows (the side panel's seam, the split conversation's column
 * seams). Nothing at rest; hover or keyboard focus reveals one small ink block centred on the
 * seam, focus taller and darker than hover, drag darkest, so a divider stays quiet until someone
 * reaches for it. The handle it sits in must carry `group/handle`.
 */
export function SeamGrip() {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none h-7 w-[3px] shrink-0 rounded-full bg-foreground opacity-0',
        'transition-[background-color,opacity,scale] duration-150',
        'group-data-[resize-handle-state=hover]/handle:bg-foreground/30',
        'group-data-[resize-handle-state=hover]/handle:opacity-100',
        'group-data-[resize-handle-state=drag]/handle:scale-y-125',
        'group-data-[resize-handle-state=drag]/handle:bg-foreground/70',
        'group-data-[resize-handle-state=drag]/handle:opacity-100',
        'group-focus-visible/handle:scale-y-125',
        'group-focus-visible/handle:bg-foreground/50',
        'group-focus-visible/handle:opacity-100'
      )}
    />
  );
}
