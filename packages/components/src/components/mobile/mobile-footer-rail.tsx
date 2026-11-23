import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';

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
    <div {...stylex.props(styles.root)}>
      <div ref={railRef} {...stylex.props(styles.rail)}>
        {children}
      </div>
      {showFade ? <div aria-hidden="true" {...stylex.props(styles.fade)} /> : null}
    </div>
  );
}

const styles = stylex.create({
  root: {
    position: 'relative',
    display: 'flex',
    minWidth: 0,
    flex: '1 1 0%',
    alignItems: 'center',
  },
  rail: {
    display: 'flex',
    width: '100%',
    minWidth: 0,
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: '6px',
    overflowX: 'auto',
    scrollbarWidth: 'none',
    '::-webkit-scrollbar': { display: 'none' },
  },
  fade: {
    pointerEvents: 'none',
    position: 'absolute',
    insetBlock: 0,
    right: 0,
    width: '40px',
    backgroundImage: `linear-gradient(to left,${themeColors.background},transparent)`,
  },
});
