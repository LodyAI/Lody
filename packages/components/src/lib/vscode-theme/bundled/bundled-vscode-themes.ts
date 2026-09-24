import gruvboxMaterialDarkJson from './themes/gruvbox-material/gruvbox-material-dark.json?raw';
import gruvboxMaterialLightJson from './themes/gruvbox-material/gruvbox-material-light.json?raw';
import ayuDarkJson from './themes/ayu/ayu-dark-unbordered.json?raw';
import ayuLightJson from './themes/ayu/ayu-light-unbordered.json?raw';
import ayuMirageJson from './themes/ayu/ayu-mirage-unbordered.json?raw';
import catppuccinMochaJson from './themes/catppuccin/themes/mocha.json?raw';
import githubDarkDefaultJson from './themes/github/themes/dark-default.json?raw';
import githubLightDefaultJson from './themes/github/themes/light-default.json?raw';
import oneDarkProJson from './themes/one-dark-pro/themes/OneDark-Pro.json?raw';
import tokyoNightJson from './themes/tokyo-night/tokyo-night-color-theme.json?raw';
import tokyoNightLightJson from './themes/tokyo-night/tokyo-night-light-color-theme.json?raw';
import tokyoNightStormJson from './themes/tokyo-night/tokyo-night-storm-color-theme.json?raw';
import vscodeDark2026Json from './themes/vscode-defaults/theme-defaults/themes/2026-dark.json?raw';
import vscodeLight2026Json from './themes/vscode-defaults/theme-defaults/themes/2026-light.json?raw';
import vscodeDarkModernJson from './themes/vscode-defaults/theme-defaults/themes/dark_modern.json?raw';
import vscodeDarkPlusJson from './themes/vscode-defaults/theme-defaults/themes/dark_plus.json?raw';
import vscodeDarkVSJson from './themes/vscode-defaults/theme-defaults/themes/dark_vs.json?raw';
import vscodeLightModernJson from './themes/vscode-defaults/theme-defaults/themes/light_modern.json?raw';
import vscodeLightPlusJson from './themes/vscode-defaults/theme-defaults/themes/light_plus.json?raw';
import vscodeLightVSJson from './themes/vscode-defaults/theme-defaults/themes/light_vs.json?raw';
import vesperThemeJson from './themes/vesper/Vesper-dark-color-theme.json?raw';
import vitesseBlackJson from './themes/vitesse/vitesse-black.json?raw';
import vitesseDarkJson from './themes/vitesse/vitesse-dark.json?raw';
import vitesseDarkSoftJson from './themes/vitesse/vitesse-dark-soft.json?raw';
import vitesseLightJson from './themes/vitesse/vitesse-light.json?raw';
import vitesseLightSoftJson from './themes/vitesse/vitesse-light-soft.json?raw';
import lodyLightJson from './themes/lody/lody-light.json?raw';
import {
  getVSCodeThemeContributions,
  parseVSCodeExtensionManifest,
  resolveVSCodeThemeSync,
  type VSCodeThemeSyncFileReader,
} from '../vscode-theme-loader';
import type { LodyResolvedVSCodeTheme } from '../vscode-theme-schemas';
import { warmVesperTheme } from './vesper-warm-palette';

// The app ships exactly two themes: Lody Light (our fork of Vitesse Light Soft,
// tuned for legible app chrome) and Vesper (dark). Only these are ever applied;
// the rest of the bundled JSONs stay for reference but are not user-selectable.
const SELECTABLE_BUNDLED_VSCODE_THEME_IDS = new Set(['lody-light', 'vesper']);

export const isSelectableBundledVSCodeThemeId = (themeId: string): boolean =>
  SELECTABLE_BUNDLED_VSCODE_THEME_IDS.has(themeId);

type BundledVSCodeThemeExtension = {
  extensionId: string;
  extensionVersion: string;
  manifest: unknown;
  files: Record<string, string>;
  themeIdsByLabel?: Record<string, string>;
};

type BundledVSCodeThemeDescriptor = {
  id: string;
  label: string;
  uiTheme: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
  path: string;
  extensionId: string;
  extensionVersion: string;
  files: Record<string, string>;
};

type BundledThemeResolveWarning = {
  extensionId: string;
  extensionVersion: string;
  themeId?: string;
  themeLabel?: string;
  path?: string;
  error: unknown;
};

const BUNDLED_THEME_EXTENSIONS: BundledVSCodeThemeExtension[] = [
  {
    // Lody's own light theme — forked from Vitesse Light Soft and tuned so the
    // derived app chrome (muted text, panels, composer field, borders) has
    // enough contrast. The syntax palette stays Vitesse.
    extensionId: 'lody.theme-lody',
    extensionVersion: '1.0.0',
    manifest: {
      name: 'theme-lody',
      displayName: 'Lody Theme',
      publisher: 'lody',
      version: '1.0.0',
      contributes: {
        themes: [
          {
            label: 'Lody Light',
            uiTheme: 'vs',
            path: './themes/lody-light.json',
          },
        ],
      },
    },
    files: {
      'themes/lody-light.json': lodyLightJson,
    },
    themeIdsByLabel: {
      'Lody Light': 'lody-light',
    },
  },
  {
    extensionId: 'vscode.theme-defaults',
    extensionVersion: 'vscode-oss-cec7c1c5',
    manifest: {
      name: 'theme-defaults',
      displayName: 'VSCode Default Themes',
      publisher: 'vscode',
      version: 'vscode-oss-cec7c1c5',
      contributes: {
        themes: [
          {
            label: 'Dark 2026',
            uiTheme: 'vs-dark',
            path: './theme-defaults/themes/2026-dark.json',
          },
          {
            label: 'Light 2026',
            uiTheme: 'vs',
            path: './theme-defaults/themes/2026-light.json',
          },
        ],
      },
    },
    files: {
      'theme-defaults/themes/2026-dark.json': vscodeDark2026Json,
      'theme-defaults/themes/2026-light.json': vscodeLight2026Json,
      'theme-defaults/themes/dark_modern.json': vscodeDarkModernJson,
      'theme-defaults/themes/dark_plus.json': vscodeDarkPlusJson,
      'theme-defaults/themes/dark_vs.json': vscodeDarkVSJson,
      'theme-defaults/themes/light_modern.json': vscodeLightModernJson,
      'theme-defaults/themes/light_plus.json': vscodeLightPlusJson,
      'theme-defaults/themes/light_vs.json': vscodeLightVSJson,
    },
    themeIdsByLabel: {
      'Dark 2026': 'vscode-dark-2026',
      'Light 2026': 'vscode-light-2026',
    },
  },
  {
    extensionId: 'raunofreiberg.vesper',
    extensionVersion: '0.0.40',
    manifest: {
      name: 'vesper',
      displayName: 'Vesper',
      publisher: 'raunofreiberg',
      version: '0.0.40',
      contributes: {
        themes: [
          {
            label: 'Vesper',
            uiTheme: 'vs-dark',
            path: './themes/Vesper-dark-color-theme.json',
          },
        ],
      },
    },
    files: {
      'themes/Vesper-dark-color-theme.json': vesperThemeJson,
    },
    themeIdsByLabel: {
      Vesper: 'vesper',
    },
  },
  {
    extensionId: 'GitHub.github-vscode-theme',
    extensionVersion: '6.3.5',
    manifest: {
      name: 'github-vscode-theme',
      displayName: 'GitHub Theme',
      publisher: 'GitHub',
      version: '6.3.5',
      contributes: {
        themes: [
          {
            label: 'GitHub Light Default',
            uiTheme: 'vs',
            path: './themes/light-default.json',
          },
          {
            label: 'GitHub Dark Default',
            uiTheme: 'vs-dark',
            path: './themes/dark-default.json',
          },
        ],
      },
    },
    files: {
      'themes/light-default.json': githubLightDefaultJson,
      'themes/dark-default.json': githubDarkDefaultJson,
    },
    themeIdsByLabel: {
      'GitHub Light Default': 'github-light-default',
      'GitHub Dark Default': 'github-dark-default',
    },
  },
  {
    extensionId: 'Catppuccin.catppuccin-vsc',
    extensionVersion: '3.18.1',
    manifest: {
      name: 'catppuccin-vsc',
      displayName: 'Catppuccin for VSCode',
      publisher: 'Catppuccin',
      version: '3.18.1',
      contributes: {
        themes: [
          {
            label: 'Catppuccin Mocha',
            uiTheme: 'vs-dark',
            path: './themes/mocha.json',
          },
        ],
      },
    },
    files: {
      'themes/mocha.json': catppuccinMochaJson,
    },
    themeIdsByLabel: {
      'Catppuccin Mocha': 'catppuccin-mocha',
    },
  },
  {
    extensionId: 'enkia.tokyo-night',
    extensionVersion: '1.1.2',
    manifest: {
      name: 'tokyo-night',
      displayName: 'Tokyo Night',
      publisher: 'enkia',
      version: '1.1.2',
      contributes: {
        themes: [
          {
            label: 'Tokyo Night',
            uiTheme: 'vs-dark',
            path: './themes/tokyo-night-color-theme.json',
          },
          {
            label: 'Tokyo Night Storm',
            uiTheme: 'vs-dark',
            path: './themes/tokyo-night-storm-color-theme.json',
          },
          {
            label: 'Tokyo Night Light',
            uiTheme: 'vs',
            path: './themes/tokyo-night-light-color-theme.json',
          },
        ],
      },
    },
    files: {
      'themes/tokyo-night-color-theme.json': tokyoNightJson,
      'themes/tokyo-night-storm-color-theme.json': tokyoNightStormJson,
      'themes/tokyo-night-light-color-theme.json': tokyoNightLightJson,
    },
    themeIdsByLabel: {
      'Tokyo Night': 'tokyo-night',
      'Tokyo Night Storm': 'tokyo-night-storm',
      'Tokyo Night Light': 'tokyo-night-light',
    },
  },
  {
    extensionId: 'antfu.theme-vitesse',
    extensionVersion: '1.0.1',
    manifest: {
      name: 'theme-vitesse',
      displayName: 'Vitesse Theme',
      publisher: 'antfu',
      version: '1.0.1',
      contributes: {
        themes: [
          {
            label: 'Vitesse Light',
            uiTheme: 'vs',
            path: './themes/vitesse-light.json',
          },
          {
            label: 'Vitesse Dark',
            uiTheme: 'vs-dark',
            path: './themes/vitesse-dark.json',
          },
          {
            label: 'Vitesse Black',
            uiTheme: 'vs-dark',
            path: './themes/vitesse-black.json',
          },
          {
            label: 'Vitesse Light Soft',
            uiTheme: 'vs',
            path: './themes/vitesse-light-soft.json',
          },
          {
            label: 'Vitesse Dark Soft',
            uiTheme: 'vs-dark',
            path: './themes/vitesse-dark-soft.json',
          },
        ],
      },
    },
    files: {
      'themes/vitesse-light.json': vitesseLightJson,
      'themes/vitesse-dark.json': vitesseDarkJson,
      'themes/vitesse-black.json': vitesseBlackJson,
      'themes/vitesse-light-soft.json': vitesseLightSoftJson,
      'themes/vitesse-dark-soft.json': vitesseDarkSoftJson,
    },
    themeIdsByLabel: {
      'Vitesse Light': 'vitesse-light',
      'Vitesse Dark': 'vitesse-dark',
      'Vitesse Black': 'vitesse-black',
      'Vitesse Light Soft': 'vitesse-light-soft',
      'Vitesse Dark Soft': 'vitesse-dark-soft',
    },
  },
  {
    extensionId: 'binaryify.one-dark-pro',
    extensionVersion: '3.19.0',
    manifest: {
      name: 'one-dark-pro',
      displayName: 'One Dark Pro',
      publisher: 'Binaryify',
      version: '3.19.0',
      contributes: {
        themes: [
          {
            label: 'One Dark Pro',
            uiTheme: 'vs-dark',
            path: './themes/OneDark-Pro.json',
          },
        ],
      },
    },
    files: {
      'themes/OneDark-Pro.json': oneDarkProJson,
    },
    themeIdsByLabel: {
      'One Dark Pro': 'one-dark-pro',
    },
  },
  {
    extensionId: 'teabyii.ayu',
    extensionVersion: '1.1.11',
    manifest: {
      name: 'ayu',
      displayName: 'Ayu',
      publisher: 'teabyii',
      version: '1.1.11',
      contributes: {
        themes: [
          {
            label: 'Ayu Light',
            uiTheme: 'vs',
            path: './ayu-light-unbordered.json',
          },
          {
            label: 'Ayu Mirage',
            uiTheme: 'vs-dark',
            path: './ayu-mirage-unbordered.json',
          },
          {
            label: 'Ayu Dark',
            uiTheme: 'vs-dark',
            path: './ayu-dark-unbordered.json',
          },
        ],
      },
    },
    files: {
      'ayu-light-unbordered.json': ayuLightJson,
      'ayu-mirage-unbordered.json': ayuMirageJson,
      'ayu-dark-unbordered.json': ayuDarkJson,
    },
    themeIdsByLabel: {
      'Ayu Light': 'ayu-light',
      'Ayu Mirage': 'ayu-mirage',
      'Ayu Dark': 'ayu-dark',
    },
  },
  {
    extensionId: 'sainnhe.gruvbox-material',
    extensionVersion: '6.5.2',
    manifest: {
      name: 'gruvbox-material',
      displayName: 'Gruvbox Material',
      publisher: 'sainnhe',
      version: '6.5.2',
      contributes: {
        themes: [
          {
            label: 'Gruvbox Material Dark',
            uiTheme: 'vs-dark',
            path: './themes/gruvbox-material-dark.json',
          },
          {
            label: 'Gruvbox Material Light',
            uiTheme: 'vs',
            path: './themes/gruvbox-material-light.json',
          },
        ],
      },
    },
    files: {
      'themes/gruvbox-material-dark.json': gruvboxMaterialDarkJson,
      'themes/gruvbox-material-light.json': gruvboxMaterialLightJson,
    },
    themeIdsByLabel: {
      'Gruvbox Material Dark': 'gruvbox-material-dark',
      'Gruvbox Material Light': 'gruvbox-material-light',
    },
  },
];

let bundledThemeDescriptorsCache:
  | {
      list: BundledVSCodeThemeDescriptor[];
      byId: Map<string, BundledVSCodeThemeDescriptor>;
    }
  | undefined;
let bundledThemesCache: LodyResolvedVSCodeTheme[] | undefined;
const bundledThemesById = new Map<string, LodyResolvedVSCodeTheme>();
const failedBundledThemeIds = new Set<string>();
const warnedBundledThemeFailures = new Set<string>();

export const resolveBundledVSCodeThemesFromExtensions = (
  extensions: BundledVSCodeThemeExtension[],
  onWarning: (warning: BundledThemeResolveWarning) => void = warnBundledThemeResolutionFailure
): LodyResolvedVSCodeTheme[] => {
  const descriptors = buildBundledThemeDescriptors(extensions, onWarning);
  const themes: LodyResolvedVSCodeTheme[] = [];

  for (const descriptor of descriptors.list) {
    try {
      themes.push(resolveBundledThemeDescriptorSync(descriptor));
    } catch (error) {
      failedBundledThemeIds.add(descriptor.id);
      onWarning({
        extensionId: descriptor.extensionId,
        extensionVersion: descriptor.extensionVersion,
        themeId: descriptor.id,
        themeLabel: descriptor.label,
        path: descriptor.path,
        error,
      });
    }
  }

  return themes;
};

export const getBundledVSCodeThemeById = async (
  themeId: string
): Promise<LodyResolvedVSCodeTheme | undefined> => getBundledVSCodeThemeByIdSync(themeId);

export const getBundledVSCodeThemeByIdSync = (
  themeId: string
): LodyResolvedVSCodeTheme | undefined => {
  const cached = bundledThemesById.get(themeId);
  if (cached) {
    return cached;
  }
  if (failedBundledThemeIds.has(themeId)) {
    return undefined;
  }

  const descriptor = getBundledThemeDescriptors().byId.get(themeId);
  if (!descriptor) {
    return undefined;
  }

  try {
    return resolveBundledThemeDescriptorSync(descriptor);
  } catch (error) {
    failedBundledThemeIds.add(themeId);
    warnBundledThemeResolutionFailure({
      extensionId: descriptor.extensionId,
      extensionVersion: descriptor.extensionVersion,
      themeId: descriptor.id,
      themeLabel: descriptor.label,
      path: descriptor.path,
      error,
    });
    return undefined;
  }
};

export const getCachedBundledVSCodeThemes = (): readonly LodyResolvedVSCodeTheme[] | undefined =>
  bundledThemesCache;

export const getCachedBundledVSCodeThemeById = (
  themeId: string
): LodyResolvedVSCodeTheme | undefined => bundledThemesById.get(themeId);

export const resolveBundledVSCodeThemes = async (): Promise<LodyResolvedVSCodeTheme[]> =>
  resolveBundledVSCodeThemesSync();

export const resolveBundledVSCodeThemesSync = (): LodyResolvedVSCodeTheme[] => {
  if (bundledThemesCache) {
    return bundledThemesCache;
  }

  const themes = resolveBundledVSCodeThemesFromExtensions(BUNDLED_THEME_EXTENSIONS);
  bundledThemesCache = themes;
  return themes;
};

const createBundledThemeSyncReader =
  (files: Record<string, string>, extensionId: string): VSCodeThemeSyncFileReader =>
  (path) => {
    const content = files[path];
    if (content === undefined) {
      throw new Error(`Bundled theme file not found for ${extensionId}: ${path}`);
    }
    return content;
  };

const resolveBundledThemeDescriptorSync = (
  descriptor: BundledVSCodeThemeDescriptor
): LodyResolvedVSCodeTheme => {
  const cached = bundledThemesById.get(descriptor.id);
  if (cached) {
    return cached;
  }

  const resolved = resolveVSCodeThemeSync({
    id: descriptor.id,
    label: descriptor.label,
    uiTheme: descriptor.uiTheme,
    path: descriptor.path,
    source: {
      kind: 'builtin',
      extensionId: descriptor.extensionId,
      extensionVersion: descriptor.extensionVersion,
    },
    readFile: createBundledThemeSyncReader(descriptor.files, descriptor.extensionId),
  });
  // Lody ships Vesper with a warm color temperature (see vesper-warm-palette.ts).
  const theme = resolved.id === 'vesper' ? warmVesperTheme(resolved) : resolved;
  bundledThemesById.set(theme.id, theme);
  return theme;
};

const getBundledThemeDescriptors = () => {
  bundledThemeDescriptorsCache ??= buildBundledThemeDescriptors(BUNDLED_THEME_EXTENSIONS);
  return bundledThemeDescriptorsCache;
};

const buildBundledThemeDescriptors = (
  extensions: BundledVSCodeThemeExtension[],
  onWarning: (warning: BundledThemeResolveWarning) => void = warnBundledThemeResolutionFailure
): {
  list: BundledVSCodeThemeDescriptor[];
  byId: Map<string, BundledVSCodeThemeDescriptor>;
} => {
  const list: BundledVSCodeThemeDescriptor[] = [];
  const byId = new Map<string, BundledVSCodeThemeDescriptor>();

  for (const extension of extensions) {
    let manifest;
    try {
      manifest = parseVSCodeExtensionManifest(extension.manifest);
    } catch (error) {
      onWarning({
        extensionId: extension.extensionId,
        extensionVersion: extension.extensionVersion,
        error,
      });
      continue;
    }

    const contributions = getVSCodeThemeContributions(manifest);
    for (const contribution of contributions) {
      const descriptor: BundledVSCodeThemeDescriptor = {
        id:
          extension.themeIdsByLabel?.[contribution.label] ??
          contribution.id ??
          createBundledThemeId(extension.extensionId, contribution.label),
        label: contribution.label,
        uiTheme: contribution.uiTheme,
        path: contribution.path,
        extensionId: extension.extensionId,
        extensionVersion: extension.extensionVersion,
        files: extension.files,
      };
      if (byId.has(descriptor.id)) {
        onWarning({
          extensionId: descriptor.extensionId,
          extensionVersion: descriptor.extensionVersion,
          themeId: descriptor.id,
          themeLabel: descriptor.label,
          path: descriptor.path,
          error: new Error(`Duplicate bundled VSCode theme id: ${descriptor.id}`),
        });
        continue;
      }
      list.push(descriptor);
      byId.set(descriptor.id, descriptor);
    }
  }

  return { list, byId };
};

const warnBundledThemeResolutionFailure = (warning: BundledThemeResolveWarning) => {
  const key = [
    warning.extensionId,
    warning.themeId ?? 'extension',
    warning.path ?? 'manifest',
  ].join('::');
  if (warnedBundledThemeFailures.has(key)) {
    return;
  }
  warnedBundledThemeFailures.add(key);

  console.warn('[vscode-theme] Failed to resolve bundled theme', {
    extensionId: warning.extensionId,
    extensionVersion: warning.extensionVersion,
    themeId: warning.themeId,
    themeLabel: warning.themeLabel,
    path: warning.path,
    error: warning.error,
  });
};

const createBundledThemeId = (extensionId: string, label: string): string =>
  `${extensionId}.${slugifyThemeLabel(label)}`;

const slugifyThemeLabel = (label: string): string =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
