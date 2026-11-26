/**
 * Pure-math terrain generation for the underwater point-cloud background.
 *
 * Extracted from underwater-background.tsx so a Web Worker can compute the
 * expensive seabed attributes off the main thread (three.js must stay out of
 * this module — it is bundled into the worker chunk).
 *
 * The heavy cost is `seabedHeight` (≈19 noise octaves per sample). The old
 * inline builder sampled it 5× per point (center + 4 finite differences for
 * the lighting normal). Here the derivative/curvature samples come from one
 * shared regular height grid instead, cutting total samples to ≈2× the point
 * count. Lighting is a smooth low-frequency field, so grid-sampled normals are
 * visually indistinguishable from the per-point jittered ones.
 */

export const HALF_W = 38; // terrain half-width on X
export const Z_NEAR = 19; // closest terrain row (just in front of the camera)
export const Z_FAR = -80; // furthest terrain row (fades into fog)

// Baked top-front sun direction, pre-normalized (was a THREE.Vector3).
const LIGHT_LEN = Math.hypot(0.25, 1, 0.42);
export const LIGHT_X = 0.25 / LIGHT_LEN;
export const LIGHT_Y = 1 / LIGHT_LEN;
export const LIGHT_Z = 0.42 / LIGHT_LEN;

const HALF_PI = Math.PI / 2;

/** The subset of TuneParams that shapes terrain geometry + baked lighting. */
export type TerrainParams = {
  heightScale: number;
  baseY: number;
  wallAmp: number;
  wallRoundness: number;
  ridgeRound: number;
  channelWidth: number;
  channelOpen: number;
  heightVar: number;
  slopeVar: number;
  hillsWeight: number;
  crestsWeight: number;
  fineWeight: number;
  trenchDepth: number;
  lightDiffuse: number;
  lightAmbient: number;
  lightAO: number;
};

export function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function smoothstep01(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  const u = smooth(xf);
  const v = smooth(yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x: number, y: number, octaves = 4): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm; // 0..1
}

/**
 * Ridged multifractal. `round` (0..1) shapes the crest: 0 = a sharp creased
 * ridge ((1-|n|)^2), 1 = a smooth parabolic crest (1-n^2) whose slope is zero
 * at the top, so the ridge line reads as a soft arc instead of a knife edge.
 */
function ridged(x: number, y: number, octaves: number, round: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const raw = valueNoise(x * freq, y * freq) * 2 - 1; // -1..1
    const sharp = (1 - Math.abs(raw)) ** 2; // creased crest
    const rounded = 1 - raw * raw; // smooth parabolic crest
    sum += amp * (sharp * (1 - round) + rounded * round);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm; // 0..1
}

/** Seabed height in world units for a given (x, z). */
export function seabedHeight(x: number, z: number, P: TerrainParams): number {
  // Domain warp: push the sample coordinates around with low-freq noise so the
  // ridges flow and braid instead of sitting on a grid.
  const wx = x + 6.5 * (fbm(x * 0.03 + 2.1, z * 0.03 - 1.7, 3) - 0.5);
  const wz = z + 6.5 * (fbm(x * 0.03 - 4.3, z * 0.03 + 5.9, 3) - 0.5);

  const hills = fbm(wx * 0.04 + 11.3, wz * 0.04 + 4.7, 4); // broad dunes
  const crests = ridged(wx * 0.075 - 5.1, wz * 0.075 + 9.2, 4, P.ridgeRound); // ridges
  const fine = fbm(wx * 0.22 + 30.0, wz * 0.22 - 12.0, 3); // grain

  // Macro relief: big 2D patches of tall vs flat seabed that vary across the
  // WIDTH as well as depth (the old per-row variation looked uniform). Contrast-
  // expanded so it reaches genuine extremes, then scaled by heightVar — at the
  // max some regions become near-flat while others tower.
  const ampField = smoothstep01(0.22, 0.78, fbm(x * 0.05 + 41.0, z * 0.05 - 17.0, 3)) * 2 - 1;
  const relief = Math.max(0.1, 1 + P.heightVar * 2.4 * ampField);
  // Per-region steepness so the canyon walls don't all share one slope.
  const slopeField = fbm(x * 0.04 + 9.0, z * 0.045 + 23.0, 2) * 2 - 1;
  const slopeVar = 1 + P.slopeVar * slopeField;

  const fg = smoothstep01(-44, 16, z); // ~1 near the camera, ~0 toward the horizon
  const vhw = Math.max(1.6, (P.channelWidth + (16 - z) * P.channelOpen) * slopeVar);
  const xv = Math.min(Math.abs(x) / vhw, 1);
  // Rounded crest: a quarter-sine rises from the channel and eases to a smooth
  // plateau (tangent horizontal at the top), so the wall peak is an arc rather
  // than a hard angular shoulder. wallRoundness shapes the arc.
  const wallShape = Math.pow(Math.sin(xv * HALF_PI), P.wallRoundness);
  const walls = wallShape * P.wallAmp * (0.65 + 0.5 * fg);
  const trough = Math.exp(-((x / (vhw * 0.7)) ** 2)) * P.trenchDepth;

  const micro = hills * P.hillsWeight + crests * P.crestsWeight + fine * P.fineWeight;
  // The inner dune relief swings hard by region; the canyon walls swing gently so
  // the two-high-sides identity survives.
  const h = micro * relief + walls * (0.6 + 0.4 * Math.min(relief, 2.2)) - trough;
  return h * P.heightScale + P.baseY;
}

export type TerrainAttributes = {
  count: number;
  positions: Float32Array;
  /** Height normalized to 0..1 for the color ramp. */
  normH: Float32Array;
  rnd: Float32Array;
  light: Float32Array;
  ridge: Float32Array;
};

/** Transferable buffers of a TerrainAttributes (for zero-copy worker handoff). */
export function terrainTransferables(a: TerrainAttributes): ArrayBuffer[] {
  // These arrays are always allocated over plain ArrayBuffers above; the cast
  // only narrows the lib.dom `ArrayBufferLike` so postMessage accepts them.
  return [a.positions.buffer, a.normH.buffer, a.rnd.buffer, a.light.buffer, a.ridge.buffer].map(
    (b) => b as ArrayBuffer
  );
}

export function computeTerrainAttributes(pointBudget: number, P: TerrainParams): TerrainAttributes {
  const aspect = (2 * HALF_W) / (Z_NEAR - Z_FAR);
  const rows = Math.max(40, Math.round(Math.sqrt(pointBudget / aspect)));
  const cols = Math.max(40, Math.round(pointBudget / rows));
  const dx = (2 * HALF_W) / (cols - 1);
  const dz = (Z_NEAR - Z_FAR) / (rows - 1);

  // Shared regular height grid (one ring of padding) for normals + curvature.
  // Grid node (r, c) sits at the point's unjittered lattice position.
  const gCols = cols + 2;
  const gRows = rows + 2;
  const grid = new Float32Array(gRows * gCols);
  for (let gr = 0; gr < gRows; gr++) {
    const z = Z_NEAR - (gr - 1) * dz;
    for (let gc = 0; gc < gCols; gc++) {
      grid[gr * gCols + gc] = seabedHeight(-HALF_W + (gc - 1) * dx, z, P);
    }
  }

  const count = rows * cols;
  const positions = new Float32Array(count * 3);
  const heights = new Float32Array(count);
  const rnd = new Float32Array(count);
  const light = new Float32Array(count);
  const ridge = new Float32Array(count);

  let minH = Infinity;
  let maxH = -Infinity;
  let i = 0;
  for (let r = 0; r < rows; r++) {
    // Stagger every other row by half a cell to break the axis-aligned grid.
    const stagger = (r % 2) * dx * 0.5;
    const g = (r + 1) * gCols + 1;
    for (let c = 0; c < cols; c++) {
      const x = -HALF_W + c * dx + stagger + (hash2(c, r) - 0.5) * dx * 0.7;
      const z = Z_NEAR - r * dz + (hash2(r, c) - 0.5) * dz * 0.7;
      const y = seabedHeight(x, z, P);

      // Grid-sampled central differences for slope shading. Note the grid's row
      // axis runs toward -z, so the +row neighbor is the -z ("down") sample.
      const hC = grid[g + c];
      const hL = grid[g + c - 1];
      const hR = grid[g + c + 1];
      const hD = grid[g + c + gCols];
      const hU = grid[g + c - gCols];
      const dHdx = (hR - hL) / (2 * dx);
      const dHdz = (hU - hD) / (2 * dz);
      const nLen = Math.hypot(dHdx, 1, dHdz) || 1;
      const lambert = Math.max(0, (-dHdx * LIGHT_X + LIGHT_Y - dHdz * LIGHT_Z) / nLen);

      // Curvature: convex (ridge crest) vs concave (valley floor → AO).
      const conc = (hL + hR + hU + hD) / 4 - hC;
      const convex = smoothstep01(0, -0.5, conc); // 1 on crests
      const valley = smoothstep01(0, 0.5, conc); // 1 in basins

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      heights[i] = y;
      rnd[i] = hash2(c * 1.7, r * 2.3);
      light[i] = Math.min(1.6, P.lightAmbient + P.lightDiffuse * lambert - P.lightAO * valley);
      ridge[i] = convex;
      if (y < minH) minH = y;
      if (y > maxH) maxH = y;
      i++;
    }
  }

  // Normalize height into 0..1 for the color ramp.
  const inv = 1 / Math.max(0.0001, maxH - minH);
  const normH = new Float32Array(count);
  for (let k = 0; k < count; k++) normH[k] = (heights[k] - minH) * inv;

  return { count, positions, normH, rnd, light, ridge };
}
