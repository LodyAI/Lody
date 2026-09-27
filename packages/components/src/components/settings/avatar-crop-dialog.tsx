import { useEffect, useState } from 'react';
import Cropper, { type Area, type Point } from 'react-easy-crop';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import type { AvatarKind } from '@lody/shared';
import { Slider } from '@/ui/slider';
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
  cropViewport: {
    position: 'relative',
    width: '100%',
    aspectRatio: '1 / 1',
    overflow: 'hidden',
    backgroundColor: colors.wellBackground,
    borderRadius: radius.medium,
  },
  zoomControl: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
  },
  zoomLabel: {
    color: colors.secondaryLabel,
    fontSize: '0.8125rem',
  },
  zoomSlider: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
  },
});

interface AvatarCropDialogProps {
  file: File | null;
  kind: AvatarKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (file: File, crop: Area) => Promise<boolean>;
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
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [cropAreaPixels, setCropAreaPixels] = useState<Area | null>(null);
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
    setCrop({ x: 0, y: 0 });
    setZoom(1);
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
          <div {...stylex.props(styles.cropViewport)}>
            {imageUrl !== null ? (
              <Cropper
                image={imageUrl}
                crop={crop}
                zoom={zoom}
                minZoom={1}
                maxZoom={3}
                aspect={1}
                cropShape={kind === 'user' ? 'round' : 'rect'}
                showGrid
                roundCropAreaPixels
                zoomWithScroll={false}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={(_, areaPixels) => setCropAreaPixels(areaPixels)}
                cropperProps={{ 'aria-label': t('settings.avatar.crop.description') }}
              />
            ) : null}
          </div>
          <div {...stylex.props(styles.zoomControl)}>
            <label htmlFor="avatar-crop-zoom" {...stylex.props(styles.zoomLabel)}>
              {t('settings.avatar.crop.zoom')}
            </label>
            <div {...stylex.props(styles.zoomSlider)}>
              <Slider
                id="avatar-crop-zoom"
                value={zoom}
                min={1}
                max={3}
                step={0.01}
                onValueChange={setZoom}
                disabled={isSaving}
                aria-label={t('settings.avatar.crop.zoom')}
              />
            </div>
          </div>
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
