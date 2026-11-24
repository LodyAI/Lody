import {
  cloneElement,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
} from 'react';
import { ScrollText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { text } from '@lody/ui/tokens/scales.stylex';
import { Button, Dialog } from '@/ui';

/* Lazy so the generated attribution bundle (~380KB) stays out of the boot
   chunk: it is fetched only when the dialog panel actually opens. */
const OpenSourceAttributionsContent = lazy(() =>
  import('./open-source-attributions-content').then((module) => ({
    default: module.OpenSourceAttributionsContent,
  }))
);

/**
 * The panel's own width: a license list reads as a table of names and notes, so
 * it takes a wider panel than a question does.
 */
const PANEL_WIDTH = '1024px';

const styles = stylex.create({
  smallIcon: { width: '14px', height: '14px', flexShrink: 0 },
  /** Centered while the lazily loaded attribution content arrives. */
  pending: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '240px',
    fontSize: text.footnoteSize,
  },
});

type TriggerHandlers = {
  onClick?: (event: MouseEvent) => void;
  onDoubleClick?: (event: MouseEvent) => void;
};

export function OpenSourceAttributionsDialog({
  trigger,
  onTriggerDoubleClick,
}: {
  /**
   * What opens the dialog, when not the default "View notices" button — the
   * desktop About page makes the row itself the link. It must render a
   * `<button>` and forward its ref and handlers.
   */
  trigger?: ReactElement<TriggerHandlers>;
  onTriggerDoubleClick?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearOpenTimer = () => {
    if (!openTimerRef.current) return;
    clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  };

  useEffect(() => clearOpenTimer, []);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) clearOpenTimer();
        setOpen(nextOpen);
      }}
    >
      <Dialog.Trigger
        render={cloneElement<TriggerHandlers>(
          trigger ?? <Button variant="secondary" size="small" />,
          {
            onClick: (event: MouseEvent) => {
              event.preventDefault();
              // Base UI's trigger still opens on click after this handler —
              // `preventDefault` does not reach it, only its own opt-out does.
              // Suppress it so the deferred open survives long enough for a
              // double-click to cancel it.
              (event as { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
              clearOpenTimer();
              openTimerRef.current = setTimeout(() => {
                openTimerRef.current = null;
                setOpen(true);
              }, 400);
            },
            onDoubleClick: (event: MouseEvent) => {
              event.preventDefault();
              clearOpenTimer();
              onTriggerDoubleClick?.();
            },
          }
        )}
      >
        {trigger ? undefined : (
          <>
            <ScrollText {...stylex.props(styles.smallIcon)} />
            {t('settings.about.viewAttributions', 'View notices')}
          </>
        )}
      </Dialog.Trigger>
      <Dialog.Content width={PANEL_WIDTH}>
        <Suspense
          fallback={<div {...stylex.props(styles.pending)}>{t('common.loading', 'Loading…')}</div>}
        >
          <OpenSourceAttributionsContent />
        </Suspense>
      </Dialog.Content>
    </Dialog.Root>
  );
}
