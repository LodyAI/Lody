import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Drawer, DrawerContent, DrawerTitle, DrawerClose } from '../ui/drawer';
import { useKeyboardAwareSheet } from '../hooks/use-keyboard-aware-scroll-into-view';
export function MobilePluginContainer({
  title,
  children,
  close,
}: {
  title?: string;
  children: ReactNode;
  close: () => void;
}) {
  const keyboard = useKeyboardAwareSheet();
  const { t } = useTranslation();
  return (
    <Drawer
      open
      repositionInputs={false}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DrawerContent className={keyboard.contentClassName}>
        <header className="flex items-center justify-between px-4">
          <DrawerTitle>{title}</DrawerTitle>
          <DrawerClose>{t('common.close', 'Close')}</DrawerClose>
        </header>
        <div ref={keyboard.scrollRef} style={keyboard.scrollStyle} className="overflow-y-auto px-4">
          {children}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
