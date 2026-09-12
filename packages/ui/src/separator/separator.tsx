import { Separator as BaseSeparator } from '@base-ui/react/separator';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps } from 'react';
import { appendClassName } from '../internal/class-name';
import { colors } from '../tokens/colors.stylex';

type BaseProps = ComponentProps<typeof BaseSeparator>;

export interface SeparatorProps extends Omit<BaseProps, 'className'> {
  className?: string;
}

const styles = stylex.create({
  /**
   * The one line this system allows, and it has no token group of its own.
   *
   * Every other component here derives its edge — a well's inset shadow, a
   * raised button's, a card's elevation — from tokens that say which rung it is
   * on. A separator *is* the edge: `separator` is already the semantic name for
   * "the next row starts here", and a `separator.color` pointing at it would be
   * a second name for one fact, which is the drift the rules warn about. The
   * hairline is the same 1px the popup's own row divider takes.
   */
  base: {
    flexShrink: 0,
    backgroundColor: colors.separator,
    // No margin. Where a line sits in a stack is the surface's layout, and the
    // popup's divider carries its own only because it has to bleed through an
    // inset the caller cannot see.
    margin: 0,
    borderWidth: 0,
    borderStyle: 'none',
  },
  horizontal: { width: '100%', height: '1px' },
  /**
   * A line down a row of controls. It stretches to the row rather than taking
   * `height: 100%`, because the row is a flex container and a percentage height
   * there resolves against a height the row has not got.
   */
  vertical: { width: '1px', alignSelf: 'stretch' },
});

/**
 * A line between rows.
 *
 * The rules give this one edge exactly one job: dividers between the rows of a
 * list or a table. Never around a surface, which is a shadow, and never under a
 * header, which is a gap — so a caller reaching for it to close a panel or to
 * underline a title is the sign that the panel wanted a rung and the title
 * wanted room.
 *
 * It says what it is to a screen reader. Base UI renders `role="separator"`
 * with the orientation, and there is no `decorative` escape hatch: the old
 * Radix wrapper defaulted to `decorative`, which is `role="none"`, because it
 * was used for decoration — and in this system a line is never decoration. The
 * one place it is allowed is structural by definition.
 */
export const Separator = forwardRef<HTMLDivElement, SeparatorProps>(function Separator(
  { orientation = 'horizontal', className, ...rest },
  ref
) {
  const sx = stylex.props(
    styles.base,
    orientation === 'vertical' ? styles.vertical : styles.horizontal
  );
  return (
    <BaseSeparator
      ref={ref}
      orientation={orientation}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});
