// Mermaid diagrams for the Android transcript, run in QuickJS. Pele (the renderer web uses)
// emits SVG coloured through CSS custom properties, which Android's SVG renderer does not
// resolve, so every `var()` is replaced with a concrete value: the app palette passed by the
// host first, then the diagram's own declarations and defaults.
import { render } from 'pele';

// Agent-written diagrams must not fetch images or carry links; a fixed size lets the host scale.
const OPTIONS = { fontFamily: 'sans-serif', responsive: false, links: false, images: false };
const VAR = /var\(\s*--([\w-]+)\s*(?:,\s*([^()]*?)\s*)?\)/g;
const MAX_DEPTH = 8;

const rootDeclarations = (svg) => {
  const style = /^<svg\b[^>]*?\sstyle="([^"]*)"/.exec(svg)?.[1] ?? '';
  const declarations = {};
  for (const part of style.split(';')) {
    const colon = part.indexOf(':');
    const name = part.slice(0, colon).trim();
    if (colon > 0 && name.startsWith('--')) declarations[name.slice(2)] = part.slice(colon + 1).trim();
  }
  return declarations;
};

const resolve = (value, palette, declarations, depth = 0) =>
  value.replace(VAR, (_, name, fallback) => {
    const next = palette[name] ?? declarations[name] ?? fallback ?? '';
    return depth < MAX_DEPTH && next.includes('var(') ? resolve(next, palette, declarations, depth + 1) : next;
  });

globalThis.renderMermaid = (source, palette) => {
  const svg = render(source, OPTIONS).svg;
  const declarations = rootDeclarations(svg);
  // The root style keeps only ordinary properties once its custom ones are resolved.
  const stripped = svg.replace(/^(<svg\b[^>]*?\sstyle=")([^"]*)"/, (_, head, style) =>
    `${head}${style.split(';').filter((part) => !part.trim().startsWith('--')).join(';')}"`
  );
  return resolve(stripped, palette, declarations);
};
