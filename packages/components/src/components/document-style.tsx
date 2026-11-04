import { useLayoutEffect } from 'react';

/**
 * React owns the live stylesheet as ordinary DOM so CSS edits update in place.
 * A hoisted `style href` is immutable after insertion, including during HMR.
 */
export function DocumentStyle({ name, css }: { name: string; css: string }) {
  useLayoutEffect(() => {
    // Replace the document's first-paint sheet only after the live one commits.
    // Also retire a sheet hoisted by the earlier implementation during HMR.
    for (const sheet of document.head.querySelectorAll('style[data-href]')) {
      if (sheet.getAttribute('data-href') === name) sheet.remove();
    }
  }, [name]);

  return <style data-lody-style={name}>{css}</style>;
}
