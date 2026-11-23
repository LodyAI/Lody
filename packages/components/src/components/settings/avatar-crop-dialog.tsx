import { useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { space } from '@lody/ui/tokens/scales.stylex';
import type { AvatarKind } from '@lody/shared';
import type { AvatarCropArea } from '@/lib/avatar-crop';
import { SquareCropper } from './avatar-square-cropper';
import { Dialog } from '@/ui/dialog';
import { useTranslation } from 'react-i18next';

const styles = stylex.create({
  content: {
    minWidth: 0,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    minWidth: 0,
  },
});

interface AvatarCropDialogProps {
  file: File | null;
  kind: AvatarKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (file: File, crop: AvatarCropArea) => Promise<boolean>;
}

/** The square crop surface shared by user and workspace avatar uploads. */
export function AvatarCropDialog({
  file,
  kind,
  open,
  onOpenChange,
  onConfirm,
}: AvatarCropDialogProps) {
  const { t } = useTranslation();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [cropAreaPixels, setCropAreaPixels] = useState<AvatarCropArea | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!file) {
      setImageUrl(null);
      return undefined;
    }

    const nextUrl = URL.createObjectURL(file);
    setImageUrl(nextUrl);
    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [file]);

  useEffect(() => {
    if (!open) return;
    setCropAreaPixels(null);
  }, [file, open]);

  const handleConfirm = async () => {
    if (!file || !cropAreaPixels || isSaving) return;
    setIsSaving(true);
    try {
      const saved = await onConfirm(file, cropAreaPixels);
      if (saved) onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={isSaving ? undefined : onOpenChange}>
      <Dialog.Content
        closeButton={!isSaving}
        closeLabel={t('settings.avatar.crop.close')}
        {...stylex.props(styles.content)}
      >
        <Dialog.Header>
          <Dialog.Title>{t('settings.avatar.crop.title')}</Dialog.Title>
          <Dialog.Description>{t('settings.avatar.crop.description')}</Dialog.Description>
        </Dialog.Header>
        <div {...stylex.props(styles.body)}>
          {imageUrl !== null ? (
            <SquareCropper
              imageUrl={imageUrl}
              shape={kind === 'user' ? 'round' : 'rect'}
              label={t('settings.avatar.crop.description')}
              onAreaChange={setCropAreaPixels}
            />
          ) : null}
        </div>
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="secondary" disabled={isSaving} />}>
            {t('settings.avatar.crop.cancel')}
          </Dialog.Close>
          <Button disabled={!cropAreaPixels || isSaving} onClick={() => void handleConfirm()}>
            {isSaving ? <Spinner size="small" label={null} /> : null}
            {t('settings.avatar.crop.confirm')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
