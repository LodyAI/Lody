/**
 * The shared "sea" behind every {@link WorkingGrid}.
 *
 * One height field over the whole page, sampled by every tile at its own page
 * position, built from two scales:
 *
 * - Ripples: short waves, about one mark long, so the nine tiles of a mark always
 *   differ. Four fixed directions (down-right to down-left) swell and fade out of
 *   step, so at any moment about two interfere and the heading they share keeps
 *   turning — the same heading in every mark on the page at the same moment.
 * - Swells: long waves, several sidebar rows long and mostly downward, that lift
 *   and lower whole marks in turn, giving the list one rhythm.
 *
 * Positions are in "cells": one cell is a third of a mark's size. Time is in ms.
 * Every period divides {@link WORKING_GRID_LOOP_MS}, so the field loops seamlessly
 * and each tile's motion can be baked into one repeating keyframe animation.
 */

export const WORKING_GRID_LOOP_MS = 36_000;

/** Default multiplier on the ripple wavelengths (tile-scale texture). */
export const WORKING_GRID_WAVELENGTH = 1;

interface Ripple {
  /** Travel direction, degrees from +x towards +y (down). */
  angleDeg: number;
  /** Crest spacing in cells, before the wavelength multiplier. */
  length: number;
  periodMs: number;
  /** Period of the slow swell in this ripple's strength. */
  envelopeMs: number;
  /** Phase of that swell, in turns, so the ripples take turns dominating. */
  envelopePhase: number;
}

const RIPPLES: readonly Ripple[] = [
  { angleDeg: 20, length: 3.2, periodMs: 1_800, envelopeMs: 36_000, envelopePhase: 0 },
  { angleDeg: 70, length: 3.6, periodMs: 2_000, envelopeMs: 18_000, envelopePhase: 0.3 },
  { angleDeg: 110, length: 3.4, periodMs: 2_250, envelopeMs: 12_000, envelopePhase: 0.6 },
  { angleDeg: 160, length: 4, periodMs: 2_400, envelopeMs: 36_000, envelopePhase: 0.5 },
];

const SWELLS: readonly { angleDeg: number; length: number; periodMs: number }[] = [
  { angleDeg: 88, length: 18, periodMs: 6_000 },
  { angleDeg: 100, length: 26, periodMs: 9_000 },
];

// Share of the height carried by ripples vs swells, and how much the averaged
// ripples are stretched back to full contrast (averaging four waves flattens them).
const RIPPLE_WEIGHT = 0.6;
const RIPPLE_CONTRAST = 2;

const TAU = Math.PI * 2;
const sin01 = (turns: number) => 0.5 + 0.5 * Math.sin(TAU * turns);
const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);
const along = (angleDeg: number, x: number, y: number) => {
  const angle = (angleDeg * Math.PI) / 180;
  return Math.cos(angle) * x + Math.sin(angle) * y;
};

/** Sea height in [0, 1] at cell point (x, y) and time `tMs`. */
export function seaHeight(x: number, y: number, tMs: number, wavelength: number): number {
  let sum = 0;
  let weight = 0;
  for (const ripple of RIPPLES) {
    const height = sin01(
      along(ripple.angleDeg, x, y) / (ripple.length * wavelength) - tMs / ripple.periodMs
    );
    // Never fully silent, so the surface keeps some motion while a ripple rests.
    const strength = 0.15 + 0.85 * sin01(tMs / ripple.envelopeMs + ripple.envelopePhase) ** 2;
    sum += strength * height;
    weight += strength;
  }
  const ripples = clamp01(0.5 + RIPPLE_CONTRAST * (sum / weight - 0.5));
  let swells = 0;
  for (const swell of SWELLS) {
    swells += sin01(along(swell.angleDeg, x, y) / swell.length - tMs / swell.periodMs);
  }
  return RIPPLE_WEIGHT * ripples + (1 - RIPPLE_WEIGHT) * (swells / SWELLS.length);
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
export function seaHeightsOverLoop(
  x: number,
  y: number,
  wavelength: number,
  samples: number
): number[] {
  return Array.from({ length: samples + 1 }, (_, k) =>
    seaHeight(x, y, (k / samples) * WORKING_GRID_LOOP_MS, wavelength)
  );
}
