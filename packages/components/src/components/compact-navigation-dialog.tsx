import { useEffect, useRef, type ComponentProps, type ReactNode, type RefObject } from 'react';
import { useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/ui/dialog';
import { WORKSPACE_FOCUS_SCOPES } from '@/atoms/focus-layer';

type DialogActions = NonNullable<ComponentProps<typeof Dialog.Root>['actionsRef']>['current'];

/** Longer than the 220ms slide and the backdrop fade: a close that has not finished by
 * then never started its exit transition. */
export const COMPACT_NAVIGATION_CLOSE_SETTLE_MS = 600;

export function CompactNavigationDialog({
  open,
  onOpenChange,
  container,
  returnFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container: HTMLElement | null;
  returnFocus: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const actionsRef = useRef<DialogActions>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wasOpen = useRef(open);
  useEffect(() => {
    const opened = wasOpen.current;
    wasOpen.current = open;
    if (open || !opened) return undefined;
    // A close that begins before the opening frame finishes has no transition to wait
    // for, and Base UI then keeps the backdrop and the inert background forever. Finish
    // that exit ourselves so the window never stays unusable.
    settleTimer.current = setTimeout(
      () => actionsRef.current?.unmount(),
      COMPACT_NAVIGATION_CLOSE_SETTLE_MS
    );
    return () => clearTimeout(settleTimer.current);
  }, [open]);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={onOpenChange}
      actionsRef={actionsRef}
      onOpenChangeComplete={(nowOpen) => {
        if (!nowOpen) clearTimeout(settleTimer.current);
      }}
    >
      <Dialog.Content
        container={container}
        aria-label={t('sidebar.navigationMenu')}
        aria-modal="true"
        data-state={open ? 'open' : 'closed'}
        closeButton={false}
        width="min(18rem,85vw)"
        finalFocus={() => {
          // Resolve after Dialog releases outside inert/aria-hidden. Focus the
          // fallback scope itself, not Base UI's first tabbable child of it.
          queueMicrotask(() => {
            const target = returnFocus.current;
            if (
              target?.isConnected &&
              !target.matches('[disabled], [aria-disabled="true"]') &&
              !target.closest('[inert], [hidden], [aria-hidden="true"]') &&
              (typeof target.checkVisibility !== 'function' ||
                target.checkVisibility({ checkVisibilityCSS: true }))
            ) {
              target.focus({ preventScroll: true });
              return;
            }
            const content = container?.querySelector<HTMLElement>(
              `[data-focus-scope="${WORKSPACE_FOCUS_SCOPES.content}"]`
            );
            if (content?.isConnected && !content.closest('[inert]'))
              content.focus({ preventScroll: true });
          });
          return false;
        }}
        style={({ transitionStatus }) => ({
          position: 'absolute',
          insetInlineStart: 0,
          insetBlockStart: 0,
          height: '100%',
          maxHeight: '100%',
          padding: 0,
          gap: 0,
          borderRadius: 0,
          transform:
            transitionStatus === 'starting' || transitionStatus === 'ending'
              ? 'translateX(-100%)'
              : 'translateX(0)',
          transitionDuration: reduceMotion ? '0ms' : '220ms',
        })}
      >
        {children}
      </Dialog.Content>
    </Dialog.Root>
  );
}
