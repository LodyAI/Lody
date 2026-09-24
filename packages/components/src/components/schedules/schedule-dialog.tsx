import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';

/**
 * Desktop host for a schedule's editor or detail: a Dialog over the list, never
 * a tab. The list stays the page underneath, so closing — or saving, which the
 * container routes back to the list — lands where the person started.
 *
 * The body scrolls inside the dialog; a sticky toolbar in it keeps `sm:pr-12`
 * clear of the dialog's close button.
 */
export function ScheduleDialog({
  title,
  open,
  onClose,
  children,
}: {
  /** Accessible name; the form's own title field is the visible heading. */
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogContent className="flex w-[min(46rem,calc(100vw-4rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:p-0">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <div data-settings-surface="" className="min-h-0 flex-1 overflow-auto">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
