import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/* Footer rail for the mobile composer: a horizontal scroller with a
   right-edge fade only while there is more content to reach. The fade is a
   sibling overlay, so it never blocks the chips or the native selects inside. */
export function MobileFooterRail({ children }: { children: ReactNode }) {
  const railRef = useRef<HTMLDivElement>(null);
  const [showFade, setShowFade] = useState(false);
  const updateFade = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const remaining = rail.scrollWidth - rail.clientWidth - rail.scrollLeft;
    setShowFade(remaining > 2);
  }, []);
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;
    updateFade();
    rail.addEventListener('scroll', updateFade, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateFade);
    observer?.observe(rail);
    /* The rail's own width is fixed by the flex row, so a context switch that
       adds or removes chips changes `scrollWidth` without resizing the rail.
       Observe the subtree to keep the fade in sync with the controls. */
    const contentObserver =
      typeof MutationObserver === 'undefined' ? null : new MutationObserver(updateFade);
    contentObserver?.observe(rail, { childList: true, subtree: true, characterData: true });
    return () => {
      rail.removeEventListener('scroll', updateFade);
      observer?.disconnect();
      contentObserver?.disconnect();
    };
  }, [updateFade]);

  return (
    <div className="relative flex min-w-0 flex-1 items-center">
      <div
        ref={railRef}
        className={cn(
          'flex w-full min-w-0 flex-nowrap items-center gap-1.5 overflow-x-auto',
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
        )}
      >
        {children}
      </div>
      {showFade ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-background to-transparent"
        />
      ) : null}
    </div>
  );
}
