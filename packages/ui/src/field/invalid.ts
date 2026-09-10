import type { AriaAttributes } from 'react';

/**
 * Whether a control wears the invalid ring.
 *
 * `Field.Root invalid` renders `aria-invalid` onto its control, so the
 * attribute is not a second source of truth: it is the rendered form of the
 * field's validity. Reading it here keeps what a screen reader announces and
 * what a sighted person sees from disagreeing, and lets a surface that owns its
 * own validation mark one control without a field around it.
 *
 * ARIA treats every value except `false` as an invalid state, `grammar` and
 * `spelling` included.
 */
export function isInvalid(
  fieldValid: boolean | null | undefined,
  ariaInvalid: AriaAttributes['aria-invalid']
): boolean {
  if (fieldValid === false) return true;
  return ariaInvalid != null && ariaInvalid !== false && ariaInvalid !== 'false';
}
