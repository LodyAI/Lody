import { cn } from '@/lib/utils';
import {
  isElectronRenderer,
  isWindowsElectronRenderer,
  useElectronFullscreen,
} from '@/lib/electron';

export const WINDOW_DRAG_REGION_HEIGHT_CLASS = 'h-11';
export const WINDOW_DRAG_REGION_CLASS = 'app-region-drag';
export const WINDOW_DRAG_EXEMPT_CLASS = 'app-region-no-drag';
export const WINDOW_DRAG_HEADER_CLASS = `${WINDOW_DRAG_REGION_CLASS} relative z-20`;
export const WINDOWS_CAPTION_PAD_CLASS = 'pr-[144px]';

export function useWindowDragRegionClass(): string | undefined {
  const fullscreen = useElectronFullscreen();
  if (!isElectronRenderer() || fullscreen) return undefined;
  return WINDOW_DRAG_HEADER_CLASS;
}

export function useWindowsCaptionPadClass(): string | undefined {
  const fullscreen = useElectronFullscreen();
  if (!isWindowsElectronRenderer() || fullscreen) return undefined;
  return WINDOWS_CAPTION_PAD_CLASS;
}

export function WindowDragStrip({
  className,
  position = 'absolute',
}: {
  className?: string;
  position?: 'absolute' | 'fixed';
}) {
  const fullscreen = useElectronFullscreen();
  if (!isElectronRenderer() || fullscreen) return null;
  return (
    <div
      aria-hidden
      data-window-drag-strip=""
      className={cn(
        WINDOW_DRAG_REGION_CLASS,
        WINDOW_DRAG_REGION_HEIGHT_CLASS,
        position === 'fixed' ? 'fixed' : 'absolute',
        'inset-x-0 top-0 z-10',
        className
      )}
    />
  );
}
