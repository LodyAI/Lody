import { Collapsible as BaseCollapsible } from '@base-ui/react/collapsible';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps } from 'react';
import { appendClassName } from '../internal/class-name';
import { disclosureSurface as surface, isCollapsed } from './surface';

type PanelBaseProps = ComponentProps<typeof BaseCollapsible.Panel>;

export interface CollapsiblePanelProps extends Omit<PanelBaseProps, 'className'> {
  className?: string;
}

/**
 * The panel, and the reveal it owns. Everything a caller has to get right about
 * a collapsible is here: the height Base UI measures, the transition between
 * that height and nothing, and the overflow that hides what is on its way in.
 */
export const CollapsiblePanel = forwardRef<HTMLDivElement, CollapsiblePanelProps>(
  function CollapsiblePanel({ className, ...rest }, ref) {
    return (
      <BaseCollapsible.Panel
        ref={ref}
        {...rest}
        className={(state) =>
          appendClassName(
            stylex.props(
              surface.collapsiblePanel,
              isCollapsed(state.transitionStatus) && surface.collapsed
            ).className,
            className
          )
        }
      />
    );
  }
);

/**
 * One thing that can be shown or hidden, with no list around it: an accordion
 * of one item, and the primitive the Accordion is built out of.
 *
 * Its trigger is Base UI's, unstyled, for the reason `Menu.Trigger` is: a lone
 * collapsible is opened by whatever the surface already had there — a card's
 * header, a row of a table, a button that also says how many things are under
 * it — and handing it a second styled control would be a second thing to keep
 * in step with `Button`. What the primitive owns is the panel; an `Accordion`
 * is what this becomes when the rows are a list and each needs the same row.
 */
export const Collapsible = {
  Root: BaseCollapsible.Root,
  Trigger: BaseCollapsible.Trigger,
  Panel: CollapsiblePanel,
};
