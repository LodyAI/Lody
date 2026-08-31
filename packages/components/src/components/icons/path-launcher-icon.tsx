import type React from 'react';
import { FolderOpen } from 'lucide-react';
import type { BuiltinPathLauncherId, PathLauncherOption } from '@/lib/session-path-launchers';
import {
  AntigravityIcon,
  CursorIcon,
  SublimeIcon,
  TerminalIcon,
  VSCodeIcon,
  WarpIcon,
  WindsurfIcon,
  XcodeIcon,
  ZedIcon,
} from './ide-icons';

// Some launcher glyphs are inline SVGs (accept SVGProps), others render an <img>
// (e.g. the Xcode app icon). Both only need `className` from callers, so the
// shared contract is intentionally narrow.
export type PathLauncherIconComponent = React.ComponentType<{ className?: string }>;

const BUILTIN_PATH_LAUNCHER_ICONS: Record<BuiltinPathLauncherId, PathLauncherIconComponent> = {
  vscode: VSCodeIcon,
  cursor: CursorIcon,
  antigravity: AntigravityIcon,
  windsurf: WindsurfIcon,
  zed: ZedIcon,
  sublime: SublimeIcon,
  warp: WarpIcon,
  xcode: XcodeIcon,
  // The file managers get a generic folder glyph rather than the OS artwork:
  // only one of the three is ever offered on a given platform, so the icon has
  // no brand to disambiguate — it only has to read as "a folder opens".
  finder: FolderOpen,
  explorer: FolderOpen,
  'file-manager': FolderOpen,
};

/**
 * Resolve the brand/glyph icon for a path launcher. Custom launchers run an
 * arbitrary shell command, so they fall back to the generic terminal glyph.
 * Shared by the session header split button and the settings list so both stay
 * in sync.
 */
export function getPathLauncherIcon(launcher: PathLauncherOption): PathLauncherIconComponent {
  return launcher.kind === 'custom' ? TerminalIcon : BUILTIN_PATH_LAUNCHER_ICONS[launcher.id];
}
