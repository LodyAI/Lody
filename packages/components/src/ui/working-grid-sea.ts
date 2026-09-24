/**
 * The shared "sea" behind every {@link WorkingGrid}, in two layers:
 *
 * - Chop: every tile wanders on its own — a few slow sines with frequencies and
 *   phases hashed from the tile's position — so a single tile looks like it bobs
 *   at random, unrelated to its neighbours.
 * - Sweeps: now and then a bright band passes across the whole page in one
 *   direction (down, or diagonally), lifting every tile it crosses. Squint at a
 *   column of marks and a wave rolls through them, top to bottom, in order.
 *
 * Positions are in "cells": one cell is a third of a mark's size. Time is in ms.
 * Every period and sweep repeats within {@link WORKING_GRID_LOOP_MS}, so the field
 * loops seamlessly and each tile's motion bakes into one repeating animation.
 */

export const WORKING_GRID_LOOP_MS = 36_000;

/** Default strength of the sweeps relative to the chop. */
export const WORKING_GRID_SWEEP = 0.55;

export interface WorkingGridSweep {
  startMs: number;
  /** Travel direction, degrees from +x towards +y (down). */
  angleDeg: number;
  durationMs: number;
}

/** Irregularly spaced, in varying directions, so they read as "now and then". */
export const WORKING_GRID_SWEEPS: readonly WorkingGridSweep[] = [
  { startMs: 1_500, angleDeg: 90, durationMs: 2_800 },
  { startMs: 8_500, angleDeg: 60, durationMs: 2_800 },
  { startMs: 15_000, angleDeg: 120, durationMs: 2_800 },
  { startMs: 21_500, angleDeg: 90, durationMs: 2_800 },
  { startMs: 28_500, angleDeg: 35, durationMs: 2_800 },
];

// A sweep is a train of bands SPACING cells apart, so it crosses any page region;
// each point is crossed once per sweep. WIDTH is the band's half-width in cells.
const SPACING = 66;
const WIDTH = 5;
const CHOP_WEIGHT = 0.75;

const TAU = Math.PI * 2;
const sin01 = (turns: number) => 0.5 + 0.5 * Math.sin(TAU * turns);
const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);
const frac = (value: number) => value - Math.floor(value);
/** Deterministic [0, 1) hash of an integer. */
const hash = (n: number) => frac(Math.sin(n * 127.1 + 311.7) * 43_758.5453);

/** A tile's own random bobbing: three sines, 9–20 cycles per loop (1.8–4s). */
function chop(x: number, y: number, tMs: number): number {
  const seed = Math.round(x * 8) * 7919 + Math.round(y * 8) * 104_729;
  let sum = 0;
  for (let m = 0; m < 3; m += 1) {
    const cycles = 9 + Math.floor(hash(seed + m * 13) * 12);
    sum += sin01((cycles * tMs) / WORKING_GRID_LOOP_MS + hash(seed + m * 29));
  }
  return sum / 3;
}

/** How strongly a passing sweep band lifts point (x, y) at `tMs`, in [0, 1]. */
export function sweepBand(x: number, y: number, tMs: number): number {
  let band = 0;
  for (const sweep of WORKING_GRID_SWEEPS) {
    const elapsed =
      (((tMs - sweep.startMs) % WORKING_GRID_LOOP_MS) + WORKING_GRID_LOOP_MS) %
      WORKING_GRID_LOOP_MS;
    if (elapsed > sweep.durationMs) continue;
    const progress = elapsed / sweep.durationMs;
    const angle = (sweep.angleDeg * Math.PI) / 180;
    const along = Math.cos(angle) * x + Math.sin(angle) * y;
    const offset =
      ((((along - SPACING * progress + SPACING / 2) % SPACING) + SPACING) % SPACING) - SPACING / 2;
    // Fade the train in and out so a sweep never pops on or off.
    const envelope = Math.sin(Math.PI * progress) ** 0.6;
    band = Math.max(band, envelope * Math.exp(-((offset / WIDTH) ** 2)));
  }
  return band;
}

/** Sea height in [0, 1] at cell point (x, y) and time `tMs`. */
export function seaHeight(x: number, y: number, tMs: number, sweep: number): number {
  return clamp01(CHOP_WEIGHT * chop(x, y, tMs) + sweep * sweepBand(x, y, tMs) - 0.05);
}

export interface WorkingGridPlacement {
  /** Grid's top-left corner in page coordinates, px. */
  left: number;
  top: number;
  /** Grid edge length, px. */
  size: number;
  /**
   * Row pitch of the list the grid sits in, px. When set, the sea between two
   * rows' marks is skipped, as if the marks were stacked edge to edge, so a wave
   * leaving the bottom of one mark enters the top of the next. `null` samples
   * the real page distance.
   */
  rowPitch: number | null;
}

/** Sea point of tile (column `i`, row `j`) of a 3×3 grid. */
export function tileSeaPoint(
  { left, top, size, rowPitch }: WorkingGridPlacement,
  i: number,
  j: number
): [number, number] {
  const cell = size / 3;
  const stitch = rowPitch != null && rowPitch > size ? size / rowPitch : 1;
  return [left / cell + i, (top / cell) * stitch + j];
}

/** Heights at a point over one loop: `samples` evenly spaced, plus the wrap-around sample. */
export function seaHeightsOverLoop(x: number, y: number, sweep: number, samples: number): number[] {
  return Array.from({ length: samples + 1 }, (_, k) =>
    seaHeight(x, y, (k / samples) * WORKING_GRID_LOOP_MS, sweep)
  );
}
