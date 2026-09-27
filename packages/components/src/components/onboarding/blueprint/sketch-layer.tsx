import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { resolveAnchor } from '../tour/camera';
import { pencil, traceRegions, type SketchRect, type TracedRegion } from './sketch';

// The pencil layer over the real window.
//
// A region that is not configured yet is covered by its own paper — the colour
// the product paints there — and drawn over in pencil, traced from the real
// layout underneath. Configuring it INKS it: a hole opens in the paper from the
// control the person just used and spreads until the real, working UI shows
// through. Going back closes the hole again. The drawing is therefore the
// progress: what is still pencil is what Lody still needs.

export type BlueprintRegionState = 'sketch' | 'current' | 'ink';

export type BlueprintRegion = {
  id: string;
  /** Camera anchor naming the real node this region covers. */
  anchor: string;
  state: BlueprintRegionState;
  /** Anchor the ink spreads from; defaults to the region's own centre. */
  inkFrom?: string;
  /** Or a point in the region, as fractions of its box: where the answer landed. */
  inkAt?: { x: number; y: number };
  /**
   * Identifies what the ink shows. A new key on an already inked region (a
   * different agent landing in the chip) runs the wet edge again.
   */
  inkKey?: string;
};

type Traced = TracedRegion & { origin: { x: number; y: number } };

const INK_DURATION_MS = 1000;
const DRAW_DURATION_MS = 1500;
/** The draughtsman's construction lines: laid first, faded once the detail is in. */
const CONSTRUCT_MS = 2600;
/** Detail strokes wait for the construction lines to be laid. */
const DETAIL_DELAY_MS = 450;
/** The ink front is feathered; the hole grows past the corner by this factor so the feather clears it. */
const FEATHER = 0.8;

const styles = stylex.create({
  layer: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    zIndex: 5,
  },
  svg: { position: 'absolute', inset: 0, overflow: 'visible' },
  stroke: {
    fill: 'none',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    transitionProperty: 'stroke, opacity',
    transitionDuration: '420ms',
  },
  pencil: { stroke: colors.label, opacity: 0.5 },
  pencilCurrent: { stroke: colors.accent, opacity: 0.95 },
  faint: { opacity: 0.22 },
  construct: { fill: 'none', stroke: colors.accent, strokeLinecap: 'round' },
  ring: { fill: 'none', stroke: colors.accent, strokeWidth: 1.5 },
});

const DRAW_CSS = `
@keyframes lody-blueprint-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes lody-blueprint-construct {
  0% { stroke-dashoffset: 1; opacity: .55; }
  22% { stroke-dashoffset: 0; opacity: .55; }
  70% { opacity: .55; }
  100% { stroke-dashoffset: 0; opacity: 0; }
}
@keyframes lody-blueprint-ring {
  from { r: 0px; opacity: .9; }
  60% { opacity: .55; }
  to { r: var(--ring-r); opacity: 0; }
}
.lody-blueprint-draw path[data-pencil] {
  stroke-dasharray: 1 1;
  animation: lody-blueprint-draw 620ms cubic-bezier(.4,0,.2,1) both;
}
.lody-blueprint-construct {
  stroke-dasharray: 1 1;
  animation: lody-blueprint-construct ${CONSTRUCT_MS}ms cubic-bezier(.4,0,.2,1) both;
}
.lody-blueprint-ring { animation: lody-blueprint-ring ${INK_DURATION_MS}ms cubic-bezier(.3,0,.1,1) forwards; }
@media (prefers-reduced-motion: reduce) {
  .lody-blueprint-draw path[data-pencil], .lody-blueprint-construct, .lody-blueprint-ring { animation: none; opacity: 0; }
  .lody-blueprint-draw path[data-pencil] { opacity: 1; }
  .lody-blueprint-ink { transition: none !important; }
}
`;

/** A region's outline as four ruled lines running past its corners, as a draughtsman lays them. */
function constructionLines(rect: SketchRect): string {
  const run = 16;
  const { x, y, w, h } = rect;
  const f = (value: number): string => value.toFixed(1);
  return [
    `M${f(x - run)} ${f(y)}H${f(x + w + run)}`,
    `M${f(x - run)} ${f(y + h)}H${f(x + w + run)}`,
    `M${f(x)} ${f(y - run)}V${f(y + h + run)}`,
    `M${f(x + w)} ${f(y - run)}V${f(y + h + run)}`,
  ].join('');
}

function farthestCorner(origin: { x: number; y: number }, rect: SketchRect): number {
  const xs = [rect.x, rect.x + rect.w];
  const ys = [rect.y, rect.y + rect.h];
  let max = 0;
  for (const x of xs)
    for (const y of ys) max = Math.max(max, Math.hypot(x - origin.x, y - origin.y));
  return max + 2;
}

export function SketchLayer({
  regions,
  drawOn = false,
  retraceKey,
}: {
  /** Innermost first: a region nested in another must precede it. */
  regions: readonly BlueprintRegion[];
  /** Draw the strokes on in reading order the first time they appear. */
  drawOn?: boolean;
  /** Changing it retraces, for layout changes the observers cannot see. */
  retraceKey?: string;
}): React.JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null);
  const [traced, setTraced] = useState<Traced[] | null>(null);
  const [drawing, setDrawing] = useState(drawOn);
  const id = useId().replace(/:/gu, '');
  const regionsRef = useRef(regions);
  regionsRef.current = regions;
  const anchorsKey = regions
    .map((region) => `${region.id}:${region.anchor}:${region.inkFrom ?? ''}`)
    .join('|');

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const content = layer?.parentElement;
    if (!layer || !content) return undefined;
    let frame = 0;
    let timer = 0;

    const trace = (): void => {
      const resolved = regionsRef.current.flatMap((region) => {
        const element = resolveAnchor(content, region.anchor);
        return element ? [{ id: region.id, element, region }] : [];
      });
      const origin = content.getBoundingClientRect();
      const scale = origin.width / content.offsetWidth || 1;
      const product = resolveAnchor(content, 'window');
      const ground = product ? getComputedStyle(product).backgroundColor : 'rgb(255, 255, 255)';
      // Paper stays inside the window's own border, so a region reaching the
      // window edge cannot hide that edge while an inked neighbour shows it.
      const productRect = product?.getBoundingClientRect();
      const inner = productRect
        ? {
            x: (productRect.left - origin.left) / scale + 1,
            y: (productRect.top - origin.top) / scale + 1,
            w: productRect.width / scale - 2,
            h: productRect.height / scale - 2,
          }
        : null;
      const clip = (rect: SketchRect): SketchRect => {
        if (!inner) return rect;
        const x = Math.max(rect.x, inner.x);
        const y = Math.max(rect.y, inner.y);
        return {
          x,
          y,
          w: Math.max(0, Math.min(rect.x + rect.w, inner.x + inner.w) - x),
          h: Math.max(0, Math.min(rect.y + rect.h, inner.y + inner.h) - y),
        };
      };
      const next = traceRegions(content, resolved).map((region, index) => {
        const from = resolved[index]!.region.inkFrom;
        // One paper for the whole drawing: a tinted surface (the sidebar) is
        // drawn, not painted, and its tint arrives with the ink.
        const paper = ground;
        const fromElement = from ? resolveAnchor(content, from) : null;
        const fromRect = fromElement?.getBoundingClientRect();
        return {
          ...region,
          rect: clip(region.rect),
          paper,
          origin: fromRect
            ? {
                x: (fromRect.left + fromRect.width / 2 - origin.left) / scale,
                y: (fromRect.top + fromRect.height / 2 - origin.top) / scale,
              }
            : {
                x: region.rect.x + region.rect.w * (resolved[index]!.region.inkAt?.x ?? 0.5),
                y: region.rect.y + region.rect.h * (resolved[index]!.region.inkAt?.y ?? 0.5),
              },
        };
      });
      setTraced(next);
    };

    const schedule = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(trace);
      }, 120);
    };

    // Two frames: the product's first layout pass and its fonts settle first.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(trace);
    });
    const product = resolveAnchor(content, 'window');
    const mutations = new MutationObserver(schedule);
    if (product) {
      mutations.observe(product, { childList: true, subtree: true, characterData: true });
    }
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (product) resize?.observe(product);
    void document.fonts?.ready.then(schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      mutations.disconnect();
      resize?.disconnect();
    };
  }, [anchorsKey, retraceKey]);

  useEffect(() => {
    if (!drawing || !traced) return undefined;
    const timer = window.setTimeout(() => setDrawing(false), CONSTRUCT_MS + 200);
    return () => window.clearTimeout(timer);
  }, [drawing, traced]);

  const stateById = useMemo(
    () => new Map(regions.map((region) => [region.id, region.state])),
    [regions]
  );
  const inkKeyById = useMemo(
    () => new Map(regions.map((region) => [region.id, region.inkKey ?? ''])),
    [regions]
  );

  // Outermost first, so an inner region's paper and pencil land on top.
  const painted = traced ? [...traced].reverse() : [];
  const sweep = traced?.reduce<SketchRect | null>((acc, region) => {
    if (!acc) return region.rect;
    const x = Math.min(acc.x, region.rect.x);
    const y = Math.min(acc.y, region.rect.y);
    return {
      x,
      y,
      w: Math.max(acc.x + acc.w, region.rect.x + region.rect.w) - x,
      h: Math.max(acc.y + acc.h, region.rect.y + region.rect.h) - y,
    };
  }, null);

  return (
    <div ref={layerRef} aria-hidden {...stylex.props(styles.layer)}>
      <style>{DRAW_CSS}</style>
      {traced && sweep ? (
        <svg
          width="100%"
          height="100%"
          {...stylex.props(styles.svg)}
          className={`${stylex.props(styles.svg).className ?? ''} ${drawing ? 'lody-blueprint-draw' : ''}`}
        >
          <defs>
            {/* A developing front, not a hard wipe: solid ink inside, feathered
                over its last fifth. */}
            <radialGradient id={`${id}-feather`}>
              <stop offset="0" stopColor="black" />
              <stop offset={FEATHER} stopColor="black" />
              <stop offset="1" stopColor="white" />
            </radialGradient>
            {traced.map((region) => (
              <clipPath key={region.id} id={`${id}-clip-${region.id}`}>
                <rect
                  x={region.rect.x}
                  y={region.rect.y}
                  width={region.rect.w}
                  height={region.rect.h}
                />
              </clipPath>
            ))}
            <mask
              id={`${id}-ink`}
              maskUnits="userSpaceOnUse"
              x="-50"
              y="-50"
              width="4000"
              height="4000"
            >
              <rect x="-50" y="-50" width="4000" height="4000" fill="white" />
              {traced.map((region) => {
                const inked = stateById.get(region.id) === 'ink';
                return (
                  <g key={region.id} clipPath={`url(#${id}-clip-${region.id})`}>
                    <circle
                      className="lody-blueprint-ink"
                      cx={region.origin.x}
                      cy={region.origin.y}
                      fill={`url(#${id}-feather)`}
                      style={{
                        r: inked ? farthestCorner(region.origin, region.rect) / FEATHER : 0,
                        transition: `r ${INK_DURATION_MS}ms cubic-bezier(.3,0,.1,1)`,
                      }}
                    />
                  </g>
                );
              })}
            </mask>
          </defs>
          <g mask={`url(#${id}-ink)`}>
            {painted.map((region) => {
              const state = stateById.get(region.id) ?? 'sketch';
              const current = state === 'current';
              return (
                <g key={region.id}>
                  <rect
                    x={region.rect.x}
                    y={region.rect.y}
                    width={region.rect.w}
                    height={region.rect.h}
                    fill={region.paper}
                  />
                  {drawing && region.rect.w > 120 && region.rect.h > 30 ? (
                    <path
                      className="lody-blueprint-construct"
                      d={constructionLines(region.rect)}
                      pathLength={1}
                      vectorEffect="non-scaling-stroke"
                      strokeWidth={1}
                      {...stylex.props(styles.construct)}
                    />
                  ) : null}
                  {pencil(region, sweep).map((line, index) => (
                    <path
                      key={index}
                      data-pencil=""
                      d={line.d}
                      pathLength={1}
                      vectorEffect="non-scaling-stroke"
                      strokeWidth={line.weight}
                      {...stylex.props(
                        styles.stroke,
                        current ? styles.pencilCurrent : styles.pencil,
                        line.faint && styles.faint
                      )}
                      style={
                        drawing
                          ? {
                              animationDelay: `${Math.round(DETAIL_DELAY_MS + line.order * DRAW_DURATION_MS)}ms`,
                            }
                          : undefined
                      }
                    />
                  ))}
                </g>
              );
            })}
          </g>
          {/* The wet edge: one accent ring riding the ink front, then gone. */}
          {traced.map((region) =>
            stateById.get(region.id) === 'ink' ? (
              <g
                key={`ring-${region.id}-${inkKeyById.get(region.id)}`}
                clipPath={`url(#${id}-clip-${region.id})`}
              >
                <circle
                  className="lody-blueprint-ring"
                  cx={region.origin.x}
                  cy={region.origin.y}
                  vectorEffect="non-scaling-stroke"
                  {...stylex.props(styles.ring)}
                  style={
                    {
                      '--ring-r': `${farthestCorner(region.origin, region.rect) * 0.92}px`,
                    } as React.CSSProperties
                  }
                />
              </g>
            ) : null
          )}
        </svg>
      ) : null}
    </div>
  );
}
