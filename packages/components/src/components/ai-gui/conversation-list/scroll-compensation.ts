/** Apply one reading-position correction; navigation uses absolute writes. */
export function compensateConversationScroll(
  viewport: HTMLElement,
  delta: number,
  webKit = typeof navigator !== 'undefined' &&
    /AppleWebKit\//.test(navigator.userAgent) &&
    (navigator.vendor === 'Apple Computer, Inc.' ||
      /(?:iPhone|iPad|iPod)/.test(navigator.userAgent))
): void {
  if (delta === 0) return;
  const apply = () => {
    if (typeof viewport.scrollBy === 'function') {
      viewport.scrollBy({ top: delta, behavior: 'instant' });
    } else {
      viewport.scrollTop += delta;
    }
  };
  if (!webKit) {
    apply();
    return;
  }

  // WebKit can replay a native offset sampled before this correction, even
  // after CSSOM has read back its corrected value. Commit a non-user-scrollable
  // overflow state to release that native owner, then publish the correction
  // before restoring input. This can cancel an in-flight native input/fling;
  // content stays painted at its existing origin.
  const overflow = viewport.style.getPropertyValue('overflow-y');
  const priority = viewport.style.getPropertyPriority('overflow-y');
  try {
    viewport.style.setProperty('overflow-y', 'hidden', 'important');
    void viewport.offsetHeight;
    apply();
    void viewport.offsetHeight;
  } finally {
    viewport.style.setProperty('overflow-y', overflow, priority);
  }
}
