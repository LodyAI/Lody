import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import type { useSessionShareManagement } from '@/hooks/use-session-share-management';

const styles = stylex.create({
  body: { display: 'flex', flexDirection: 'column', gap: space[3] },
  title: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 500,
    color: colors.label,
  },
  description: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.secondaryLabel,
  },
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space[2] },
});

/** Inline in both editors and MCP approval cards: no nested portal can dismiss its owner. */
export function SessionSharePlaintextConfirmation({
  management,
}: {
  management: Pick<
    ReturnType<typeof useSessionShareManagement>,
    'onConfirmPlaintextPublish' | 'onCancelPlaintextPublish'
  >;
}) {
  const { t } = useTranslation();
  return (
    <section
      {...stylex.props(styles.body)}
      aria-label={t('sharing.e2ee.title', 'Publish outside E2EE?')}
    >
      <p {...stylex.props(styles.title)}>{t('sharing.e2ee.title', 'Publish outside E2EE?')}</p>
      <p {...stylex.props(styles.description)}>
        {t(
          'sharing.e2ee.disclosure',
          'Sharing publishes a decrypted copy outside E2EE, where the server can read it. Revoking the share cannot take back content that has already been viewed or copied.'
        )}
      </p>
      <div {...stylex.props(styles.actions)}>
        <Button size="small" variant="ghost" onClick={management.onCancelPlaintextPublish}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button size="small" onClick={() => void management.onConfirmPlaintextPublish()}>
          {t('sharing.e2ee.confirm', 'Publish decrypted copy')}
        </Button>
      </div>
    </section>
  );
}
