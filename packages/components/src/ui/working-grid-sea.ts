/**
 * The shared "sea" behind every {@link WorkingGrid}.
 *
 * Two plane waves cross over the whole page. Every tile samples them at its own
 * page position, so all working marks on screen are windows onto the same water
 * and a crest visibly travels from one sidebar row into the next.
 *
 * Positions are in "cells": one cell is a third of the grid's size (one tile
 * pitch). Phases are in turns, so `0.25` is a quarter period.
 */

export type WorkingGridDirection = 'across' | 'down';

export interface WorkingGridWave {
  /** Travel direction; roughly unit length. */
  dir: readonly [number, number];
  /** Distance between crests, in cells, before the wavelength multiplier. */
  length: number;
  periodMs: number;
  /** Constant phase offset, in turns. */
  phase: number;
}

// The first wave is shorter and faster than the second and their periods are
// 19:27, so the interference pattern takes ~51s to repeat and never reads as a loop.
const WAVES: Record<WorkingGridDirection, readonly [WorkingGridWave, WorkingGridWave]> = {
  // 27° down-right and 60° down-left of horizontal.
  across: [
    { dir: [0.9, 0.45], length: 3.2, periodMs: 1900, phase: 0 },
    { dir: [-0.5, 0.85], length: 4.4, periodMs: 2700, phase: 0.3 },
  ],
  // Within 15–20° of vertical: sweeps down a narrow list.
  down: [
    { dir: [0.34, 0.94], length: 3.2, periodMs: 1900, phase: 0 },
    { dir: [-0.26, 0.97], length: 4.4, periodMs: 2700, phase: 0.3 },
  ],
};

export function workingGridWaves(
  direction: WorkingGridDirection
): readonly [WorkingGridWave, WorkingGridWave] {
  return WAVES[direction];
}

/**
 * The rhythm: one long, slow wave heading straight down, about twelve stitched
 * sidebar rows from crest to crest. It dims and brightens whole marks in turn, so
 * a column of marks reads as one calm pulse travelling down the list while the
 * two shorter waves only texture the tiles inside each mark.
 */
export const WORKING_GRID_RHYTHM: WorkingGridWave = {
  dir: [0, 1],
  length: 36,
  periodMs: 3600,
  phase: 0,
};

const frac = (value: number) => value - Math.floor(value);

/** Phase of `wave` at sea point (x, y), in turns within [0, 1). */
export function wavePhase(wave: WorkingGridWave, x: number, y: number, wavelength: number): number {
  return frac((wave.dir[0] * x + wave.dir[1] * y) / (wave.length * wavelength) + wave.phase);
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

/**
 * Animation delay (ms, never positive) for a loop whose keyframes start at the
 * crest, such that at document-timeline time 0 it shows `phase`. With every
 * loop's start time pinned to 0, marks mounted at different moments stay on
 * the same sea.
 */
export function crestDelayMs(phase: number, periodMs: number): number {
  const turns = frac(0.25 - phase);
  return turns === 0 ? 0 : -turns * periodMs;
}
