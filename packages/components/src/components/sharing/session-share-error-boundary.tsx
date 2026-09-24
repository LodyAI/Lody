import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/ui/button';

export function SessionShareReadError() {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-dvh items-center justify-center p-8 text-center" role="alert">
      <div className="max-w-sm space-y-3">
        <h1 className="text-lg font-medium">
          {t('sharing.renderError', 'This conversation could not be displayed')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(
            'sharing.renderErrorDetail',
            'The shared document may contain unsupported content. Try reloading the page.'
          )}
        </p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t('sharing.reloadPage', 'Reload page')}
        </Button>
      </div>
    </main>
  );
}

/** Unmounting the reader closes its transport and attachments. No error payload,
 * content or fragment is retained/reported; recovery is an explicit user action.
 * The app's ordinary boundary imports telemetry and cannot be used by this entry.
 */
export class SessionShareErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <SessionShareReadError /> : this.props.children;
  }
}
