import { Drawer as BaseDrawer } from '@base-ui/react/drawer';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { Button } from '../button/button';
import { DialogFooter, DialogHeader, usePanelContainer } from '../dialog/parts';
import {
  drawerFlushStyle,
  drawerHiddenStyle,
  drawerSizeStyle,
  drawerSwipeDirection,
  drawerViewportStyle,
  isHidden,
  modal,
  type DrawerSide,
} from '../dialog/surface';
import { appendClassName } from '../internal/class-name';
import { CrossGlyph } from '../internal/glyphs';
import { PopupContainerProvider, type PopupContainer } from '../popup/portal-container';
import { useForcedThemeClassNames } from '../theme/theme';

export type { DrawerSide };

type PopupBaseProps = ComponentProps<typeof BaseDrawer.Popup>;

/**
 * Everything Base UI's drawer popup takes comes through, the way it does on the
 * dialog's `Content`. It is stated against the drawer's own popup rather than
 * reusing `ModalContentProps`: the two popups report different state — a dialog
 * knows about nested dialogs, a drawer about snap points and swipes — so a
 * `style` or `className` callback typed for one cannot be handed to the other.
 */
export interface DrawerContentProps extends Omit<PopupBaseProps, 'className' | 'render'> {
  /** Where the drawer mounts. Defaults to the document body. */
  container?: PopupContainer;
  /**
   * Content laid over the backdrop rather than in the panel — a desktop shell's
   * window drag strip, for instance.
   */
  backdropContent?: ReactNode;
  /** Classes for the backdrop, for a host that has to restack it. */
  backdropClassName?: string;
  className?: string;
  /**
   * Which edge the drawer comes in on. `start` and `end` are the writing
   * direction's edges rather than left and right, so a drawer that opens from
   * the trailing side of the window does so in every locale — and is swiped
   * away in the direction that actually means "away" there.
   */
  side?: DrawerSide;
  /**
   * Hold the panel off every edge instead of meeting one.
   *
   * A flush drawer is part of the window: it reaches the physical edge and
   * squares the two corners that touch it. An inset drawer is an object resting
   * over the page: it floats at `dialog.drawerInset`, keeps all four corners,
   * and travels that extra distance on its way out.
   */
  inset?: boolean;
  /** The cross in the panel's corner. */
  closeButton?: boolean;
  /** What a screen reader calls that cross. */
  closeLabel?: string;
}

const styles = stylex.create({
  portal: { display: 'contents' },
});

/**
 * Whether the document reads right to left.
 *
 * Base UI names a swipe in physical directions because a finger moves in
 * physical space, while this package names an edge in writing-direction terms.
 * Resolving between them needs the direction actually in force, which is a
 * property of the document rather than of a prop, so it is subscribed to rather
 * than passed in. It is read through `useSyncExternalStore` with a server
 * snapshot of `false`, so a server render and the first client render agree.
 */
function useRtl(): boolean {
  return useSyncExternalStore(
    subscribeToDirection,
    () => document.documentElement.dir === 'rtl',
    () => false
  );
}

function subscribeToDirection(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['dir'] });
  return () => observer.disconnect();
}

/**
 * The drawer, assembled: the portal, the backdrop, the viewport that decides
 * which edge the panel is on, and the panel itself.
 *
 * The viewport is the part a dialog does not have, and it is what makes this a
 * drawer rather than a dialog pinned to an edge: Base UI lays the panel out
 * inside it instead of positioning the panel, which leaves the panel's own
 * `transform` free to carry the drag. A `Dialog` centred with
 * `translate(-50%, -50%)` has no room for a gesture in that property.
 *
 * `Drawer.Content` — Base UI's, not this package's `Content` — wraps the
 * children so a mouse can select text inside the panel without the selection
 * being read as a swipe.
 */
export const DrawerContent = forwardRef<HTMLDivElement, DrawerContentProps>(function DrawerContent(
  {
    className,
    children,
    container,
    backdropContent,
    backdropClassName,
    closeButton = true,
    closeLabel = 'Close',
    side = 'end',
    inset = false,
    ...rest
  },
  ref
) {
  const { ref: panelRef, container: panel } = usePanelContainer<HTMLDivElement>(ref);
  const palette = useForcedThemeClassNames();
  return (
    <BaseDrawer.Portal
      container={container}
      className={[stylex.props(styles.portal).className, ...palette].filter(Boolean).join(' ')}
    >
      <BaseDrawer.Backdrop
        className={(state) =>
          appendClassName(
            stylex.props(
              modal.backdrop,
              modal.backdropSwipe,
              isHidden(state.transitionStatus) && modal.backdropHidden
            ).className,
            backdropClassName
          )
        }
      >
        {backdropContent}
      </BaseDrawer.Backdrop>
      <BaseDrawer.Viewport
        className={
          stylex.props(
            modal.drawerViewport,
            drawerViewportStyle(side),
            inset && modal.drawerViewportInset
          ).className
        }
      >
        <BaseDrawer.Popup
          ref={panelRef}
          data-side={side}
          {...rest}
          className={(state) =>
            appendClassName(
              stylex.props(
                modal.drawerPopup,
                drawerSizeStyle(side),
                !inset && drawerFlushStyle(side),
                isHidden(state.transitionStatus) && drawerHiddenStyle(side, inset)
              ).className,
              className
            )
          }
        >
          <BaseDrawer.Content>
            <PopupContainerProvider container={panel}>{children}</PopupContainerProvider>
          </BaseDrawer.Content>
          {closeButton ? (
            <BaseDrawer.Close
              render={
                <Button
                  variant="ghost"
                  size="small"
                  icon
                  aria-label={closeLabel}
                  {...stylex.props(modal.close)}
                />
              }
            >
              <CrossGlyph />
            </BaseDrawer.Close>
          ) : null}
        </BaseDrawer.Popup>
      </BaseDrawer.Viewport>
    </BaseDrawer.Portal>
  );
});

type TitleBaseProps = ComponentProps<typeof BaseDrawer.Title>;
type DescriptionBaseProps = ComponentProps<typeof BaseDrawer.Description>;

export interface DrawerTitleProps extends Omit<TitleBaseProps, 'className'> {
  className?: string;
}
export interface DrawerDescriptionProps extends Omit<DescriptionBaseProps, 'className'> {
  className?: string;
}

/**
 * The heading. It is Base UI's drawer title rather than the dialog's: the two
 * look identical and read different contexts, and a dialog's inside a drawer
 * would label nothing.
 */
export const DrawerTitle = forwardRef<HTMLHeadingElement, DrawerTitleProps>(function DrawerTitle(
  { className, ...rest },
  ref
) {
  const sx = stylex.props(modal.title);
  return (
    <BaseDrawer.Title
      ref={ref}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

/** What the heading is about; Base UI wires it to the accessible description. */
export const DrawerDescription = forwardRef<HTMLParagraphElement, DrawerDescriptionProps>(
  function DrawerDescription({ className, ...rest }, ref) {
    const sx = stylex.props(modal.description);
    return (
      <BaseDrawer.Description
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    );
  }
);

export interface DrawerRootProps extends Omit<
  ComponentProps<typeof BaseDrawer.Root>,
  'swipeDirection'
> {
  /**
   * Which edge the drawer belongs to. The swipe that dismisses it is derived
   * from this, so a caller states the edge once rather than keeping an edge and
   * a gesture in step — and the derivation flips the inline pair in a
   * right-to-left document, because "away" is the other way there.
   */
  side?: DrawerSide;
}

/**
 * The root. It owns the open state and, through `side`, the gesture.
 *
 * A caller states the edge on both the root and the content, because the root
 * needs it for the swipe and the content needs it for the layout, and Base UI
 * keeps the two parts apart. That is one repeated prop rather than a context
 * this package would have to invent and keep in step with Base UI's own.
 */
export function DrawerRoot({ side = 'end', ...rest }: DrawerRootProps) {
  const rtl = useRtl();
  return <BaseDrawer.Root swipeDirection={drawerSwipeDirection(side, rtl)} {...rest} />;
}

/**
 * A drawer: a panel that slides in from an edge of the window, and that a
 * person can drag back out of it.
 *
 * It is the modal rung — the same `dialog` token group and the same
 * `dialog/surface.ts` as `Dialog` and `AlertDialog` — so a padding or a title
 * step has one place to change. What makes it a drawer rather than a dialog
 * pinned to an edge is the gesture: a panel that arrives from an edge promises
 * that it can be sent back, and on touch a person will try. Building one on
 * `Dialog` cannot answer that, which is why this package has no `Sheet`.
 *
 * `Drawer.Indent` is Base UI's, unstyled: a surface that wants the page behind
 * the drawer to recede wraps its own UI in it and styles `data-active` itself.
 * That is a decision about a product's shell rather than about a drawer, so the
 * primitive exposes it and does not choose.
 */
export const Drawer = {
  Root: DrawerRoot,
  /** Unstyled, like `Menu.Trigger`: whatever the surface already had there. */
  Trigger: BaseDrawer.Trigger,
  Content: DrawerContent,
  Header: DialogHeader,
  Title: DrawerTitle,
  Description: DrawerDescription,
  Footer: DialogFooter,
  Close: BaseDrawer.Close,
  /** The app's own UI, for a shell that wants it to recede behind the drawer. */
  Provider: BaseDrawer.Provider,
  Indent: BaseDrawer.Indent,
};
