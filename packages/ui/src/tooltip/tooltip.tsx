import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { appendClassName } from '../internal/class-name';
import { usePopupContainer, type PopupContainer } from '../popup/portal-container';
import { useForcedThemeClassNames } from '../theme/theme';
import { chip, hiddenChipForSide } from './chip';

/** The gap between a tooltip and what it names; the rules' rise distance. */
const POPUP_GAP = 4;

type PositionerBaseProps = ComponentProps<typeof BaseTooltip.Positioner>;
type TriggerBaseProps = ComponentProps<typeof BaseTooltip.Trigger>;

export interface TooltipContentProps extends Omit<
  PositionerBaseProps,
  'className' | 'children' | 'render'
> {
  children?: ReactNode;
  /** Where the tooltip mounts. Defaults to the nearest `PopupContainerProvider`. */
  container?: PopupContainer;
  className?: string;
}

/**
 * What the tooltip names. It is Base UI's trigger unchanged: a tooltip is about
 * something the surface already had there, so a caller wraps it with
 * `render={<Button …/>}` rather than being handed a second control.
 */
export type TooltipTriggerProps = TriggerBaseProps;

/**
 * The tooltip, assembled. Base UI splits it into a portal, a positioner and the
 * popup; every caller writes the same three, so this part writes them once and
 * takes the positioning props on the outside, the way every other floating part
 * in this package does.
 */
export const TooltipContent = forwardRef<HTMLDivElement, TooltipContentProps>(
  function TooltipContent(
    { className, children, container, sideOffset = POPUP_GAP, ...rest },
    ref
  ) {
    const inheritedContainer = usePopupContainer();
    // A portalled popup leaves the subtree whose palette it should be using, so
    // the classes that declare that palette travel with it and land on the
    // positioner. A tooltip inverts, so getting this wrong is the one case that
    // is unreadable rather than merely wrong: light ink on a light chip.
    const palette = useForcedThemeClassNames();
    const mountPoint = container ?? inheritedContainer;
    // See `Select.Content`: a container that centres itself with `translate` is
    // the containing block for its `position: fixed` descendants, so a popup
    // mounted into one switches to the absolute strategy to agree with it.
    const strategy = rest.positionMethod ?? (mountPoint != null ? 'absolute' : undefined);
    return (
      <BaseTooltip.Portal container={mountPoint}>
        <BaseTooltip.Positioner
          ref={ref}
          {...rest}
          sideOffset={sideOffset}
          positionMethod={strategy}
          className={[stylex.props(chip.positioner).className, ...palette]
            .filter(Boolean)
            .join(' ')}
        >
          <BaseTooltip.Popup
            className={(state) => {
              // StyleX cannot express `[data-starting-style]`, so both ends of
              // the rise are read off Base UI's transition status here.
              const hidden =
                state.transitionStatus === 'starting' || state.transitionStatus === 'ending';
              return appendClassName(
                stylex.props(chip.popup, hidden && hiddenChipForSide(state.side)).className,
                className
              );
            }}
          >
            {children}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    );
  }
);

/**
 * A tooltip: the name of the thing under the pointer.
 *
 * It is the one floating part that does not read `popup`. The elevation ladder
 * puts a menu, a popover and a list on the raised background under the popover
 * shadow and then names the tooltip apart — `label` with `shadow.medium` — an
 * inversion, because a tooltip is not a place to act but a label over one, and
 * it has to read at a glance without becoming another surface.
 *
 * `Tooltip.Provider` groups them: once one tooltip has opened, the next opens
 * without its delay, so a row of icon buttons reads like one strip rather than
 * making a person wait at each. A surface that has such a row states the
 * provider around it; without one every tooltip waits on its own.
 */
export const Tooltip = {
  Provider: BaseTooltip.Provider,
  Root: BaseTooltip.Root,
  Trigger: BaseTooltip.Trigger,
  Content: TooltipContent,
};
