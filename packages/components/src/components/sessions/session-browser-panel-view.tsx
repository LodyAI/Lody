import type { ComponentProps, ReactNode } from 'react';
import { Globe2, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { cn } from '@/lib/utils';
import { SessionBrowserToolbar } from './session-browser-toolbar';
import {
  PreviewConnectionPlaceholder,
  type PreviewConnectionStatusProps,
} from './preview-connection-status';

export type ManagedNavigationPhase = 'resolving-machine' | 'opening-local' | 'creating-tunnel';

type SessionBrowserPanelViewProps = {
  className?: string;
  toolbar: ComponentProps<typeof SessionBrowserToolbar>;
  previewStatus?: PreviewConnectionStatusProps;
  error?: string | null;
  onDismissError: () => void;
  navigationPhase?: ManagedNavigationPhase | null;
  suggestedAddress?: string;
  children?: ReactNode;
};

/** Presentation only. The controller owns navigation, authorization and endpoint lifetime. */
export function SessionBrowserPanelView({
  className,
  toolbar,
  previewStatus,
  error,
  onDismissError,
  navigationPhase,
  suggestedAddress,
  children,
}: SessionBrowserPanelViewProps) {
  const { t } = useTranslation();
  const hasContent = Boolean(children);
  // When remote content is absent the placeholder owns the single recovery
  // action; keeping it out of the popover avoids two simultaneous Restore
  // buttons. Local/connected content has no placeholder, so the popover owns it.
  const toolbarPreviewStatus =
    previewStatus && hasContent
      ? previewStatus
      : previewStatus && { ...previewStatus, onRestore: undefined, onStopSharing: undefined };
  const previewDiagnostic =
    previewStatus?.unavailableReason ??
    previewStatus?.error ??
    previewStatus?.connection?.error?.message ??
    null;
  const showErrorBanner =
    Boolean(error) && !(previewStatus && !hasContent && previewDiagnostic === error);
  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-background', className)}>
      <SessionBrowserToolbar {...toolbar} previewStatus={toolbarPreviewStatus} />
      {showErrorBanner ? (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive"
        >
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
          <Button
            type="button"
            variant="ghost"
            size="mini"
            className="ml-auto"
            onClick={onDismissError}
          >
            {t('common.dismiss', 'Dismiss')}
          </Button>
        </div>
      ) : null}
      {navigationPhase ? (
        <div
          role="status"
          aria-live="polite"
          className="flex min-h-0 flex-1 items-center justify-center gap-2 bg-background text-sm text-muted-foreground"
        >
          <Spinner label={null} className="h-4 w-4" />
          <span>
            {navigationPhase === 'resolving-machine'
              ? t('sessions.browser.resolvingMachine', 'Resolving the session machine…')
              : navigationPhase === 'creating-tunnel'
                ? t('sessions.browser.creatingTunnel', 'Establishing a secure preview connection…')
                : t('sessions.browser.openingLocal', 'Opening the local preview…')}
          </span>
        </div>
      ) : (
        (children ??
        (previewStatus ? (
          <PreviewConnectionPlaceholder {...previewStatus} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-background px-6 text-center">
            <Globe2 className="h-7 w-7 text-muted-foreground/60" aria-hidden />
            <p className="max-w-xs text-xs text-muted-foreground">
              {suggestedAddress
                ? t('sessions.browser.emptyWithCandidate', 'Press Enter to open {{url}}', {
                    url: suggestedAddress,
                  })
                : t(
                    'sessions.browser.emptyNoCandidate',
                    'No preview address reported yet. Enter a URL above, or ask the agent to report its dev server.'
                  )}
            </p>
          </div>
        )))
      )}
    </div>
  );
}
