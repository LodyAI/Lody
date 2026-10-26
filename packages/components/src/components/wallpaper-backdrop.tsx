import * as stylex from '@stylexjs/stylex';
import { type WallpaperSettings } from '@/lib/wallpaper';

const styles = stylex.create({
  root: (opacity: number) => ({
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
    pointerEvents: 'none',
    maskImage: 'linear-gradient(to bottom, black, transparent)',
    opacity: opacity / 100,
  }),
  image: (image: string, blur: number) => ({
    position: 'absolute',
    inset: -48,
    backgroundImage: `url("${image}")`,
    backgroundPosition: 'center',
    backgroundSize: 'cover',
    filter: `blur(${blur}px)`,
  }),
  shade: (shade: number) => ({
    position: 'absolute',
    inset: 0,
    backgroundImage: `radial-gradient(ellipse at 50% 25%, transparent 20%, rgb(0 0 0 / ${shade / 100}))`,
  }),
});

/** Decoration only: opacity and filtering never apply to the foreground controls. */
export function WallpaperBackdrop({ settings }: { settings: WallpaperSettings }) {
  if (!settings.image) return null;
  return (
    <div
      aria-hidden="true"
      data-wallpaper-backdrop
      {...stylex.props(styles.root(settings.opacity))}
    >
      <div {...stylex.props(styles.image(settings.image, settings.blur))} />
      <div {...stylex.props(styles.shade(settings.shade))} />
    </div>
  );
}
