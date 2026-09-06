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

/** A grid of one visual kind, `columns` wide, at a fixed pitch on both axes. */
function grid(columns: number, rows: number, cell = { width: 40, height: 40 }): VisualAtom[] {
  return Array.from({ length: rows }, (_unused, row) =>
    Array.from({ length: columns }, (_ignored, column) => ({
      id: `cell-${row}-${column}`,
      kind: 'image',
      xStart: 60 + column * 100,
      xEnd: 60 + column * 100 + cell.width,
      yStart: 40 + row * 60,
      yEnd: 40 + row * 60 + cell.height,
    }))
  ).flat();
}

/** Two vertical lists that render alike, rendered beside each other. */
function sideBySideLists(rows: number): VisualAtom[] {
  return [40, 340].flatMap((left, list) =>
    Array.from({ length: rows }, (_unused, row) => ({
      id: `list-${list}-${row}`,
      kind: 'image',
      xStart: left,
      xEnd: left + 24,
      yStart: 50 + row * 70,
      yEnd: 74 + row * 70,
    }))
  );
}

function shiftX(atoms: readonly VisualAtom[], id: string, offset: number): VisualAtom[] {
  return atoms.map((atom) =>
    atom.id === id ? { ...atom, xStart: atom.xStart + offset, xEnd: atom.xEnd + offset } : atom
  );
}

function leftEdgeDeviations(atoms: readonly VisualAtom[]) {
  return mineVisualDeviations(atoms).filter(
    (deviation) => deviation.axis === 'x' && deviation.measure === 'start'
  );
}

describe('mineVisualDeviations', () => {
  it('finds a singleton offset across fractional height rounding boundaries', () => {
    const atoms = stackedRows([24, 24, 24, 28]).map((atom, index) => ({
      ...atom,
      yEnd: atom.yStart + (index < 2 ? 15.49 : 15.51),
    }));
    for (const ordered of [atoms, [...atoms].reverse()]) {
      expect(leftEdgeDeviations(ordered)).toEqual([
        expect.objectContaining({
          atomId: 'row-3',
          expected: 24,
          value: 28,
          dominantSupport: 3,
          peerSupport: 1,
        }),
      ]);
    }
  });

  it('does not chain distinct heights through intermediate boxes', () => {
    const atoms = stackedRows([24, 24, 24, 80, 80, 80]).map((atom, index) => ({
      ...atom,
      yEnd: atom.yStart + [15, 15.5, 16, 16.5, 17, 17.5][index]!,
    }));
    expect(leftEdgeDeviations(atoms)).toEqual([]);
    expect(leftEdgeDeviations([...atoms].reverse())).toEqual([]);
  });

  it('keeps different heights separate when height tolerance is zero', () => {
    const atoms = stackedRows([24, 24, 24, 28]).map((atom, index) => ({
      ...atom,
      yEnd: atom.yStart + (index < 2 ? 15 : 15.5),
    }));
    expect(mineVisualDeviations(atoms, { heightTolerance: 0 })).toEqual([]);
  });

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

  it('reports the one row that left, with nothing to share the blame with', () => {
    // The shape the scorer ranks highest: peer support of one. It has to reach
    // the reviewer, so the report's default queue may not filter on peers.
    const deviations = leftEdgeDeviations(stackedRows([100, 100, 100, 108, 100, 100]));

    expect(deviations).toEqual([
      expect.objectContaining({
        atomId: 'row-3',
        expected: 100,
        value: 108,
        dominantSupport: 5,
        peerSupport: 1,
      }),
    ]);
  });

  it('reads a regular grid as its own rows and columns, not as one flat series', () => {
    // Orientation used to come from the whole signature group's page-wide
    // spread, so a grid was mined as a single horizontal series: every row
    // then deviated on Y and every column break on pitch, all of it scored
    // high by the very spread that caused it. Rows and columns are isolated
    // before orientation is settled, so a grid that agrees with itself is
    // silent — the same guarantee a single regular column already had.
    expect(mineVisualDeviations(grid(3, 6))).toEqual([]);
  });

  it('still finds one cell out of line inside a grid', () => {
    const deviations = mineVisualDeviations(shiftX(grid(3, 6), 'cell-2-1', 8));

    expect(deviations.map((deviation) => deviation.atomId)).toEqual([
      'cell-2-1',
      'cell-2-1',
      'cell-2-1',
    ]);
    expect(deviations[0]).toMatchObject({
      axis: 'x',
      expected: 160,
      value: 168,
      // Compared against its own column, never against the neighbouring ones.
      dominantSupport: 5,
      seriesSize: 6,
    });
  });

  it('keeps two side-by-side lists vertical instead of reading across them', () => {
    expect(mineVisualDeviations(sideBySideLists(6))).toEqual([]);
  });

  it('finds a misaligned row inside one of two side-by-side lists', () => {
    const deviations = mineVisualDeviations(shiftX(sideBySideLists(6), 'list-1-3', 8));

    expect(deviations.map((deviation) => deviation.atomId)).toEqual([
      'list-1-3',
      'list-1-3',
      'list-1-3',
    ]);
    // Its own column is the expectation, not the list on the other side.
    expect(deviations[0]).toMatchObject({ expected: 340, value: 348 });
  });

  it.each([8, 16, 20, 28, 200])(
    'keeps a box that flew %ipx out of its series inside that series',
    (offset) => {
      // The failure this guards is the tempting one: cut the series into
      // spatial neighbourhoods and the clearest defects — the ones that flew
      // furthest — are the ones cut loose and lost. Suspicion has to rise with
      // the offset, never fall off a locality boundary.
      const deviations = leftEdgeDeviations(stackedRows([100, 100, 100, 100 + offset, 100, 100]));

      expect(deviations).toEqual([
        expect.objectContaining({ atomId: 'row-3', expected: 100, value: 100 + offset }),
      ]);
    }
  );

  it('sees a box that is only wider, whose left edge agrees', () => {
    // Width drift lives entirely in `end` and `center`. Keeping only the
    // best-agreeing measure per series would silence variable-width text and
    // this real defect in the same stroke, so all three are mined.
    const rows = stackedRows([100, 100, 100, 100, 100, 100]).map((atom, index) => ({
      ...atom,
      xEnd: atom.xEnd + (index === 3 ? 8 : 0),
    }));

    const measures = mineVisualDeviations(rows).filter(
      (deviation) => deviation.atomId === 'row-3'
    );

    expect(measures.map((deviation) => deviation.measure).sort()).toEqual(['center', 'end']);
    expect(leftEdgeDeviations(rows)).toEqual([]);
  });

  it('reads the same layout the same way wherever it sits on the page', () => {
    const atoms = shiftX(grid(3, 6), 'cell-4-2', 9);
    const translated = atoms.map((atom) => ({
      ...atom,
      xStart: atom.xStart + 1000,
      xEnd: atom.xEnd + 1000,
      yStart: atom.yStart + 777,
      yEnd: atom.yEnd + 777,
    }));

    expect(mineVisualDeviations(translated).map((deviation) => deviation.delta)).toEqual(
      mineVisualDeviations(atoms).map((deviation) => deviation.delta)
    );
  });

  it('absorbs sub-pixel jitter and ranks one input one way', () => {
    const jittered = grid(3, 6).map((atom, index) => {
      const noise = ((index % 5) - 2) * 0.2;
      return {
        ...atom,
        xStart: atom.xStart + noise,
        xEnd: atom.xEnd + noise,
        yStart: atom.yStart - noise,
        yEnd: atom.yEnd - noise,
      };
    });

    expect(mineVisualDeviations(jittered)).toEqual([]);
    const anomalous = shiftX(jittered, 'cell-3-0', 12);
    expect(mineVisualDeviations(anomalous)).toEqual(mineVisualDeviations(anomalous));
  });
});
