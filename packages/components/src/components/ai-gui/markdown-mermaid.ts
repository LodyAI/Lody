import type { RenderOptions } from 'pele';

import type { ResolvedTheme } from '../../theme-provider';

const MERMAID_FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export interface MarkdownMermaidPalette {
  bg: string;
  fg: string;
  muted: string;
  line: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  accent: string;
}

const MERMAID_LIGHT_PALETTE: MarkdownMermaidPalette = {
  bg: '#ffffff',
  fg: '#0f172a',
  muted: '#475569',
  line: '#64748b',
  surface: '#f8fafc',
  surfaceAlt: '#f1f5f9',
  border: '#60a5fa',
  accent: '#60a5fa',
};

// Dark diagram text stays under the app's dark brightness ceiling (text no
// lighter than ~13:1 against the canvas, see `vscode-theme-css.ts`). The
// colors are written into the SVG itself rather than read from the app's
// theme variables, so a downloaded or full-screen copy keeps them.
const MERMAID_DARK_PALETTE: MarkdownMermaidPalette = {
  bg: '#0b1120',
  fg: '#cbd5e1',
  muted: '#94a3b8',
  line: '#cbd5e1',
  surface: '#111827',
  surfaceAlt: '#0f172a',
  border: '#60a5fa',
  accent: '#60a5fa',
};

export const markdownMermaidPalette = (theme: ResolvedTheme): MarkdownMermaidPalette =>
  theme === 'dark' ? MERMAID_DARK_PALETTE : MERMAID_LIGHT_PALETTE;

// Agent-written diagrams must not make the desktop fetch remote images or
// navigate, so links and images are off; a fixed size keeps the inline canvas
// and the full-screen viewer in charge of scaling.
const RENDER_OPTIONS = {
  fontFamily: MERMAID_FONT_FAMILY,
  responsive: false,
  links: false,
  images: false,
} satisfies RenderOptions;

const paletteStyle = (palette: MarkdownMermaidPalette): string =>
  [
    `--pele-bg:${palette.bg}`,
    `--pele-fg:${palette.fg}`,
    `--pele-muted:${palette.muted}`,
    `--pele-line:${palette.line}`,
    `--pele-surface:${palette.surface}`,
    `--pele-surface-alt:${palette.surfaceAlt}`,
    `--pele-border:${palette.border}`,
    `--pele-accent:${palette.accent}`,
  ].join(';');

// Pele reads its colors from `--pele-*` custom properties on any ancestor.
// Declaring them on the root `<svg>` makes the markup self-contained.
const applyPalette = (svg: string, palette: MarkdownMermaidPalette): string =>
  svg.replace(/^<svg\b[^>]*?\sstyle="/u, (match) => `${match}${paletteStyle(palette)};`);

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

// When the runtime cannot load (old browser), or Pele rejects the source (a
// syntax error, an unsupported type such as ZenUML, or a size limit), show the
// mermaid source as a plain code block instead of an error panel: the source is the most useful thing left to
// display, and staying SVG keeps the block's copy/download controls working.
const renderMermaidLoadFallback = (source: string, palette: MarkdownMermaidPalette): string => {
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
<rect width="100%" height="100%" fill="${palette.surface}" rx="6" />
<text x="${FALLBACK_PADDING}" y="${FALLBACK_PADDING + FALLBACK_FONT_SIZE}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${FALLBACK_FONT_SIZE}" fill="${palette.fg}">${tspans}${
    truncated ? `<tspan x="${FALLBACK_PADDING}" dy="${FALLBACK_LINE_HEIGHT}">…</tspan>` : ''
  }</text>
</svg>`;
};

type PeleRuntime = typeof import('pele');

let runtimePromise: Promise<PeleRuntime> | null = null;
let runtimeUnavailable = false;

const loadRuntime = async (): Promise<PeleRuntime | null> => {
  if (runtimeUnavailable) return null;
  runtimePromise ??= import('pele');
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
  const palette = markdownMermaidPalette(theme);
  const runtime = await loadRuntime();
  if (!runtime) {
    return renderMermaidLoadFallback(source, palette);
  }
  try {
    return applyPalette(runtime.render(source, RENDER_OPTIONS).svg, palette);
  } catch (error) {
    console.warn('[Lody] Mermaid render failed; using fallback.', error);
    return renderMermaidLoadFallback(source, palette);
  }
};
