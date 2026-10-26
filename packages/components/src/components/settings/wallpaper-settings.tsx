import { useEffect, useRef, useState } from 'react';
import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { wallpaperAtom } from '@/atoms/wallpaper';
import {
  DEFAULT_WALLPAPER,
  prepareWallpaper,
  type WallpaperSettings as Settings,
} from '@/lib/wallpaper';
import { Slider } from '@/ui/slider';
import { WallpaperBackdrop } from '../wallpaper-backdrop';
import { CompactRow, CompactSection } from './compact-layout';

const styles = stylex.create({
  actions: { display: 'flex', gap: space[2], flexWrap: 'wrap' },
  slider: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    width: '180px',
    maxWidth: '100%',
  },
  value: { minWidth: '4ch', textAlign: 'end', fontVariantNumeric: 'tabular-nums' },
  preview: {
    position: 'relative',
    overflow: 'hidden',
    height: '180px',
    margin: space[4],
    borderRadius: radius.large,
    backgroundColor: colors.background,
    border: '1px solid',
    borderColor: colors.separator,
  },
  previewContent: {
    position: 'relative',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[4],
    padding: space[4],
    color: colors.label,
  },
  heading: { fontSize: text.titleSize, fontWeight: 600 },
  composer: {
    width: '80%',
    padding: space[3],
    borderRadius: radius.large,
    backgroundColor: colors.background,
    border: '1px solid',
    borderColor: colors.separator,
    boxShadow: shadow.card,
    color: colors.secondaryLabel,
  },
  error: { color: colors.destructive, padding: space[4] },
});

export function WallpaperSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useAtom(wallpaperAtom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  function update(patch: Partial<Settings>) {
    try {
      setSettings(patch);
      setError(false);
    } catch {
      setError(true);
    }
  }

  async function choose(file: File) {
    const request = ++generation.current;
    setBusy(true);
    setError(false);
    try {
      const image = await prepareWallpaper(file);
      if (generation.current === request) update({ image });
    } catch {
      if (generation.current === request) setError(true);
    } finally {
      if (generation.current === request) setBusy(false);
    }
  }

  return (
    <CompactSection
      title={t('settings.wallpaper.title')}
      description={t('settings.wallpaper.description')}
    >
      <CompactRow label={t('settings.wallpaper.image')} helper={t('settings.wallpaper.localHint')}>
        <div {...stylex.props(styles.actions)}>
          <input
            ref={input}
            type="file"
            hidden
            accept="image/png,image/jpeg,image/webp"
            aria-label={t('settings.wallpaper.choose')}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void choose(file);
            }}
          />
          <Button size="small" disabled={busy} onClick={() => input.current?.click()}>
            {t(busy ? 'settings.wallpaper.loading' : 'settings.wallpaper.choose')}
          </Button>
          <Button
            size="small"
            variant="ghost"
            disabled={!settings.image || busy}
            onClick={() => update({ image: null })}
          >
            {t('settings.wallpaper.remove')}
          </Button>
        </div>
      </CompactRow>
      <div
        {...stylex.props(styles.preview)}
        role="img"
        aria-label={t('settings.wallpaper.preview')}
      >
        <WallpaperBackdrop settings={settings} />
        <div {...stylex.props(styles.previewContent)}>
          <span {...stylex.props(styles.heading)}>{t('settings.wallpaper.greeting')}</span>
          <span {...stylex.props(styles.composer)}>{t('settings.wallpaper.prompt')}</span>
        </div>
      </div>
      {(['opacity', 'blur', 'shade'] as const).map((key) => (
        <CompactRow key={key} label={t(`settings.wallpaper.${key}`)}>
          <div {...stylex.props(styles.slider)}>
            <Slider
              aria-label={t(`settings.wallpaper.${key}`)}
              value={key === 'opacity' ? 100 - settings.opacity : settings[key]}
              min={0}
              max={key === 'blur' ? 24 : key === 'shade' ? 80 : 100}
              disabled={!settings.image || busy}
              onValueChange={(value) => update({ [key]: key === 'opacity' ? 100 - value : value })}
            />
            <span {...stylex.props(styles.value)}>
              {key === 'opacity' ? 100 - settings.opacity : settings[key]}
              {key === 'blur' ? 'px' : '%'}
            </span>
          </div>
        </CompactRow>
      ))}
      <CompactRow label={t('settings.wallpaper.adjustments')}>
        <Button
          size="small"
          variant="ghost"
          disabled={!settings.image || busy}
          onClick={() => update({ ...DEFAULT_WALLPAPER, image: settings.image })}
        >
          {t('settings.wallpaper.reset')}
        </Button>
      </CompactRow>
      {error ? (
        <p role="alert" {...stylex.props(styles.error)}>
          {t('settings.wallpaper.error')}
        </p>
      ) : null}
    </CompactSection>
  );
}
