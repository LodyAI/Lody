/**
 * The shared "sea" behind every {@link WorkingGrid}.
 *
 * One height field over the whole page, sampled by every tile at its own page
 * position, so all working marks on screen are windows onto the same water.
 *
 * The field is four long plane waves with fixed directions (down-right, down,
 * down-slightly-left, down-left) whose strengths swell and fade slowly and out of
 * step. At any moment roughly two dominate and interfere, and as dominance passes
 * from one to another the flow appears to turn. Waves span several sidebar rows,
 * so a crest visibly travels from one mark into the next.
 *
 * Positions are in "cells": one cell is a third of a mark's size. Time is in ms.
 * Every period divides {@link WORKING_GRID_LOOP_MS}, so the field loops seamlessly
 * and each tile's motion can be baked into one repeating keyframe animation.
 */

export const WORKING_GRID_LOOP_MS = 36_000;

/**
 * Default wavelength multiplier. Neighbouring stitched marks sit 3 cells apart;
 * the previous 3–4-cell waves put them almost in antiphase, so each mark looked
 * like it ran on its own. At 1.3 the centre tiles of adjacent rows correlate
 * ~0.7 over a loop while a whole mark still almost never sinks out of sight.
 */
export const WORKING_GRID_WAVELENGTH = 1.3;

interface SeaWave {
  /** Travel direction, degrees from +x towards +y (down). */
  angleDeg: number;
  /** Crest spacing in cells, before the wavelength multiplier. */
  length: number;
  periodMs: number;
  /** Period of the slow swell in this wave's strength. */
  envelopeMs: number;
  /** Phase of that swell, in turns, so the waves take turns dominating. */
  envelopePhase: number;
}

const WAVES: readonly SeaWave[] = [
  { angleDeg: 25, length: 14, periodMs: 3_000, envelopeMs: 36_000, envelopePhase: 0 },
  { angleDeg: 80, length: 12, periodMs: 2_400, envelopeMs: 18_000, envelopePhase: 0.25 },
  { angleDeg: 105, length: 13, periodMs: 2_250, envelopeMs: 12_000, envelopePhase: 0.55 },
  { angleDeg: 155, length: 15, periodMs: 3_600, envelopeMs: 36_000, envelopePhase: 0.5 },
];

const TAU = Math.PI * 2;
const sin01 = (turns: number) => 0.5 + 0.5 * Math.sin(TAU * turns);

/** Sea height in [0, 1] at cell point (x, y) and time `tMs`. */
export function seaHeight(x: number, y: number, tMs: number, wavelength: number): number {
  let sum = 0;
  let weight = 0;
  for (const wave of WAVES) {
    const angle = (wave.angleDeg * Math.PI) / 180;
    const along = Math.cos(angle) * x + Math.sin(angle) * y;
    const height = sin01(along / (wave.length * wavelength) - tMs / wave.periodMs);
    // Never fully silent, so the surface keeps some motion while a wave rests.
    const strength = 0.15 + 0.85 * sin01(tMs / wave.envelopeMs + wave.envelopePhase) ** 2;
    sum += strength * height;
    weight += strength;
  }
  return sum / weight;
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
