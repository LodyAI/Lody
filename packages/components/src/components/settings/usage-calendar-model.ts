import * as THREE from 'three';
import lodySvg from '@/assets/lody.svg?raw';
import {
  USAGE_CALENDAR_CELLS,
  USAGE_CALENDAR_COLUMNS,
  USAGE_CALENDAR_ROWS,
} from './usage-calendar-geometry';

// The grid dimensions live in usage-calendar-geometry so the loading skeleton
// can share them without pulling three.js. Re-export keeps existing imports
// of this module working.
export { USAGE_CALENDAR_CELLS, USAGE_CALENDAR_COLUMNS, USAGE_CALENDAR_ROWS };
export const USAGE_SKYLINE_STL_CELL_SIZE = 2.5;
export const USAGE_SKYLINE_STL_BASE_HEIGHT = 10;
export const USAGE_SKYLINE_STL_COLUMN_HEIGHT_MULTIPLIER = 4;
export const USAGE_SKYLINE_STL_FRONT_MARGIN = USAGE_SKYLINE_STL_CELL_SIZE;
export const USAGE_SKYLINE_STL_BACK_MARGIN = USAGE_SKYLINE_STL_CELL_SIZE;
export const USAGE_SKYLINE_STL_LOGO_HEIGHT = 7;
export const USAGE_SKYLINE_STL_LOGO_RELIEF_HEIGHT = 0.8;
export const USAGE_SKYLINE_STL_BASE_WIDTH =
  USAGE_CALENDAR_COLUMNS * USAGE_SKYLINE_STL_CELL_SIZE + USAGE_SKYLINE_STL_CELL_SIZE * 2;
export const USAGE_SKYLINE_STL_BASE_DEPTH =
  USAGE_SKYLINE_STL_FRONT_MARGIN +
  USAGE_CALENDAR_ROWS * USAGE_SKYLINE_STL_CELL_SIZE +
  USAGE_SKYLINE_STL_BACK_MARGIN;

export type UsageCalendarMetric = 'tokens' | 'costUSD';

export type UsageCalendarDay = {
  dayStartMs: number;
  date: string;
  tokens: number;
  costUSD: number;
  isFuture: boolean;
};

export type UsageCalendarData = {
  startMs: number;
  endMs: number;
  days: UsageCalendarDay[];
};

export type UsageCalendarCell = UsageCalendarDay & {
  column: number;
  row: number;
  value: number;
  level: 0 | 1 | 2 | 3 | 4;
};

export type UsageCalendarModel = {
  cells: UsageCalendarCell[];
  weeks: UsageCalendarCell[][];
  maxValue: number;
  totalValue: number;
  activeDays: number;
  longestStreak: number;
  currentStreak: number;
};

export type UsageSkylineViewport = {
  /** Horizontal center in the skyline's world coordinates. */
  centerX: number;
  /** Number of calendar columns included by the camera framing. */
  width: number;
};

export const USAGE_SKYLINE_MIN_VIEWPORT_COLUMNS = 44;
export const USAGE_SKYLINE_ACTIVE_COLUMN_PADDING = 4;

const EMPTY_DAY: UsageCalendarDay = {
  dayStartMs: 0,
  date: '',
  tokens: 0,
  costUSD: 0,
  isFuture: false,
};

export const getUsageCalendarValue = (
  day: UsageCalendarDay,
  metric: UsageCalendarMetric
): number => (metric === 'tokens' ? day.tokens : day.costUSD);

export function getUsageCalendarLevel(value: number, maxValue: number): UsageCalendarCell['level'] {
  if (!Number.isFinite(value) || value <= 0 || maxValue <= 0) return 0;
  const normalized = value / maxValue;
  if (normalized <= 0.25) return 1;
  if (normalized <= 0.5) return 2;
  if (normalized <= 0.75) return 3;
  return 4;
}

/** Lowest intensity an active day may render at, so a quiet day stays visible. */
export const USAGE_HEAT_MIN_INTENSITY = 0.12;
/**
 * Percentile that maps to full intensity. Anchoring on the absolute maximum lets a
 * single outlier day flatten every other day into the same near-invisible tint.
 */
export const USAGE_HEAT_REFERENCE_PERCENTILE = 0.9;

export type UsageHeatScale = {
  /** Value that renders at full intensity; days above it clamp to 1. */
  referenceValue: number;
  /** 0 for days without usage, otherwise a continuous ramp in [0.12, 1]. */
  intensity: (value: number) => number;
};

/**
 * Continuous, outlier-resistant intensity ramp for the flat heatmap. The discrete
 * `level` buckets stay for the skyline, ASCII, STL, and share-card renderers.
 */
export function createUsageHeatScale(
  model: UsageCalendarModel,
  percentile: number = USAGE_HEAT_REFERENCE_PERCENTILE
): UsageHeatScale {
  const activeValues = model.cells
    .filter((cell) => !cell.isFuture && cell.value > 0)
    .map((cell) => cell.value)
    .sort((a, b) => a - b);
  const percentileValue =
    activeValues.length > 0
      ? (activeValues[
          Math.min(activeValues.length - 1, Math.ceil((activeValues.length - 1) * percentile))
        ] ?? 0)
      : 0;
  const referenceValue = percentileValue > 0 ? percentileValue : model.maxValue;

  return {
    referenceValue,
    intensity: (value: number) => {
      if (!Number.isFinite(value) || value <= 0 || referenceValue <= 0) return 0;
      const normalized = Math.min(1, value / referenceValue);
      // Gamma < 1 keeps the low end distinguishable instead of crushing it to one tint.
      return USAGE_HEAT_MIN_INTENSITY + (1 - USAGE_HEAT_MIN_INTENSITY) * normalized ** 0.6;
    },
  };
}

export function getUsageColumnHeight(
  value: number,
  maxValue: number,
  scale: 'linear' | 'skyline' = 'linear'
): number {
  if (!Number.isFinite(value) || value <= 0 || maxValue <= 0) return 0.08;
  const normalized = Math.min(1, value / maxValue);
  const scaled = scale === 'skyline' ? Math.sqrt(normalized) : normalized;
  return 0.16 + scaled * 5.84;
}

function calculateStreaks(days: UsageCalendarDay[], metric: UsageCalendarMetric) {
  let longestStreak = 0;
  let currentRun = 0;
  let lastCompletedRun = 0;
  let currentStreak = 0;

  for (const day of days) {
    if (day.isFuture) continue;
    if (getUsageCalendarValue(day, metric) > 0) {
      currentRun += 1;
      longestStreak = Math.max(longestStreak, currentRun);
    } else {
      lastCompletedRun = currentRun;
      currentRun = 0;
    }
  }

  currentStreak = currentRun > 0 ? currentRun : lastCompletedRun;
  return { longestStreak, currentStreak };
}

export function createUsageCalendarModel(
  calendar: UsageCalendarData,
  metric: UsageCalendarMetric = 'tokens'
): UsageCalendarModel {
  const suppliedDays = calendar.days.slice(0, USAGE_CALENDAR_CELLS);
  const days = Array.from({ length: USAGE_CALENDAR_CELLS }, (_, index) => {
    const day = suppliedDays[index];
    if (day) return day;
    const dayStartMs = calendar.startMs + index * 24 * 60 * 60 * 1000;
    return {
      ...EMPTY_DAY,
      dayStartMs,
      date: new Date(dayStartMs).toISOString().slice(0, 10),
    };
  });
  const maxValue = days.reduce(
    (maximum, day) => Math.max(maximum, getUsageCalendarValue(day, metric)),
    0
  );
  const totalValue = days.reduce((total, day) => total + getUsageCalendarValue(day, metric), 0);
  const cells = days.map((day, index) => {
    const value = getUsageCalendarValue(day, metric);
    return {
      ...day,
      column: Math.floor(index / USAGE_CALENDAR_ROWS),
      row: index % USAGE_CALENDAR_ROWS,
      value,
      level: getUsageCalendarLevel(value, maxValue),
    };
  });
  const weeks = Array.from({ length: USAGE_CALENDAR_COLUMNS }, (_, index) =>
    cells.slice(index * USAGE_CALENDAR_ROWS, (index + 1) * USAGE_CALENDAR_ROWS)
  );
  const streaks = calculateStreaks(days, metric);

  return {
    cells,
    weeks,
    maxValue,
    totalValue,
    activeDays: cells.filter((cell) => !cell.isFuture && cell.value > 0).length,
    ...streaks,
  };
}

/**
 * Frame the useful part of a sparse skyline without changing its stable 53x7 model.
 * Empty and near-full-year ranges retain the complete calendar framing.
 */
export function getUsageSkylineViewport(model: UsageCalendarModel): UsageSkylineViewport {
  const activeColumns = model.weeks
    .map((week, column) => (week.some((cell) => !cell.isFuture && cell.value > 0) ? column : null))
    .filter((column): column is number => column !== null);

  const firstActiveColumn = activeColumns[0];
  const lastActiveColumn = activeColumns.at(-1);
  if (firstActiveColumn === undefined || lastActiveColumn === undefined) {
    return { centerX: 0, width: USAGE_CALENDAR_COLUMNS };
  }

  const activeWidth = lastActiveColumn - firstActiveColumn + 1;
  const width = Math.min(
    USAGE_CALENDAR_COLUMNS,
    Math.max(
      USAGE_SKYLINE_MIN_VIEWPORT_COLUMNS,
      activeWidth + USAGE_SKYLINE_ACTIVE_COLUMN_PADDING * 2
    )
  );

  if (width === USAGE_CALENDAR_COLUMNS) {
    return { centerX: 0, width };
  }

  return {
    centerX: (firstActiveColumn + lastActiveColumn) / 2 - (USAGE_CALENDAR_COLUMNS - 1) / 2,
    width,
  };
}

const ASCII_FOUNDATION_BLOCKS = ['░', '▒', '▓'] as const;
const ASCII_TOP_BLOCKS = ['╻', '┃', '╽'] as const;

function getAsciiIntensity(value: number, maxValue: number): 0 | 1 | 2 {
  const normalized = maxValue > 0 ? value / maxValue : 0;
  if (normalized < 0.33) return 0;
  if (normalized < 0.66) return 1;
  return 2;
}

/** Create the weekly stacked skyline used by the reference CLI's terminal preview. */
export function createUsageSkylineAscii(model: UsageCalendarModel): string {
  // This deliberately mirrors gh-skyline: active days fill each week from the
  // foundation upwards, then zero-value and future days occupy the remaining space.
  const grid = Array.from({ length: USAGE_CALENDAR_ROWS }, () =>
    Array.from({ length: USAGE_CALENDAR_COLUMNS }, () => ' ')
  );

  for (const [column, week] of model.weeks.entries()) {
    const active = week.filter((cell) => !cell.isFuture && cell.value > 0);
    const empty = week.filter((cell) => !cell.isFuture && cell.value <= 0);
    const future = week.filter((cell) => cell.isFuture);
    const stackedWeek = [...active, ...empty, ...future];

    for (const [stackIndex, cell] of stackedWeek.entries()) {
      if (stackIndex >= USAGE_CALENDAR_ROWS) continue;
      if (cell.isFuture) {
        grid[stackIndex]![column] = '.';
        continue;
      }
      if (cell.value <= 0) continue;

      const intensity = getAsciiIntensity(cell.value, model.maxValue);
      const isPeak = active.length > 1 && stackIndex === active.length - 1;
      grid[stackIndex]![column] = isPeak
        ? ASCII_TOP_BLOCKS[intensity]
        : ASCII_FOUNDATION_BLOCKS[intensity];
    }
  }

  return grid
    .slice()
    .reverse()
    .map((row) => row.join(''))
    .join('\n');
}

export type UsageSkylineStlTriangle = {
  normal: [number, number, number];
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
};

type Triangle = UsageSkylineStlTriangle;

function appendBox(
  triangles: Triangle[],
  x: number,
  y: number,
  z: number,
  width: number,
  depth: number,
  height: number
) {
  const x2 = x + width;
  const y2 = y + depth;
  const z2 = z + height;
  const vertices: Array<[number, number, number]> = [
    [x, y, z],
    [x2, y, z],
    [x2, y2, z],
    [x, y2, z],
    [x, y, z2],
    [x2, y, z2],
    [x2, y2, z2],
    [x, y2, z2],
  ];
  const faces: Array<[Triangle['normal'], number, number, number, number]> = [
    [[0, -1, 0], 0, 1, 5, 4],
    [[0, 1, 0], 3, 7, 6, 2],
    [[-1, 0, 0], 0, 4, 7, 3],
    [[1, 0, 0], 1, 2, 6, 5],
    [[0, 0, 1], 4, 5, 6, 7],
    [[0, 0, -1], 0, 3, 2, 1],
  ];
  for (const [normal, a, b, c, d] of faces) {
    triangles.push({ normal, a: vertices[a]!, b: vertices[b]!, c: vertices[c]! });
    triangles.push({ normal, a: vertices[a]!, b: vertices[c]!, c: vertices[d]! });
  }
}

type Point = [number, number];

const LOGO_VIEWBOX_HEIGHT = 626;
const LOGO_CURVE_SEGMENTS = 8;

function cubicPoint(
  start: Point,
  controlA: Point,
  controlB: Point,
  end: Point,
  progress: number
): Point {
  const inverse = 1 - progress;
  return [
    inverse ** 3 * start[0] +
      3 * inverse ** 2 * progress * controlA[0] +
      3 * inverse * progress ** 2 * controlB[0] +
      progress ** 3 * end[0],
    inverse ** 3 * start[1] +
      3 * inverse ** 2 * progress * controlA[1] +
      3 * inverse * progress ** 2 * controlB[1] +
      progress ** 3 * end[1],
  ];
}

/** Parse the command subset used by the checked-in Lody SVG into printable contours. */
export function parseLodyLogoContours(): Point[][] {
  const path = lodySvg.match(/\bd="([^"]+)"/u)?.[1];
  if (!path) throw new Error('Lody SVG path is unavailable');

  const tokens = path.match(/[MLCVZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/giu) ?? [];
  const contours: Point[][] = [];
  let contour: Point[] = [];
  let cursor: Point = [0, 0];
  let command = '';
  let tokenIndex = 0;

  const value = () => Number(tokens[tokenIndex++]);
  const point = (): Point => [value(), value()];

  while (tokenIndex < tokens.length) {
    if (/^[MLCVZ]$/iu.test(tokens[tokenIndex]!)) command = tokens[tokenIndex++]!.toUpperCase();

    if (command === 'M') {
      if (contour.length > 0) contours.push(contour);
      cursor = point();
      contour = [cursor];
      command = 'L';
      continue;
    }

    if (command === 'L') {
      cursor = point();
      contour.push(cursor);
      continue;
    }

    if (command === 'V') {
      cursor = [cursor[0], value()];
      contour.push(cursor);
      continue;
    }

    if (command === 'C') {
      const controlA = point();
      const controlB = point();
      const end = point();
      for (let segment = 1; segment <= LOGO_CURVE_SEGMENTS; segment += 1) {
        contour.push(cubicPoint(cursor, controlA, controlB, end, segment / LOGO_CURVE_SEGMENTS));
      }
      cursor = end;
      continue;
    }

    if (command === 'Z') {
      if (contour.length > 0) contours.push(contour);
      contour = [];
      command = '';
      continue;
    }

    throw new Error(`Unsupported Lody SVG command: ${command}`);
  }

  if (contour.length > 0) contours.push(contour);
  return contours;
}

function triangleNormal(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number]
): [number, number, number] {
  const ab: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const normal: [number, number, number] = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const length = Math.hypot(...normal) || 1;
  return [normal[0] / length, normal[1] / length, normal[2] / length];
}

function appendTriangle(
  triangles: Triangle[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number]
) {
  triangles.push({ normal: triangleNormal(a, b, c), a, b, c });
}

function appendTriangleFacing(
  triangles: Triangle[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  direction: [number, number, number]
) {
  const normal = triangleNormal(a, b, c);
  const facesDirection =
    normal[0] * direction[0] + normal[1] * direction[1] + normal[2] * direction[2] >= 0;
  if (facesDirection) {
    appendTriangle(triangles, a, b, c);
  } else {
    appendTriangle(triangles, a, c, b);
  }
}

function appendLodyLogoRelief(triangles: Triangle[]) {
  const scale = USAGE_SKYLINE_STL_LOGO_HEIGHT / LOGO_VIEWBOX_HEIGHT;
  const left = USAGE_SKYLINE_STL_BASE_WIDTH * 0.03;
  const top = -USAGE_SKYLINE_STL_BASE_HEIGHT * 0.15;

  for (const contour of parseLodyLogoContours()) {
    const points = contour.map(([x, y]): Point => [left + x * scale, top - y * scale]);
    const shape = points.map(([x, z]) => new THREE.Vector2(x, z));
    const faces = THREE.ShapeUtils.triangulateShape(shape, []);
    const signedArea = THREE.ShapeUtils.area(shape);

    for (const [aIndex, bIndex, cIndex] of faces) {
      const a = points[aIndex]!;
      const b = points[bIndex]!;
      const c = points[cIndex]!;
      const frontA: [number, number, number] = [a[0], -USAGE_SKYLINE_STL_LOGO_RELIEF_HEIGHT, a[1]];
      const frontB: [number, number, number] = [b[0], -USAGE_SKYLINE_STL_LOGO_RELIEF_HEIGHT, b[1]];
      const frontC: [number, number, number] = [c[0], -USAGE_SKYLINE_STL_LOGO_RELIEF_HEIGHT, c[1]];
      const backA: [number, number, number] = [a[0], 0, a[1]];
      const backB: [number, number, number] = [b[0], 0, b[1]];
      const backC: [number, number, number] = [c[0], 0, c[1]];
      appendTriangleFacing(triangles, frontA, frontB, frontC, [0, -1, 0]);
      appendTriangleFacing(triangles, backA, backB, backC, [0, 1, 0]);
    }

    for (let index = 0; index < points.length; index += 1) {
      const current = points[index]!;
      const next = points[(index + 1) % points.length]!;
      const frontCurrent: [number, number, number] = [
        current[0],
        -USAGE_SKYLINE_STL_LOGO_RELIEF_HEIGHT,
        current[1],
      ];
      const frontNext: [number, number, number] = [
        next[0],
        -USAGE_SKYLINE_STL_LOGO_RELIEF_HEIGHT,
        next[1],
      ];
      const backCurrent: [number, number, number] = [current[0], 0, current[1]];
      const backNext: [number, number, number] = [next[0], 0, next[1]];
      const outward: [number, number, number] =
        signedArea >= 0
          ? [next[1] - current[1], 0, current[0] - next[0]]
          : [current[1] - next[1], 0, next[0] - current[0]];
      appendTriangleFacing(triangles, frontCurrent, frontNext, backNext, outward);
      appendTriangleFacing(triangles, frontCurrent, backNext, backCurrent, outward);
    }
  }
}

const LODY_WORDMARK_GLYPHS = {
  L: ['100', '100', '100', '100', '100', '100', '111'],
  O: ['111', '101', '101', '101', '101', '101', '111'],
  D: ['110', '101', '101', '101', '101', '101', '110'],
  Y: ['101', '101', '101', '010', '010', '010', '010'],
} as const;

function appendLodyWordmarkRelief(triangles: Triangle[]) {
  const cellSize = 0.68;
  const glyphGap = 0.42;
  const left = USAGE_SKYLINE_STL_BASE_WIDTH * 0.1;
  const top = -USAGE_SKYLINE_STL_BASE_HEIGHT * 0.24;
  let glyphLeft = left;

  for (const glyph of 'LODY') {
    const rows = LODY_WORDMARK_GLYPHS[glyph as keyof typeof LODY_WORDMARK_GLYPHS];
    for (const [row, pattern] of rows.entries()) {
      for (const [column, filled] of pattern.split('').entries()) {
        if (filled !== '1') continue;
        appendBox(
          triangles,
          glyphLeft + column * cellSize,
          -USAGE_SKYLINE_STL_LOGO_RELIEF_HEIGHT,
          top - (row + 1) * cellSize,
          cellSize,
          USAGE_SKYLINE_STL_LOGO_RELIEF_HEIGHT,
          cellSize
        );
      }
    }
    glyphLeft += rows[0].length * cellSize + glyphGap;
  }
}

export function createUsageSkylineLodyLogoTriangles(): UsageSkylineStlTriangle[] {
  const triangles: UsageSkylineStlTriangle[] = [];
  appendLodyLogoRelief(triangles);
  appendLodyWordmarkRelief(triangles);
  return triangles;
}

/** Create a binary STL with an 80-byte header, triangle count, and little-endian triangle data. */
export function createUsageSkylineBinaryStl(model: UsageCalendarModel): ArrayBuffer {
  const triangles: Triangle[] = [];
  appendBox(
    triangles,
    0,
    0,
    -USAGE_SKYLINE_STL_BASE_HEIGHT,
    USAGE_SKYLINE_STL_BASE_WIDTH,
    USAGE_SKYLINE_STL_BASE_DEPTH,
    USAGE_SKYLINE_STL_BASE_HEIGHT
  );
  for (const cell of model.cells) {
    if (cell.isFuture || cell.value <= 0) continue;
    appendBox(
      triangles,
      USAGE_SKYLINE_STL_CELL_SIZE + cell.column * USAGE_SKYLINE_STL_CELL_SIZE,
      USAGE_SKYLINE_STL_BACK_MARGIN + cell.row * USAGE_SKYLINE_STL_CELL_SIZE,
      0,
      USAGE_SKYLINE_STL_CELL_SIZE,
      USAGE_SKYLINE_STL_CELL_SIZE,
      getUsageColumnHeight(cell.value, model.maxValue, 'skyline') *
        USAGE_SKYLINE_STL_COLUMN_HEIGHT_MULTIPLIER
    );
  }
  appendLodyLogoRelief(triangles);
  appendLodyWordmarkRelief(triangles);

  const output = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(output);
  const header = new TextEncoder().encode('Lody usage skyline binary STL');
  new Uint8Array(output, 0, header.length).set(header);
  view.setUint32(80, triangles.length, true);
  let offset = 84;
  for (const triangle of triangles) {
    for (const vector of [triangle.normal, triangle.a, triangle.b, triangle.c]) {
      for (const value of vector) {
        view.setFloat32(offset, value, true);
        offset += 4;
      }
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return output;
}
