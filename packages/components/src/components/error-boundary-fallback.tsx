import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';

import { Button } from '@/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { writeTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/native-browser';
import { LODY_DISCORD_URL } from '@/lib/lody-urls';
import { reloadApp, startHardReset } from '@/lib/clear-local-cache';
import {
  buildErrorBoundaryReport,
  collectErrorBoundaryEnvironment,
  isRawConvexServerError,
} from '@/lib/error-boundary-report';
import { getSessionRenderTraceText } from '@/lib/session-render-trace';
import { cn } from '@/lib/utils';

export type ErrorBoundaryFallbackVariant = 'page' | 'section' | 'inline';

export type ErrorBoundaryFallbackViewProps = {
  error: Error;
  /** Retry the crashed subtree without a page reload. */
  resetErrorBoundary: () => void;
  variant: ErrorBoundaryFallbackVariant;
  componentStack: string | null;
  boundaryName?: string | undefined;
  /** Hide the message + details block. Only used by hosts that must stay terse. */
  showErrorDetails?: boolean;
  /**
   * The boundary gave up on recovering this error by itself (see
   * `MAX_AUTOMATIC_RESETS`). Say so, because from here the screen only changes
   * when the user presses something.
   */
  automaticRetriesStopped?: boolean;
};

const COPIED_RESET_MS = 2000;

/**
 * The crash screen a user actually gets to read.
 *
 * Invariants, learned from users who got permanently wedged on the old version:
 * - The real error text is on screen, not only in DevTools, and copyable in one
 *   click — the copy payload is the full report from `error-boundary-report.ts`.
 * - Nothing here reloads or resets on its own. Every recovery step is a button
 *   the user presses, in escalating order (retry → reload → report → wipe).
 * - The last resort clears every local trace and signs the user out, so a
 *   poisoned local state (a bad sign-in above all) cannot trap them forever.
 */
export function ErrorBoundaryFallback({
  error,
  resetErrorBoundary,
  variant,
  componentStack,
  boundaryName,
  showErrorDetails = true,
  automaticRetriesStopped = false,
}: ErrorBoundaryFallbackViewProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [hardResetOpen, setHardResetOpen] = useState(false);
  const [hardResetting, setHardResetting] = useState(false);

  // The environment snapshot is taken once per crash, not per render, so the
  // timestamp in the report is when the crash surfaced.
  const report = useMemo(
    () =>
      buildErrorBoundaryReport({
        error,
        boundaryName,
        componentStack,
        environment: collectErrorBoundaryEnvironment(),
        renderTrace: getSessionRenderTraceText(),
      }),
    [error, boundaryName, componentStack]
  );

  // Backend payloads quote server internals, so the headline stays generic while
  // the raw text remains one deliberate click (or one copy) away.
  const headline = isRawConvexServerError(error)
    ? t('errorBoundary.serverErrorSummary', 'The Lody backend returned a server error.')
    : report.summary;

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = useCallback(() => {
    void writeTextToClipboard(report.text).then((ok) => {
      setCopied(ok);
      setCopyFailed(!ok);
      if (!ok) {
        // Copying can be blocked (insecure context, no gesture). Open the
        // details so the text is at least selectable by hand.
        setDetailsOpen(true);
      }
    });
  }, [report.text]);

  const handleHardReset = useCallback(() => {
    setHardResetting(true);
    // Ends in a reload, so there is no success state to render — the dialog just
    // stays in its progress state until the app comes back.
    void startHardReset();
  }, []);

  if (variant === 'inline') {
    return (
      <div
        role="alert"
        className="inline-flex w-fit max-w-full items-center gap-2 rounded-md border border-border/60 bg-background/80 px-3 py-2"
      >
        <AlertTriangle className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={headline}>
          {showErrorDetails ? headline : t('errorBoundary.inlineTitle', 'This part failed')}
        </span>
        <button
          type="button"
          className="shrink-0 text-xs font-medium text-foreground underline-offset-4 hover:underline"
          onClick={resetErrorBoundary}
        >
          {t('errorBoundary.tryAgain', 'Try again')}
        </button>
        <button
          type="button"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={handleCopy}
          aria-label={t('errorBoundary.copyDetails', 'Copy error details')}
        >
          {copied ? (
            <Check className="size-3.5 text-emerald-500" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
        </button>
      </div>
    );
  }

  const isPage = variant === 'page';

  return (
    <div
      role="alert"
      className={cn(
        'w-full',
        isPage
          ? 'flex min-h-[60vh] items-start justify-center overflow-auto p-4 sm:items-center sm:p-6'
          : 'rounded-lg border border-border/60 bg-background/80 p-4'
      )}
    >
      <div
        className={cn(
          'flex w-full min-w-0 flex-col gap-3 text-left',
          isPage && 'max-w-2xl rounded-xl border border-border/60 bg-background/80 p-5 shadow-sm'
        )}
      >
        <div className="flex items-start gap-2.5">
          <AlertTriangle
            className={cn('shrink-0 text-destructive', isPage ? 'mt-0.5 size-5' : 'mt-px size-4')}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h2 className={cn('font-semibold text-foreground', isPage ? 'text-base' : 'text-sm')}>
              {t('errorBoundary.title', 'Lody hit an unexpected error')}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
              {automaticRetriesStopped
                ? t(
                    'errorBoundary.descriptionRetriesStopped',
                    'This error came back every time, so Lody stopped retrying on its own — the screen now stays put until you choose a step below.'
                  )
                : t(
                    'errorBoundary.description',
                    'The rest of the app is still running. Nothing reloads on its own — pick a step below.'
                  )}
            </p>
          </div>
        </div>

        {showErrorDetails ? (
          <pre className="max-h-32 min-w-0 select-text overflow-auto rounded-md border border-border/60 bg-muted/40 p-3 font-mono text-xs leading-5 text-foreground [overflow-wrap:anywhere] whitespace-pre-wrap">
            {headline}
          </pre>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={resetErrorBoundary}>
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {t('errorBoundary.tryAgain', 'Try again')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              reloadApp();
            }}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {t('errorBoundary.reload', 'Reload Lody')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={handleCopy}>
            {copied ? (
              <Check className="size-3.5 text-emerald-500" aria-hidden="true" />
            ) : (
              <Copy className="size-3.5" aria-hidden="true" />
            )}
            {copied
              ? t('errorBoundary.copied', 'Copied')
              : t('errorBoundary.copyDetails', 'Copy error details')}
          </Button>
        </div>

        {copyFailed ? (
          <p className="text-xs text-destructive">
            {t(
              'errorBoundary.copyFailed',
              'Copying was blocked. Open the technical details below and select the text manually.'
            )}
          </p>
        ) : null}

        <div className="rounded-md border border-border/60 bg-muted/20 p-3">
          <p className="text-xs font-medium text-foreground">
            {t('errorBoundary.nextStepsTitle', 'If it keeps happening')}
          </p>
          <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-xs leading-5 text-muted-foreground">
            <li>{t('errorBoundary.stepRetry', 'Try again — one-off glitches recover here.')}</li>
            <li>
              {t('errorBoundary.stepReload', 'Reload Lody. Your synced work is not affected.')}
            </li>
            <li>
              {t(
                'errorBoundary.stepReport',
                'Still broken? Copy the error details and send them to us on Discord — they tell us exactly what failed.'
              )}{' '}
              <button
                type="button"
                className="font-medium text-primary underline-offset-4 hover:underline"
                onClick={() => {
                  void openExternalUrl(LODY_DISCORD_URL);
                }}
              >
                {t('errorBoundary.openDiscord', 'Open Discord')}
              </button>
            </li>
            <li>
              {t(
                'errorBoundary.stepHardReset',
                'Stuck on this screen after every reload? Clear all local data and sign in again.'
              )}
            </li>
          </ol>
        </div>

        {showErrorDetails && report.details ? (
          <div className="min-w-0">
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
              {t('errorBoundary.technicalDetails', 'Technical details')}
            </button>
            {detailsOpen ? (
              <pre className="mt-2 max-h-[40vh] min-w-0 select-text overflow-auto rounded-md border border-border/60 bg-muted/40 p-3 font-mono text-[11px] leading-5 text-muted-foreground [overflow-wrap:anywhere] whitespace-pre-wrap">
                {report.details}
              </pre>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-3">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setHardResetOpen(true)}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            {t('errorBoundary.hardReset', 'Clear all local data and sign out')}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {t('errorBoundary.hardResetHint', 'Last resort. Synced work stays on the server.')}
          </span>
        </div>
      </div>

      <HardResetConfirmDialog
        open={hardResetOpen}
        onOpenChange={setHardResetOpen}
        isResetting={hardResetting}
        onConfirm={handleHardReset}
      />
    </div>
  );
}

/**
 * Second gate on the hard reset. It signs the user out and deletes local data,
 * so it must never be one stray click away — especially on a crash screen the
 * user is already clicking around in frustration.
 */
export function HardResetConfirmDialog({
  open,
  onOpenChange,
  isResetting,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isResetting: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('errorBoundary.hardResetConfirmTitle', 'Clear all local data and sign out?')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              'errorBoundary.hardResetConfirmDescription',
              'This signs you out and deletes everything Lody stored on this device — local caches, offline copies, and preferences — then restarts the app. Work already synced to your account stays safe and downloads again after you sign in. Unsynced local drafts on this device are lost.'
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isResetting}>
            {t('common.cancel', 'Cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // Keep the dialog mounted while the wipe + reload runs so the
              // button can show progress instead of flashing closed.
              event.preventDefault();
              onConfirm();
            }}
            disabled={isResetting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            <Trash2 className="mr-1.5 size-3.5" aria-hidden="true" />
            {isResetting
              ? t('errorBoundary.hardResetConfirmRunning', 'Clearing…')
              : t('errorBoundary.hardResetConfirmButton', 'Clear and sign out')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
