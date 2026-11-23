import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { StatusPage, StatusPageActions } from '@/components/status-page';

export function SessionShareReadError() {
  const { t } = useTranslation();
  return (
    <main>
      <StatusPage
        layout="window"
        illustration="broken"
        role="alert"
        title={t('sharing.renderError', 'This conversation could not be displayed')}
        description={t(
          'sharing.renderErrorDetail',
          'The shared document may contain unsupported content. Try reloading the page.'
        )}
      >
        <StatusPageActions>
          <Button size="small" onClick={() => window.location.reload()}>
            {t('sharing.reloadPage', 'Reload page')}
          </Button>
        </StatusPageActions>
      </StatusPage>
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
