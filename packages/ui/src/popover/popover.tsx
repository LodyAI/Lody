import { nativeScrollbar } from '../scroll-area/surface';
import { Popover as BasePopover } from '@base-ui/react/popover';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { appendClassName } from '../internal/class-name';
import { portalClassName, usePopupContainer, type PopupContainer } from '../popup/portal-container';
import { hiddenSurfaceForSide, surface } from '../popup/surface';
import { useForcedThemeClassNames } from '../theme/theme';

/** The gap between a popover and whatever opened it; the rules' rise distance. */
const POPUP_GAP = 4;

type PositionerBaseProps = ComponentProps<typeof BasePopover.Positioner>;
type PopupBaseProps = ComponentProps<typeof BasePopover.Popup>;
type TriggerBaseProps = ComponentProps<typeof BasePopover.Trigger>;
type TitleBaseProps = ComponentProps<typeof BasePopover.Title>;
type DescriptionBaseProps = ComponentProps<typeof BasePopover.Description>;

const layout = stylex.create({
  noPadding: { padding: 0 },
  noGap: { gap: 0 },
  visuallyHidden: {
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    position: 'absolute',
    overflow: 'hidden',
  },
});

const dimensions = stylex.create({
  width: (value: string | number) => ({ width: value }),
  minWidth: (value: string | number) => ({ minWidth: value }),
  maxWidth: (value: string | number) => ({ maxWidth: value }),
  maxHeight: (value: string | number) => ({ maxHeight: value }),
});

export interface PopoverContentProps extends Omit<
  PositionerBaseProps,
  'className' | 'children' | 'render'
> {
  children?: ReactNode;
  /** Where the popover mounts. Defaults to the nearest `PopupContainerProvider`. */
  container?: PopupContainer;
  /** What takes focus when the popover opens; Base UI's `Popover.Popup` prop. */
  initialFocus?: PopupBaseProps['initialFocus'];
  /** Where focus goes when it closes; the product's policy, not this package's. */
  finalFocus?: PopupBaseProps['finalFocus'];
  /** Keep the prose inset, or let embedded content reach the panel's edges. */
  padding?: 'default' | 'none';
  /** Space direct content blocks, or let embedded content own their spacing. */
  gap?: 'default' | 'none';
  /** Panel dimensions: numbers are pixels; strings are CSS lengths. Omission restores its defaults. */
  width?: string | number;
  minWidth?: string | number;
  maxWidth?: string | number;
  maxHeight?: string | number;
  className?: string;
}

/**
 * What opens the popover. It is Base UI's trigger unchanged, for the reason
 * `Menu.Trigger` is: a popover is opened by whatever the surface already had
 * there, so a caller passes the control it wants through
 * `render={<Button …/>}` rather than being handed a second button to keep in
 * step with `Button`.
 */
export type PopoverTriggerProps = TriggerBaseProps;

export interface PopoverTitleProps extends Omit<TitleBaseProps, 'className'> {
  /** Clip the painted heading while keeping it as the popup's accessible name. */
  visuallyHidden?: boolean;
  className?: string;
}
export interface PopoverDescriptionProps extends Omit<DescriptionBaseProps, 'className'> {
  className?: string;
}
export interface PopoverHeaderProps {
  children?: ReactNode;
  className?: string;
}

/**
 * The popover, assembled. Base UI splits it into a portal, a positioner and the
 * popup; every caller writes the same three, so this part writes them once and
 * takes the positioning props on the outside — the same shape `Select.Content`
 * and `Menu.Content` already have.
 */
export const PopoverContent = forwardRef<HTMLDivElement, PopoverContentProps>(
  function PopoverContent(
    {
      className,
      children,
      container,
      initialFocus,
      finalFocus,
      padding = 'default',
      gap = 'default',
      width,
      minWidth,
      maxWidth,
      maxHeight,
      sideOffset = POPUP_GAP,
      ...rest
    },
    ref
  ) {
    const inheritedContainer = usePopupContainer();
    // A portalled popup leaves the subtree whose palette it should be using, so
    // the classes that declare that palette travel with it and land on the
    // positioner, where they cascade into the popup and its contents.
    const palette = useForcedThemeClassNames();
    const mountPoint = container ?? inheritedContainer;
    // A popup mounted into a named container is inside a subtree the host owns,
    // and a modal panel typically centres itself with `translate`, which makes
    // it the containing block for every `position: fixed` descendant. Floating
    // UI's fixed strategy then resolves the coordinates it computed against the
    // viewport relative to that panel instead. The absolute strategy resolves
    // against the offset parent, which is the panel, so the two agree again.
    const strategy = rest.positionMethod ?? (mountPoint != null ? 'absolute' : undefined);
    const panelDimensions = [
      width != null && dimensions.width(width),
      minWidth != null && dimensions.minWidth(minWidth),
      maxWidth != null && dimensions.maxWidth(maxWidth),
      maxHeight != null && dimensions.maxHeight(maxHeight),
    ] as const;
    return (
      <BasePopover.Portal container={mountPoint} className={portalClassName}>
        <BasePopover.Positioner
          ref={ref}
          {...rest}
          sideOffset={sideOffset}
          positionMethod={strategy}
          className={[stylex.props(surface.positioner).className, ...palette]
            .filter(Boolean)
            .join(' ')}
        >
          <BasePopover.Popup
            initialFocus={initialFocus}
            finalFocus={finalFocus}
            style={stylex.props(...panelDimensions).style}
            className={(state) => {
              // StyleX cannot express `[data-starting-style]`, so the two ends
              // of the rise are read off Base UI's transition status here, and
              // the direction from the side the popover actually landed on.
              const hidden =
                state.transitionStatus === 'starting' || state.transitionStatus === 'ending';
              return appendClassName(
                stylex.props(
                  surface.popup,
                  nativeScrollbar,
                  surface.popupPanel,
                  padding === 'none' && layout.noPadding,
                  gap === 'none' && layout.noGap,
                  ...panelDimensions,
                  hidden && hiddenSurfaceForSide(state.side)
                ).className,
                className
              );
            }}
          >
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    );
  }
);

/** A popover's heading, and the sentence under it: one block rather than two. */
export function PopoverHeader({ children, className }: PopoverHeaderProps) {
  const sx = stylex.props(surface.panelHeader);
  return (
    <div className={appendClassName(sx.className, className)} style={sx.style}>
      {children}
    </div>
  );
}

/**
 * The heading. Base UI wires it to the popup's accessible name, so a popover
 * that has one announces it rather than reading its whole body out.
 */
export const PopoverTitle = forwardRef<HTMLHeadingElement, PopoverTitleProps>(function PopoverTitle(
  { className, visuallyHidden = false, ...rest },
  ref
) {
  const sx = stylex.props(surface.panelTitle, visuallyHidden && layout.visuallyHidden);
  return (
    <BasePopover.Title
      ref={ref}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

/** What the heading is about; Base UI wires it to the accessible description. */
export const PopoverDescription = forwardRef<HTMLParagraphElement, PopoverDescriptionProps>(
  function PopoverDescription({ className, ...rest }, ref) {
    const sx = stylex.props(surface.panelDescription);
    return (
      <BasePopover.Description
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    );
  }
);

/**
 * A popover: a trigger and the floating surface it opens, with content on that
 * surface instead of rows.
 *
 * It is the same surface a Select list and a Menu open, and it replaces five of
 * a list's declarations: the `--anchor-width` a list takes because its control
 * shows the value it holds, the 4px inset that lets a row bleed to the
 * surface's edge, and the three that make the type a control's rather than
 * prose. A controlled popover whose anchor owns its own click
 * semantics names that element with `Popover.Content anchor={…}` instead of
 * rendering a trigger, which is Base UI's replacement for a separate anchor
 * part.
 */
export const Popover = {
  Root: BasePopover.Root,
  Trigger: BasePopover.Trigger,
  Content: PopoverContent,
  Header: PopoverHeader,
  Title: PopoverTitle,
  Description: PopoverDescription,
  /** A button that closes the popover; unstyled, like `Menu.Trigger`. */
  Close: BasePopover.Close,
};
