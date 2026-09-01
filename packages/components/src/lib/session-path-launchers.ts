import type { LaunchLocalPathInput, LocalPathCommandSpec } from '@lody/shared';
import { parseCustomAcpCommandLine } from '@lody/shared';
import {
  DEFAULT_PATH_LAUNCHER_PREFERENCE,
  PATH_LAUNCHER_PREFERENCE_STORAGE_KEY,
  builtinPathLauncherIdSchema,
  idePreferenceCache,
  type BuiltinPathLauncherId,
  type CustomPathLauncher,
  type PathLauncherPreference,
} from './local-storage-cache';

export type { BuiltinPathLauncherId, CustomPathLauncher, PathLauncherPreference };
export { DEFAULT_PATH_LAUNCHER_PREFERENCE, PATH_LAUNCHER_PREFERENCE_STORAGE_KEY };

export type PathLauncherPlatform = 'darwin' | 'win32' | 'linux' | 'unknown';

export type BuiltinPathLauncher = {
  kind: 'builtin';
  id: BuiltinPathLauncherId;
  label: string;
  platforms?: readonly PathLauncherPlatform[];
  requiresElectron?: boolean;
};

export type CustomPathLauncherOption = CustomPathLauncher & {
  kind: 'custom';
  launcherId: string;
  label: string;
};

export type PathLauncherOption = BuiltinPathLauncher | CustomPathLauncherOption;

export type CustomPathLauncherTemplateValidation =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'missing_path' | 'invalid_syntax' | 'path_in_command' };

export const CUSTOM_PATH_LAUNCHER_ID_PREFIX = 'custom:';
export const PATH_LAUNCHER_PATH_PLACEHOLDER = '{path}';
export const PATH_LAUNCHER_PREFERENCE_CHANGED_EVENT = 'lody:path-launcher-preference-changed';

// Every launcher runs through the desktop bridge (CLI spawn, or shell.openExternal
// for Warp and VS Code's final fallback), so all of them require Electron. Editors
// open in a NEW window via their CLI `-n` flag; VS Code's fallback preserves that
// behavior with `windowId=_blank`, while Warp is url-only.
export const BUILTIN_PATH_LAUNCHERS: readonly BuiltinPathLauncher[] = [
  { kind: 'builtin', id: 'vscode', label: 'VS Code', requiresElectron: true },
  { kind: 'builtin', id: 'cursor', label: 'Cursor', requiresElectron: true },
  { kind: 'builtin', id: 'antigravity', label: 'Antigravity', requiresElectron: true },
  { kind: 'builtin', id: 'windsurf', label: 'Windsurf', requiresElectron: true },
  { kind: 'builtin', id: 'zed', label: 'Zed', requiresElectron: true },
  { kind: 'builtin', id: 'sublime', label: 'Sublime Text', requiresElectron: true },
  { kind: 'builtin', id: 'warp', label: 'Warp', requiresElectron: true },
  {
    kind: 'builtin',
    id: 'xcode',
    label: 'Xcode',
    platforms: ['darwin'],
    requiresElectron: true,
  },
];

export function getCustomPathLauncherOptionId(id: string): string {
  return `${CUSTOM_PATH_LAUNCHER_ID_PREFIX}${id}`;
}

export function parseCustomPathLauncherOptionId(launcherId: string): string | null {
  return launcherId.startsWith(CUSTOM_PATH_LAUNCHER_ID_PREFIX)
    ? launcherId.slice(CUSTOM_PATH_LAUNCHER_ID_PREFIX.length)
    : null;
}

export function createCustomPathLauncherId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizePlatform(platform: string | null | undefined): PathLauncherPlatform {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') {
    return platform;
  }
  return 'unknown';
}

function isBuiltinPathLauncherAvailable(
  launcher: BuiltinPathLauncher,
  options: { isElectron: boolean; platform?: string | null }
): boolean {
  if (launcher.requiresElectron && !options.isElectron) {
    return false;
  }
  if (!launcher.platforms) {
    return true;
  }
  return launcher.platforms.includes(normalizePlatform(options.platform));
}

export function getAvailablePathLauncherOptions({
  customLaunchers,
  isElectron,
  platform,
}: {
  customLaunchers: readonly CustomPathLauncher[];
  isElectron: boolean;
  platform?: string | null;
}): PathLauncherOption[] {
  const builtins = BUILTIN_PATH_LAUNCHERS.filter((launcher) =>
    isBuiltinPathLauncherAvailable(launcher, { isElectron, platform })
  );
  const customOptions: CustomPathLauncherOption[] = isElectron
    ? customLaunchers.map((launcher) => ({
        ...launcher,
        kind: 'custom',
        launcherId: getCustomPathLauncherOptionId(launcher.id),
      }))
    : [];
  return [...builtins, ...customOptions];
}

export function resolveSelectedPathLauncher(
  selectedLauncherId: string | null | undefined,
  options: readonly PathLauncherOption[]
): PathLauncherOption {
  const preferred = selectedLauncherId
    ? options.find((option) => getPathLauncherId(option) === selectedLauncherId)
    : undefined;
  return preferred ?? options[0] ?? BUILTIN_PATH_LAUNCHERS[0]!;
}

export function getPathLauncherId(launcher: PathLauncherOption): string {
  return launcher.kind === 'custom' ? launcher.launcherId : launcher.id;
}

export function readStoredPathLauncherPreference(): PathLauncherPreference {
  return idePreferenceCache.get('global') ?? DEFAULT_PATH_LAUNCHER_PREFERENCE;
}

export function writeStoredPathLauncherPreference(preference: PathLauncherPreference): void {
  const normalized = normalizePathLauncherPreference(preference);
  idePreferenceCache.set('global', normalized);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(PATH_LAUNCHER_PREFERENCE_CHANGED_EVENT));
  }
}

export function normalizePathLauncherPreference(
  preference: PathLauncherPreference
): PathLauncherPreference {
  const customLaunchers = preference.customLaunchers.slice(0, 20);
  const selectedLauncherId = isKnownPathLauncherId(preference.selectedLauncherId, customLaunchers)
    ? preference.selectedLauncherId
    : DEFAULT_PATH_LAUNCHER_PREFERENCE.selectedLauncherId;
  return { selectedLauncherId, customLaunchers };
}

function isKnownPathLauncherId(
  launcherId: string,
  customLaunchers: readonly CustomPathLauncher[]
): boolean {
  if (builtinPathLauncherIdSchema.safeParse(launcherId).success) {
    return true;
  }
  const customId = parseCustomPathLauncherOptionId(launcherId);
  return customId !== null && customLaunchers.some((launcher) => launcher.id === customId);
}

export function validateCustomPathLauncherCommandTemplate(
  commandTemplate: string
): CustomPathLauncherTemplateValidation {
  const parsed = parseCustomPathLauncherCommandTemplate(commandTemplate, '/tmp/lody-path');
  return parsed.ok ? { ok: true } : parsed;
}

function parseCustomPathLauncherCommandTemplate(
  commandTemplate: string,
  targetPath: string
): { ok: true; command: LocalPathCommandSpec } | Exclude<CustomPathLauncherTemplateValidation, { ok: true }> {
  const trimmed = commandTemplate.trim();
  if (!trimmed) {
    return { ok: false, reason: 'empty' };
  }
  if (!trimmed.includes(PATH_LAUNCHER_PATH_PLACEHOLDER)) {
    return { ok: false, reason: 'missing_path' };
  }

  const parsed = parseCustomAcpCommandLine(trimmed);
  if (!parsed) {
    return { ok: false, reason: 'invalid_syntax' };
  }
  if (parsed.command.includes(PATH_LAUNCHER_PATH_PLACEHOLDER)) {
    return { ok: false, reason: 'path_in_command' };
  }

  const args = (parsed.args ?? []).map((arg) =>
    arg.replaceAll(PATH_LAUNCHER_PATH_PLACEHOLDER, targetPath)
  );
  return {
    ok: true,
    command: {
      command: parsed.command,
      ...(args.length > 0 ? { args } : {}),
    },
  };
}

/**
 * Sublime Text ships a `subl` CLI but its location/availability differs per OS
 * (and the CLI is often not on PATH on macOS), so we pick a platform-specific
 * primary command with a few best-effort fallbacks. The native bridge tries the
 * primary, then each fallback in order (capped at 3 by LaunchLocalPathInput).
 */
function buildSublimePathLauncherInput(
  targetPath: string,
  platform: PathLauncherPlatform,
  label: string
): LaunchLocalPathInput {
  const subl = (command: string) => ({ command, args: [targetPath] });
  const base = { kind: 'command' as const, targetPath, label };

  switch (platform) {
    case 'darwin':
      // `open -a` is the only reliable entry point on macOS (subl is rarely on
      // PATH); fall back to the CLI if the user symlinked it.
      return {
        ...base,
        command: { command: '/usr/bin/open', args: ['-a', 'Sublime Text', targetPath] },
        fallbackCommands: [subl('subl'), subl('/usr/local/bin/subl')],
      };
    case 'win32':
      return {
        ...base,
        command: subl('subl'),
        fallbackCommands: [
          subl('C:\\Program Files\\Sublime Text\\subl.exe'),
          subl('C:\\Program Files\\Sublime Text\\sublime_text.exe'),
          subl('C:\\Program Files\\Sublime Text 3\\sublime_text.exe'),
        ],
      };
    case 'linux':
      return {
        ...base,
        command: subl('subl'),
        fallbackCommands: [
          subl('sublime_text'),
          subl('/opt/sublime_text/sublime_text'),
          subl('/usr/bin/subl'),
        ],
      };
    default:
      return {
        ...base,
        command: subl('subl'),
        fallbackCommands: [subl('sublime_text')],
      };
  }
}

/**
 * Editors are launched through their CLI before any URL fallback. A plain URL
 * handler routes the open into the most recently focused editor window and reuses
 * it, so opening different worktrees in a row clobbers each other. VS Code's final
 * fallback adds `windowId=_blank` to preserve the CLI's separate-window behavior.
 *
 * The VS Code family takes `-n` (`newWindowFlag`). `-n` there is "open in a new
 * window" but VS Code still de-dupes by folder, so re-opening a worktree that is
 * already open just focuses its existing window — it never spawns a duplicate.
 *
 * Zed gets NO flag: its `-n`/`--new` means "create a new workspace" and forces a
 * brand-new window every time, so re-opening an already-open worktree piled up
 * duplicate windows. Zed's default CLI behavior is exactly what we want — focus
 * the existing window for a worktree that is already open, otherwise open a new
 * window (it does not clobber other worktrees' windows; that is `-a`/`--add`).
 *
 * macOS GUI apps inherit a minimal launchd PATH (frequently without
 * `/usr/local/bin`), so we try the bare CLI name first, then absolute install
 * locations. Windows `.cmd` shims can't be spawned with `shell:false`, so we fall
 * back to the app `.exe`. The native bridge tries the primary command, then each
 * fallback in order (capped at 3 by LaunchLocalPathInput); after they all fail,
 * VS Code alone falls back to its deeplink.
 */
const EDITOR_CLI_LAUNCHERS: Record<
  'vscode' | 'cursor' | 'windsurf' | 'antigravity' | 'zed',
  {
    cli: string;
    darwinApp: string;
    darwinBundleCli: string;
    win: readonly string[];
    linux: readonly string[];
    /** Flag forcing a new window; omit when the editor's default already focuses-or-opens. */
    newWindowFlag?: string;
  }
> = {
  vscode: {
    cli: 'code',
    darwinApp: 'Visual Studio Code',
    darwinBundleCli: 'Contents/Resources/app/bin/code',
    win: ['C:\\Program Files\\Microsoft VS Code\\Code.exe'],
    linux: ['/usr/bin/code', '/snap/bin/code', '/usr/share/code/bin/code'],
    newWindowFlag: '-n',
  },
  cursor: {
    cli: 'cursor',
    darwinApp: 'Cursor',
    darwinBundleCli: 'Contents/Resources/app/bin/cursor',
    win: ['C:\\Program Files\\Cursor\\Cursor.exe'],
    linux: ['/usr/bin/cursor', '/opt/cursor/cursor'],
    newWindowFlag: '-n',
  },
  windsurf: {
    cli: 'windsurf',
    darwinApp: 'Windsurf',
    darwinBundleCli: 'Contents/Resources/app/bin/windsurf',
    win: ['C:\\Program Files\\Windsurf\\Windsurf.exe'],
    linux: ['/usr/bin/windsurf'],
    newWindowFlag: '-n',
  },
  antigravity: {
    cli: 'antigravity',
    darwinApp: 'Antigravity',
    darwinBundleCli: 'Contents/Resources/app/bin/antigravity',
    win: ['C:\\Program Files\\Antigravity\\Antigravity.exe'],
    linux: ['/usr/bin/antigravity'],
    newWindowFlag: '-n',
  },
  zed: {
    cli: 'zed',
    darwinApp: 'Zed',
    darwinBundleCli: 'Contents/MacOS/cli',
    win: [],
    linux: ['/usr/bin/zed', '/usr/local/bin/zed'],
    // No newWindowFlag: `zed <path>` focuses an already-open worktree, otherwise
    // opens a new window. `-n` would force a duplicate window every time.
  },
};

function isEditorCliLauncherId(id: string): id is keyof typeof EDITOR_CLI_LAUNCHERS {
  return Object.prototype.hasOwnProperty.call(EDITOR_CLI_LAUNCHERS, id);
}

export function buildVSCodePathLauncherFallbackUrl(targetPath: string): string {
  const normalizedPath = targetPath.replaceAll('\\', '/');
  const absolutePath = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
  const directoryPath = absolutePath.endsWith('/') ? absolutePath : `${absolutePath}/`;
  const encodedPath = directoryPath
    .split('/')
    .map((segment, index) =>
      index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)
    )
    .join('/');

  return `vscode://file${encodedPath}?windowId=_blank`;
}

function buildEditorCliLauncherInput(
  id: keyof typeof EDITOR_CLI_LAUNCHERS,
  targetPath: string,
  platform: PathLauncherPlatform,
  label: string
): LaunchLocalPathInput {
  const spec = EDITOR_CLI_LAUNCHERS[id];
  const make = (command: string): LocalPathCommandSpec => ({
    command,
    args: spec.newWindowFlag ? [spec.newWindowFlag, targetPath] : [targetPath],
  });

  let absoluteFallbacks: readonly string[];
  switch (platform) {
    case 'darwin':
      absoluteFallbacks = [
        `/usr/local/bin/${spec.cli}`,
        `/Applications/${spec.darwinApp}.app/${spec.darwinBundleCli}`,
      ];
      break;
    case 'win32':
      absoluteFallbacks = spec.win;
      break;
    case 'linux':
      absoluteFallbacks = spec.linux;
      break;
    default:
      absoluteFallbacks = [];
  }

  const fallbackCommands = absoluteFallbacks.slice(0, 3).map(make);
  return {
    kind: 'command',
    command: make(spec.cli),
    ...(fallbackCommands.length > 0 ? { fallbackCommands } : {}),
    ...(id === 'vscode' ? { fallbackUrl: buildVSCodePathLauncherFallbackUrl(targetPath) } : {}),
    targetPath,
    label,
  };
}

export function buildPathLauncherLaunchInput(
  launcher: PathLauncherOption,
  targetPath: string,
  platform?: string | null
): LaunchLocalPathInput {
  if (launcher.kind === 'custom') {
    const parsed = parseCustomPathLauncherCommandTemplate(launcher.commandTemplate, targetPath);
    if (!parsed.ok) {
      throw new Error(`Invalid path launcher command template: ${parsed.reason}`);
    }
    return {
      kind: 'command',
      command: parsed.command,
      targetPath,
      label: launcher.label,
    };
  }

  if (isEditorCliLauncherId(launcher.id)) {
    return buildEditorCliLauncherInput(
      launcher.id,
      targetPath,
      normalizePlatform(platform),
      launcher.label
    );
  }

  if (launcher.id === 'sublime') {
    return buildSublimePathLauncherInput(targetPath, normalizePlatform(platform), launcher.label);
  }

  if (launcher.id === 'xcode') {
    return {
      kind: 'command',
      command: { command: '/usr/bin/xed', args: [targetPath] },
      fallbackCommands: [{ command: 'xed', args: [targetPath] }],
      targetPath,
      label: launcher.label,
    };
  }

  if (launcher.id === 'warp') {
    // Warp is a terminal with no clean CLI to open a new tab at a path, but its
    // url scheme already opens a NEW tab (no window-reuse problem), so it stays on
    // the url launch path — handled by the desktop bridge via shell.openExternal.
    return {
      kind: 'url',
      url: `warp://action/new_tab?path=${encodeURIComponent(targetPath)}`,
      targetPath,
      label: launcher.label,
    };
  }

  throw new Error(`Path launcher ${launcher.id} cannot build a launch request`);
}

export function buildPathLauncherProbes(
  launchers: readonly PathLauncherOption[],
  targetPath: string,
  platform?: string | null
): Array<{ launcherId: string; input: LaunchLocalPathInput }> {
  const checks: Array<{ launcherId: string; input: LaunchLocalPathInput }> = [];
  for (const launcher of launchers) {
    if (
      launcher.kind === 'custom' &&
      !validateCustomPathLauncherCommandTemplate(launcher.commandTemplate).ok
    )
      continue;
    checks.push({
      launcherId: getPathLauncherId(launcher),
      input: buildPathLauncherLaunchInput(launcher, targetPath, platform),
    });
  }
  return checks;
}
