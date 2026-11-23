import * as stylex from '@stylexjs/stylex';
import { Children, type ReactNode } from 'react';
import { surface } from './surface';

/**
 * A row's label slot, shared by every list row in this package: a menu command,
 * a Select option, a Combobox option.
 *
 * The slot is a line of items, so words beside a caller's mark or value stay on
 * one line; words themselves need a box of their own to take an ellipsis, since
 * a bare text node in a flex line cannot. So every run of text a caller passes
 * is wrapped here, and an element is left as it is.
 */
export function rowLabel(children: ReactNode): ReactNode {
  return Children.map(children, (child) =>
    typeof child === 'string' || typeof child === 'number' ? (
      <span {...stylex.props(surface.itemTextRun)}>{child}</span>
    ) : (
      child
    )
  );
}
