import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ChevronRight, HardDrive, LogOut, RefreshCw } from 'lucide-react';

import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { isDesktopAppShell, quitApp, restartApp } from '@/lib/app-restart';
import {
  getStorageCrisisState,
  subscribeToStorageCrisis,
  type StorageCrisisState,
} from '@/lib/storage-crisis';

export type StorageCrisisRecoveryViewProps = {
  crisis: StorageCrisisState;
  /** Desktop can relaunch the process; a browser shell can only reload. */
  isDesktop: boolean;
  onRestart: () => void;
  onQuit: () => void;
  /** A restart or quit is already underway, so both actions are locked. */
  actionPending?: boolean;
};

/**
 * The recovery screen itself. Pure: it renders one latched crisis and reports
 * button presses, exactly like `ErrorBoundaryFallback` sits under
 * `ErrorBoundary`.
 */
export function StorageCrisisRecoveryView({
  crisis,
  isDesktop,
  onRestart,
  onQuit,
  actionPending = false,
}: StorageCrisisRecoveryViewProps) {
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="storage-crisis-title"
      aria-describedby="storage-crisis-description"
      className="fixed inset-0 z-[var(--z-storage-crisis)] flex items-start justify-center overflow-auto bg-background/95 p-4 backdrop-blur-sm sm:items-center sm:p-6"
    >
      <div className="flex w-full max-w-lg min-w-0 flex-col gap-4 rounded-xl border border-border/60 bg-background p-5 text-left shadow-lg">
        <div className="flex items-start gap-2.5">
          <HardDrive className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id="storage-crisis-title" className="text-base font-semibold text-foreground">
              {t('storageCrisis.title', 'Lody ran out of local storage')}
            </h2>
            <p id="storage-crisis-description" className="mt-1 text-sm text-muted-foreground">
              {crisis.kind === 'quota'
                ? t(
                    'storageCrisis.descriptionQuota',
                    'This device is out of space, so Lody could not save your work locally. It has stopped writing to local storage to avoid losing data.'
                  )
                : t(
                    'storageCrisis.descriptionUnavailable',
                    "Lody's local database stopped responding, usually because the device ran out of space. It has stopped writing to local storage to avoid losing data."
                  )}
            </p>
          </div>
        </div>

        <div className="rounded-md border border-border/60 bg-muted/20 p-3">
          <p className="text-xs font-medium text-foreground">
            {t('storageCrisis.stepsTitle', 'How to recover')}
          </p>
          <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-xs leading-5 text-muted-foreground">
            <li>
              {t(
                'storageCrisis.stepFreeSpace',
                'Free up disk space on this device — empty the trash, or delete large files you no longer need.'
              )}
            </li>
            <li>
              {isDesktop
                ? t(
                    'storageCrisis.stepRestartDesktop',
                    'Restart Lody. Freeing space is not enough on its own: the local database only reopens in a new app process.'
                  )
                : t(
                    'storageCrisis.stepRestartWeb',
                    'Reload this page. Freeing space is not enough on its own: the local database only reopens on a fresh page load.'
                  )}
            </li>
          </ol>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {t(
              'storageCrisis.syncedWorkSafe',
              'Work that already synced is unaffected and comes back after the restart.'
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={onRestart} disabled={actionPending}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {isDesktop
              ? t('storageCrisis.restart', 'Restart Lody')
              : t('storageCrisis.reload', 'Reload Lody')}
          </Button>
          {isDesktop ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onQuit}
              disabled={actionPending}
            >
              <LogOut className="size-3.5" aria-hidden="true" />
              {t('storageCrisis.quit', 'Quit Lody')}
            </Button>
          ) : null}
        </div>

        <div className="min-w-0 border-t border-border/60 pt-3">
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
          >
            <ChevronRight
              className={cn('size-3.5 transition-transform', detailsOpen && 'rotate-90')}
              aria-hidden="true"
            />
            {t('storageCrisis.technicalDetails', 'Technical details')}
          </button>
          {detailsOpen ? (
            <pre className="mt-2 max-h-32 min-w-0 [overflow-wrap:anywhere] overflow-auto rounded-md border border-border/60 bg-muted/40 p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap text-muted-foreground select-text">
              {`${crisis.operation}: ${crisis.detail}`}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function readCrisisSnapshot(): StorageCrisisState | null {
  return getStorageCrisisState();
}

function readCrisisServerSnapshot(): StorageCrisisState | null {
  return null;
}

/**
 * The blocking recovery screen for a full or dead repo IndexedDB.
 *
 * Mounted once at the app root, ABOVE the runtime, because the crisis can latch
 * while the workspace runtime is still opening (`loadMeta` runs before anything
 * renders) as easily as it can mid-session.
 *
 * Why blocking rather than a banner: nothing the user does in the app can
 * succeed from here — every repo write goes to the same dead connection — and
 * each attempt used to produce another toast carrying a raw DOMException. It
 * takes over the screen, dismisses whatever error toasts the first failure
 * already raised, and leaves exactly the two actions that actually recover.
 *
 * It deliberately offers no "clear cache" button: `clear-local-cache.ts` works
 * by deleting IndexedDB databases, which blocks while the runtime holds the
 * repo connection open, and it is the wrong tool for a full disk. Freeing disk
 * space happens outside Lody; the app's part is to stop writing and relaunch.
 */
export function StorageCrisisDialog() {
  const crisis = useSyncExternalStore(
    subscribeToStorageCrisis,
    readCrisisSnapshot,
    readCrisisServerSnapshot
  );
  const [pendingAction, setPendingAction] = useState<'restart' | 'quit' | null>(null);

  const active = crisis !== null;
  useEffect(() => {
    if (!active) return;
    // The first failure already raised a toast on whichever surface the user was
    // using. This screen replaces it; leaving it stacked underneath is how the
    // cryptic message stayed on screen.
    toast.dismiss();
  }, [active]);

  const handleRestart = useCallback(() => {
    setPendingAction('restart');
    void restartApp().then((ok) => {
      if (ok) return;
      // No desktop bridge (browser shell, or the bridge itself is gone): a
      // reload is the only restart available there.
      if (typeof window !== 'undefined') window.location.reload();
    });
  }, []);

  const handleQuit = useCallback(() => {
    setPendingAction('quit');
    void quitApp().then((ok) => {
      if (!ok) setPendingAction(null);
    });
  }, []);

  if (!crisis) return null;

  return (
    <StorageCrisisRecoveryView
      crisis={crisis}
      isDesktop={isDesktopAppShell()}
      onRestart={handleRestart}
      onQuit={handleQuit}
      actionPending={pendingAction !== null}
    />
  );
}
