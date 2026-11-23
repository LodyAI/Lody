import type { AndroidEmulatorQuality } from '@lody/shared';

export const ANDROID_PREVIEW_VIEWER_GRACE_MS = 30_000;

export function androidEncoderOptions(quality: AndroidEmulatorQuality = 'balanced') {
  switch (quality) {
    case 'saver':
      return { videoBitRate: 300_000, maxSize: 640, maxFps: 15 };
    case 'clear':
      return { videoBitRate: 1_000_000, maxSize: 1280, maxFps: 30 };
    default:
      return { videoBitRate: 600_000, maxSize: 960, maxFps: 24 };
  }
}

/** Expiry ends the operation through its normal joined cleanup and lease release. */
export function createAndroidViewerIdleTimeout(onIdle: () => void) {
  let viewers = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const arm = () => {
    clear();
    if (disposed) return;
    timer = setTimeout(() => {
      timer = undefined;
      disposed = true;
      onIdle();
    }, ANDROID_PREVIEW_VIEWER_GRACE_MS);
    timer.unref?.();
  };
  arm();
  return {
    attach() {
      if (disposed) return () => {};
      clear();
      viewers++;
      let left = false;
      return () => {
        if (left || disposed) return;
        left = true;
        if (--viewers === 0) arm();
      };
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}
