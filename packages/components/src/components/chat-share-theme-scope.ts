import {
  DEFAULT_VSCODE_THEME_SELECTION,
  createThemeCssVariables,
  getBundledVSCodeThemeByIdSync,
} from '@/lib/vscode-theme';

let injected = false;

const scopeRule = (selector: string, scheme: 'light' | 'dark', variables: Record<string, string>) =>
  `${selector}{color-scheme:${scheme};` +
  Object.entries(variables)
    .map(([name, value]) => `${name}:${value};`)
    .join('') +
  '}';

/**
 * Injects `.light-scope` / `.dark-scope` rules carrying the bundled Lody
 * light/dark theme variables, so a `ChatShareCard` can pin the exported
 * image's palette instead of following whatever theme the app currently has
 * applied. One-time and idempotent; if a bundled theme fails to resolve the
 * scope simply inherits the app's variables (graceful degradation).
 *
 * Pair with the `dark` custom variant in src/tailwind/index.css, which treats
 * `.dark-scope` as a dark root and lets `.light-scope` opt out of an ancestor
 * `.dark`.
 */
export function ensureChatShareThemeScopes(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;

  const sections: string[] = [];
  const lightId = DEFAULT_VSCODE_THEME_SELECTION.lightThemeId;
  const darkId = DEFAULT_VSCODE_THEME_SELECTION.darkThemeId;
  const light = lightId ? getBundledVSCodeThemeByIdSync(lightId) : undefined;
  const dark = darkId ? getBundledVSCodeThemeByIdSync(darkId) : undefined;
  if (light) {
    sections.push(scopeRule('.light-scope', 'light', createThemeCssVariables(light)));
  }
  if (dark) {
    sections.push(scopeRule('.dark-scope', 'dark', createThemeCssVariables(dark)));
  }
  if (sections.length === 0) return;

  const style = document.createElement('style');
  style.dataset.lodyChatShareThemeScopes = 'true';
  style.textContent = sections.join('\n');
  document.head.appendChild(style);
}
