import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { copyTextToClipboard } from '@/lib/clipboard';

export function E2eeDiagnosticCode({ code }: { code: string }) {
  const { t } = useTranslation();
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  return (
    <details>
      <summary>{t('errorBoundary.technicalDetails')}</summary>
      <p>
        <code>{code}</code>
      </p>
      <Button
        type="button"
        variant="secondary"
        size="small"
        onClick={async () => {
          try {
            await copyTextToClipboard(code);
            setCopiedCode(code);
          } catch {
            setCopiedCode(null);
          }
        }}
      >
        {t(
          copiedCode === code ? 'errorBoundary.copied' : 'workspace.route.recovery.copyDiagnostics'
        )}
      </Button>
    </details>
  );
}
