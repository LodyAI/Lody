import type * as stylex from '@stylexjs/stylex';

/**
 * `stylex.props` with a caller's class appended: the compiled styles are the
 * element's own, and a caller's class only lays it out. Never pass a visual
 * class through here to restyle something; two classes setting one property
 * are ordered by the stylesheet, not by this list.
 */
export function withClassName(
  props: ReturnType<typeof stylex.props>,
  className?: string
): { className?: string; style?: ReturnType<typeof stylex.props>['style'] } {
  return {
    className: [props.className, className].filter(Boolean).join(' ') || undefined,
    style: props.style,
  };
}
