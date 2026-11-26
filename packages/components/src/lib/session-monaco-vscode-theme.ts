import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type {
  LodyResolvedVSCodeTheme,
  TextMateTokenColorRule,
} from './vscode-theme/vscode-theme-schemas';

// Bridges `LodyResolvedVSCodeTheme` (VSCode workbench colors + TextMate
// token rules) to Monaco's `IStandaloneThemeData`. Without this, the
// session Monaco viewer falls back to `vs` / `vs-dark`, ignoring the
// user's selected VSCode color theme even though the diff side already
// honors it. We register each resolved theme exactly once and reuse the
// registered name on subsequent calls.

const registeredMonacoThemeNames = new Set<string>();

export function getMonacoThemeNameForVSCodeTheme(theme: LodyResolvedVSCodeTheme): string {
  return `lody-vscode-monaco-${theme.id}`;
}

export function isVSCodeThemeRegisteredForMonaco(name: string): boolean {
  return registeredMonacoThemeNames.has(name);
}

export function registerMonacoThemeFromVSCodeTheme(
  theme: LodyResolvedVSCodeTheme,
  name: string = getMonacoThemeNameForVSCodeTheme(theme)
): string | undefined {
  if (registeredMonacoThemeNames.has(name)) {
    return name;
  }
  try {
    monaco.editor.defineTheme(name, toMonacoThemeData(theme));
    registeredMonacoThemeNames.add(name);
    return name;
  } catch (error) {
    // `defineTheme` rejects unknown workbench color keys or malformed
    // hex values. Theme registration is non-critical: surface a warning
    // and let the viewer fall back to `vs` / `vs-dark`.
    console.warn('[session-monaco] Failed to register VSCode theme for Monaco', error);
    return undefined;
  }
}

export function toMonacoThemeData(
  theme: LodyResolvedVSCodeTheme
): monaco.editor.IStandaloneThemeData {
  return {
    base: vscodeTypeToMonacoBase(theme.type),
    inherit: true,
    rules: theme.tokenColors.flatMap(toMonacoRules),
    colors: normalizeWorkbenchColors(theme.colors),
  };
}

function vscodeTypeToMonacoBase(type: LodyResolvedVSCodeTheme['type']): monaco.editor.BuiltinTheme {
  switch (type) {
    case 'light':
      return 'vs';
    case 'dark':
      return 'vs-dark';
    case 'hcLight':
      return 'hc-light';
    case 'hcDark':
      return 'hc-black';
  }
  return assertNever(type);
}

function toMonacoRules(rule: TextMateTokenColorRule): monaco.editor.ITokenThemeRule[] {
  if (rule.scope === undefined) return [];
  const scopes = Array.isArray(rule.scope) ? rule.scope : splitScopeString(rule.scope);
  const fg = rule.settings.foreground
    ? stripHash(normalizeHex(rule.settings.foreground))
    : undefined;
  const bg = rule.settings.background
    ? stripHash(normalizeHex(rule.settings.background))
    : undefined;
  const fontStyle = rule.settings.fontStyle?.trim();
  return scopes
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0)
    .map((token) => ({
      token,
      ...(fg ? { foreground: fg } : {}),
      ...(bg ? { background: bg } : {}),
      ...(fontStyle ? { fontStyle } : {}),
    }));
}

// VSCode TextMate scopes can also be expressed as a comma-separated string
// (e.g. `"comment, string"`). Split on commas/whitespace so each scope
// becomes its own Monaco rule.
function splitScopeString(scope: string): string[] {
  return scope.split(/[\s,]+/g);
}

function normalizeWorkbenchColors(colors: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(colors)) {
    result[key] = normalizeHex(value);
  }
  return result;
}

// Monaco workbench colors only accept 6 (#RRGGBB) or 8 (#RRGGBBAA) hex
// digits. The VSCode schema also tolerates 3- and 4-digit shorthand, so
// expand them before handing off.
function normalizeHex(value: string): string {
  if (!value.startsWith('#')) return value;
  const hex = value.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    return (
      '#' +
      hex
        .split('')
        .map((c) => c + c)
        .join('')
    );
  }
  return value;
}

function stripHash(value: string): string {
  return value.startsWith('#') ? value.slice(1) : value;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled VSCode theme type: ${String(value)}`);
}
