export const WALLPAPER_STORAGE_KEY = 'lody-appearance-wallpaper';
export const WALLPAPER_MAX_DATA_LENGTH = 1_400_000;

export interface WallpaperSettings {
  image: string | null;
  opacity: number;
  blur: number;
  shade: number;
}

export const DEFAULT_WALLPAPER: WallpaperSettings = {
  image: null,
  opacity: 55,
  blur: 0,
  shade: 20,
};

function bounded(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(max, Math.max(0, value)))
    : fallback;
}

export function normalizeWallpaper(value: unknown): WallpaperSettings {
  const input = value && typeof value === 'object' ? (value as Partial<WallpaperSettings>) : {};
  return {
    // Only locally encoded raster images; never fetch a persisted external URL.
    image:
      typeof input.image === 'string' &&
      input.image.length <= WALLPAPER_MAX_DATA_LENGTH &&
      /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(input.image)
        ? input.image
        : null,
    opacity: bounded(input.opacity, DEFAULT_WALLPAPER.opacity, 100),
    blur: bounded(input.blur, DEFAULT_WALLPAPER.blur, 24),
    shade: bounded(input.shade, DEFAULT_WALLPAPER.shade, 80),
  };
}

export function readWallpaper(): WallpaperSettings {
  try {
    return normalizeWallpaper(JSON.parse(localStorage.getItem(WALLPAPER_STORAGE_KEY) ?? 'null'));
  } catch {
    return DEFAULT_WALLPAPER;
  }
}

/** Decode before replacing the saved picture; bound storage and rendered texture size. */
export async function prepareWallpaper(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 20_000_000) {
    throw new Error('unsupported-wallpaper');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('wallpaper-canvas-unavailable');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/webp', 0.85);
    if (!normalizeWallpaper({ image }).image) throw new Error('wallpaper-too-large');
    return image;
  } finally {
    bitmap.close();
  }
}
