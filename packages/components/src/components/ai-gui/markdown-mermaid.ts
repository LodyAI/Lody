import type { RenderOptions } from 'pele';

const MERMAID_FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

// Agent-written diagrams must not make the desktop fetch remote images or
// navigate, so links and images are off; a fixed size keeps the inline canvas
// and the full-screen viewer in charge of scaling.
const RENDER_OPTIONS = {
  fontFamily: MERMAID_FONT_FAMILY,
  responsive: false,
  links: false,
  images: false,
} satisfies RenderOptions;

// Pele colors every diagram through these custom properties. The markdown
// stylesheet maps them to the app palette's tokens on the block, so an inline
// diagram matches light or dark and switches without re-rendering. A copy that
// leaves the block (download, the full-screen viewer) must carry resolved
// values instead.
const MERMAID_COLOR_PROPERTIES = [
  '--pele-bg',
  '--pele-fg',
  '--pele-muted',
  '--pele-line',
  '--pele-surface',
  '--pele-surface-alt',
  '--pele-border',
  '--pele-accent',
  '--pele-critical',
  '--pele-error',
] as const;

export type MermaidColors = ReadonlyArray<readonly [property: string, value: string]>;

let colorProbe: CanvasRenderingContext2D | null | undefined;

// A theme token resolves to modern syntax (`hsl(220 16% 96%)`, `color-mix()`)
// that other SVG consumers may not parse. Painting one pixel normalizes any
// CSS color to plain rgb; without a canvas the value is kept as resolved.
const toPlainColor = (value: string): string => {
  if (colorProbe === undefined) {
    colorProbe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  }
  if (!colorProbe) return value;
  colorProbe.clearRect(0, 0, 1, 1);
  colorProbe.fillStyle = '#000';
  colorProbe.fillStyle = value;
  colorProbe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colorProbe.getImageData(0, 0, 1, 1).data;
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a! / 255).toFixed(3)})`;
};

/** The diagram colors in effect at `element`, as plain values. */
export const resolveMermaidColors = (element: Element): MermaidColors => {
  const computed = getComputedStyle(element);
  return MERMAID_COLOR_PROPERTIES.flatMap((property) => {
    const value = computed.getPropertyValue(property).trim();
    return value ? [[property, toPlainColor(value)] as const] : [];
  });
};

/** Declares `colors` on the root of serialized diagram markup. */
export const withMermaidColors = (svg: string, colors: MermaidColors): string => {
  if (colors.length === 0) return svg;
  const declarations = colors.map(([property, value]) => `${property}:${value}`).join(';');
  return /^<svg\b[^>]*?\sstyle="/u.test(svg)
    ? svg.replace(/^<svg\b[^>]*?\sstyle="/u, (match) => `${match}${declarations};`)
    : svg.replace(/^<svg\b/u, `<svg style="${declarations}"`);
};

/** Declares `colors` on a diagram element that is leaving its themed block. */
export const applyMermaidColors = (svg: SVGSVGElement, colors: MermaidColors): void => {
  for (const [property, value] of colors) svg.style.setProperty(property, value);
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

// When the runtime cannot load (old browser), or Pele rejects the source (a
// syntax error, an unsupported type such as ZenUML, or a size limit), show the
// mermaid source as a plain code block instead of an error panel: the source is the most useful thing left to
// display, and staying SVG keeps the block's copy/download controls working.
const renderMermaidLoadFallback = (source: string): string => {
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
<rect width="100%" height="100%" fill="var(--pele-surface, #f3f3f3)" rx="6" />
<text x="${FALLBACK_PADDING}" y="${FALLBACK_PADDING + FALLBACK_FONT_SIZE}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${FALLBACK_FONT_SIZE}" fill="var(--pele-fg, #1f1f1f)">${tspans}${
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

export const renderMarkdownMermaidSvg = async (source: string): Promise<string> => {
  const runtime = await loadRuntime();
  if (!runtime) {
    return renderMermaidLoadFallback(source);
  }
  try {
    return runtime.render(source, RENDER_OPTIONS).svg;
  } catch (error) {
    console.warn('[Lody] Mermaid render failed; using fallback.', error);
    return renderMermaidLoadFallback(source);
  }
};
