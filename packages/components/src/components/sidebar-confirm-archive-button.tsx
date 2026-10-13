import { Archive } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { Button } from '@lody/ui/button';

type SidebarConfirmArchiveButtonProps = {
  label: string;
  confirmLabel: string;
  iconClassName?: string;
  onConfirm: () => void;
} & Omit<ComponentPropsWithoutRef<'button'>, 'type' | 'onConfirm'>;

/** Confirmation is owned by SessionArchiveDialog, shared by every manual entry. */
export const SidebarConfirmArchiveButton = forwardRef<
  HTMLButtonElement,
  SidebarConfirmArchiveButtonProps
>(function SidebarConfirmArchiveButton(
  { label, confirmLabel: _confirmLabel, iconClassName, onConfirm, onClick, className, ...props },
  ref
) {
  return (
    <Button
      {...props}
      ref={ref}
      type="button"
      variant="ghost"
      size="mini"
      icon
      aria-label={label}
      className={className}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onConfirm();
      }}
    >
      <Archive size={14} className={iconClassName} />
    </Button>
  );
});
