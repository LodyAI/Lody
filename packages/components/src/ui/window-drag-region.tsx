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
// `--window-caption-*` (tailwind/index.css) is the measured caption-button
// strip, 0 when there is none. A header that shares its row with the buttons
// pads by the strip's width plus a gap; a full-window overlay with no such row
// starts its chrome below `WINDOW_CAPTION_CLEAR_TOP` instead.
export const WINDOWS_CAPTION_PAD_CLASS = 'pr-[calc(var(--window-caption-inset-right)+0.5rem)]';
export const WINDOW_CAPTION_CLEAR_TOP =
  'max(var(--safe-area-top, env(safe-area-inset-top, 0px)), var(--window-caption-height, 0px))';

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

// Windows caption buttons are OS-drawn in the `titleBarOverlay` strip
// (`MAIN_WINDOW_TITLE_BAR_OVERLAY_HEIGHT` = 36 in
// apps/electron/src/main/window-theme.ts), so their centerline is y=18. A
// border-box h-11 row centers its controls at y=22 (21.5 with a 1px bottom
// border); bottom padding lifts that center onto the buttons so every
// window-top row lines up with them.
export function useWindowsCaptionRowPadClass({
  bottomBorder = false,
}: { bottomBorder?: boolean } = {}): string | undefined {
  const fullscreen = useElectronFullscreen();
  if (!isWindowsElectronRenderer() || fullscreen) return undefined;
  return bottomBorder ? 'pb-[7px]' : 'pb-2';
}

// macOS traffic lights are centered at y=23 (`trafficLightPosition.y` 16 + 7px
// radius in apps/electron/src/main/window.ts). Rows at the window origin use top
// padding; rows inside WorkspaceCard's top rim use bottom padding. Both place
// their controls on the native centerline.
export function useMacTrafficLightRowPadClass({
  bottomBorder = false,
  insideWorkspaceFrame = false,
}: { bottomBorder?: boolean; insideWorkspaceFrame?: boolean } = {}): string | undefined {
  const fullscreen = useElectronFullscreen();
  if (!isMacOSElectronRenderer() || fullscreen) return undefined;
  // Workspace rows begin below the frame's 4px top rim. Bottom padding lifts
  // their content back onto the fixed y=23 native centreline while retaining
  // a real gap between 28px controls and the card edge. A bordered h-11 row
  // has one fewer content pixel, so it needs one fewer padding pixel.
  if (insideWorkspaceFrame) return bottomBorder ? 'pb-[5px]' : 'pb-[6px]';
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
