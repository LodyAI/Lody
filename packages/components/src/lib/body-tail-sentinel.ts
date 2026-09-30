const SENTINEL_ATTRIBUTE = 'data-lody-body-tail';

/**
 * Keeps the app's React root from being `<body>`'s last child.
 *
 * Every portal (tooltip, menu, popover, dialog, toast) and every Radix focus
 * guard is appended to, or removed from, the end of `<body>`. While the root is
 * the last child, each of those flips its `:last-child` state and Chrome
 * restyles the entire app subtree — about 25ms per hover card on a large
 * workspace, measured with 9k nodes. A permanent empty element right after the
 * root takes those flips instead, so portal churn restyles nothing.
 */
export function keepAppRootOffBodyTail(
  root: Element | null = typeof document === 'undefined' ? null : document.getElementById('root')
): void {
  if (!root || root.parentElement !== root.ownerDocument.body) return;
  if (root.nextElementSibling?.hasAttribute(SENTINEL_ATTRIBUTE)) return;
  const sentinel = root.ownerDocument.createElement('div');
  sentinel.setAttribute(SENTINEL_ATTRIBUTE, '');
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.hidden = true;
  root.after(sentinel);
}
