import { useTranslation } from 'react-i18next';
import { AppWindow } from 'lucide-react';
import { ContextMenuItem } from '@/ui/context-menu';
import { DropdownMenuItem } from '@/ui/dropdown-menu';
import { isElectronRenderer } from '@/lib/electron';
import { openDesktopWindow } from '@/lib/desktop-window';

export function SessionWindowMenuItem({
  sessionId,
  dropdown = false,
}: {
  sessionId: string;
  dropdown?: boolean;
}) {
  const { t } = useTranslation();
  if (!isElectronRenderer()) return null;
  const Item = dropdown ? DropdownMenuItem : ContextMenuItem;
  return (
    <Item
      onSelect={() => {
        openDesktopWindow(sessionId);
      }}
    >
      <AppWindow />
      {t('session.openInNewWindow')}
    </Item>
  );
}
