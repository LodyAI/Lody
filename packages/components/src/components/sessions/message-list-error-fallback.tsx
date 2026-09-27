import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { text } from '@lody/ui/tokens/scales.stylex';
import type { ErrorBoundaryFallbackProps } from '@/components/error-boundary';
import { Button } from '@lody/ui/button';
import {
  StatusPage,
  StatusPageActions,
  StatusPageCode,
  StatusPageDetails,
} from '@/components/status-page';
import { writeTextToClipboard } from '@/lib/clipboard';
import {
  buildErrorBoundaryReport,
  collectErrorBoundaryEnvironment,
  isRawConvexServerError,
} from '@/lib/error-boundary-report';
import { getSessionRenderTraceText } from '@/lib/session-render-trace';

const styles = stylex.create({
  icon14: { flexShrink: 0, width: '14px', height: '14px' },
  success: { color: colors.success },
  copyFailed: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.destructive,
  },
});

/**
 * The message list crashed but the composer under it did not: the pane says
 * so, keeps the draft, and offers a retry that remounts only the list.
 */
export function MessageListErrorFallback({
  error,
  componentStack,
  resetErrorBoundary,
}: ErrorBoundaryFallbackProps) {
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const report = useMemo(
    () =>
      buildErrorBoundaryReport({
        error,
        componentStack,
        boundaryName: 'SessionChatStream',
        environment: collectErrorBoundaryEnvironment(),
        renderTrace: getSessionRenderTraceText(),
      }),
    [error, componentStack]
  );
  // As on the crash screen: a backend payload quotes server internals, so it
  // stays in the copy and the details rather than on the page.
  const headline = isRawConvexServerError(error)
    ? t('errorBoundary.serverErrorSummary', 'The Lody backend returned a server error.')
    : report.summary;
  const copyLabel =
    copyState === 'copied'
      ? t('errorBoundary.copied', 'Copied')
      : t('errorBoundary.copyDetails', 'Copy error details');

  return (
    <StatusPage
      layout="pane"
      illustration="broken"
      role="alert"
      title={t('sessions.messageListCrashedTitle', "Messages couldn't be displayed")}
      description={t(
        'sessions.messageListCrashed',
        'The message list failed to render. Your draft below is safe.'
      )}
    >
      <StatusPageActions>
        <Button type="button" size="small" onClick={resetErrorBoundary}>
          {t('errorBoundary.tryAgain', 'Try again')}
        </Button>
      </StatusPageActions>
      <StatusPageCode
        action={
          // As on the crash screen, copying acts on the error, so it sits on it.
          <Button
            type="button"
            variant="ghost"
            size="mini"
            icon
            aria-label={copyLabel}
            title={copyLabel}
            onClick={() => {
              void writeTextToClipboard(report.text).then((ok) => {
                setCopyState(ok ? 'copied' : 'failed');
                if (!ok) setDetailsOpen(true);
              });
            }}
          >
            {copyState === 'copied' ? (
              <Check {...stylex.props(styles.icon14, styles.success)} aria-hidden="true" />
            ) : (
              <Copy {...stylex.props(styles.icon14)} aria-hidden="true" />
            )}
          </Button>
        }
      >
        {headline}
      </StatusPageCode>
      {copyState === 'failed' ? (
        <p role="status" {...stylex.props(styles.copyFailed)}>
          {t(
            'errorBoundary.copyFailed',
            'Copying was blocked. Open the technical details below and select the text manually.'
          )}
        </p>
      ) : null}
      <StatusPageDetails
        label={t('errorBoundary.technicalDetails', 'Technical details')}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      >
        <StatusPageCode size="details">{report.text}</StatusPageCode>
      </StatusPageDetails>
    </StatusPage>
  );
}
