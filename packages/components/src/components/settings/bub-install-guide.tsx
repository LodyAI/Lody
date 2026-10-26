import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { Button } from '@lody/ui/button';
import * as stylex from '@stylexjs/stylex';
import { writeTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/native-browser';

export const BUB_ACP_INSTALL_DOCS_URL =
  'https://bub.build/docs/tutorials/acp-server/?utm_source=lody';
const BUB_ACP_INSTALL_COMMAND = 'curl -fsSL https://bub.build/install.sh | bash -- --preset acp';

const styles = stylex.create({
  intro: {
    marginBlockStart: 0,
    marginBlockEnd: 'calc(var(--spacing) * 2)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--tw-leading, var(--text-xs--line-height))',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  commandRow: {
    display: 'flex',
    minWidth: 'calc(var(--spacing) * 0)',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    marginBlockStart: 0,
    marginBlockEnd: 'calc(var(--spacing) * 2)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted) / 1) 60%, transparent)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1.5)',
  },
  command: {
    minWidth: 'calc(var(--spacing) * 0)',
    flex: '1',
    userSelect: 'all',
    overflowX: 'auto',
    whiteSpace: 'nowrap',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--tw-leading, var(--text-xs--line-height))',
  },
  mark: { height: 'calc(var(--spacing) * 3.5)', width: 'calc(var(--spacing) * 3.5)' },
});

export function BubInstallGuide() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p {...stylex.props(styles.intro)}>
        {t('settings.agent.setup.bubInstallCommand', 'Install it in one step:')}
      </p>
      <div {...stylex.props(styles.commandRow)}>
        <code {...stylex.props(styles.command)}>{BUB_ACP_INSTALL_COMMAND}</code>
        <Button
          type="button"
          variant="ghost"
          size="small"
          className="h-7 shrink-0 gap-1 px-2 text-xs"
          aria-label={copied ? t('common.copied', 'Copied') : t('common.copy', 'Copy')}
          onClick={() => {
            void writeTextToClipboard(BUB_ACP_INSTALL_COMMAND).then((success) => {
              if (success) setCopied(true);
            });
          }}
        >
          {copied ? (
            <Check {...stylex.props(styles.mark)} />
          ) : (
            <Copy {...stylex.props(styles.mark)} />
          )}
          {copied ? t('common.copied', 'Copied') : t('common.copy', 'Copy')}
        </Button>
      </div>
      <Button
        type="button"
        variant="link"
        size="small"
        className="h-auto p-0 text-xs"
        onClick={() => {
          void openExternalUrl(BUB_ACP_INSTALL_DOCS_URL);
        }}
      >
        {t('settings.agent.dialog.bubInstallDocs', 'Open install guide')}
      </Button>
    </div>
  );
}
