import type { PathLauncherRequest } from '@lody/shared/electron-ipc';
export {
  buildPathLauncherLaunchInput,
  buildVSCodePathLauncherFallbackUrl,
  validateCustomPathLauncherCommandTemplate,
} from '@lody/shared/path-launchers';
import { validateCustomPathLauncherCommandTemplate } from '@lody/shared/path-launchers';
import { getIpcServices } from './electron-ipc-client';
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
  { kind: 'builtin', id: 'delta', label: 'Delta', requiresElectron: true },
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

export function buildPathLauncherProbes(
  launchers: readonly PathLauncherOption[],
  targetPath: string,
  _platform?: string | null
): PathLauncherRequest[] {
  const checks: PathLauncherRequest[] = [];
  for (const launcher of launchers) {
    if (
      launcher.kind === 'custom' &&
      !validateCustomPathLauncherCommandTemplate(launcher.commandTemplate).ok
    )
      continue;
    checks.push({
      launcherId: getPathLauncherId(launcher),
      targetPath,
      targetKind: 'directory',
    });
  }
  return checks;
}

/** Custom commands become main-owned only after native approval. */
export async function executePathLauncher(
  launcher: PathLauncherOption,
  targetPath: string,
  targetKind: 'file' | 'directory' = 'directory'
) {
  const app = getIpcServices()!.app;
  if (launcher.kind === 'custom') {
    const approved = await app.approvePathLauncher({
      id: launcher.id,
      label: launcher.label,
      commandTemplate: launcher.commandTemplate,
    });
    if (!approved.approved) return { launched: false as const, error: 'launcher_not_approved' };
  }
  return app.launchLocalPath({ launcherId: getPathLauncherId(launcher), targetPath, targetKind });
}
