import { PreviewCard as BasePreviewCard } from '@base-ui/react/preview-card';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { appendClassName } from '../internal/class-name';
import { usePopupContainer, type PopupContainer } from '../popup/portal-container';
import { hiddenSurfaceForSide, surface } from '../popup/surface';
import { useForcedThemeClassNames } from '../theme/theme';

/** The gap between a card and what it previews; the rules' rise distance. */
const POPUP_GAP = 4;

type PositionerBaseProps = ComponentProps<typeof BasePreviewCard.Positioner>;
type PopupBaseProps = ComponentProps<typeof BasePreviewCard.Popup>;

export interface PreviewCardContentProps extends Omit<
  PositionerBaseProps,
  'className' | 'children' | 'render'
> {
  children?: ReactNode;
  /** Where the card mounts. Defaults to the nearest `PopupContainerProvider`. */
  container?: PopupContainer;
  /** The popup's own pointer handlers, for a caller that owns the hover intent. */
  onPointerEnter?: PopupBaseProps['onPointerEnter'];
  onPointerLeave?: PopupBaseProps['onPointerLeave'];
  /**
   * Skip the rise and fade, in and out. A surface that swaps one card for the
   * next as a pointer runs down a list states it for those swaps: two cards
   * crossing in opposite fades read as flicker, not as one card moving.
   */
  noAnimation?: boolean;
  className?: string;
}

/**
 * The card, assembled: portal, positioner and popup, written once, with the
 * positioning props taken on the outside, as `Popover.Content` does.
 *
 * It is a popover's surface — the floating rung with content on it — because
 * what it holds is the same kind of thing: facts about something, not commands.
 * What differs is the way in. A popover is pressed open and holds focus; a
 * preview card is hovered open, never takes focus and is not a dialog, so a row
 * a pointer sweeps across is not announced as one.
 */
export const PreviewCardContent = forwardRef<HTMLDivElement, PreviewCardContentProps>(
  function PreviewCardContent(
    {
      className,
      children,
      container,
      onPointerEnter,
      onPointerLeave,
      noAnimation = false,
      sideOffset = POPUP_GAP,
      ...rest
    },
    ref
  ) {
    const inheritedContainer = usePopupContainer();
    // See `PopoverContent`: a portalled popup carries its subtree's palette.
    const palette = useForcedThemeClassNames();
    const mountPoint = container ?? inheritedContainer;
    const strategy = rest.positionMethod ?? (mountPoint != null ? 'absolute' : undefined);
    return (
      <BasePreviewCard.Portal container={mountPoint}>
        <BasePreviewCard.Positioner
          ref={ref}
          {...rest}
          sideOffset={sideOffset}
          positionMethod={strategy}
          className={[stylex.props(surface.positioner).className, ...palette]
            .filter(Boolean)
            .join(' ')}
        >
          <BasePreviewCard.Popup
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
            className={(state) => {
              const hidden =
                !noAnimation &&
                (state.transitionStatus === 'starting' || state.transitionStatus === 'ending');
              return appendClassName(
                stylex.props(
                  surface.popup,
                  surface.popupPanel,
                  hidden && hiddenSurfaceForSide(state.side),
                  noAnimation && surface.popupNoTransition
                ).className,
                className
              );
            }}
          >
            {children}
          </BasePreviewCard.Popup>
        </BasePreviewCard.Positioner>
      </BasePreviewCard.Portal>
    );
  }
);

/**
 * A preview card: what a pointer resting on something shows about it.
 *
 * `Trigger` is Base UI's link-shaped trigger with its own hover delays. A
 * surface that owns the hover intent itself — a list whose rows share one warm
 * window, say — controls `Root open` and names the row with
 * `Content anchor={…}` instead of rendering a trigger.
 */
export const PreviewCard = {
  Root: BasePreviewCard.Root,
  Trigger: BasePreviewCard.Trigger,
  Content: PreviewCardContent,
};
