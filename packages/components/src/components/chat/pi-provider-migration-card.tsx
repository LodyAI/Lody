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
      aria-label={t('chat.piMigration.title', 'Upgrade Pi providers')}
    >
      <p className="font-medium">{t('chat.piMigration.title', 'Upgrade Pi providers')}</p>
      <p className="mt-1 text-muted-foreground">
        {t(
          'chat.piMigration.description',
          'Switch your existing Pi providers to the built-in version managed by Lody. Names, credentials and settings are kept. Start a new chat after upgrading; old Pi sessions cannot be resumed by the new adapter.'
        )}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {t(
            'chat.piMigration.error',
            'Some providers could not be upgraded. Your remaining providers are unchanged. Try again.'
          )}
        </p>
      )}
      <Button className="mt-3" size="sm" disabled={busy || !canMigrate} onClick={onConfirm}>
        {busy
          ? t('chat.piMigration.running', 'Upgrading…')
          : t('chat.piMigration.confirm', 'Confirm upgrade')}
      </Button>
    </section>
  );
}
