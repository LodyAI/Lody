import type { ClientPluginRegistry, PluginThemeTokens } from '@lody/plugin-sdk/client';
import type { PluginManifest } from '@lody/shared/plugins/manifest-schema';
import { resolveVSCodeThemeSync } from '../lib/vscode-theme/vscode-theme-loader';
import type { LodyResolvedVSCodeTheme } from '../lib/vscode-theme/vscode-theme-schemas';
import type { VerifiedBundle } from './bundle-cache';
import { pluginSafeMode } from './safe-mode';

type Palette = { theme: LodyResolvedVSCodeTheme; tokens?: PluginThemeTokens };
type Theme = NonNullable<PluginManifest['themes']>[number];
const listeners = new Set<() => void>();
const palettes = new Map<string, Palette>();
let selected: Palette | undefined;
export const getActivePluginPalette = () => selected;
export function subscribePluginPalette(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function select(value?: Palette) {
  if (value === selected) return;
  selected = value;
  for (const fn of listeners) fn();
}
export const resetPluginPalette = () => select();
type Key = { workspaceId: string; sourceKey: string; pluginId: string };
const themeKey = (key: Key, id: string) =>
  JSON.stringify([key.workspaceId, key.sourceKey, key.pluginId, id]);
export function activatePluginTheme(key: Key, id: string) {
  const palette = palettes.get(themeKey(key, id));
  if (!palette || pluginSafeMode()) throw Error('Plugin theme unavailable');
  select(palette);
}
export function createPluginAppearance(
  key: Key,
  manifest: PluginManifest,
  files: VerifiedBundle,
  signal: AbortSignal
): Pick<ClientPluginRegistry, 'themes' | 'styles'> {
  const styles = new Map<string, HTMLStyleElement>();
  const owned = new Map<string, Palette>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const check = () => {
    signal.throwIfAborted();
    if (pluginSafeMode()) throw Error('Plugins disabled in safe mode');
  };
  signal.addEventListener(
    'abort',
    () => {
      for (const node of styles.values()) node.remove();
      for (const [id, palette] of owned) {
        if (palettes.get(id) === palette) palettes.delete(id);
        if (selected === palette) select();
      }
      owned.clear();
      styles.clear();
    },
    { once: true }
  );
  function addTheme(spec: Theme) {
    check();
    const id = themeKey(key, spec.id);
    if (owned.has(id)) throw Error('Duplicate plugin theme');
    const seed = 'seed' in spec ? spec.seed : undefined;
    const path = 'path' in spec ? spec.path : 'theme.json';
    const theme = resolveVSCodeThemeSync({
      id,
      label: spec.label,
      uiTheme: spec.appearance === 'dark' ? 'vs-dark' : 'vs',
      path,
      source: { kind: 'extension-directory', extensionId: key.pluginId },
      readFile: seed
        ? () =>
            JSON.stringify({
              colors: {
                'editor.background': seed.bg,
                'editor.foreground': seed.fg,
                foreground: seed.fg,
                'sideBar.background': seed.surface ?? seed.bg,
                'panel.background': seed.surface ?? seed.bg,
                'editorWidget.background': seed.surface ?? seed.bg,
                'button.background': seed.accent,
                focusBorder: seed.accent,
                'textLink.foreground': seed.accent,
                'panel.border': seed.border,
                descriptionForeground: seed.muted,
                'terminal.ansiGreen': seed.success,
                'editorWarning.foreground': seed.warning,
                'editorError.foreground': seed.danger,
              },
            })
        : (p) => decoder.decode(files(p)),
    });
    const palette = { theme, tokens: spec.tokens };
    owned.set(id, palette);
    palettes.set(id, palette);
  }
  function addStyle({ id, css }: { id: string; css: string }) {
    check();
    if (styles.has(id)) throw Error('Duplicate plugin stylesheet');
    const node = document.createElement('style');
    node.dataset.lodyPlugin = key.pluginId;
    document.head.appendChild(node);
    try {
      if (!node.sheet) throw Error('Plugin stylesheet unavailable');
      // insertRule accepts one rule, so a closing brace cannot inject an unlayered sibling.
      node.sheet.insertRule('@layer lody-plugin {' + css + '\n}');
      styles.set(id, node);
    } catch (error) {
      node.remove();
      throw error;
    }
  }
  for (const theme of manifest.themes ?? []) addTheme(theme);
  for (const path of manifest.styles ?? [])
    addStyle({ id: path, css: decoder.decode(files(path)) });
  return { themes: { add: addTheme }, styles: { add: addStyle } };
}
