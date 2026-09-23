import type { ComponentProps, ReactNode } from 'react';
import { Globe2, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';
import { cn } from '@/lib/utils';
import { SessionBrowserToolbar } from './session-browser-toolbar';
import {
  PreviewConnectionStatus,
  type PreviewConnectionStatusProps,
} from './preview-connection-status';

export type ManagedNavigationPhase = 'resolving-machine' | 'opening-local' | 'creating-tunnel';

type SessionBrowserPanelViewProps = {
  className?: string;
  toolbar: ComponentProps<typeof SessionBrowserToolbar>;
  remoteMachineName?: string;
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
  remoteMachineName,
  previewStatus,
  error,
  onDismissError,
  navigationPhase,
  suggestedAddress,
  children,
}: SessionBrowserPanelViewProps) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-background', className)}>
      <SessionBrowserToolbar {...toolbar} />
      {remoteMachineName && (
        <p className="border-b border-border px-3 py-1 text-[11px] text-muted-foreground">
          {t(
            'sessions.browser.connection.enterConsent',
            'For localhost on {{machine}}, Enter authorizes remote sharing. Anyone with the link can access it.',
            { machine: remoteMachineName }
          )}
        </p>
      )}
      {previewStatus && <PreviewConnectionStatus {...previewStatus} />}
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive"
        >
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2"
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
          <Spinner className="h-4 w-4" aria-hidden />
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
          <PreviewConnectionStatus {...previewStatus} placeholder />
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
