import * as React from 'react';
import { Dialog as UiDialog, AlertDialog as UiAlertDialog } from '@lody/ui';
import { Button, type ButtonVariant } from '@lody/ui/button';

import { WindowDragStrip } from '@/ui/window-drag-region';

/**
 * Product adapter over `@lody/ui`'s modal family. The package owns the
 * surface; this file owns the two pieces of product behaviour the old Radix
 * wrappers carried:
 *
 * - `data-lody-dialog-content` on the panel, which the mention popover and a
 *   few floating callers `closest()` to find the modal they should mount into.
 * - `WindowDragStrip` on the backdrop, so an Electron window stays draggable
 *   beside the dialog the same way it is beside the page.
 *
 * `AlertDialog.Action`/`AlertDialog.Cancel` are `Close` rendered as styled
 * buttons: an answer runs its `onClick` and then closes. An answer that must
 * hold the dialog open while work is in flight is not a `Close` at all — it is
 * a plain `Button`, and the caller closes through the root's `onOpenChange`
 * when the work resolves.
 */

type DialogContentProps = React.ComponentProps<typeof UiDialog.Content>;

const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(function DialogContent(
  { backdropContent, ...props },
  ref
) {
  return (
    <UiDialog.Content
      ref={ref}
      data-lody-dialog-content=""
      backdropContent={backdropContent ?? <WindowDragStrip />}
      {...props}
    />
  );
});

export const Dialog = {
  ...UiDialog,
  Content: DialogContent,
};

type AlertDialogContentProps = React.ComponentProps<typeof UiAlertDialog.Content>;

const AlertDialogContent = React.forwardRef<HTMLDivElement, AlertDialogContentProps>(
  function AlertDialogContent({ backdropContent, ...props }, ref) {
    return (
      <UiAlertDialog.Content
        ref={ref}
        data-lody-dialog-content=""
        backdropContent={backdropContent ?? <WindowDragStrip />}
        {...props}
      />
    );
  }
);

type AlertDialogAnswerProps = Omit<React.ComponentProps<typeof UiAlertDialog.Close>, 'render'> & {
  variant?: ButtonVariant;
  className?: string;
};

/** The confirming answer: a `Close` rendered as a `Button` with a variant. */
const AlertDialogAction = React.forwardRef<HTMLButtonElement, AlertDialogAnswerProps>(
  function AlertDialogAction({ variant, className, children, ...props }, ref) {
    return (
      <UiAlertDialog.Close
        ref={ref}
        render={<Button variant={variant} className={className} />}
        {...props}
      >
        {children}
      </UiAlertDialog.Close>
    );
  }
);

const AlertDialogCancel = React.forwardRef<HTMLButtonElement, AlertDialogAnswerProps>(
  function AlertDialogCancel({ className, children, ...props }, ref) {
    return (
      <UiAlertDialog.Close
        ref={ref}
        render={<Button variant="secondary" className={className} />}
        {...props}
      >
        {children}
      </UiAlertDialog.Close>
    );
  }
);

export const AlertDialog = {
  ...UiAlertDialog,
  Content: AlertDialogContent,
  Action: AlertDialogAction,
  Cancel: AlertDialogCancel,
};
