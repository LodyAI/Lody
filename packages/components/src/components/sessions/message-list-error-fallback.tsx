import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import type { ErrorBoundaryFallbackProps } from '@/components/error-boundary';
import { Button } from '@lody/ui/button';
import { writeTextToClipboard } from '@/lib/clipboard';
import {
  buildErrorBoundaryReport,
  collectErrorBoundaryEnvironment,
} from '@/lib/error-boundary-report';
import { getSessionRenderTraceText } from '@/lib/session-render-trace';

export function MessageListErrorFallback({
  error,
  componentStack,
  resetErrorBoundary,
}: ErrorBoundaryFallbackProps) {
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
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

  return (
    <div
      role="alert"
      className="flex h-full w-full items-center justify-center overflow-auto p-4 text-center"
    >
      <div className="w-full min-w-0 max-w-lg">
        <div className="text-sm font-semibold text-foreground">
          {t('common.somethingWentWrong', 'Something went wrong')}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {t(
            'sessions.messageListCrashed',
            'The message list failed to render. Your draft message below is safe.'
          )}
        </div>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Button type="button" onClick={resetErrorBoundary}>
            {t('common.tryAgain', 'Try again')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void writeTextToClipboard(report.text).then((ok) =>
                setCopyState(ok ? 'copied' : 'failed')
              );
            }}
          >
            {copyState === 'copied' ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
            {copyState === 'copied'
              ? t('errorBoundary.copied', 'Copied')
              : t('errorBoundary.copyDetails', 'Copy error details')}
          </Button>
        </div>
        {copyState === 'failed' ? (
          <p role="status" className="mt-2 text-xs text-destructive">
            {t(
              'errorBoundary.copyFailed',
              'Copying was blocked. Open the technical details below and select the text manually.'
            )}
          </p>
        ) : null}
        <details
          className="mt-3 text-left text-xs text-muted-foreground"
          open={copyState === 'failed' || undefined}
        >
          <summary className="cursor-pointer text-center">
            {t('errorBoundary.technicalDetails', 'Technical details')}
          </summary>
          <pre className="mt-2 max-h-64 select-text overflow-auto rounded-md border border-border p-3 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {report.text}
          </pre>
        </details>
      </div>
    </div>
  );
}
