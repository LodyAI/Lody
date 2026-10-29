import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { Button } from '@lody/ui/button';
import { toast } from '@/lib/toast';

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

/** A blocked shortcut retains only an explicit retry/opt-out action, never an automatic send. */
export function reportMcpDefaultsBlocked(
  t: (key: string) => string,
  failed: boolean,
  retry: () => void,
  sendWithoutMcp: () => void,
  sessionId: string
): void {
  const id = `mcp-defaults:${sessionId}`;
  toast.error(
    t(failed ? 'chat.validation.mcpDefaultsFailed' : 'chat.validation.mcpDefaultsLoading'),
    {
      id,
      duration: 10_000,
      ...(failed
        ? {
            description: (
              <Button variant="ghost" size="small" onClick={retry}>
                {t('common.retry')}
              </Button>
            ),
            action: {
              label: t('chat.sendWithoutMcp'),
              onClick: () => {
                toast.dismiss(id);
                sendWithoutMcp();
              },
            },
          }
        : {}),
    }
  );
}
