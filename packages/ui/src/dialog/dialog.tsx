import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { Button } from '../button/button';
import { appendClassName } from '../internal/class-name';
import { CrossGlyph } from '../internal/glyphs';
import { PopupContainerProvider, type PopupContainer } from '../popup/portal-container';
import { useForcedThemeClassNames } from '../theme/theme';
import { DialogFooter, DialogHeader, usePanelContainer } from './parts';
import { isHidden, modal } from './surface';

type PopupBaseProps = ComponentProps<typeof BaseDialog.Popup>;
type BackdropBaseProps = ComponentProps<typeof BaseDialog.Backdrop>;
type TitleBaseProps = ComponentProps<typeof BaseDialog.Title>;
type DescriptionBaseProps = ComponentProps<typeof BaseDialog.Description>;

/**
 * What every panel on the modal rung takes, whichever part opens it.
 *
 * Everything Base UI's popup takes comes through — `initialFocus`, `finalFocus`,
 * a `style`, an `id`, the `data-*` a host hangs its own selectors off — because
 * a panel is where a product surface puts its own layout, and a props list that
 * enumerated only what this package thought of would send the next caller back
 * to Radix for a `style` attribute.
 */
export interface ModalContentProps extends Omit<PopupBaseProps, 'className' | 'render'> {
  /** Where the dialog mounts. Defaults to the document body. */
  container?: PopupContainer;
  /**
   * Content laid over the backdrop rather than in the panel. The backdrop is
   * the one element that spans the whole window above the page, so a desktop
   * shell that needs a drag strip there names it here; a dialog has no other
   * opinion about what a host puts on its overlay.
   */
  backdropContent?: ReactNode;
  /** Classes for the backdrop, for a host that has to restack it. */
  backdropClassName?: string;
  className?: string;
}

export interface DialogContentProps extends ModalContentProps {
  /**
   * The cross in the panel's corner. It is on by default because a dialog is
   * dismissable and a person has to be able to see that without trying; a panel
   * whose only way out is its own footer says so with `closeButton={false}`.
   */
  closeButton?: boolean;
  /** What a screen reader calls that cross. */
  closeLabel?: string;
}

export interface DialogTitleProps extends Omit<TitleBaseProps, 'className'> {
  className?: string;
}
export interface DialogDescriptionProps extends Omit<DescriptionBaseProps, 'className'> {
  className?: string;
}
export interface DialogBackdropProps extends Omit<BackdropBaseProps, 'className'> {
  className?: string;
}

const styles = stylex.create({
  /**
   * The portal wraps both the backdrop and the panel, and a forced palette has
   * to reach both. It carries no appearance of its own, so it is the one place
   * the palette classes can land without a second element being invented for
   * them.
   */
  portal: { display: 'contents' },
});

/** The overlay under the panel, and whatever the host put on it. */
export const DialogBackdrop = forwardRef<HTMLDivElement, DialogBackdropProps>(
  function DialogBackdrop({ className, children, ...rest }, ref) {
    return (
      <BaseDialog.Backdrop
        ref={ref}
        {...rest}
        className={(state) =>
          appendClassName(
            stylex.props(modal.backdrop, isHidden(state.transitionStatus) && modal.backdropHidden)
              .className,
            className
          )
        }
      >
        {children}
      </BaseDialog.Backdrop>
    );
  }
);

/**
 * The dialog, assembled. Base UI splits it into a portal, a backdrop and the
 * popup; every caller writes the same three, so this part writes them once.
 *
 * It also states the panel as the container for every popup under it. A modal
 * holds focus and the scroll inside its own subtree by DOM position, so a
 * Select, a Combobox or a Menu portalled to the body would be outside the
 * dialog to the dialog — focus pulled back the moment the list opened and the
 * wheel swallowed before it could scroll. The panel names itself once here, so
 * a product surface never has to.
 */
export const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(function DialogContent(
  {
    className,
    children,
    container,
    backdropContent,
    backdropClassName,
    closeButton = true,
    closeLabel = 'Close',
    ...rest
  },
  ref
) {
  const { ref: panelRef, container: panel } = usePanelContainer<HTMLDivElement>(ref);
  // A portalled panel leaves the subtree whose palette it should be using, so
  // the classes that declare that palette travel with it and land on the
  // portal, where they cascade into the backdrop and the panel alike.
  const palette = useForcedThemeClassNames();
  return (
    <BaseDialog.Portal
      container={container}
      className={[stylex.props(styles.portal).className, ...palette].filter(Boolean).join(' ')}
    >
      <DialogBackdrop className={backdropClassName}>{backdropContent}</DialogBackdrop>
      <BaseDialog.Popup
        ref={panelRef}
        {...rest}
        className={(state) =>
          appendClassName(
            stylex.props(modal.popup, isHidden(state.transitionStatus) && modal.popupHidden)
              .className,
            className
          )
        }
      >
        <PopupContainerProvider container={panel}>{children}</PopupContainerProvider>
        {closeButton ? (
          <BaseDialog.Close
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
          </BaseDialog.Close>
        ) : null}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
});

/** The heading. Base UI wires it to the panel's accessible name. */
export const DialogTitle = forwardRef<HTMLHeadingElement, DialogTitleProps>(function DialogTitle(
  { className, ...rest },
  ref
) {
  const sx = stylex.props(modal.title);
  return (
    <BaseDialog.Title
      ref={ref}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

/** What the heading is about; Base UI wires it to the accessible description. */
export const DialogDescription = forwardRef<HTMLParagraphElement, DialogDescriptionProps>(
  function DialogDescription({ className, ...rest }, ref) {
    const sx = stylex.props(modal.description);
    return (
      <BaseDialog.Description
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    );
  }
);

/**
 * A dialog: a panel on the modal rung, over an overlay, holding the page still
 * until it is answered or dismissed.
 *
 * `Dialog.Content` assembles the portal, the backdrop and the panel, renders
 * the cross that dismisses it, carries a forced palette across the portal, and
 * names itself as the container every popup inside it mounts into. A caller
 * writes a header, a body and a footer.
 *
 * `AlertDialog` is the same panel for a question that has to be answered, and
 * `Drawer` is the same panel arriving from an edge of the window and draggable
 * back out of it; all three read one token group, so a padding or a title step
 * has one place to change.
 */
export const Dialog = {
  Root: BaseDialog.Root,
  /** Unstyled, like `Menu.Trigger`: whatever the surface already had there. */
  Trigger: BaseDialog.Trigger,
  Content: DialogContent,
  Backdrop: DialogBackdrop,
  Header: DialogHeader,
  Title: DialogTitle,
  Description: DialogDescription,
  Footer: DialogFooter,
  /** A button that closes the dialog; unstyled, so a footer answers with it. */
  Close: BaseDialog.Close,
};
