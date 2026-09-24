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
import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';

import { Button } from '@lody/ui/button';
import { AlertDialog } from '@/ui/dialog';
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

const WIDE = '@media (min-width: 640px)';
const MONO = 'var(--font-mono, ui-monospace, monospace)';
/** A block inside a surface is the region rung: a fill with no edge. */
const REGION = `color-mix(in oklab, transparent, ${colors.label} 3%)`;

const styles = stylex.create({
  icon14: { flexShrink: 0, width: '14px', height: '14px' },
  success: { color: colors.success },
  destructive: { color: colors.destructive },

  /** Inline: a message, a tint and a mark. */
  inline: {
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[2],
    width: 'fit-content',
    maxWidth: '100%',
    paddingInlineStart: space[3],
    paddingInlineEnd: space[1],
    paddingBlock: space[1],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.destructive} 10%)`,
  },
  inlineText: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    color: colors.label,
  },

  root: { boxSizing: 'border-box', width: '100%' },
  /** The page: the report is a card centred on it. */
  page: {
    display: 'flex',
    alignItems: { default: 'flex-start', [WIDE]: 'center' },
    justifyContent: 'center',
    minHeight: '60vh',
    overflow: 'auto',
    padding: { default: space[4], [WIDE]: space[6] },
  },
  /** A section: the report is a region of whatever surface holds it. */
  section: {
    padding: space[4],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: REGION,
  },
  body: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    width: '100%',
    minWidth: 0,
    textAlign: 'start',
  },
  card: {
    maxWidth: '672px',
    padding: '20px',
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    borderRadius: radius.large,
    cornerShape: corner.shape,
  },
  header: { display: 'flex', alignItems: 'flex-start', gap: '10px' },
  headerMark: { flexShrink: 0, width: '16px', height: '16px', marginTop: '1px' },
  headerMarkPage: { width: '20px', height: '20px', marginTop: '2px' },
  headerText: { minWidth: 0 },
  title: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 600,
    color: colors.label,
  },
  titlePage: { fontSize: text.headlineSize, lineHeight: text.headlineLeading },
  description: {
    margin: 0,
    marginTop: space[1],
    fontSize: { default: text.footnoteSize, [WIDE]: text.bodySize },
    lineHeight: { default: text.footnoteLeading, [WIDE]: text.bodyLeading },
    color: colors.secondaryLabel,
  },
  code: {
    boxSizing: 'border-box',
    minWidth: 0,
    margin: 0,
    padding: space[3],
    overflow: 'auto',
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: REGION,
    fontFamily: MONO,
    lineHeight: '20px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    userSelect: 'text',
  },
  headline: { maxHeight: '128px', fontSize: text.footnoteSize, color: colors.label },
  details: {
    maxHeight: '40vh',
    marginTop: space[2],
    fontSize: text.captionSize,
    color: colors.secondaryLabel,
  },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  message: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    margin: 0,
    paddingInline: space[3],
    paddingBlock: space[2],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.destructive} 10%)`,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.destructive,
  },
  messageMark: { marginTop: '1px' },
  steps: {
    padding: space[3],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: REGION,
  },
  stepsTitle: {
    margin: 0,
    fontSize: text.footnoteSize,
    fontWeight: 500,
    color: colors.label,
  },
  stepsList: {
    margin: 0,
    marginTop: space[1.5],
    paddingInlineStart: space[4],
    listStyleType: 'decimal',
    fontSize: text.footnoteSize,
    lineHeight: '20px',
    color: colors.secondaryLabel,
  },
  step: { marginTop: { default: space[1], ':first-child': 0 } },
  /** A link inside a sentence: accent, underlined under the pointer. */
  textLink: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.accent,
    fontFamily: 'inherit',
    fontSize: 'inherit',
    lineHeight: 'inherit',
    fontWeight: 500,
    textDecorationLine: { default: 'none', ':hover': 'underline' },
    textUnderlineOffset: '4px',
    cursor: 'pointer',
  },
  disclosure: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    fontFamily: 'inherit',
    fontSize: text.footnoteSize,
    cursor: 'pointer',
  },
  chevron: {
    transform: 'rotate(0deg)',
    transitionProperty: 'transform',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  chevronOpen: { transform: 'rotate(90deg)' },
  detailsBlock: { minWidth: 0 },
  lastResort: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[3],
    rowGap: space[1],
  },
  lastResortHint: { fontSize: text.captionSize, color: colors.secondaryLabel },
});

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
      <div role="alert" {...stylex.props(styles.inline)}>
        <AlertTriangle {...stylex.props(styles.icon14, styles.destructive)} aria-hidden="true" />
        <span {...stylex.props(styles.inlineText)} title={headline}>
          {showErrorDetails ? headline : t('errorBoundary.inlineTitle', 'This part failed')}
        </span>
        <Button type="button" variant="ghost" size="mini" onClick={resetErrorBoundary}>
          {t('errorBoundary.tryAgain', 'Try again')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="mini"
          icon
          onClick={handleCopy}
          aria-label={t('errorBoundary.copyDetails', 'Copy error details')}
        >
          {copied ? (
            <Check {...stylex.props(styles.icon14, styles.success)} aria-hidden="true" />
          ) : (
            <Copy {...stylex.props(styles.icon14)} aria-hidden="true" />
          )}
        </Button>
      </div>
    );
  }

  const isPage = variant === 'page';

  return (
    <div role="alert" {...stylex.props(styles.root, isPage ? styles.page : styles.section)}>
      <div {...stylex.props(styles.body, isPage && styles.card)}>
        <div {...stylex.props(styles.header)}>
          <AlertTriangle
            {...stylex.props(
              styles.headerMark,
              isPage && styles.headerMarkPage,
              styles.destructive
            )}
            aria-hidden="true"
          />
          <div {...stylex.props(styles.headerText)}>
            <h2 {...stylex.props(styles.title, isPage && styles.titlePage)}>
              {t('errorBoundary.title', 'Lody hit an unexpected error')}
            </h2>
            <p {...stylex.props(styles.description)}>
              {t(
                'errorBoundary.description',
                'The rest of the app is still running. Nothing reloads on its own — pick a step below.'
              )}
            </p>
          </div>
        </div>

        {showErrorDetails ? (
          <pre {...stylex.props(styles.code, styles.headline)}>{headline}</pre>
        ) : null}

        <div {...stylex.props(styles.actions)}>
          <Button type="button" size="small" onClick={resetErrorBoundary}>
            <RotateCcw {...stylex.props(styles.icon14)} aria-hidden="true" />
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
            <RefreshCw {...stylex.props(styles.icon14)} aria-hidden="true" />
            {t('errorBoundary.reload', 'Reload Lody')}
          </Button>
          <Button type="button" variant="secondary" size="small" onClick={handleCopy}>
            {copied ? (
              <Check {...stylex.props(styles.icon14, styles.success)} aria-hidden="true" />
            ) : (
              <Copy {...stylex.props(styles.icon14)} aria-hidden="true" />
            )}
            {copied
              ? t('errorBoundary.copied', 'Copied')
              : t('errorBoundary.copyDetails', 'Copy error details')}
          </Button>
        </div>

        {copyFailed ? (
          <p {...stylex.props(styles.message)}>
            <AlertTriangle
              {...stylex.props(styles.icon14, styles.messageMark)}
              aria-hidden="true"
            />
            {t(
              'errorBoundary.copyFailed',
              'Copying was blocked. Open the technical details below and select the text manually.'
            )}
          </p>
        ) : null}

        <div {...stylex.props(styles.steps)}>
          <p {...stylex.props(styles.stepsTitle)}>
            {t('errorBoundary.nextStepsTitle', 'If it keeps happening')}
          </p>
          <ol {...stylex.props(styles.stepsList)}>
            <li {...stylex.props(styles.step)}>
              {t('errorBoundary.stepRetry', 'Try again — one-off glitches recover here.')}
            </li>
            <li {...stylex.props(styles.step)}>
              {t('errorBoundary.stepReload', 'Reload Lody. Your synced work is not affected.')}
            </li>
            <li {...stylex.props(styles.step)}>
              {t(
                'errorBoundary.stepReport',
                'Still broken? Copy the error details and send them to us on Discord — they tell us exactly what failed.'
              )}{' '}
              <button
                type="button"
                {...stylex.props(styles.textLink)}
                onClick={() => {
                  void openExternalUrl(LODY_DISCORD_URL);
                }}
              >
                {t('errorBoundary.openDiscord', 'Open Discord')}
              </button>
            </li>
            <li {...stylex.props(styles.step)}>
              {t(
                'errorBoundary.stepHardReset',
                'Stuck on this screen after every reload? Clear all local data and sign in again.'
              )}
            </li>
          </ol>
        </div>

        {showErrorDetails && report.details ? (
          <div {...stylex.props(styles.detailsBlock)}>
            <button
              type="button"
              {...stylex.props(styles.disclosure)}
              onClick={() => setDetailsOpen((open) => !open)}
              aria-expanded={detailsOpen}
            >
              <ChevronRight
                {...stylex.props(styles.icon14, styles.chevron, detailsOpen && styles.chevronOpen)}
                aria-hidden="true"
              />
              {t('errorBoundary.technicalDetails', 'Technical details')}
            </button>
            {detailsOpen ? (
              <pre {...stylex.props(styles.code, styles.details)}>{report.details}</pre>
            ) : null}
          </div>
        ) : null}

        <div {...stylex.props(styles.lastResort)}>
          <Button
            type="button"
            variant="ghost"
            size="small"
            tone="destructive"
            onClick={() => setHardResetOpen(true)}
          >
            <Trash2 {...stylex.props(styles.icon14)} aria-hidden="true" />
            {t('errorBoundary.hardReset', 'Clear all local data and sign out')}
          </Button>
          <span {...stylex.props(styles.lastResortHint)}>
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
