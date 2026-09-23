import { useTranslation } from 'react-i18next';
import { Button } from '@/ui/button';

export function PiProviderMigrationCard({
  count,
  busy,
  error,
  canMigrate,
  onConfirm,
}: {
  count: number;
  busy: boolean;
  error: boolean;
  canMigrate: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (!count || !canMigrate) return null;
  return (
    <section
      className="mb-3 rounded-lg border bg-background p-4 text-sm"
      aria-label={t('chat.piMigration.title', 'Add managed Pi')}
    >
      <p className="font-medium">{t('chat.piMigration.title', 'Add managed Pi')}</p>
      <p className="mt-1 text-muted-foreground">
        {t(
          'chat.piMigration.description',
          'Add Pi managed by Lody alongside your existing self-managed Pi provider. The existing provider, environment, and sessions stay unchanged. Use PI_CODING_AGENT_DIR on a provider when the two integrations need separate Pi profiles.'
        )}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {t(
            'chat.piMigration.error',
            'Managed Pi could not be added. Your existing provider is unchanged. Try again.'
          )}
        </p>
      )}
      <Button className="mt-3" size="sm" disabled={busy || !canMigrate} onClick={onConfirm}>
        {busy
          ? t('chat.piMigration.running', 'Adding…')
          : t('chat.piMigration.confirm', 'Add managed Pi')}
      </Button>
    </section>
  );
}
