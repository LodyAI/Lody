export interface PluginEnvField {
  readonly description: string;
  readonly required?: boolean;
  readonly secret?: boolean;
}

/**
 * Minimal seed palette from which Lody's theme engine (`vscode-theme-dom.ts` / `vscode-theme-css.ts`)
 * derives app chrome, panel, diff, Monaco, Shiki, and integrated terminal color variables.
 */
export interface PluginThemeSeedColors {
  readonly bg: string;
  readonly fg: string;
  readonly accent: string;
  readonly surface?: string;
  readonly border?: string;
  readonly muted?: string;
  readonly success?: string;
  readonly warning?: string;
  readonly danger?: string;
}

/**
 * Optional non-color design tokens applied as stable root CSS variables alongside a theme's colors,
 * allowing themes to reshape typography, corner geometry, and UI density without fragile DOM selectors.
 */
export interface PluginThemeTokens {
  readonly fontSans?: string;
  readonly fontMono?: string;
  readonly radius?: string;
  readonly density?: "compact" | "comfortable" | "spacious";
}

/**
 * Theme contribution declared in `lody.plugin.json`: accepts either a full VS Code color theme
 * JSON in `assets/` (`path`) or a compact seed palette (`seed`), plus optional `tokens`.
 */
export type PluginThemeContribution = {
  readonly id: string;
  readonly label: string;
  readonly appearance: "dark" | "light";
  readonly tokens?: PluginThemeTokens;
} & (
  | { readonly path: string; readonly seed?: undefined }
  | { readonly seed: PluginThemeSeedColors; readonly path?: undefined }
);

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly sdk: "^1.0.0";
  readonly title: string;
  readonly description?: string;
  readonly client?: string;
  readonly machine?: string;
  readonly skills?: readonly string[];
  readonly themes?: readonly PluginThemeContribution[];
  /**
   * Optional host-managed CSS asset paths injected for the opting-in local client.
   * Disposed automatically on disablement/HMR and bypassed in `lody --safe-mode`.
   * Stability contract covers documented CSS variables (`--*`), not internal host DOM structure.
   */
  readonly styles?: readonly string[];
  readonly env?: Readonly<Record<string, PluginEnvField>>;
}
