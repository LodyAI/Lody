import { AlertDialog as BaseAlertDialog } from '@base-ui/react/alert-dialog';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps } from 'react';
import { appendClassName } from '../internal/class-name';
import { PopupContainerProvider } from '../popup/portal-container';
import { useForcedThemeClassNames } from '../theme/theme';
import type { ModalContentProps } from './dialog';
import { DialogFooter, DialogHeader, usePanelContainer } from './parts';
import { isHidden, modal } from './surface';

type TitleBaseProps = ComponentProps<typeof BaseAlertDialog.Title>;
type DescriptionBaseProps = ComponentProps<typeof BaseAlertDialog.Description>;

/**
 * An alert dialog's panel takes everything a dialog's does except the cross:
 * the point of one is that it is answered rather than dismissed, so there is no
 * affordance to leave it by and a press beside it is not an answer.
 */
export type AlertDialogContentProps = ModalContentProps;

export interface AlertDialogTitleProps extends Omit<TitleBaseProps, 'className'> {
  className?: string;
}
export interface AlertDialogDescriptionProps extends Omit<DescriptionBaseProps, 'className'> {
  className?: string;
}

const styles = stylex.create({
  /** The portal carries the forced palette for the backdrop and the panel both. */
  portal: { display: 'contents' },
});

/**
 * The alert dialog, assembled: the same portal, backdrop and panel a
 * `Dialog.Content` writes, reading the same token group, and naming itself as
 * the container every popup inside it mounts into.
 */
export const AlertDialogContent = forwardRef<HTMLDivElement, AlertDialogContentProps>(
  function AlertDialogContent(
    { className, children, container, backdropContent, backdropClassName, ...rest },
    ref
  ) {
    const { ref: panelRef, container: panel } = usePanelContainer<HTMLDivElement>(ref);
    const palette = useForcedThemeClassNames();
    return (
      <BaseAlertDialog.Portal
        container={container}
        className={[stylex.props(styles.portal).className, ...palette].filter(Boolean).join(' ')}
      >
        <BaseAlertDialog.Backdrop
          className={(state) =>
            appendClassName(
              stylex.props(modal.backdrop, isHidden(state.transitionStatus) && modal.backdropHidden)
                .className,
              backdropClassName
            )
          }
        >
          {backdropContent}
        </BaseAlertDialog.Backdrop>
        <BaseAlertDialog.Popup
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
        </BaseAlertDialog.Popup>
      </BaseAlertDialog.Portal>
    );
  }
);

/** The question. Base UI wires it to the panel's accessible name. */
export const AlertDialogTitle = forwardRef<HTMLHeadingElement, AlertDialogTitleProps>(
  function AlertDialogTitle({ className, ...rest }, ref) {
    const sx = stylex.props(modal.title);
    return (
      <BaseAlertDialog.Title
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    );
  }
);

/** What is at stake in the question; the accessible description. */
export const AlertDialogDescription = forwardRef<HTMLParagraphElement, AlertDialogDescriptionProps>(
  function AlertDialogDescription({ className, ...rest }, ref) {
    const sx = stylex.props(modal.description);
    return (
      <BaseAlertDialog.Description
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    );
  }
);

/**
 * An alert dialog: the dialog's panel for a question that has to be answered.
 *
 * It is the same rung, the same padding and the same title step as `Dialog` —
 * they are one family reading one token group — and it differs in exactly what
 * the name says: there is no cross, and a press beside it is not an answer, so
 * a stray click cannot take it away. Escape still closes it, because Escape is
 * the platform's cancel: removing it would leave a keyboard user holding a
 * panel they had no way to put down. `test/dialog.test.tsx` pins both halves.
 *
 * The answers in its footer are Buttons, not parts of this component. Which variant and
 * which tone an answer takes is the surface's decision — "Delete" is
 * destructive in one place and ordinary in another — so a footer writes them
 * the way a menu writes its trigger:
 *
 * ```tsx
 * <AlertDialog.Footer>
 *   <AlertDialog.Close render={<Button variant="secondary" />}>Keep</AlertDialog.Close>
 *   <AlertDialog.Close render={<Button variant="destructive" onClick={remove} />}>
 *     Delete
 *   </AlertDialog.Close>
 * </AlertDialog.Footer>
 * ```
 */
export const AlertDialog = {
  Root: BaseAlertDialog.Root,
  /** Unstyled, like `Menu.Trigger`: whatever the surface already had there. */
  Trigger: BaseAlertDialog.Trigger,
  Content: AlertDialogContent,
  Header: DialogHeader,
  Title: AlertDialogTitle,
  Description: AlertDialogDescription,
  Footer: DialogFooter,
  /** An answer: it runs its own `onClick` and then closes the panel. */
  Close: BaseAlertDialog.Close,
};
