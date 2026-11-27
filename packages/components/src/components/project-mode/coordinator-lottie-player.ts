const SVG_NS = 'http://www.w3.org/2000/svg';

type LottieEasingHandle = {
  x?: number | number[];
  y?: number | number[];
};

type LottieKeyframe<T> = {
  t: number;
  s?: T;
  e?: T;
  h?: number;
  i?: LottieEasingHandle;
  o?: LottieEasingHandle;
};

type LottieAnimatedProp<T> = {
  a?: 0 | 1;
  k: T | LottieKeyframe<T>[];
};

type LottiePathValue = {
  v: number[][];
  i: number[][];
  o: number[][];
  c?: boolean;
};

type LottieTransformShape = {
  ty: 'tr';
  hd?: boolean;
  p?: LottieAnimatedProp<number[]>;
  a?: LottieAnimatedProp<number[]>;
  s?: LottieAnimatedProp<number[]>;
  r?: LottieAnimatedProp<number | number[]>;
  o?: LottieAnimatedProp<number | number[]>;
};

type LottiePathShape = {
  ty: 'sh';
  hd?: boolean;
  ks: LottieAnimatedProp<LottiePathValue>;
};

type LottieEllipseShape = {
  ty: 'el';
  hd?: boolean;
  p: LottieAnimatedProp<number[]>;
  s: LottieAnimatedProp<number[]>;
};

type LottieFillShape = {
  ty: 'fl';
  hd?: boolean;
  c: LottieAnimatedProp<number[]>;
  o?: LottieAnimatedProp<number | number[]>;
  r?: number;
};

type LottieGradientFillShape = {
  ty: 'gf';
  hd?: boolean;
  t?: number;
  o?: LottieAnimatedProp<number | number[]>;
  s: LottieAnimatedProp<number[]>;
  e: LottieAnimatedProp<number[]>;
  r?: number;
  g: {
    p: number;
    k: LottieAnimatedProp<number[]>;
  };
};

type LottieStrokeShape = {
  ty: 'st';
  hd?: boolean;
  c: LottieAnimatedProp<number[]>;
  w: LottieAnimatedProp<number | number[]>;
  o?: LottieAnimatedProp<number | number[]>;
  lc?: number;
  lj?: number;
};

type LottieGroupShape = {
  ty: 'gr';
  hd?: boolean;
  nm?: string;
  it: LottieShapeItem[];
};

type LottieShapeItem =
  | LottieGroupShape
  | LottiePathShape
  | LottieEllipseShape
  | LottieFillShape
  | LottieGradientFillShape
  | LottieStrokeShape
  | LottieTransformShape
  | { ty: string; hd?: boolean };

type LottieShapeLayer = {
  ty: number;
  hd?: boolean;
  ip?: number;
  op?: number;
  ks?: Omit<LottieTransformShape, 'ty'>;
  shapes?: LottieShapeItem[];
};

export type CoordinatorLottieData = {
  v?: string;
  fr: number;
  ip: number;
  op: number;
  w: number;
  h: number;
  layers: LottieShapeLayer[];
};

export type MountCoordinatorLottieOptions = {
  container: HTMLElement;
  data: CoordinatorLottieData;
  size?: number;
  onComplete?: () => void;
  now?: () => number;
  requestFrame?: (cb: (timestamp: number) => void) => number;
  cancelFrame?: (id: number) => void;
};

let nextGradientScopeId = 0;

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

const readHandleCoord = (coord: number | number[] | undefined, fallback: number): number => {
  if (typeof coord === 'number' && Number.isFinite(coord)) return coord;
  if (Array.isArray(coord) && typeof coord[0] === 'number' && Number.isFinite(coord[0])) {
    return coord[0];
  }
  return fallback;
};

const sampleBezierCoord = (a1: number, a2: number, t: number): number => {
  const inv = 1 - t;
  return 3 * inv * inv * t * a1 + 3 * inv * t * t * a2 + t * t * t;
};

const sampleBezierDerivative = (a1: number, a2: number, t: number): number => {
  const inv = 1 - t;
  return 3 * inv * inv * a1 + 6 * inv * t * (a2 - a1) + 3 * t * t * (1 - a2);
};

function solveCubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x1 === y1 && x2 === y2) return x;
  let guess = x;
  for (let iter = 0; iter < 6; iter += 1) {
    const slope = sampleBezierDerivative(x1, x2, guess);
    if (Math.abs(slope) < 1e-6) break;
    const currentX = sampleBezierCoord(x1, x2, guess) - x;
    guess = clamp01(guess - currentX / slope);
  }
  return sampleBezierCoord(y1, y2, guess);
}

const toNumber = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && typeof value[0] === 'number' && Number.isFinite(value[0])) {
    return value[0];
  }
  return fallback;
};

const toVec = (value: unknown, fallback: readonly number[]): number[] => {
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'number')) {
    return value;
  }
  return [...fallback];
};

function evalScalar(
  prop: LottieAnimatedProp<number | number[]> | undefined,
  frame: number,
  fallback: number
): number {
  if (!prop) return fallback;
  if (prop.a !== 1 || !Array.isArray(prop.k) || typeof prop.k[0] === 'number') {
    return toNumber(prop.k, fallback);
  }
  const keyframes = prop.k as LottieKeyframe<number | number[]>[];
  if (keyframes.length === 0) return fallback;
  const first = keyframes[0]!;
  if (frame <= first.t) return toNumber(first.s, fallback);
  for (let i = 0; i < keyframes.length - 1; i += 1) {
    const cur = keyframes[i]!;
    const next = keyframes[i + 1]!;
    if (frame < next.t) {
      const startVal = toNumber(cur.s, fallback);
      if (cur.h === 1) return startVal;
      const endVal = toNumber(cur.e ?? next.s, startVal);
      const span = next.t - cur.t;
      if (span <= 0) return startVal;
      const rawProgress = clamp01((frame - cur.t) / span);
      const eased = solveCubicBezier(
        clamp01(readHandleCoord(cur.o?.x, 0)),
        readHandleCoord(cur.o?.y, 0),
        clamp01(readHandleCoord(cur.i?.x, 1)),
        readHandleCoord(cur.i?.y, 1),
        rawProgress
      );
      return startVal + (endVal - startVal) * eased;
    }
  }
  const last = keyframes[keyframes.length - 1]!;
  const prev = keyframes.length >= 2 ? keyframes[keyframes.length - 2] : undefined;
  return toNumber(last.s ?? prev?.e, fallback);
}

function evalVector(
  prop: LottieAnimatedProp<number[]> | undefined,
  frame: number,
  fallback: readonly number[]
): number[] {
  if (!prop) return [...fallback];
  if (prop.a !== 1 || !Array.isArray(prop.k) || typeof prop.k[0] === 'number') {
    return toVec(prop.k, fallback);
  }
  const keyframes = prop.k as LottieKeyframe<number[]>[];
  if (keyframes.length === 0) return [...fallback];
  const first = keyframes[0]!;
  if (frame <= first.t) return toVec(first.s, fallback);
  for (let i = 0; i < keyframes.length - 1; i += 1) {
    const cur = keyframes[i]!;
    const next = keyframes[i + 1]!;
    if (frame < next.t) {
      const startVec = toVec(cur.s, fallback);
      if (cur.h === 1) return startVec;
      const endVec = toVec(cur.e ?? next.s, startVec);
      const span = next.t - cur.t;
      if (span <= 0) return startVec;
      const rawProgress = clamp01((frame - cur.t) / span);
      const eased = solveCubicBezier(
        clamp01(readHandleCoord(cur.o?.x, 0)),
        readHandleCoord(cur.o?.y, 0),
        clamp01(readHandleCoord(cur.i?.x, 1)),
        readHandleCoord(cur.i?.y, 1),
        rawProgress
      );
      const len = Math.min(startVec.length, endVec.length);
      const result: number[] = [];
      for (let d = 0; d < len; d += 1) {
        result.push(startVec[d]! + (endVec[d]! - startVec[d]!) * eased);
      }
      return result;
    }
  }
  const last = keyframes[keyframes.length - 1]!;
  const prev = keyframes.length >= 2 ? keyframes[keyframes.length - 2] : undefined;
  return toVec(last.s ?? prev?.e, fallback);
}

const formatNumber = (n: number): string => {
  const rounded = Math.round(n * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

function buildBezierPathD(path: LottiePathValue): string {
  const { v, i, o, c } = path;
  if (!v || v.length === 0) return '';
  const parts: string[] = [`M ${formatNumber(v[0]![0]!)} ${formatNumber(v[0]![1]!)}`];
  const segmentCount = c ? v.length : v.length - 1;
  for (let idx = 0; idx < segmentCount; idx += 1) {
    const nextIdx = (idx + 1) % v.length;
    const p0 = v[idx]!;
    const p1 = v[nextIdx]!;
    const outTan = o[idx] ?? [0, 0];
    const inTan = i[nextIdx] ?? [0, 0];
    if (
      outTan[0] === 0 &&
      outTan[1] === 0 &&
      inTan[0] === 0 &&
      inTan[1] === 0
    ) {
      parts.push(`L ${formatNumber(p1[0]!)} ${formatNumber(p1[1]!)}`);
    } else {
      const c1x = p0[0]! + outTan[0]!;
      const c1y = p0[1]! + outTan[1]!;
      const c2x = p1[0]! + inTan[0]!;
      const c2y = p1[1]! + inTan[1]!;
      parts.push(
        `C ${formatNumber(c1x)} ${formatNumber(c1y)}, ${formatNumber(c2x)} ${formatNumber(c2y)}, ${formatNumber(p1[0]!)} ${formatNumber(p1[1]!)}`
      );
    }
  }
  if (c) {
    parts.push('Z');
  }
  return parts.join(' ');
}

const toRgbCss = (color: readonly number[]): string => {
  const r = Math.round(clamp01(color[0] ?? 0) * 255);
  const g = Math.round(clamp01(color[1] ?? 0) * 255);
  const b = Math.round(clamp01(color[2] ?? 0) * 255);
  return `rgb(${r}, ${g}, ${b})`;
};

const lineCapName = (lc: number | undefined): string => {
  if (lc === 2) return 'round';
  if (lc === 3) return 'square';
  return 'butt';
};

const lineJoinName = (lj: number | undefined): string => {
  if (lj === 2) return 'round';
  if (lj === 3) return 'bevel';
  return 'miter';
};

function computeTransformAttr(
  tr: Omit<LottieTransformShape, 'ty'> | undefined,
  frame: number
): { transform: string | null; opacity: string | null } {
  if (!tr) return { transform: null, opacity: null };
  const pos = evalVector(tr.p, frame, [0, 0]);
  const anchor = evalVector(tr.a, frame, [0, 0]);
  const scale = evalVector(tr.s, frame, [100, 100]);
  const rot = evalScalar(tr.r, frame, 0);
  const opacity = evalScalar(tr.o, frame, 100);

  const px = pos[0] ?? 0;
  const py = pos[1] ?? 0;
  const ax = anchor[0] ?? 0;
  const ay = anchor[1] ?? 0;
  const sx = (scale[0] ?? 100) / 100;
  const sy = (scale[1] ?? 100) / 100;

  const ops: string[] = [];
  if (px !== 0 || py !== 0) {
    ops.push(`translate(${formatNumber(px)}, ${formatNumber(py)})`);
  }
  if (rot !== 0) {
    ops.push(`rotate(${formatNumber(rot)})`);
  }
  if (sx !== 1 || sy !== 1) {
    ops.push(`scale(${formatNumber(sx)}, ${formatNumber(sy)})`);
  }
  if (ax !== 0 || ay !== 0) {
    ops.push(`translate(${formatNumber(-ax)}, ${formatNumber(-ay)})`);
  }

  return {
    transform: ops.length > 0 ? ops.join(' ') : null,
    opacity: opacity < 100 ? formatNumber(clamp01(opacity / 100)) : null,
  };
}

/**
 * Mount and play a pure-vector Lottie animation once inside `container`,
 * invoking `onComplete` as soon as the final frame `op` is reached.
 */
export function mountCoordinatorLottieOnce({
  container,
  data,
  size = 32,
  onComplete,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  requestFrame = (cb) => requestAnimationFrame(cb),
  cancelFrame = (id) => cancelAnimationFrame(id),
}: MountCoordinatorLottieOptions): () => void {
  const scopePrefix = `coord-av-${++nextGradientScopeId}`;
  let gradCounter = 0;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${data.w} ${data.h}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.display = 'block';
  svg.style.width = `${size}px`;
  svg.style.height = `${size}px`;

  const defs = document.createElementNS(SVG_NS, 'defs');
  svg.appendChild(defs);

  const updaters: Array<(frame: number) => void> = [];

  const registerTransformUpdater = (
    el: SVGGElement,
    tr: Omit<LottieTransformShape, 'ty'> | undefined
  ) => {
    if (!tr) return;
    const isAnimated =
      tr.p?.a === 1 || tr.a?.a === 1 || tr.s?.a === 1 || tr.r?.a === 1 || tr.o?.a === 1;
    const apply = (frame: number) => {
      const { transform, opacity } = computeTransformAttr(tr, frame);
      if (transform) el.setAttribute('transform', transform);
      else el.removeAttribute('transform');
      if (opacity) el.setAttribute('opacity', opacity);
      else el.removeAttribute('opacity');
    };
    apply(data.ip);
    if (isAnimated) {
      updaters.push(apply);
    }
  };

  const applyPaintToElement = (
    geomEl: SVGElement,
    fillItem: LottieFillShape | LottieGradientFillShape | undefined,
    strokeItem: LottieStrokeShape | undefined
  ) => {
    if (fillItem && !fillItem.hd) {
      if (fillItem.ty === 'fl') {
        const color = evalVector(fillItem.c, data.ip, [0, 0, 0]);
        const opacity = evalScalar(fillItem.o, data.ip, 100) / 100;
        geomEl.setAttribute('fill', toRgbCss(color));
        if (opacity < 1) geomEl.setAttribute('fill-opacity', formatNumber(clamp01(opacity)));
        if (fillItem.r === 2) geomEl.setAttribute('fill-rule', 'evenodd');
      } else if (fillItem.ty === 'gf') {
        const gradId = `${scopePrefix}-g-${++gradCounter}`;
        const isRadial = fillItem.t === 2;
        const gradEl = document.createElementNS(
          SVG_NS,
          isRadial ? 'radialGradient' : 'linearGradient'
        );
        gradEl.setAttribute('id', gradId);
        gradEl.setAttribute('gradientUnits', 'userSpaceOnUse');
        const startPt = evalVector(fillItem.s, data.ip, [0, 0]);
        const endPt = evalVector(fillItem.e, data.ip, [data.w, data.h]);
        if (isRadial) {
          const dx = (endPt[0] ?? 0) - (startPt[0] ?? 0);
          const dy = (endPt[1] ?? 0) - (startPt[1] ?? 0);
          gradEl.setAttribute('cx', formatNumber(startPt[0] ?? 0));
          gradEl.setAttribute('cy', formatNumber(startPt[1] ?? 0));
          gradEl.setAttribute('r', formatNumber(Math.hypot(dx, dy)));
        } else {
          gradEl.setAttribute('x1', formatNumber(startPt[0] ?? 0));
          gradEl.setAttribute('y1', formatNumber(startPt[1] ?? 0));
          gradEl.setAttribute('x2', formatNumber(endPt[0] ?? 0));
          gradEl.setAttribute('y2', formatNumber(endPt[1] ?? 0));
        }
        const rawStops = evalVector(fillItem.g.k, data.ip, []);
        const colorStopCount = fillItem.g.p;
        for (let sIdx = 0; sIdx < colorStopCount; sIdx += 1) {
          const base = sIdx * 4;
          if (base + 3 >= rawStops.length) break;
          const stop = document.createElementNS(SVG_NS, 'stop');
          stop.setAttribute('offset', `${formatNumber(clamp01(rawStops[base]!) * 100)}%`);
          stop.setAttribute(
            'stop-color',
            toRgbCss([rawStops[base + 1]!, rawStops[base + 2]!, rawStops[base + 3]!])
          );
          gradEl.appendChild(stop);
        }
        defs.appendChild(gradEl);
        geomEl.setAttribute('fill', `url(#${gradId})`);
        const opacity = evalScalar(fillItem.o, data.ip, 100) / 100;
        if (opacity < 1) geomEl.setAttribute('fill-opacity', formatNumber(clamp01(opacity)));
        if (fillItem.r === 2) geomEl.setAttribute('fill-rule', 'evenodd');
      }
    } else {
      geomEl.setAttribute('fill', 'none');
    }

    if (strokeItem && !strokeItem.hd) {
      const color = evalVector(strokeItem.c, data.ip, [0, 0, 0]);
      const width = evalScalar(strokeItem.w, data.ip, 1);
      const opacity = evalScalar(strokeItem.o, data.ip, 100) / 100;
      geomEl.setAttribute('stroke', toRgbCss(color));
      geomEl.setAttribute('stroke-width', formatNumber(width));
      geomEl.setAttribute('stroke-linecap', lineCapName(strokeItem.lc));
      geomEl.setAttribute('stroke-linejoin', lineJoinName(strokeItem.lj));
      if (opacity < 1) geomEl.setAttribute('stroke-opacity', formatNumber(clamp01(opacity)));
    }
  };

  const buildShapeItems = (items: readonly LottieShapeItem[], parentEl: SVGGElement) => {
    const transformItem = items.find((item): item is LottieTransformShape => item.ty === 'tr');
    if (transformItem) {
      registerTransformUpdater(parentEl, transformItem);
    }

    const fillItem = items.find(
      (item): item is LottieFillShape | LottieGradientFillShape =>
        (item.ty === 'fl' || item.ty === 'gf') && !item.hd
    );
    const strokeItem = items.find(
      (item): item is LottieStrokeShape => item.ty === 'st' && !item.hd
    );

    for (let idx = items.length - 1; idx >= 0; idx -= 1) {
      const item = items[idx]!;
      if (item.hd) continue;
      if (item.ty === 'gr' && 'it' in item) {
        const groupEl = document.createElementNS(SVG_NS, 'g');
        buildShapeItems(item.it, groupEl);
        parentEl.appendChild(groupEl);
      } else if (item.ty === 'sh' && 'ks' in item) {
        const pathEl = document.createElementNS(SVG_NS, 'path');
        const pathVal = item.ks.k as LottiePathValue;
        pathEl.setAttribute('d', buildBezierPathD(pathVal));
        applyPaintToElement(pathEl, fillItem, strokeItem);
        parentEl.appendChild(pathEl);
      } else if (item.ty === 'el' && 'p' in item && 's' in item) {
        const ellipseEl = document.createElementNS(SVG_NS, 'ellipse');
        const applyEllipse = (frame: number) => {
          const center = evalVector(item.p, frame, [0, 0]);
          const radii = evalVector(item.s, frame, [0, 0]);
          ellipseEl.setAttribute('cx', formatNumber(center[0] ?? 0));
          ellipseEl.setAttribute('cy', formatNumber(center[1] ?? 0));
          ellipseEl.setAttribute('rx', formatNumber((radii[0] ?? 0) / 2));
          ellipseEl.setAttribute('ry', formatNumber((radii[1] ?? 0) / 2));
        };
        applyEllipse(data.ip);
        if (item.p.a === 1 || item.s.a === 1) {
          updaters.push(applyEllipse);
        }
        applyPaintToElement(ellipseEl, fillItem, strokeItem);
        parentEl.appendChild(ellipseEl);
      }
    }
  };

  for (let layerIdx = data.layers.length - 1; layerIdx >= 0; layerIdx -= 1) {
    const layer = data.layers[layerIdx]!;
    if (layer.hd || layer.ty !== 4 || !layer.shapes) continue;
    const layerGroup = document.createElementNS(SVG_NS, 'g');
    registerTransformUpdater(layerGroup, layer.ks);
    buildShapeItems(layer.shapes, layerGroup);
    svg.appendChild(layerGroup);
  }

  container.replaceChildren(svg);

  let disposed = false;
  let rafId: number | null = null;
  const startMs = now();
  const totalFrames = Math.max(1, data.op - data.ip);
  const fps = data.fr > 0 ? data.fr : 30;

  const step = (timestamp: number) => {
    if (disposed) return;
    const elapsedSec = Math.max(0, (timestamp - startMs) / 1000);
    const currentFrame = data.ip + elapsedSec * fps;
    if (currentFrame >= data.op || elapsedSec * fps >= totalFrames) {
      for (const update of updaters) {
        update(data.op);
      }
      disposed = true;
      rafId = null;
      onComplete?.();
      return;
    }
    for (const update of updaters) {
      update(currentFrame);
    }
    rafId = requestFrame(step);
  };

  rafId = requestFrame(step);

  return () => {
    disposed = true;
    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }
    if (svg.parentNode === container) {
      container.removeChild(svg);
    }
  };
}
