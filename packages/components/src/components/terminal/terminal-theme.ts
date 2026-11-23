import type { ITheme } from '@xterm/xterm';

// Bridges the shared theme system (CSS custom properties declared in
// tailwind/index.css) into the color/font shapes xterm.js needs. xterm renders to
// canvas and cannot consume `var(--x)` directly, so we resolve the `--terminal-*`
// fields to concrete colors at runtime and re-read them whenever the theme changes.
//
// Because the active VS Code theme override writes onto the same base tokens
// (--background/--foreground/--selection) and exposes its terminal palette as
// --vscode-terminal-ansi*, reading these `--terminal-*` fields makes the terminal
// track light/dark and the selected VS Code theme with no extra wiring.

const TERMINAL_COLOR_VARS = {
  background: '--terminal-background',
  foreground: '--terminal-foreground',
  cursor: '--terminal-cursor',
  cursorAccent: '--terminal-cursor-accent',
  selectionBackground: '--terminal-selection',
  black: '--terminal-ansi-black',
  red: '--terminal-ansi-red',
  green: '--terminal-ansi-green',
  yellow: '--terminal-ansi-yellow',
  blue: '--terminal-ansi-blue',
  magenta: '--terminal-ansi-magenta',
  cyan: '--terminal-ansi-cyan',
  white: '--terminal-ansi-white',
  brightBlack: '--terminal-ansi-bright-black',
  brightRed: '--terminal-ansi-bright-red',
  brightGreen: '--terminal-ansi-bright-green',
  brightYellow: '--terminal-ansi-bright-yellow',
  brightBlue: '--terminal-ansi-bright-blue',
  brightMagenta: '--terminal-ansi-bright-magenta',
  brightCyan: '--terminal-ansi-bright-cyan',
  brightWhite: '--terminal-ansi-bright-white',
} as const satisfies Partial<Record<keyof ITheme, string>>;

// Used only if `--font-terminal` is somehow unset (it is always defined in
// tailwind/index.css); keeps xterm monospace rather than falling back to serif.
const FALLBACK_TERMINAL_FONT =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/**
 * Resolve the `--terminal-*` CSS fields (in the context of `host`, so light/dark
 * and VS Code overrides apply) into an xterm theme. Values are normalized to
 * `rgb()/rgba()` via a throwaway probe so xterm parses them regardless of whether
 * the underlying token was authored as hex, `hsl()`, or carries an alpha channel.
 */
export function buildTerminalTheme(host: HTMLElement): ITheme {
  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  // Global reduced-motion styles must not animate synchronous color reads.
  probe.style.transitionProperty = 'none';
  host.appendChild(probe);
  try {
    const theme: ITheme = {};
    for (const key of Object.keys(TERMINAL_COLOR_VARS) as Array<
      keyof typeof TERMINAL_COLOR_VARS
    >) {
      probe.style.setProperty('color', `var(${TERMINAL_COLOR_VARS[key]})`);
      const resolved = getComputedStyle(probe).color;
      if (resolved) {
        theme[key] = resolved;
      }
    }
    return theme;
  } finally {
    host.removeChild(probe);
  }
}

/** Resolve the shared `--font-terminal` stack for the xterm `fontFamily` option. */
export function readTerminalFontFamily(host: HTMLElement): string {
  const value = getComputedStyle(host).getPropertyValue('--font-terminal').trim();
  return value || FALLBACK_TERMINAL_FONT;
}

function quoteTerminalFontFamily(fontFamily: string): string {
  return `"${fontFamily.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** Add a user-selected primary font to the app's existing monospace fallback stack. */
export function resolveTerminalFontFamily(host: HTMLElement, fontFamily: string): string {
  const fallback = readTerminalFontFamily(host);
  return fontFamily ? `${quoteTerminalFontFamily(fontFamily)}, ${fallback}` : fallback;
}

/** CSS font-family value used by the lightweight terminal settings preview. */
export function buildTerminalFontPreviewFamily(fontFamily: string): string {
  return fontFamily
    ? `${quoteTerminalFontFamily(fontFamily)}, var(--font-terminal)`
    : 'var(--font-terminal)';
}

/** Font shorthand used to wait for the selected face before xterm measures its cells. */
export function buildTerminalFontLoadSpec(fontFamily: string, fontSize: number): string {
  const family = fontFamily ? quoteTerminalFontFamily(fontFamily) : "'JetBrains Mono'";
  return `${fontSize}px ${family}`;
}
