import { describe, expect, it } from 'vitest';

import {
  mineVisualDeviations,
  type VisualAtom,
} from '../src/lib/geometry-discovery/visual-repetition';

/**
 * Rows of one visual kind stacked at a fixed pitch, each placed at the left
 * edge the caller asks for. Fixtures are synthetic coordinates only; nothing
 * here reads a real capture.
 */
function stackedRows(
  lefts: readonly number[],
  options?: { kinds?: readonly string[] }
): VisualAtom[] {
  return lefts.map((left, index) => ({
    id: `row-${index}`,
    kind: options?.kinds?.[index] ?? 'image',
    xStart: left,
    xEnd: left + 24,
    yStart: 100 + index * 80,
    yEnd: 124 + index * 80,
  }));
}

function leftEdgeDeviations(atoms: readonly VisualAtom[]) {
  return mineVisualDeviations(atoms).filter(
    (deviation) => deviation.axis === 'x' && deviation.measure === 'start'
  );
}

describe('mineVisualDeviations', () => {
  it('reports the rows a series leaves off its own left edge', () => {
    // The reported shape: the run starts and ends on one edge and a block in
    // the middle sits elsewhere. Nothing declares which edge is correct; the
    // better-supported one wins by count.
    const atoms = stackedRows([100, 100, 100, 143, 143, 143, 143, 100, 100, 100]);

    const deviations = leftEdgeDeviations(atoms);

    expect(deviations.map((deviation) => deviation.atomId).sort()).toEqual([
      'row-3',
      'row-4',
      'row-5',
      'row-6',
    ]);
    expect(deviations[0]).toMatchObject({ expected: 100, value: 143, delta: 43 });
  });

  it('stays silent on a series that agrees with itself', () => {
    expect(leftEdgeDeviations(stackedRows([100, 100, 100, 100, 100, 100]))).toEqual([]);
  });

  it('does not let intermediate coordinates chain two edges into one level', () => {
    // Single linkage would walk 100 through to 126 one step at a time and call
    // the whole run a single edge, which is exactly how a real indentation
    // difference disappears. Levels grow by distance to their anchor instead.
    const atoms = stackedRows([100, 101, 102, 103, 104, 105, 106, 126]);

    const deviations = leftEdgeDeviations(atoms);

    expect(deviations.length).toBeGreaterThan(0);
    expect(deviations.map((deviation) => deviation.atomId)).toContain('row-7');
  });

  it('compares boxes that differ only by tag, because that difference is not visible', () => {
    // `link` and `button` are the same painted box. Splitting on them would
    // file two code paths into separate groups and never compare them — the
    // blindness this whole pass exists to remove.
    const atoms = stackedRows([100, 100, 100, 100, 137], {
      kinds: ['button', 'link', 'button', 'link', 'link'],
    });

    expect(leftEdgeDeviations(atoms).map((deviation) => deviation.atomId)).toEqual(['row-4']);
  });

  it('does not compare two lists that merely render alike', () => {
    // Each list agrees with itself at its own left edge. The gap between them
    // is far past the pitch inside either, so they are two series and neither
    // becomes evidence about the other.
    const first = stackedRows([100, 100, 100, 100]);
    const second = stackedRows([300, 300, 300, 300]).map((atom, index) => ({
      ...atom,
      id: `second-${index}`,
      yStart: atom.yStart + 900,
      yEnd: atom.yEnd + 900,
    }));

    expect(leftEdgeDeviations([...first, ...second])).toEqual([]);
  });

  it('ranks a value few boxes share above one many share', () => {
    // An indent ladder comes back as deviations too — without being told which
    // level was intended, it has to. It sorts below the stray because a level
    // with company is less suspicious than a level without.
    const atoms = stackedRows([100, 100, 100, 100, 100, 100, 100, 100, 112, 126, 126, 126]);

    const deviations = leftEdgeDeviations(atoms);

    expect(deviations[0]?.atomId).toBe('row-8');
    expect(deviations[0]?.peerSupport).toBe(1);
  });

  it('mines irregular spacing along the series axis', () => {
    const atoms = stackedRows([100, 100, 100, 100, 100, 100]);
    const shifted = atoms.map((atom, index) =>
      index >= 3 ? { ...atom, yStart: atom.yStart + 31, yEnd: atom.yEnd + 31 } : atom
    );

    const pitch = mineVisualDeviations(shifted).filter(
      (deviation) => deviation.measure === 'pitch'
    );

    expect(pitch.map((deviation) => deviation.atomId)).toEqual(['row-3']);
    expect(pitch[0]).toMatchObject({ expected: 80, value: 111 });
  });
});
