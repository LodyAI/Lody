import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { Button } from '@lody/ui/button';

const styles = stylex.create({
  body: { display: 'flex', flexDirection: 'column', gap: space[4], padding: space[4] },
});

export type MobileRemoveLocalProjectSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  onConfirm: () => Promise<boolean>;
};

/** Removing an entry preserves its registration, memberships and conversations. */
export function MobileRemoveLocalProjectSheet({
  open,
  onOpenChange,
  projectName,
  onConfirm,
}: MobileRemoveLocalProjectSheetProps) {
  const { t } = useTranslation();
  const [isRemoving, setIsRemoving] = useState(false);
  const remove = async () => {
    if (isRemoving) return;
    setIsRemoving(true);
    try {
      if (await onConfirm()) onOpenChange(false);
    } finally {
      setIsRemoving(false);
    }
  };
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!isRemoving) onOpenChange(next);
      }}
    >
      <DrawerContent>
        <div {...stylex.props(styles.body)}>
          <DrawerTitle>
            {t('sidebar.localProjects.remove.entryTitle', { name: projectName })}
          </DrawerTitle>
          <DrawerDescription>
            {t('sidebar.localProjects.remove.entryDescription')}
          </DrawerDescription>
          <Button disabled={isRemoving} onClick={() => void remove()}>
            {t('sidebar.localProjects.remove.entryConfirm')}
          </Button>
          <Button variant="secondary" disabled={isRemoving} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
