import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { appendClassName } from '../internal/class-name';
import { corner, duration, ease, text } from '../tokens/scales.stylex';
import { card } from './card.tokens.stylex';

/** Which heading a card's title is on the page that holds it. */
export type CardTitleLevel = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

export interface CardProps extends Omit<ComponentProps<'div'>, 'className'> {
  /**
   * The whole card is the pressable thing, so it answers the pointer.
   *
   * It marks the card rather than making it a control: the button or the link
   * stays the caller's, because what a press *does* — navigate, select, open —
   * is a product decision and a card that rendered its own `<button>` would
   * have made it. A caller wraps the card in one, or renders one over it.
   */
  interactive?: boolean;
  children?: ReactNode;
  className?: string;
}

export interface CardSectionProps {
  children?: ReactNode;
  className?: string;
}

export interface CardTitleProps extends Omit<ComponentProps<'h3'>, 'className'> {
  /**
   * The heading element. The step and the weight are the card's; which level
   * the heading is belongs to the page, because only the page knows what is
   * above it. Defaults to `h3`.
   */
  as?: CardTitleLevel;
  className?: string;
}

export interface CardDescriptionProps extends Omit<ComponentProps<'p'>, 'className'> {
  className?: string;
}

const styles = stylex.create({
  /**
   * The card rung: the elevated background under the card shadow. There is no
   * border — depth without lines — and no ring, because a card is not a control
   * and nothing here takes focus but what a caller puts inside it.
   */
  root: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: card.gap,
    padding: card.padding,
    backgroundColor: card.background,
    boxShadow: card.shadow,
    borderRadius: card.radius,
    cornerShape: corner.shape,
    color: card.title,
  },
  /**
   * The pointer's answer. Only the fill changes: the shadow is the rung and a
   * card that lifted on hover would be claiming a rung it is not on.
   */
  interactive: {
    backgroundColor: { default: card.background, ':hover': card.hover },
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  /**
   * The heading block. A title and the one sentence about it are one block with
   * one gap, so the card's own `gap` separates the pair from the body rather
   * than the title from the sentence it belongs to.
   */
  header: { display: 'flex', flexDirection: 'column', gap: card.headerGap },
  title: {
    margin: 0,
    fontSize: card.titleSize,
    lineHeight: card.titleLeading,
    fontWeight: 600,
    letterSpacing: text.controlTracking,
    color: card.title,
  },
  description: {
    margin: 0,
    fontSize: card.descriptionSize,
    lineHeight: card.descriptionLeading,
    fontWeight: 400,
    color: card.description,
  },
  /**
   * The answers, at the end of the card — the same row a dialog's footer is,
   * stacking in reverse on a narrow window so the affirmative answer is the
   * last one read and the nearest to the thumb in both shapes.
   */
  footer: {
    display: 'flex',
    flexDirection: { default: 'row', '@media (max-width: 480px)': 'column-reverse' },
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: card.footerGap,
  },
});

/**
 * A block of a page, on the card rung.
 *
 * It is the elevation ladder's card step made a component: the elevated
 * background under the card shadow at the large radius, and no border, because
 * this system has no border token and a card's edge is its shadow. The parts
 * are a Dialog's — a header, the body a caller writes, and the answers — for
 * the reason the three modal surfaces share theirs: what differs between a
 * panel that owns the window and a block that owns a region of a page is the
 * rung and the heading step, not what either is made of.
 *
 * A card does not nest. Two cards one inside the other are the same fill twice
 * in the light palette, where the card rung and the page are one white; a block
 * inside a card is the region rung, which is a surface a caller lays out rather
 * than a primitive.
 */
export const CardRoot = forwardRef<HTMLDivElement, CardProps>(function CardRoot(
  { interactive = false, className, children, ...rest },
  ref
) {
  const sx = stylex.props(styles.root, interactive && styles.interactive);
  return (
    <div ref={ref} {...rest} className={appendClassName(sx.className, className)} style={sx.style}>
      {children}
    </div>
  );
});

/** The title and the sentence about it: one block. */
export function CardHeader({ children, className }: CardSectionProps) {
  const sx = stylex.props(styles.header);
  return (
    <div className={appendClassName(sx.className, className)} style={sx.style}>
      {children}
    </div>
  );
}

/**
 * What the card is about.
 *
 * It is a real heading, unlike an Alert's title, because a card owns a region
 * of the page and a person walking the headings should land on it. Which level
 * that heading is cannot be known here — a card on an onboarding page is the
 * page's only heading, and the same card in a settings list is the fourth of
 * nine — so the level is the caller's and the step is not.
 */
export const CardTitle = forwardRef<HTMLHeadingElement, CardTitleProps>(function CardTitle(
  { as: Heading = 'h3', className, ...rest },
  ref
) {
  const sx = stylex.props(styles.title);
  return (
    <Heading
      ref={ref}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

/** The sentence under it: prose, in the secondary label. */
export const CardDescription = forwardRef<HTMLParagraphElement, CardDescriptionProps>(
  function CardDescription({ className, ...rest }, ref) {
    const sx = stylex.props(styles.description);
    return (
      <p
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    );
  }
);

/** What answers the card. The buttons are the surface's choice, as everywhere. */
export function CardFooter({ children, className }: CardSectionProps) {
  const sx = stylex.props(styles.footer);
  return (
    <div className={appendClassName(sx.className, className)} style={sx.style}>
      {children}
    </div>
  );
}

export const Card = {
  Root: CardRoot,
  Header: CardHeader,
  Title: CardTitle,
  Description: CardDescription,
  Footer: CardFooter,
};
