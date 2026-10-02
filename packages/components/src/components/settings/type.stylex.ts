import * as stylex from '@stylexjs/stylex';

/** Settings prose weights and leading; sizes belong to `@lody/ui`'s text tokens. */
export const settingsType = stylex.defineConsts({
  /** Line height for a label, a helper, and anything else that stacks. */
  leading: '1.45',
  /** A section heading or a group's name. */
  headingWeight: '500',
  /** A page's title, the one semibold string on the page. */
  titleWeight: '600',
});
