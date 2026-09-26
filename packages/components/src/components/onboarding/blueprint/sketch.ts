// The blueprint's drawing, traced from the real product.
//
// Nothing here is a hand-authored wireframe. Each region names a real node in
// `TourApp`; the tracer walks that node's live layout and turns every line of
// text, every control and every visible container into a pencil stroke at the
// same place. When the product's layout changes, the drawing changes with it,
// so the sketch can never show a window the product does not have.

export type SketchRect = { x: number; y: number; w: number; h: number };

export type SketchPrimitive =
  | { kind: 'text'; rect: SketchRect; size: number }
  | { kind: 'box'; rect: SketchRect; radius: number; material: 'raised' | 'well' | 'flat' }
  | { kind: 'rule'; x1: number; y1: number; x2: number; y2: number; rect: SketchRect }
  | { kind: 'glyph'; rect: SketchRect };

export type TracedRegion = {
  id: string;
  rect: SketchRect;
  /** The colour the region paints under its content: the sketch's paper. */
  paper: string;
  primitives: SketchPrimitive[];
};

const MAX_PRIMITIVES_PER_REGION = 260;

function parseAlpha(color: string): number {
  if (!color || color === 'transparent') return 0;
  const match = color.match(/rgba?\(([^)]+)\)/u);
  if (!match) return 1;
  const parts = match[1]!.split(/[\s,/]+/u).filter(Boolean);
  return parts.length >= 4 ? Number(parts[3]) : 1;
}

function toLocal(rect: DOMRect, origin: DOMRect, scale: number): SketchRect {
  return {
    x: (rect.left - origin.left) / scale,
    y: (rect.top - origin.top) / scale,
    w: rect.width / scale,
    h: rect.height / scale,
  };
}

function intersect(a: SketchRect, b: SketchRect): SketchRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (r - x < 2 || bottom - y < 2) return null;
  return { x, y, w: r - x, h: bottom - y };
}

function paperOf(element: HTMLElement): string {
  let node: HTMLElement | null = element;
  while (node) {
    const background = getComputedStyle(node).backgroundColor;
    if (parseAlpha(background) > 0.5) return background;
    node = node.parentElement;
  }
  return 'rgb(255, 255, 255)';
}

function isHidden(style: CSSStyleDeclaration): boolean {
  return style.visibility === 'hidden' || Number(style.opacity) < 0.05 || style.display === 'none';
}

/**
 * Trace the regions, innermost first: a node already drawn by an inner region
 * (the run-config chip inside the composer) is not drawn again by its parent,
 * so each region's strokes can ink independently.
 */
export function traceRegions(
  content: HTMLElement,
  regions: ReadonlyArray<{ id: string; element: HTMLElement }>
): TracedRegion[] {
  const origin = content.getBoundingClientRect();
  const scale = origin.width / content.offsetWidth || 1;
  const claimed: HTMLElement[] = [];
  const traced: TracedRegion[] = [];

  for (const { id, element } of regions) {
    const regionRect = toLocal(element.getBoundingClientRect(), origin, scale);
    const primitives: SketchPrimitive[] = [];
    const ownedByInner = (node: Node): boolean =>
      claimed.some((inner) => inner !== element && element.contains(inner) && inner.contains(node));

    const push = (primitive: SketchPrimitive): void => {
      if (primitives.length < MAX_PRIMITIVES_PER_REGION) primitives.push(primitive);
    };

    // Containers and controls first, so text lands on top of its box.
    for (const node of element.querySelectorAll<HTMLElement | SVGElement>('*')) {
      if (node instanceof SVGElement && node.tagName.toLowerCase() !== 'svg') continue;
      if (ownedByInner(node)) continue;
      const bounds = node.getBoundingClientRect();
      if (bounds.width < 5 || bounds.height < 5) continue;
      const style = getComputedStyle(node);
      if (isHidden(style)) continue;
      const local = intersect(toLocal(bounds, origin, scale), regionRect);
      if (!local) continue;
      const tag = node.tagName.toLowerCase();
      if (tag === 'svg' || tag === 'img') {
        // Icons under 14px drawn as circles read as bullet dots at a line's
        // end; only glyphs big enough to be objects (avatars, the send
        // button) get a mark.
        if (local.w >= 14 && local.w <= 40 && local.h <= 40) push({ kind: 'glyph', rect: local });
        continue;
      }
      // The region's own fill is the paper, not a box on it.
      if (local.w * local.h > regionRect.w * regionRect.h * 0.82) continue;
      const side = (name: 'Top' | 'Right' | 'Bottom' | 'Left'): boolean =>
        parseFloat(style[`border${name}Width`]) > 0 &&
        parseAlpha(style[`border${name}Color`]) > 0.15;
      const sides = {
        top: side('Top'),
        right: side('Right'),
        bottom: side('Bottom'),
        left: side('Left'),
      };
      const allSides = sides.top && sides.right && sides.bottom && sides.left;
      const parent = node.parentElement;
      // A fill is a surface only if it differs from the paper actually behind
      // it; a transparent parent says nothing about what shows through.
      const filled =
        parseAlpha(style.backgroundColor) > 0.08 &&
        (!parent || paperOf(parent) !== style.backgroundColor);
      const shadowed = style.boxShadow !== 'none' && local.h > 14;
      if (allSides || filled || shadowed) {
        // The drawing speaks the system's material: one light from above, so
        // a raised thing casts a contact line under itself and a well takes a
        // shade inside its top edge.
        const material = !shadowed ? 'flat' : style.boxShadow.includes('inset') ? 'well' : 'raised';
        push({
          kind: 'box',
          rect: local,
          radius: parseFloat(style.borderTopLeftRadius) || 0,
          material,
        });
      } else {
        // A divider is a line, not a box: draw only the edges that exist.
        const { x, y, w, h } = local;
        if (sides.top) push({ kind: 'rule', x1: x, y1: y, x2: x + w, y2: y, rect: local });
        if (sides.bottom)
          push({ kind: 'rule', x1: x, y1: y + h, x2: x + w, y2: y + h, rect: local });
        if (sides.left) push({ kind: 'rule', x1: x, y1: y, x2: x, y2: y + h, rect: local });
        if (sides.right)
          push({ kind: 'rule', x1: x + w, y1: y, x2: x + w, y2: y + h, rect: local });
      }
    }

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.textContent?.trim()) continue;
      const parent = text.parentElement;
      if (!parent || ownedByInner(text)) continue;
      const style = getComputedStyle(parent);
      if (isHidden(style) || parseAlpha(style.color) < 0.1) continue;
      range.selectNodeContents(text);
      for (const line of range.getClientRects()) {
        const local = intersect(toLocal(line, origin, scale), regionRect);
        if (!local || local.w < 3) continue;
        push({ kind: 'text', rect: local, size: parseFloat(style.fontSize) || 13 });
      }
    }
    range.detach();

    traced.push({ id, rect: regionRect, paper: paperOf(element), primitives });
    claimed.push(element);
  }
  return traced;
}

// --- Pencil -----------------------------------------------------------------

/** A small deterministic PRNG, so a redraw does not make the pencil shiver. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 10_000) / 10_000;
  };
}

function seedOf(rect: SketchRect): number {
  return Math.round(rect.x * 73 + rect.y * 131 + rect.w * 17 + rect.h * 7);
}

const f = (value: number): string => value.toFixed(1);

/**
 * A rounded rectangle in the same pencil as the traced window, for surfaces
 * drawn outside it (an agent that is not on this Mac yet, a project row not
 * chosen yet). Two passes, the second faint, like every traced box.
 */
export function pencilRect(rect: SketchRect, radius: number, seed = 1): [string, string] {
  return [box(rect, radius, random(seed)), box(rect, radius, random(seed + 7919))];
}

/** One slightly bowed stroke, the way a hand pulls a pencil across a ruler it is not using. */
function stroke(x1: number, y1: number, x2: number, y2: number, rand: () => number): string {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const bow = Math.min(1.4, length * 0.01) * (rand() - 0.5) * 2;
  const nx = -(y2 - y1) / (length || 1);
  const ny = (x2 - x1) / (length || 1);
  const jitter = (): number => (rand() - 0.5) * 0.9;
  const mx = (x1 + x2) / 2 + nx * bow;
  const my = (y1 + y2) / 2 + ny * bow;
  return `M${f(x1 + jitter())} ${f(y1 + jitter())}Q${f(mx)} ${f(my)} ${f(x2 + jitter())} ${f(y2 + jitter())}`;
}

/** A rounded box drawn in one go, its last side overshooting the start a little. */
function box(rect: SketchRect, radius: number, rand: () => number): string {
  const r = Math.max(0, Math.min(radius, rect.w / 2, rect.h / 2));
  const { x, y, w, h } = rect;
  const o = 1.6 + rand() * 1.4;
  const j = (): number => (rand() - 0.5) * 1.2;
  if (r < 2) {
    return [
      stroke(x - o * 0.4, y, x + w, y, rand),
      stroke(x + w, y - o * 0.3, x + w, y + h, rand),
      stroke(x + w, y + h, x, y + h, rand),
      stroke(x, y + h, x + j(), y - o * 0.5, rand),
    ].join('');
  }
  return (
    `M${f(x + r + j())} ${f(y + j())}` +
    `L${f(x + w - r + j())} ${f(y + j())}Q${f(x + w)} ${f(y)} ${f(x + w + j())} ${f(y + r)}` +
    `L${f(x + w + j())} ${f(y + h - r)}Q${f(x + w)} ${f(y + h)} ${f(x + w - r)} ${f(y + h + j())}` +
    `L${f(x + r)} ${f(y + h + j())}Q${f(x)} ${f(y + h)} ${f(x + j())} ${f(y + h - r)}` +
    `L${f(x + j())} ${f(y + r)}Q${f(x)} ${f(y)} ${f(x + r + o)} ${f(y + j() * 0.5)}`
  );
}

/** Text as words: runs of uneven length on the x-height, the way a hand abbreviates a sentence. */
function words(rect: SketchRect, rand: () => number): string {
  const y = rect.y + rect.h * 0.56;
  const end = rect.x + rect.w;
  let x = rect.x + 0.5;
  let path = '';
  while (x < end - 2) {
    const length = Math.min(end - x, 6 + rand() * rand() * 44);
    const dy = (rand() - 0.5) * 0.9;
    path += stroke(x, y + dy, x + length, y + dy + (rand() - 0.5) * 0.6, rand);
    x += length + 3 + rand() * 3;
  }
  return path;
}

function glyph(rect: SketchRect, rand: () => number): string {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const r = Math.max(2.5, Math.min(rect.w, rect.h) * 0.36);
  const start = rand() * Math.PI * 2;
  const points = 9;
  let path = '';
  for (let i = 0; i <= points; i += 1) {
    const angle = start + (i / points) * Math.PI * 2.15;
    const radius = r * (0.92 + rand() * 0.16);
    const px = cx + Math.cos(angle) * radius;
    const py = cy + Math.sin(angle) * radius;
    path += `${i === 0 ? 'M' : 'L'}${f(px)} ${f(py)}`;
  }
  return path;
}

export type PencilStroke = { d: string; weight: number; order: number; faint?: boolean };

/**
 * Turn traced primitives into strokes. `order` is 0..1 along a reading sweep
 * (top-left to bottom-right) and staggers the draw-on so the window appears to
 * be drawn by one hand rather than faded in. A box is drawn twice, the second
 * pass lighter and a little off, which is what makes a line read as pencil
 * rather than as a placeholder.
 */
export function pencil(region: TracedRegion, sweep: SketchRect): PencilStroke[] {
  const strokes: PencilStroke[] = [];
  for (const primitive of region.primitives) {
    const rand = random(seedOf(primitive.rect));
    const rx = (primitive.rect.x - sweep.x) / Math.max(1, sweep.w);
    const ry = (primitive.rect.y - sweep.y) / Math.max(1, sweep.h);
    const order = Math.min(1, Math.max(0, ry * 0.7 + rx * 0.3));
    // Weights are SCREEN pixels at every zoom: the drawing is a material, and
    // a material does not thicken because the camera leaned in.
    switch (primitive.kind) {
      case 'text':
        strokes.push({
          d: words(primitive.rect, rand),
          weight: primitive.size >= 15 ? 2.2 : primitive.size >= 13 ? 1.7 : 1.4,
          order,
        });
        break;
      case 'glyph':
        strokes.push({ d: glyph(primitive.rect, rand), weight: 1.4, order });
        break;
      case 'rule':
        strokes.push({
          d: stroke(primitive.x1, primitive.y1, primitive.x2, primitive.y2, rand),
          weight: 1.1,
          order,
        });
        break;
      case 'box':
        strokes.push({ d: box(primitive.rect, primitive.radius, rand), weight: 1.4, order });
        strokes.push({
          d: box(primitive.rect, primitive.radius, random(seedOf(primitive.rect) + 7919)),
          weight: 0.8,
          order: Math.min(1, order + 0.04),
          faint: true,
        });
        if (primitive.material !== 'flat' && primitive.rect.w > 24) {
          const { x, y, w, h } = primitive.rect;
          const inset = Math.min(primitive.radius, w / 4) + 2;
          const light = random(seedOf(primitive.rect) + 31);
          strokes.push({
            d:
              primitive.material === 'raised'
                ? stroke(x + inset, y + h + 2.2, x + w - inset, y + h + 2.2, light)
                : stroke(x + inset, y + 2.4, x + w - inset, y + 2.4, light),
            weight: primitive.material === 'raised' ? 1.6 : 1,
            order: Math.min(1, order + 0.06),
            faint: true,
          });
        }
        break;
    }
  }
  return strokes;
}
