import { atom } from 'jotai';
import {
  normalizeWallpaper,
  readWallpaper,
  WALLPAPER_STORAGE_KEY,
  type WallpaperSettings,
} from '@/lib/wallpaper';

const state = atom(readWallpaper());
state.onMount = (set) => {
  set(readWallpaper());
  const onStorage = (event: StorageEvent) => {
    if (
      event.storageArea === localStorage &&
      (event.key === WALLPAPER_STORAGE_KEY || event.key === null)
    ) {
      set(readWallpaper());
    }
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
};

export const wallpaperAtom = atom(
  (get) => get(state),
  (get, set, patch: Partial<WallpaperSettings>) => {
    const next = normalizeWallpaper({ ...get(state), ...patch });
    // Persist first: quota/permission errors leave both the old image and UI intact.
    localStorage.setItem(WALLPAPER_STORAGE_KEY, JSON.stringify(next));
    set(state, next);
  }
);
