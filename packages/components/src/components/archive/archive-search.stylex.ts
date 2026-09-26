import * as stylex from '@stylexjs/stylex';
import { field } from '@lody/ui/field/field.tokens.stylex';

/**
 * The archive search is a flat field, not a recessed well: on the deep-sea
 * canvas the package's well (28% black under a 2px inner shadow and a lit
 * lower lip) read as a heavy trench across the top of the page. It takes the
 * product's editable-field fill and a 1px input border, as it did before
 * `@lody/ui`; its focus ring still composes over this edge.
 */
export const archiveSearchFieldTheme = stylex.createTheme(field, {
  background: 'hsl(var(--input-field))',
  well: 'inset 0 0 0 1px hsl(var(--input-border))',
});
