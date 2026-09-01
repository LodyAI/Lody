import React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { isImeComposingNativeKeyboardEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { WindowDragStrip } from '@/ui/window-drag-region';

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

// Fade animation for the backdrop. Pulled out so surfaces that opt into
// `noAnimation` (e.g. the command palette) can appear instantly.
const dialogOverlayAnimationClasses =
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0';

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay> & {
    /** Skip the backdrop fade so the overlay shows/hides instantly. */
    noAnimation?: boolean;
  }
>(({ className, noAnimation, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-[var(--z-dialog-overlay)] bg-black/80',
      !noAnimation && dialogOverlayAnimationClasses,
      className
    )}
    {...props}
  >
    <WindowDragStrip />
  </DialogPrimitive.Overlay>
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

// Center vertically and cap height while accounting for the device safe area
// (notch, home indicator). On desktop browsers `env(safe-area-inset-*)` is 0px,
// so behavior is identical there; on iOS/Android shells the dialog shifts and
// shrinks so it never sits underneath the status bar or home indicator.
// Consumers that want a true full-screen sheet (e.g. the agent config dialog on
// narrow viewports) override these by adding `max-h-none top-[50%]` and
// applying their own safe-area padding.
const dialogBaseClasses =
  'fixed left-[50%] top-[calc(50%+(var(--safe-area-top)-var(--safe-area-bottom))/2)] z-[var(--z-dialog)] grid w-[calc(100vw-4rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-border bg-background p-4 sm:p-6 shadow-lg rounded-lg max-h-[calc(100vh-2rem-var(--safe-area-top)-var(--safe-area-bottom))]';

// Enter/exit animation for the dialog panel. Just a fade — the old zoom + slide
// made the panel appear to fly in from the top-left corner. Pulled out so surfaces
// that opt into `noAnimation` (e.g. the command palette) can pop in instantly.
const dialogAnimationClasses =
  'duration-100 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0';

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Extra classes for the backdrop overlay — e.g. a z-index override so the dialog
     *  stacks above a surface that carries its own hardcoded z-index. */
    overlayClassName?: string;
    /** Skip the enter/exit animation so the dialog appears instantly. */
    noAnimation?: boolean;
  }
>(({ className, overlayClassName, noAnimation, children, onEscapeKeyDown, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay className={overlayClassName} noAnimation={noAnimation} />
    <DialogPrimitive.Content
      ref={ref}
      data-lody-dialog-content=""
      className={cn(dialogBaseClasses, !noAnimation && dialogAnimationClasses, className)}
      onEscapeKeyDown={(event) => {
        if (isImeComposingNativeKeyboardEvent(event)) {
          event.preventDefault();
          return;
        }
        onEscapeKeyDown?.(event);
      }}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-hover data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogContentWithoutClose = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Extra classes for the backdrop overlay — e.g. a z-index override. */
    overlayClassName?: string;
    /** Skip the enter/exit animation so the dialog appears instantly. */
    noAnimation?: boolean;
  }
>(({ className, overlayClassName, noAnimation, children, onEscapeKeyDown, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay className={overlayClassName} noAnimation={noAnimation} />
    <DialogPrimitive.Content
      ref={ref}
      data-lody-dialog-content=""
      className={cn(dialogBaseClasses, !noAnimation && dialogAnimationClasses, className)}
      onEscapeKeyDown={(event) => {
        if (isImeComposingNativeKeyboardEvent(event)) {
          event.preventDefault();
          return;
        }
        onEscapeKeyDown?.(event);
      }}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContentWithoutClose.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1.5 text-center sm:text-left', className)} {...props} />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:gap-2', className)}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogContentWithoutClose,
};
