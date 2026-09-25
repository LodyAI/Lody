import { Accordion as BaseAccordion } from '@base-ui/react/accordion';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { ChevronDownGlyph } from '../internal/glyphs';
import { appendClassName } from '../internal/class-name';
import { disclosureSurface as surface, isCollapsed } from './surface';

type RootBaseProps = ComponentProps<typeof BaseAccordion.Root>;
type ItemBaseProps = ComponentProps<typeof BaseAccordion.Item>;
type TriggerBaseProps = ComponentProps<typeof BaseAccordion.Trigger>;
type PanelBaseProps = ComponentProps<typeof BaseAccordion.Panel>;

export interface AccordionRootProps extends Omit<RootBaseProps, 'className'> {
  className?: string;
}
export interface AccordionItemProps extends Omit<ItemBaseProps, 'className'> {
  className?: string;
}
export interface AccordionTriggerProps extends Omit<TriggerBaseProps, 'className' | 'children'> {
  children?: ReactNode;
  className?: string;
}
export interface AccordionPanelProps extends Omit<PanelBaseProps, 'className' | 'children'> {
  children?: ReactNode;
  className?: string;
}

export const AccordionRoot = forwardRef<HTMLDivElement, AccordionRootProps>(function AccordionRoot(
  { className, ...rest },
  ref
) {
  const sx = stylex.props(surface.stack);
  return (
    <BaseAccordion.Root
      ref={ref}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

/** One row and the panel it owns, with the line to the row after it. */
export const AccordionItem = forwardRef<HTMLDivElement, AccordionItemProps>(function AccordionItem(
  { className, ...rest },
  ref
) {
  const sx = stylex.props(surface.item);
  return (
    <BaseAccordion.Item
      ref={ref}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

/**
 * The row that opens the panel, inside the heading that names it.
 *
 * The two are one part rather than two: Base UI's `Header` is what puts the row
 * in the document's outline, and a caller assembling the pair themselves can
 * leave it out and produce an accordion a screen reader reads as a run of
 * buttons. The chevron is drawn here for the same reason a submenu's is —
 * it is how a closed row says there is something under it.
 */
export const AccordionTrigger = forwardRef<HTMLButtonElement, AccordionTriggerProps>(
  function AccordionTrigger({ className, children, ...rest }, ref) {
    const header = stylex.props(surface.header);
    const label = stylex.props(surface.rowLabel);
    return (
      <BaseAccordion.Header className={header.className} style={header.style}>
        <BaseAccordion.Trigger
          ref={ref}
          {...rest}
          className={(state) =>
            appendClassName(
              stylex.props(surface.ring, surface.row, state.disabled && surface.disabled).className,
              className
            )
          }
          // The chevron has to know whether the panel is open, and Base UI
          // reports that as state to `render` and to `className` rather than to
          // `children`. The row is therefore assembled here, which is also what
          // keeps the heading around it from being a caller's responsibility.
          render={(props, state) => (
            <button type="button" {...props}>
              <span className={label.className} style={label.style}>
                {children}
              </span>
              <span
                {...stylex.props(surface.chevron, state.open && surface.chevronOpen)}
                aria-hidden="true"
              >
                <ChevronDownGlyph />
              </span>
            </button>
          )}
        />
      </BaseAccordion.Header>
    );
  }
);

/**
 * What the row opens. The reveal is the Collapsible's, and the prose step and
 * the room under it are this family's: a panel's own padding cannot ride on the
 * element whose height is being animated, so it rides on a child of it.
 */
export const AccordionPanel = forwardRef<HTMLDivElement, AccordionPanelProps>(
  function AccordionPanel({ className, children, ...rest }, ref) {
    const body = stylex.props(surface.body);
    return (
      <BaseAccordion.Panel
        ref={ref}
        {...rest}
        className={(state) =>
          appendClassName(
            stylex.props(
              surface.accordionPanel,
              isCollapsed(state.transitionStatus) && surface.collapsed
            ).className,
            className
          )
        }
      >
        <div className={body.className} style={body.style}>
          {children}
        </div>
      </BaseAccordion.Panel>
    );
  }
);

/**
 * A stack of disclosures: rows a person walks down, each opening what is under
 * it in place rather than swapping a panel beside it.
 *
 * One row is open at a time unless the root says `multiple`, because an
 * accordion's point is that a long page stays short. The rows are separated by
 * the line the rules give a list rather than by a gap or a card each, so the
 * stack reads as one block of a page and not as a column of panels.
 */
export const Accordion = {
  Root: AccordionRoot,
  Item: AccordionItem,
  Trigger: AccordionTrigger,
  Panel: AccordionPanel,
};
