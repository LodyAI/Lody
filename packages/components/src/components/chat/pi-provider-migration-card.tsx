import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const styles = stylex.create({
  confirmSpacing: { marginTop: 'calc(var(--spacing) * 3)' },
  card: {
    marginBottom: themeSpace[3],
    borderRadius: themeRadius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    backgroundColor: themeColors.background,
    padding: themeSpace[4],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
  },
  title: { fontWeight: themeFontWeight.medium },
  description: { marginTop: themeSpace[1], color: themeColors.mutedForeground },
  error: { marginTop: themeSpace[2], color: themeColors.destructive },
});

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
      {...stylex.props(styles.card)}
      aria-label={t('chat.piMigration.title', 'Upgrade Pi providers')}
    >
      <p {...stylex.props(styles.title)}>{t('chat.piMigration.title', 'Upgrade Pi providers')}</p>
      <p {...stylex.props(styles.description)}>
        {t(
          'chat.piMigration.description',
          'Switch your existing Pi providers to the built-in version managed by Lody. Names, credentials and settings are kept. Start a new chat after upgrading; old Pi sessions cannot be resumed by the new adapter.'
        )}
      </p>
      {error && (
        <p role="alert" {...stylex.props(styles.error)}>
          {t(
            'chat.piMigration.error',
            'Some providers could not be upgraded. Your remaining providers are unchanged. Try again.'
          )}
        </p>
      )}
      <Button
        {...stylex.props(styles.confirmSpacing)}
        size="small"
        disabled={busy || !canMigrate}
        onClick={onConfirm}
      >
        {busy
          ? t('chat.piMigration.running', 'Upgrading…')
          : t('chat.piMigration.confirm', 'Confirm upgrade')}
      </Button>
    </section>
  );
}
