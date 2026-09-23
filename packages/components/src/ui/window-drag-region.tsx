import { cn } from '@/lib/utils';
import {
  isElectronRenderer,
  isMacOSElectronRenderer,
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

// macOS traffic lights are centered at y=23 (`trafficLightPosition.y` 16 + 7px
// radius in apps/electron/src/main/window.ts). A border-box h-11 row centers its
// controls at y=22 (21.5 with a 1px bottom border); top padding moves that
// center onto the lights so every window-top row lines up with them.
export function useMacTrafficLightRowPadClass({
  bottomBorder = false,
}: { bottomBorder?: boolean } = {}): string | undefined {
  const fullscreen = useElectronFullscreen();
  if (!isMacOSElectronRenderer() || fullscreen) return undefined;
  return bottomBorder ? 'pt-[3px]' : 'pt-[2px]';
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
