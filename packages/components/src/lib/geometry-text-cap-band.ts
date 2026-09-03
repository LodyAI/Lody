/**
 * The ONE optical text measurement the geometry system owns.
 *
 * A text primitive's visual centre is the cap-height band of a FIXED reference
 * glyph (`H`), not the ink bounds of its own string: a label that happens to
 * carry a descender would otherwise demand a different icon offset than an
 * identical row without one. That band is measured on a canvas, and the canvas
 * font string is the only thing deciding which font gets measured — so the
 * `?geometry=1` overlay and the Playwright capture must build it here, once, or
 * they quietly disagree about the same row.
 *
 * Every function here is deliberately self-contained: capture serializes them
 * into the page with `Function.prototype.toString`, so none may close over an
 * import, a module constant, or another function in this file.
 */

export type GeometryCanvasFontStyle = Readonly<{
  fontStyle: string;
  fontWeight: string;
  fontSize: string;
  fontFamily: string;
}>;

export type GeometryCapBand = Readonly<{ ascent: number; descent: number }>;

/**
 * `font-variant` is deliberately NOT part of this string. A computed variant
 * such as `tabular-nums` is not a canvas font-variant value, and an invalid
 * font string leaves `context.font` at whatever it already was — silently
 * measuring one element's cap band with another element's font.
 *
 * Keep closure-free: capture serializes this function into the page.
 */
export function geometryCanvasFontString(style: GeometryCanvasFontStyle): string {
  return [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ');
}

/**
 * The reference glyph's cap-height band in `font`, cached per font string: the
 * answer depends only on the font, never on the element, and capture asks for
 * it once per rendered text primitive, so one canvas serves the whole page.
 *
 * `expectedFontSize` is the computed `font-size` the caller believes it asked
 * for. A canvas that refuses a font string keeps its previous value, and a
 * silent wrong-font measurement is exactly the bug this module exists to stop.
 *
 * Keep closure-free: capture serializes this function into the page.
 */
export function measureGeometryCapBand(font: string, expectedFontSize?: string): GeometryCapBand {
  const cache = globalThis as typeof globalThis & {
    __lodyGeometryCapBands?: Map<string, Readonly<{ ascent: number; descent: number }>>;
    __lodyGeometryCanvas?: HTMLCanvasElement;
  };
  cache.__lodyGeometryCapBands ??= new Map();
  const cached = cache.__lodyGeometryCapBands.get(font);
  if (cached) return cached;
  cache.__lodyGeometryCanvas ??= document.createElement('canvas');
  const context = cache.__lodyGeometryCanvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable');
  context.font = font;
  if (expectedFontSize !== undefined && !context.font.includes(expectedFontSize)) {
    throw new Error(`Canvas refused the measured font: ${font}`);
  }
  const metrics = context.measureText('H');
  const band = {
    ascent: metrics.actualBoundingBoxAscent,
    descent: metrics.actualBoundingBoxDescent,
  };
  cache.__lodyGeometryCapBands.set(font, band);
  return band;
}

/**
 * Where a cap band's centre sits relative to the line's baseline. Kept here so
 * the overlay and capture share the arithmetic as well as the measurement.
 *
 * Keep closure-free: capture serializes this function into the page.
 */
export function geometryCapBandCenter(
  baseline: number,
  band: Readonly<{ ascent: number; descent: number }>
): number {
  return baseline + (band.descent - band.ascent) / 2;
}
