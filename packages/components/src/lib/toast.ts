import type { ReactNode } from 'react';
import { Toast } from '@lody/ui';

/**
 * Product toast reporter over `@lody/ui`'s Toast. Callers keep the sonner
 * call shape — `toast.error('Failed', { description })` — while the manager
 * and the surface come from the design system. `Toast.Provider` mounts once at
 * the root with this manager.
 */
export const toastManager = Toast.createManager();

export interface ToastOptions {
  description?: ReactNode;
  /** Milliseconds before auto-dismiss; `0` keeps it until answered. */
  duration?: number;
  /** Adding with an existing id updates that toast in place. */
  id?: string;
  action?: {
    label: ReactNode;
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  };
}

const add =
  (type: 'neutral' | 'success' | 'warning' | 'danger') =>
  (title: ReactNode, options?: ToastOptions): string =>
    toastManager.add({
      title,
      type,
      description: options?.description,
      timeout: options?.duration,
      // The same message reported again updates the one already showing
      // instead of stacking a copy: "Copied" five times is one fact.
      id: options?.id ?? (typeof title === 'string' ? `${type}:${title}` : undefined),
      actionProps: options?.action
        ? { children: options.action.label, onClick: options.action.onClick }
        : undefined,
    });

export const toast = Object.assign(
  (title: ReactNode, options?: ToastOptions): string => add('neutral')(title, options),
  {
    success: add('success'),
    error: add('danger'),
    warning: add('warning'),
    info: add('neutral'),
    dismiss: (toastId?: string): void => toastManager.close(toastId),
  }
);
