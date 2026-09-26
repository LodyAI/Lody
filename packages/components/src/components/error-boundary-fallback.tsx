import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Copy, Trash2 } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';

import { Button } from '@lody/ui/button';
import { AlertDialog } from '@/ui/dialog';
import {
  StatusPage,
  StatusPageActions,
  StatusPageCode,
  StatusPageDetails,
  StatusPageFootnote,
} from '@/components/status-page';
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
};

const COPIED_RESET_MS = 2000;

const styles = stylex.create({
  icon14: { flexShrink: 0, width: '14px', height: '14px' },
  success: { color: colors.success },

  /**
   * Inline: what happened and that the rest is fine, in the page's voice, on
   * whatever ground the failed part stood on — no tint, no mark. The raw error
   * is one copy away, and in the tooltip.
   */
  inline: {
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[2],
    width: 'fit-content',
    maxWidth: '100%',
    minWidth: 0,
  },
  inlineText: {
    minWidth: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
    // Two lines at most: the sentence may wrap once in a narrow slot.
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
  },
  inlineTitle: { fontWeight: 500, color: colors.label },
  inlineActions: { display: 'inline-flex', alignItems: 'center', gap: space[1], flexShrink: 0 },

  /** A blocked copy: the one outcome here that is a message rather than a step. */
  message: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    margin: 0,
    paddingInline: space[3],
    paddingBlock: space[2],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.destructive} 8%)`,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.label,
  },
  messageMark: { marginTop: '1px', color: colors.destructive },
  /** A link inside a sentence: accent, underlined under the pointer. */
  textLink: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    boxShadow: 'none',
    color: colors.accent,
    fontFamily: 'inherit',
    fontSize: 'inherit',
    lineHeight: 'inherit',
    fontWeight: 500,
    textDecorationLine: { default: 'none', ':hover': 'underline' },
    textUnderlineOffset: '3px',
    cursor: 'pointer',
  },
  /**
   * The wipe is a way out, not an answer: a quiet link rather than a red
   * button, since its confirmation dialog is where the cost is spelled out.
   */
  quietLink: {
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    textDecorationLine: 'underline',
    textDecorationColor: `color-mix(in oklab, transparent, ${colors.secondaryLabel} 50%)`,
  },
});

/**
 * The crash screen a user actually gets to read.
 *
 * Invariants, learned from users who got permanently wedged on the old version:
 * - The real error text is on screen, not only in DevTools, and copyable in one
 *   click — the copy payload is the full report from `error-boundary-report.ts`.
 * - Nothing here reloads or resets on its own. Every recovery step is something
 *   the user presses, in escalating order (retry → reload → report → wipe):
 *   the first two are buttons, the last two share one quiet footnote line.
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

  const copyLabel = copied
    ? t('errorBoundary.copied', 'Copied')
    : t('errorBoundary.copyDetails', 'Copy error details');
  const copyButton = (
    <Button
      type="button"
      variant="ghost"
      size="mini"
      icon
      onClick={handleCopy}
      aria-label={copyLabel}
      title={copyLabel}
    >
      {copied ? (
        <Check {...stylex.props(styles.icon14, styles.success)} aria-hidden="true" />
      ) : (
        <Copy {...stylex.props(styles.icon14)} aria-hidden="true" />
      )}
    </Button>
  );

  if (variant === 'inline') {
    return (
      <div role="alert" {...stylex.props(styles.inline)}>
        <span {...stylex.props(styles.inlineText)} title={showErrorDetails ? headline : undefined}>
          <span {...stylex.props(styles.inlineTitle)}>
            {t('errorBoundary.inlineTitle', "This part couldn't be shown.")}
          </span>{' '}
          {t('errorBoundary.inlineDescription', 'Everything else still works.')}
        </span>
        <span {...stylex.props(styles.inlineActions)}>
          <Button type="button" variant="ghost" size="mini" onClick={resetErrorBoundary}>
            {t('errorBoundary.tryAgain', 'Try again')}
          </Button>
          {copyButton}
        </span>
      </div>
    );
  }

  const isRegion = variant === 'section';

  return (
    <StatusPage
      layout={isRegion ? 'region' : 'window'}
      role="alert"
      illustration="broken"
      title={
        isRegion
          ? t('errorBoundary.sectionTitle', "This part couldn't be shown")
          : t('errorBoundary.title', "Lody couldn't show this page")
      }
      description={
        isRegion
          ? t(
              'errorBoundary.sectionDescription',
              'The rest of Lody still works, and your work is safe.'
            )
          : t(
              'errorBoundary.description',
              'Your work is safe. Try again — if it keeps happening, reload Lody.'
            )
      }
    >
      <StatusPageActions>
        <Button type="button" size="small" onClick={resetErrorBoundary}>
          {t('errorBoundary.tryAgain', 'Try again')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="small"
          onClick={() => {
            reloadApp();
          }}
        >
          {t('errorBoundary.reload', 'Reload Lody')}
        </Button>
        {/* With the error hidden there is no block to carry the copy. */}
        {showErrorDetails ? null : copyButton}
      </StatusPageActions>

      {showErrorDetails ? <StatusPageCode action={copyButton}>{headline}</StatusPageCode> : null}

      {copyFailed ? (
        <p role="status" {...stylex.props(styles.message)}>
          <AlertTriangle {...stylex.props(styles.icon14, styles.messageMark)} aria-hidden="true" />
          {t(
            'errorBoundary.copyFailed',
            'Copying was blocked. Open the technical details below and select the text manually.'
          )}
        </p>
      ) : null}

      {showErrorDetails && report.details ? (
        <StatusPageDetails
          label={t('errorBoundary.technicalDetails', 'Technical details')}
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
        >
          <StatusPageCode size="details">{report.details}</StatusPageCode>
        </StatusPageDetails>
      ) : null}

      {/* One quiet line for both ways past this screen: tell us, or start clean. */}
      <StatusPageFootnote>
        <Trans
          i18nKey="errorBoundary.stillStuck"
          defaults="Still stuck? <discord>Tell us on Discord</discord> or <reset>clear local data</reset>."
          components={{
            discord: (
              <button
                type="button"
                {...stylex.props(styles.textLink)}
                onClick={() => {
                  void openExternalUrl(LODY_DISCORD_URL);
                }}
              />
            ),
            reset: (
              <button
                type="button"
                {...stylex.props(styles.textLink, styles.quietLink)}
                onClick={() => setHardResetOpen(true)}
              />
            ),
          }}
        />
      </StatusPageFootnote>

      <HardResetConfirmDialog
        open={hardResetOpen}
        onOpenChange={setHardResetOpen}
        isResetting={hardResetting}
        onConfirm={handleHardReset}
      />
    </StatusPage>
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
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>
            {t('errorBoundary.hardResetConfirmTitle', 'Clear all local data and sign out?')}
          </AlertDialog.Title>
          <AlertDialog.Description>
            {t(
              'errorBoundary.hardResetConfirmDescription',
              'This signs you out and deletes everything Lody stored on this device — local caches, offline copies, and preferences — then restarts the app. Work already synced to your account stays safe and downloads again after you sign in. Unsynced local drafts on this device are lost.'
            )}
          </AlertDialog.Description>
        </AlertDialog.Header>
        <AlertDialog.Footer>
          <AlertDialog.Cancel disabled={isResetting}>
            {t('common.cancel', 'Cancel')}
          </AlertDialog.Cancel>
          <Button
            onClick={() => {
              // Keep the dialog mounted while the wipe + reload runs so the
              // button can show progress instead of flashing closed.
              onConfirm();
            }}
            disabled={isResetting}
            variant="destructive"
          >
            <Trash2 {...stylex.props(styles.icon14)} aria-hidden="true" />
            {isResetting
              ? t('errorBoundary.hardResetConfirmRunning', 'Clearing…')
              : t('errorBoundary.hardResetConfirmButton', 'Clear and sign out')}
          </Button>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
