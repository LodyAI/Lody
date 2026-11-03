import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';
import {
  isElectronRenderer,
  isMacOSElectronRenderer,
  isWindowsElectronRenderer,
  useElectronFullscreen,
} from '@/lib/electron';

const styles = stylex.create({
  header: { position: 'relative', zIndex: 20 },
  drag: { WebkitAppRegion: 'drag' },
  exempt: { WebkitAppRegion: 'no-drag' },
  height: { height: 'calc(var(--spacing) * 11)' },
  captionPad: { paddingRight: 'calc(var(--window-caption-inset-right) + 0.5rem)' },
  windowsBorder: { paddingBottom: '7px' },
  windowsPlain: { paddingBottom: 'calc(var(--spacing) * 2)' },
  macFrameBorder: { paddingBottom: '5px' },
  macFramePlain: { paddingBottom: '6px' },
  macBorder: { paddingTop: '3px' },
  macPlain: { paddingTop: '2px' },
  strip: {
    insetInline: 'calc(var(--spacing) * 0)',
    top: 'calc(var(--spacing) * 0)',
    zIndex: 10,
  },
  fixed: { position: 'fixed' },
  absolute: { position: 'absolute' },
});

export const WINDOW_DRAG_REGION_HEIGHT_CLASS = stylex.props(styles.height).className;
export const WINDOW_DRAG_REGION_CLASS = stylex.props(styles.drag).className;
export const WINDOW_DRAG_EXEMPT_CLASS = stylex.props(styles.exempt).className;
export const WINDOW_DRAG_HEADER_CLASS = `${WINDOW_DRAG_REGION_CLASS} ${stylex.props(styles.header).className}`;
// `--window-caption-*` (tailwind/index.css) is the measured caption-button
// strip, 0 when there is none. A header that shares its row with the buttons
// pads by the strip's width plus a gap; a full-window overlay with no such row
// starts its chrome below `WINDOW_CAPTION_CLEAR_TOP` instead.
export const WINDOWS_CAPTION_PAD_CLASS = stylex.props(styles.captionPad).className;
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
  return stylex.props(bottomBorder ? styles.windowsBorder : styles.windowsPlain).className;
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
  if (insideWorkspaceFrame)
    return stylex.props(bottomBorder ? styles.macFrameBorder : styles.macFramePlain).className;
  return stylex.props(bottomBorder ? styles.macBorder : styles.macPlain).className;
}

export function WindowDragStrip({
  className,
  xstyle,
  position = 'absolute',
}: {
  className?: string;
  xstyle?: stylex.StyleXStyles;
  position?: 'absolute' | 'fixed';
}) {
  const fullscreen = useElectronFullscreen();
  if (!isElectronRenderer() || fullscreen) return null;
  const sx = stylex.props(
    styles.drag,
    styles.height,
    styles.strip,
    position === 'fixed' ? styles.fixed : styles.absolute,
    xstyle
  );
  return (
    <div aria-hidden data-window-drag-strip="" {...sx} className={clsx(sx.className, className)} />
  );
}
