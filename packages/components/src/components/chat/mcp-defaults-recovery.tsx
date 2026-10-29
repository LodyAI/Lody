import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { Button } from '@lody/ui/button';

const styles = stylex.create({
  notice: { padding: space[2], color: colors.label, fontSize: text.footnoteSize, lineHeight: 1.5 },
  message: { margin: 0, marginBottom: space[1] },
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
});

/** The opt-out is a send action, never a persistent selection or default edit. */
export function McpDefaultsRecovery({
  onRetry,
  onSendWithoutMcp,
  disabled,
}: {
  onRetry: () => void;
  onSendWithoutMcp: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div role="alert" {...stylex.props(styles.notice)}>
      <p {...stylex.props(styles.message)}>{t('chat.validation.mcpDefaultsFailed')}</p>
      <div {...stylex.props(styles.actions)}>
        <Button variant="ghost" size="small" onClick={onRetry} disabled={disabled}>
          {t('common.retry')}
        </Button>
        <Button variant="secondary" size="small" onClick={onSendWithoutMcp} disabled={disabled}>
          {t('chat.sendWithoutMcp')}
        </Button>
      </div>
    </div>
  );
}
