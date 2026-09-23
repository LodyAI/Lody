import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/ui/button';
import { writeTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/native-browser';

export const BUB_ACP_INSTALL_DOCS_URL =
  'https://bub.build/docs/tutorials/acp-server/?utm_source=lody';
const BUB_ACP_INSTALL_COMMAND = 'curl -fsSL https://bub.build/install.sh | bash -- --preset acp';

export function BubInstallGuide() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {t('settings.agent.setup.bubInstallCommand', 'Install it in one step:')}
      </p>
      <div className="flex min-w-0 items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5">
        <code className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap text-xs">
          {BUB_ACP_INSTALL_COMMAND}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 px-2 text-xs"
          aria-label={copied ? t('common.copied', 'Copied') : t('common.copy', 'Copy')}
          onClick={() => {
            void writeTextToClipboard(BUB_ACP_INSTALL_COMMAND).then((success) => {
              if (success) setCopied(true);
            });
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? t('common.copied', 'Copied') : t('common.copy', 'Copy')}
        </Button>
      </div>
      <Button
        type="button"
        variant="link"
        size="sm"
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
