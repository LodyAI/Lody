/**
 * FabricRecipe: an editable, physically-structured description of a woven
 * fabric (fibre → yarn → weave → finish), from which shader inputs are
 * derived at runtime. See Sadeghi et al. microcylinder cloth BRDF and the
 * CGF'25 surface weave model for the background.
 */

export type WeavePatternName =
  | 'plain'
  | 'twill-2-2'
  | 'twill-3-1'
  | 'satin-5'
  | 'hopsack-2-2'
  | 'herringbone'
  | 'birdseye'
  | 'custom';

export interface FabricRecipe {
  fiber: {
    /** 0 = woollen (short, random fibres) .. 1 = worsted (combed, parallel). */
    alignment: number;
    /** Fibre-level colour blend (mélange/heather), applied before spinning. */
    melangeColors: [string, string];
    /** 0..1 amount of mélange mixing into the yarn colour. */
    melange: number;
  };
  yarn: {
    /** 0..1 twist level; controls fibre helix angle around the yarn axis. */
    twist: number;
    twistDirection: 'S' | 'Z';
    /** Yarn half-width in cell units (0..0.5); < 0.5 leaves open gaps. */
    radiusWarp: number;
    radiusWeft: number;
    /** 1-D thickness irregularity along each yarn (slubs). */
    slub: number;
    /** Stray surface fibres per yarn. */
    hairiness: number;
    /** Per-yarn reflectance variation (dye lot). */
    yarnVariation: number;
  };
  weave: {
    pattern: WeavePatternName;
    /** Binary interlacing matrix, rows = weft picks, cols = warp ends; 1 = warp on top. Used when pattern is 'custom'. */
    matrix?: number[][];
    /** Display density: CSS px per thread. */
    threadPx: number;
    /** Yarn undulation over/under crossings (weave crimp), 0..1. */
    crimp: number;
    /** Cross-section flattening at crossings, 0..1. */
    flatten: number;
    /** Yarn-dyed colour sequences (hex). Length-1 = solid. */
    warpColors: string[];
    weftColors: string[];
  };
  finish: {
    /** Fulling/milling: closes gaps, thickens, hides the weave. 0..1 */
    milling: number;
    /** Raising/napping: pulls out fibres, blurs pattern, boosts fuzz. 0..1 */
    raising: number;
    /** Pressing/decatising: flattens yarns, sharpens coherent lustre. 0..1 */
    pressing: number;
  };
}

export interface WeaveMatrixData {
  cols: number;
  rows: number;
  /** RGBA per cell: r = warp-on-top bit, g = tangent-flip bit (herringbone). */
  data: Uint8Array;
  /** Fraction of intersections with warp on top. */
  warpCover: number;
}

function matrixFromFn(
  cols: number,
  rows: number,
  bit: (i: number, j: number) => number,
  flip: (i: number) => number = () => 0
): WeaveMatrixData {
  const data = new Uint8Array(cols * rows * 4);
  let sum = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const b = bit(i, j) ? 1 : 0;
      sum += b;
      const o = (j * cols + i) * 4;
      data[o] = b * 255;
      data[o + 1] = flip(i) * 255;
      data[o + 3] = 255;
    }
  }
  return { cols, rows, data, warpCover: sum / (cols * rows) };
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

export function generateWeaveMatrix(
  pattern: WeavePatternName,
  custom?: number[][]
): WeaveMatrixData {
  switch (pattern) {
    case 'plain':
      return matrixFromFn(2, 2, (i, j) => (i + j) % 2);
    case 'twill-2-2':
      return matrixFromFn(4, 4, (i, j) => (mod(i - j, 4) < 2 ? 1 : 0));
    case 'twill-3-1':
      return matrixFromFn(4, 4, (i, j) => (mod(i - j, 4) < 3 ? 1 : 0));
    case 'satin-5':
      // Warp-faced 5-end satin; weft binding points scattered (counter 2).
      return matrixFromFn(5, 5, (i, j) => (mod(j, 5) === mod(i * 2, 5) ? 0 : 1));
    case 'hopsack-2-2':
      return matrixFromFn(4, 4, (i, j) => (Math.floor(i / 2) + Math.floor(j / 2)) % 2);
    case 'herringbone': {
      // 2/2 twill, diagonal mirrored every 6 ends; flip bit lets the shader
      // mirror the fibre twist direction per stripe, not just the colour.
      const K = 6;
      return matrixFromFn(
        K * 2,
        4,
        (i, j) => {
          const stripe = Math.floor(i / K) % 2;
          return stripe === 0 ? (mod(i - j, 4) < 2 ? 1 : 0) : mod(i + j, 4) < 2 ? 1 : 0;
        },
        (i) => Math.floor(i / K) % 2
      );
    }
    case 'birdseye': {
      // Pointed twill: diagonal direction reverses inside a small repeat,
      // forming diamonds with an "eye" dot.
      const K = 4;
      return matrixFromFn(K * 2, 4, (i, j) => {
        const tri = K - Math.abs(mod(i, 2 * K) - K);
        return mod(tri - j, 4) < 2 ? 1 : 0;
      });
    }
    case 'custom': {
      const m =
        custom && custom.length > 0
          ? custom
          : [
              [1, 0],
              [0, 1],
            ];
      const rows = m.length;
      const cols = m[0].length;
      return matrixFromFn(cols, rows, (i, j) => (m[j][i] ? 1 : 0));
    }
    default:
      // Unknown pattern: fall back to a plain weave so the function is total.
      return matrixFromFn(2, 2, (i, j) => (i + j) % 2);
  }
}

export function hexToLinearRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  const n = parseInt(full, 16);
  const srgb = [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
  return [srgb[0] ** 2.2, srgb[1] ** 2.2, srgb[2] ** 2.2];
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** Flat uniform values derived from a recipe; consumed by FabricSimulator. */
export interface DerivedFabricUniforms {
  weave: WeaveMatrixData;
  warpColors: [number, number, number][];
  weftColors: [number, number, number][];
  avgWarpColor: [number, number, number];
  avgWeftColor: [number, number, number];
  threadPx: number;
  crimp: number;
  radiusWarp: number;
  radiusWeft: number;
  flatten: number;
  slub: number;
  yarnVar: number;
  patternBlur: number;
  twistAngle: number;
  sigmaS: number;
  sigmaV: number;
  kd: number;
  melA: [number, number, number];
  melB: [number, number, number];
  melange: number;
  fuzz: number;
  fuzzRough: number;
  fuzzColor: [number, number, number];
}

function averageColor(colors: [number, number, number][]): [number, number, number] {
  const acc: [number, number, number] = [0, 0, 0];
  for (const c of colors) {
    acc[0] += c[0];
    acc[1] += c[1];
    acc[2] += c[2];
  }
  return [acc[0] / colors.length, acc[1] / colors.length, acc[2] / colors.length];
}

export function deriveFabricUniforms(recipe: FabricRecipe): DerivedFabricUniforms {
  const { fiber, yarn, weave, finish } = recipe;
  const warpColors = weave.warpColors.map(hexToLinearRgb);
  const weftColors = weave.weftColors.map(hexToLinearRgb);
  const avgWarpColor = averageColor(warpColors);
  const avgWeftColor = averageColor(weftColors);
  const avgAll = averageColor([avgWarpColor, avgWeftColor]);

  // Finish → geometry: milling closes gaps and hides crimp; pressing
  // flattens cross-sections; raising/milling blur the visible pattern.
  const grow = 1 + finish.milling * 0.25;
  const sigmaS = clamp(
    (0.32 - 0.22 * finish.pressing) * (1 + finish.raising * 1.2) * (1.15 - 0.3 * yarn.twist),
    0.06,
    0.8
  );
  const sigmaV = clamp((0.85 - 0.65 * fiber.alignment) * (1 + finish.raising * 0.5), 0.15, 1.2);

  return {
    weave: generateWeaveMatrix(weave.pattern, weave.matrix),
    warpColors,
    weftColors,
    avgWarpColor,
    avgWeftColor,
    threadPx: weave.threadPx,
    crimp: weave.crimp * (1 - finish.milling * 0.45) * 0.22,
    radiusWarp: Math.min(0.499, yarn.radiusWarp * grow),
    radiusWeft: Math.min(0.499, yarn.radiusWeft * grow),
    flatten: clamp(weave.flatten + finish.pressing * 0.25, 0, 0.95),
    slub: yarn.slub,
    yarnVar: yarn.yarnVariation,
    patternBlur: clamp(finish.raising * 0.9 + finish.milling * 0.55, 0, 0.95),
    twistAngle: yarn.twist * 0.55 * (yarn.twistDirection === 'S' ? -1 : 1),
    sigmaS,
    sigmaV,
    kd: 0.42 - 0.27 * fiber.alignment,
    melA: hexToLinearRgb(fiber.melangeColors[0]),
    melB: hexToLinearRgb(fiber.melangeColors[1]),
    melange: fiber.melange,
    fuzz: clamp(finish.raising * 1.3 + yarn.hairiness * 0.6 + (1 - fiber.alignment) * 0.25, 0, 2),
    fuzzRough: 0.4 + 0.45 * clamp(finish.raising + (1 - fiber.alignment) * 0.4, 0, 1),
    fuzzColor: [avgAll[0] * 0.6 + 0.4, avgAll[1] * 0.6 + 0.4, avgAll[2] * 0.6 + 0.4],
  };
}

/** Four validation recipes with deliberately distinct looks. */
export const FABRIC_PRESETS = {
  /** Clear-finished worsted 2/2 twill — the suit reference. */
  worstedTwill: {
    fiber: { alignment: 0.92, melangeColors: ['#2f3340', '#3d4353'], melange: 0.15 },
    yarn: {
      twist: 0.6,
      twistDirection: 'Z',
      radiusWarp: 0.48,
      radiusWeft: 0.48,
      slub: 0.06,
      hairiness: 0.08,
      yarnVariation: 0.1,
    },
    weave: {
      pattern: 'twill-2-2',
      threadPx: 5,
      crimp: 0.45,
      flatten: 0.55,
      warpColors: ['#2e323f'],
      weftColors: ['#292d38'],
    },
    finish: { milling: 0.1, raising: 0.05, pressing: 0.75 },
  },
  /** High-twist open hopsack — visible basket cells and pores. */
  hopsack: {
    fiber: { alignment: 0.85, melangeColors: ['#8d867a', '#6d675d'], melange: 0.2 },
    yarn: {
      twist: 0.85,
      twistDirection: 'Z',
      radiusWarp: 0.38,
      radiusWeft: 0.38,
      slub: 0.12,
      hairiness: 0.12,
      yarnVariation: 0.18,
    },
    weave: {
      pattern: 'hopsack-2-2',
      threadPx: 9,
      crimp: 0.6,
      flatten: 0.2,
      warpColors: ['#7d7668'],
      weftColors: ['#746d60'],
    },
    finish: { milling: 0.05, raising: 0.05, pressing: 0.35 },
  },
  /** Lightly raised worsted flannel — soft, blurred twill, mélange grey. */
  flannel: {
    fiber: { alignment: 0.7, melangeColors: ['#5d6370', '#31343d'], melange: 0.55 },
    yarn: {
      twist: 0.4,
      twistDirection: 'Z',
      radiusWarp: 0.47,
      radiusWeft: 0.47,
      slub: 0.15,
      hairiness: 0.35,
      yarnVariation: 0.15,
    },
    weave: {
      pattern: 'twill-2-2',
      threadPx: 6,
      crimp: 0.45,
      flatten: 0.4,
      warpColors: ['#484d59'],
      weftColors: ['#42474f'],
    },
    finish: { milling: 0.35, raising: 0.6, pressing: 0.2 },
  },
  /** Heavily milled woollen mélange tweed — hairy herringbone. */
  tweed: {
    fiber: { alignment: 0.25, melangeColors: ['#6b5a41', '#3c4435'], melange: 0.65 },
    yarn: {
      twist: 0.45,
      twistDirection: 'S',
      radiusWarp: 0.45,
      radiusWeft: 0.45,
      slub: 0.5,
      hairiness: 0.7,
      yarnVariation: 0.35,
    },
    weave: {
      pattern: 'herringbone',
      threadPx: 10,
      crimp: 0.6,
      flatten: 0.2,
      warpColors: ['#59523f'],
      weftColors: ['#4a5540'],
    },
    finish: { milling: 0.3, raising: 0.25, pressing: 0.1 },
  },
} satisfies Record<string, FabricRecipe>;

export type FabricPresetName = keyof typeof FABRIC_PRESETS;
