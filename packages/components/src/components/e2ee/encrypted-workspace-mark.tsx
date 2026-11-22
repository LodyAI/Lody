import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Server-listed display metadata only. Runtime admission always resolves the
 * persisted descriptor; a missing or forged listing never opens or blocks data. */
export function isListedEncryptedWorkspace(workspace: unknown): boolean {
  return (
    typeof workspace === 'object' &&
    workspace !== null &&
    'contentMode' in workspace &&
    workspace.contentMode === 'e2ee'
  );
}

/** Compact lock shown beside an encrypted workspace name in lists and switchers. The
 * name stays the only text; hovering the lock explains what the mark means. */
export function EncryptedWorkspaceMark({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Lock
      role="img"
      aria-label={t('e2ee.mark.list')}
      size={14}
      className={className ?? 'shrink-0 text-muted-foreground'}
    >
      <title>{t('e2ee.mark.tooltip')}</title>
    </Lock>
  );
}
