import type { RenderOptions } from 'beautiful-mermaid';
import type { MermaidConfig } from 'mermaid';

import type { ResolvedTheme } from '../../theme-provider';

const MERMAID_FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const MERMAID_BASE_CONFIG = {
  fontFamily: MERMAID_FONT_FAMILY,
  securityLevel: 'strict',
  startOnLoad: false,
  suppressErrorRendering: true,
  theme: 'base',
} satisfies MermaidConfig;

const MERMAID_LIGHT_THEME_VARIABLES = {
  background: '#ffffff',
  mainBkg: '#f8fafc',
  secondaryColor: '#eef6ff',
  tertiaryColor: '#f1f5f9',
  primaryColor: '#eef6ff',
  primaryBorderColor: '#60a5fa',
  primaryTextColor: '#0f172a',
  secondaryTextColor: '#0f172a',
  tertiaryTextColor: '#0f172a',
  lineColor: '#64748b',
  textColor: '#0f172a',
  titleColor: '#0f172a',
  defaultLinkColor: '#64748b',
  edgeLabelBackground: '#ffffff',
  nodeBorder: '#60a5fa',
  clusterBkg: '#f8fafc',
  clusterBorder: '#cbd5e1',
  actorBkg: '#f8fafc',
  actorBorder: '#60a5fa',
  actorTextColor: '#0f172a',
  signalColor: '#64748b',
  signalTextColor: '#0f172a',
  labelBoxBkgColor: '#ffffff',
  labelBoxBorderColor: '#cbd5e1',
  labelTextColor: '#0f172a',
  loopTextColor: '#0f172a',
  noteBkgColor: '#fffbeb',
  noteTextColor: '#78350f',
  noteBorderColor: '#f59e0b',
  activationBkgColor: '#dbeafe',
  activationBorderColor: '#60a5fa',
  sequenceNumberColor: '#475569',
};

// Dark diagram text stays under the app's dark brightness ceiling (text no
// lighter than ~13:1 against the canvas, see `vscode-theme-css.ts`); Mermaid
// takes literal colors, so these cannot read the theme variables.
const MERMAID_DARK_THEME_VARIABLES = {
  background: '#0b1120',
  mainBkg: '#111827',
  secondaryColor: '#172033',
  tertiaryColor: '#1e293b',
  primaryColor: '#172033',
  primaryBorderColor: '#60a5fa',
  primaryTextColor: '#d0d5dc',
  secondaryTextColor: '#d0d5dc',
  tertiaryTextColor: '#d0d5dc',
  lineColor: '#cbd5e1',
  textColor: '#cbd5e1',
  titleColor: '#d0d5dc',
  defaultLinkColor: '#cbd5e1',
  edgeLabelBackground: '#0b1120',
  nodeBorder: '#60a5fa',
  clusterBkg: '#0f172a',
  clusterBorder: '#475569',
  actorBkg: '#111827',
  actorBorder: '#60a5fa',
  actorTextColor: '#d0d5dc',
  signalColor: '#cbd5e1',
  signalTextColor: '#d0d5dc',
  labelBoxBkgColor: '#111827',
  labelBoxBorderColor: '#475569',
  labelTextColor: '#d0d5dc',
  loopTextColor: '#d0d5dc',
  noteBkgColor: '#422006',
  noteTextColor: '#dfd3b5',
  noteBorderColor: '#f59e0b',
  activationBkgColor: '#1e3a5f',
  activationBorderColor: '#60a5fa',
  sequenceNumberColor: '#cbd5e1',
};

export const createMarkdownMermaidConfig = (theme: ResolvedTheme): MermaidConfig => ({
  ...MERMAID_BASE_CONFIG,
  darkMode: theme === 'dark',
  themeVariables:
    theme === 'dark' ? { ...MERMAID_DARK_THEME_VARIABLES } : { ...MERMAID_LIGHT_THEME_VARIABLES },
});

const mermaidConfigToRenderOptions = (config: MermaidConfig): RenderOptions => {
  const themeVariables = config.themeVariables ?? {};
  return {
    bg: themeVariables.background,
    fg: themeVariables.textColor,
    line: themeVariables.lineColor,
    accent: themeVariables.primaryBorderColor,
    muted: themeVariables.sequenceNumberColor,
    surface: themeVariables.mainBkg,
    border: themeVariables.nodeBorder,
    font: typeof config.fontFamily === 'string' ? config.fontFamily : MERMAID_FONT_FAMILY,
    transparent: false,
  };
};

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const FALLBACK_MAX_LINES = 12;
const FALLBACK_MAX_LINE_LENGTH = 88;
const FALLBACK_FONT_SIZE = 12;
const FALLBACK_LINE_HEIGHT = 18;
const FALLBACK_PADDING = 12;
// Monospace advance width is ~0.6em; close enough for sizing a source listing.
const FALLBACK_CHAR_WIDTH = FALLBACK_FONT_SIZE * 0.6;

// When the runtime cannot load (old browser) or the source uses a diagram type
// beautiful-mermaid does not support, show the mermaid source as a plain code
// block instead of an error panel: the source is the most useful thing left to
// display, and staying SVG keeps the block's copy/download controls working.
const renderMermaidLoadFallback = (source: string, options: RenderOptions): string => {
  const allLines = source.split('\n');
  const lines = allLines
    .slice(0, FALLBACK_MAX_LINES)
    .map((line) =>
      line.length > FALLBACK_MAX_LINE_LENGTH ? `${line.slice(0, FALLBACK_MAX_LINE_LENGTH)}…` : line
    );
  const truncated = allLines.length > FALLBACK_MAX_LINES;
  const longest = Math.max(1, ...lines.map((line) => line.length));
  const width = Math.ceil(FALLBACK_PADDING * 2 + longest * FALLBACK_CHAR_WIDTH);
  const height = FALLBACK_PADDING * 2 + (lines.length + (truncated ? 1 : 0)) * FALLBACK_LINE_HEIGHT;
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="${FALLBACK_PADDING}" dy="${index === 0 ? 0 : FALLBACK_LINE_HEIGHT}">${
          escapeXml(line) || ' '
        }</tspan>`
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="${options.surface ?? options.bg ?? '#f8fafc'}" rx="6" />
<text x="${FALLBACK_PADDING}" y="${FALLBACK_PADDING + FALLBACK_FONT_SIZE}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${FALLBACK_FONT_SIZE}" fill="${options.fg ?? '#0f172a'}">${tspans}${
    truncated ? `<tspan x="${FALLBACK_PADDING}" dy="${FALLBACK_LINE_HEIGHT}">…</tspan>` : ''
  }</text>
</svg>`;
};

type BeautifulMermaidRuntime = typeof import('beautiful-mermaid');

let runtimePromise: Promise<BeautifulMermaidRuntime> | null = null;
let runtimeUnavailable = false;

const loadRuntime = async (): Promise<BeautifulMermaidRuntime | null> => {
  if (runtimeUnavailable) return null;
  runtimePromise ??= import('beautiful-mermaid');
  try {
    return await runtimePromise;
  } catch (error) {
    runtimeUnavailable = true;
    runtimePromise = null;
    console.warn('[Lody] Mermaid runtime failed to load; falling back to static text.', error);
    return null;
  }
};

export const renderMarkdownMermaidSvg = async (
  source: string,
  theme: ResolvedTheme
): Promise<string> => {
  const options = mermaidConfigToRenderOptions(createMarkdownMermaidConfig(theme));
  const runtime = await loadRuntime();
  if (!runtime) {
    return renderMermaidLoadFallback(source, options);
  }
  try {
    return await runtime.renderMermaidSVGAsync(source, options);
  } catch (error) {
    console.warn('[Lody] Mermaid render failed; using fallback.', error);
    return renderMermaidLoadFallback(source, options);
  }
};
