import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps } from 'react';
import { appendClassName } from '../internal/class-name';
import { feedbackSurface as surface } from './surface';

/** What has not arrived: a line of text, a block of something, or a face. */
export type SkeletonShape = 'line' | 'block' | 'circle';

export interface SkeletonProps extends Omit<
  ComponentProps<'div'>,
  'className' | 'width' | 'height'
> {
  shape?: SkeletonShape;
  /** How much room it holds. A number is pixels; a string is a CSS length. */
  width?: string | number;
  height?: string | number;
  className?: string;
}

const SHAPES = {
  line: surface.skeletonLine,
  block: surface.skeletonBlock,
  circle: surface.skeletonCircle,
} as const;

/**
 * The room it holds. It is a prop rather than a class because that is the whole
 * of what a caller has to say about a skeleton, and a size passed as a class
 * would land in the same specificity fight as the shape's own height — a
 * dynamic style resolves to an inline value, which nothing has to win against.
 */
const dyn = stylex.create({
  size: (width: string | number | undefined, height: string | number | undefined) => ({
    width,
    height,
  }),
});

/**
 * A stand-in for content that is on its way.
 *
 * It takes a gray rather than a semantic colour, which is what the rules
 * reserve the grays for: a thing with no role. How much room it holds is the
 * caller's, because the shape of what is coming is a fact about that surface
 * and not about this package — what the primitive owns is the fill, the corner
 * of each shape, and the breathing.
 *
 * It breathes rather than sweeping, because a page of sweeping blocks is a page
 * of movement; and it stops where a person has asked for less of it, since a
 * skeleton reports nothing that its own shape does not already say. It is
 * hidden from a screen reader for the same reason.
 */
export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(function Skeleton(
  { shape = 'line', width, height, className, ...rest },
  ref
) {
  const sx = stylex.props(
    surface.skeleton,
    SHAPES[shape],
    (width != null || height != null) && dyn.size(width, height)
  );
  return (
    <div
      ref={ref}
      aria-hidden="true"
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});
