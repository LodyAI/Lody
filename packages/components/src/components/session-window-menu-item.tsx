import { useEffect } from 'react';
import type * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { AppWindow } from 'lucide-react';
import { ContextMenu } from '@lody/ui/context-menu';
import { Menu } from '@/ui/menu';
import { isElectronRenderer } from '@/lib/electron';
import { openDesktopWindow, prepareDesktopWindow } from '@/lib/desktop-window';

export function SessionWindowMenuItem({
  sessionId,
  dropdown = false,
  xstyle,
}: {
  sessionId: string;
  dropdown?: boolean;
  xstyle?: stylex.StyleXStyles;
}) {
  const { t } = useTranslation();
  useEffect(() => prepareDesktopWindow(sessionId), [sessionId]);
  if (!isElectronRenderer()) return null;
  const Item = dropdown ? Menu.Item : ContextMenu.Item;
  return (
    <Item
      {...(dropdown ? { xstyle } : {})}
      icon={AppWindow}
      onClick={() =>
        openDesktopWindow(sessionId, undefined, dropdown ? 'session_menu' : 'context_menu')
      }
    >
      {t('session.openInNewWindow')}
    </Item>
  );
}
