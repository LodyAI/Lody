import { useLayoutEffect, useState } from 'react';

import './use-vertical-division';

type FoldLayout = { messageHeight: number; lowerTop: number; gapHeight: number };

/**
 * Measure usable regions around a horizontal division in the current page.
 * While the keyboard is visible, the existing keyboard layout owns the space.
 */
export function useHorizontalFoldLayout(
  messageArea: HTMLElement | null,
  enabled: boolean
): FoldLayout | null {
  const [layout, setLayout] = useState<FoldLayout | null>(null);
  useLayoutEffect(() => {
    if (!messageArea || !enabled) {
      setLayout(null);
      return undefined;
    }
    const page = messageArea.parentElement;
    if (!page) return undefined;
    const update = () => {
      const division = window.__LODY_HORIZONTAL_DIVISION__;
      const keyboard = parseFloat(
        document.documentElement.style.getPropertyValue('--native-keyboard-height') || '0'
      );
      const pageRect = page.getBoundingClientRect();
      const messageTop = messageArea.getBoundingClientRect().top;
      const valid =
        division &&
        Number.isFinite(division.top) &&
        Number.isFinite(division.height) &&
        Number.isFinite(division.viewportHeight) &&
        division.top > 0 &&
        division.height > 0 &&
        division.top + division.height < division.viewportHeight &&
        (!Number.isFinite(keyboard) || keyboard <= 0) &&
        division.top - messageTop >= 120 &&
        pageRect.bottom - division.top - division.height >= 160;
      const next = valid
        ? {
            messageHeight: division.top - messageTop,
            lowerTop: division.top + division.height - pageRect.top,
            gapHeight: division.height,
          }
        : null;
      setLayout((old) =>
        old?.messageHeight === next?.messageHeight &&
        old?.lowerTop === next?.lowerTop &&
        old?.gapHeight === next?.gapHeight
          ? old
          : next
      );
    };
    window.addEventListener('lody:division-change', update);
    window.addEventListener('lody:keyboard-resize', update);
    window.addEventListener('resize', update);
    // Drill-in animations can finish after the first layout measurement.
    page.addEventListener('animationend', update);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(page);
    observer?.observe(messageArea);
    update();
    return () => {
      window.removeEventListener('lody:division-change', update);
      window.removeEventListener('lody:keyboard-resize', update);
      window.removeEventListener('resize', update);
      page.removeEventListener('animationend', update);
      observer?.disconnect();
    };
  }, [messageArea, enabled]);
  return layout;
}
