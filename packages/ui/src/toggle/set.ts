import { createContext, useContext } from 'react';

/** The control ladder a Button is on, plus the 24px step below it. */
export type ToggleSize = 'mini' | 'small' | 'medium' | 'large';
export type ToggleShape = 'default' | 'pill';

export interface ToggleSet {
  size: ToggleSize;
  shape: ToggleShape;
}

/**
 * What the set was told, for the members inside it.
 *
 * A member's height and shape follow from the set's, so both are stated once on
 * the group rather than repeated on every Toggle, where two of them could
 * disagree — the same reason `Tabs.List` states the strip's size for its tabs.
 *
 * It lives in its own file rather than beside either part because both need it:
 * the group publishes it and the Toggle reads it, and a module that imported
 * the other to reach it would close a cycle between them.
 */
export const ToggleSetContext = createContext<ToggleSet | null>(null);

/**
 * What a `Toggle` inherits from the set around it, or `null` when it stands
 * alone. A Toggle reads this itself rather than taking it as a prop, the way a
 * control in the field family reads validity from its `Field.Root`.
 */
export function useToggleSet(): ToggleSet | null {
  return useContext(ToggleSetContext);
}
