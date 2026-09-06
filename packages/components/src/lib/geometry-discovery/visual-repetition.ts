/**
 * Heuristic discovery of layout deviations from visual repetition alone.
 *
 * The authored path (`geometry-contracts.json`) can only find what someone
 * already wrote down, and it names its members by DOM shape — role, accessible
 * name, row family. That is the wrong ground truth twice over. A layout bug
 * almost always comes from two code paths rendering the same visual thing
 * differently, so the defect CORRELATES with the DOM difference: grouping by
 * DOM shape files the two paths into separate families and never compares
 * them. And a reader perceives a column of avatars as a column because the
 * pixels line up, not because the elements share a tag.
 *
 * So nothing here reads structure. Atoms are grouped by what they look like,
 * a repeating series is whatever renders as a repeating series, and the
 * expected coordinate is mined from what the majority of that series actually
 * does. Nobody writes down that the indent step is 26px; it is counted.
 *
 * The bias is recall. A missed misalignment is invisible forever, while a
 * false one costs a triage glance, so nothing is dropped for looking weak —
 * candidates are ranked, not filtered, and every tie is broken towards
 * reporting more.
 */

/**
 * A rendered box. `id` references a primitive within its capture and never
 * takes part in grouping: the moment identity decides who is compared with
 * whom, the DOM blindness described above is back.
 */
export type VisualAtom = Readonly<{
  id: string;
  /** Geometry-derived primitive kind, never a semantic contract name. */
  kind: string;
  xStart: number;
  xEnd: number;
  yStart: number;
  yEnd: number;
}>;

export type VisualDeviationMeasure = 'start' | 'end' | 'center' | 'pitch';

export type VisualDeviation = Readonly<{
  atomId: string;
  /** The visual signature whose series this atom deviates inside. */
  signature: string;
  axis: 'x' | 'y';
  measure: VisualDeviationMeasure;
  value: number;
  /** Median of the best-supported level in the same series. */
  expected: number;
  delta: number;
  /** How many series members share this atom's value. */
  peerSupport: number;
  /** How many share the level it deviates from. */
  dominantSupport: number;
  /** Capture-local witnesses, retained so a report can show the actual comparison. */
  dominantAtomIds: readonly string[];
  peerAtomIds: readonly string[];
  seriesSize: number;
  /** Higher is more suspicious. Ranking only; never a pass/fail threshold. */
  score: number;
}>;

export type VisualRepetitionOptions = Readonly<{
  /**
   * Shortest run that can carry an expectation at all. Two boxes agreeing is
   * a coincidence; three is the weakest thing that can be called usual.
   */
  minimumSeriesLength?: number;
  /**
   * How far apart two coordinates may be and still count as the same level.
   * Sits at measurement noise (1/devicePixelRatio of the coarsest capture),
   * not at a design tolerance — a real indent step is an order of magnitude
   * above it.
   */
  levelTolerance?: number;
  /** Heights within this distance describe the same kind of box. */
  heightTolerance?: number;
  /**
   * A gap this many times the series median ends the series. Purely visual
   * locality: it separates two lists that happen to render alike, without
   * severing a list that a date header interrupts.
   */
  seriesBreakRatio?: number;
}>;

const DEFAULTS = {
  minimumSeriesLength: 3,
  levelTolerance: 1,
  heightTolerance: 1,
  seriesBreakRatio: 3,
} as const;

type Axis = 'x' | 'y';

const CROSS_AXIS = { x: 'y', y: 'x' } as const satisfies Record<Axis, Axis>;

function centerOn(atom: VisualAtom, axis: Axis): number {
  return axis === 'y' ? (atom.yStart + atom.yEnd) / 2 : (atom.xStart + atom.xEnd) / 2;
}

function extentOn(atom: VisualAtom, axis: Axis): number {
  return axis === 'y' ? atom.yEnd - atom.yStart : atom.xEnd - atom.xStart;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * `link` versus `button` is a tag difference and `numeric-text` versus `text`
 * is a content difference; neither is visible. Folding them widens each group,
 * which is the direction that finds more.
 */
function normalizeKind(kind: string): string {
  if (kind === 'link') return 'button';
  if (kind === 'numeric-text') return 'text';
  return kind;
}

type Level = { readonly values: number[]; readonly atoms: VisualAtom[]; anchor: number };

/**
 * Levels grow by distance to the level's anchor, never to its nearest member.
 * Single linkage would let a chain of intermediate coordinates walk one level
 * into the next and quietly merge two indentation depths into one expectation
 * — the merged level then looks internally perfect and the deviation vanishes.
 */
function buildLevels(
  entries: readonly { readonly atom: VisualAtom; readonly value: number }[],
  tolerance: number
): Level[] {
  const levels: Level[] = [];
  for (const entry of [...entries].sort((left, right) => left.value - right.value)) {
    const existing = levels.find((level) => Math.abs(entry.value - level.anchor) <= tolerance);
    if (existing) {
      existing.values.push(entry.value);
      existing.atoms.push(entry.atom);
      continue;
    }
    levels.push({ values: [entry.value], atoms: [entry.atom], anchor: entry.value });
  }
  return levels;
}

/**
 * Every member of every non-dominant level is reported. In a legitimate indent
 * ladder that means the whole indented half comes back as deviations — which
 * is the accepted cost of not knowing in advance which of the two levels was
 * intended. They rank low because they have each other: score falls as a
 * level's own support rises, so a value only two boxes share outranks one
 * forty boxes share, and the stray middle row sorts above the ladder.
 */
function scoreLevels(
  levels: readonly Level[],
  seriesSize: number,
  signature: string,
  axis: Axis,
  measure: VisualDeviationMeasure,
  levelTolerance: number
): VisualDeviation[] {
  if (levels.length < 2) return [];
  const dominant = levels.reduce((best, level) =>
    level.atoms.length > best.atoms.length ? level : best
  );
  const dominantSupport = dominant.atoms.length;
  const expected = median(dominant.values);
  const deviations: VisualDeviation[] = [];
  for (const level of levels) {
    if (level === dominant) continue;
    const peerSupport = level.atoms.length;
    for (const [index, atom] of level.atoms.entries()) {
      const value = level.values[index]!;
      const delta = Math.abs(value - expected);
      if (delta <= levelTolerance) continue;
      deviations.push({
        atomId: atom.id,
        signature,
        axis,
        measure,
        value,
        expected,
        delta,
        peerSupport,
        dominantSupport,
        dominantAtomIds: dominant.atoms.map((member) => member.id),
        peerAtomIds: level.atoms.map((member) => member.id),
        seriesSize,
        score: (delta * dominantSupport) / peerSupport,
      });
    }
  }
  return deviations;
}

/**
 * Splits one already-isolated lane into the runs that read as a single series.
 * Members are ordered along the series axis and cut where the gap jumps far
 * past the run's own median gap — a date header may interrupt a list without
 * ending it; a screen of empty space ends it.
 */
function splitIntoSeries(
  atoms: readonly VisualAtom[],
  axis: Axis,
  breakRatio: number,
  minimumLength: number
): VisualAtom[][] {
  const ordered = [...atoms].sort((left, right) => centerOn(left, axis) - centerOn(right, axis));
  const gaps: number[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    gaps.push(centerOn(ordered[index]!, axis) - centerOn(ordered[index - 1]!, axis));
  }
  if (gaps.length === 0) return [];
  const typicalGap = median(gaps);
  const series: VisualAtom[][] = [];
  let current: VisualAtom[] = [ordered[0]!];
  for (let index = 1; index < ordered.length; index += 1) {
    const gap = gaps[index - 1]!;
    if (typicalGap > 0 && gap > typicalGap * breakRatio) {
      series.push(current);
      current = [];
    }
    current.push(ordered[index]!);
  }
  series.push(current);
  return series.filter((run) => run.length >= minimumLength);
}

/**
 * Orientation of one ALREADY ISOLATED run, and only used to settle a run both
 * hypotheses below produced. Asking it of a whole signature group instead is
 * the failure this replaces: two side-by-side lists spread further across the
 * page than either list runs down it, so the page-wide answer was "horizontal"
 * — and every row of a grid was then mined as if it were one series, which
 * manufactures a high-scoring Y deviation per row and a pitch deviation per
 * column break out of a layout that is completely regular.
 */
function seriesAxis(atoms: readonly VisualAtom[]): Axis {
  const spread = (axis: Axis) => {
    const centers = atoms.map((atom) => centerOn(atom, axis));
    return Math.max(...centers) - Math.min(...centers);
  };
  return spread('y') >= spread('x') ? 'y' : 'x';
}

type Lane = { readonly atoms: VisualAtom[]; readonly across: number[]; anchor: number };

/**
 * Isolates the lanes a signature group renders as, under one axis hypothesis.
 *
 * Bands are the group's own steps along the hypothesised axis: boxes whose
 * centres sit within half a box of each other occupy one band, so a column
 * list has one member per band and a grid row has all of its cells in one. A
 * series may hold at most ONE member per band, which is what a reader means by
 * "this list runs downwards" — and is what makes the wrong hypothesis free: a
 * horizontal toolbar collapses into a single vertical band and its vertical
 * reading dies as runs of one, without anything having to declare an axis.
 *
 * Lanes then track across bands by nearest cross-axis distance, bounded by the
 * group's own band step. The scale comes from the layout, not a constant: a box
 * that drifted sideways by less than one step of the series it sits in is still
 * in that series, while two lists a whole column apart are not one zigzag. A
 * lane anchors on the median of its members rather than its last one, for the
 * same reason levels grow to an anchor — a drifting cross-axis chain would
 * otherwise walk one column into the next.
 */
function laneSeries(group: readonly VisualAtom[], axis: Axis, minimumLength: number): VisualAtom[][] {
  const bands = buildLevels(
    group.map((atom) => ({ atom, value: centerOn(atom, axis) })),
    median(group.map((atom) => extentOn(atom, axis))) / 2
  );
  // A lane holds at most one atom per band, so fewer bands than a series needs
  // members means this axis cannot carry a series at all.
  if (bands.length < Math.max(minimumLength, 2)) return [];
  const step = median(bands.slice(1).map((band, index) => band.anchor - bands[index]!.anchor));
  if (!(step > 0)) return [];

  const cross = CROSS_AXIS[axis];
  const lanes: Lane[] = [];
  for (const band of bands) {
    const unplaced = new Set(band.atoms);
    const claimed = new Set<Lane>();
    const pairs = lanes
      .flatMap((lane) =>
        band.atoms.map((atom) => ({
          lane,
          atom,
          distance: Math.abs(centerOn(atom, cross) - lane.anchor),
        }))
      )
      .filter((pair) => pair.distance <= step)
      .sort((left, right) => left.distance - right.distance || (left.atom.id < right.atom.id ? -1 : 1));
    for (const { lane, atom } of pairs) {
      if (claimed.has(lane) || !unplaced.has(atom)) continue;
      claimed.add(lane);
      unplaced.delete(atom);
      lane.atoms.push(atom);
      lane.across.push(centerOn(atom, cross));
      lane.anchor = median(lane.across);
    }
    for (const atom of band.atoms) {
      if (!unplaced.has(atom)) continue;
      const across = centerOn(atom, cross);
      lanes.push({ atoms: [atom], across: [across], anchor: across });
    }
  }

  const series = lanes.filter((lane) => lane.atoms.length >= minimumLength);
  if (series.length === 0) return [];
  // Recall fallback, and the reason locality here is not a partition. A lane of
  // one is not evidence of a lane; it is one box that left. Left alone, the
  // bound above would punish the clearest defects hardest — the further a box
  // flies from its series, the more certainly it becomes its own lane and
  // disappears — so a lone residual rejoins the nearest real series and is
  // mined there at whatever delta it actually has. Two boxes agreeing on a
  // position are left alone: that is a sparse column, and folding it back
  // would report a whole second column as broken.
  for (const lane of lanes) {
    if (lane.atoms.length !== 1 || series.includes(lane)) continue;
    const nearest = series.reduce((best, candidate) =>
      Math.abs(lane.anchor - candidate.anchor) < Math.abs(lane.anchor - best.anchor)
        ? candidate
        : best
    );
    nearest.atoms.push(lane.atoms[0]!);
  }
  return series.map((lane) => lane.atoms);
}

export function mineVisualDeviations(
  atoms: readonly VisualAtom[],
  options: VisualRepetitionOptions = {}
): readonly VisualDeviation[] {
  const minimumSeriesLength = options.minimumSeriesLength ?? DEFAULTS.minimumSeriesLength;
  const levelTolerance = options.levelTolerance ?? DEFAULTS.levelTolerance;
  const heightTolerance = options.heightTolerance ?? DEFAULTS.heightTolerance;
  const seriesBreakRatio = options.seriesBreakRatio ?? DEFAULTS.seriesBreakRatio;

  const kinds = new Map<string, VisualAtom[]>();
  for (const atom of atoms) {
    const kind = normalizeKind(atom.kind);
    const group = kinds.get(kind);
    if (group) group.push(atom);
    else kinds.set(kind, [atom]);
  }
  // Height uses the same fixed-anchor distance rule as coordinates: a rounding
  // boundary must not split nearly identical boxes. Content-sized width stays
  // out of grouping so different label lengths can still be compared.
  const groups = [...kinds].flatMap(([kind, members]) =>
    buildLevels(
      members.map((atom) => ({ atom, value: atom.yEnd - atom.yStart })),
      heightTolerance
    ).map((level) => [`${kind}|h${level.anchor}`, level.atoms] as const)
  );

  const deviations: VisualDeviation[] = [];
  for (const [signature, group] of groups) {
    if (group.length < minimumSeriesLength) continue;

    // Both orientations are hypothesised and the layout answers. A group that
    // reads only one way loses the other to runs shorter than a series; a grid
    // legitimately reads both ways, and its columns and rows are then each
    // mined against themselves instead of against each other.
    const runs = new Map<string, { axis: Axis; atoms: VisualAtom[] }>();
    for (const axis of ['y', 'x'] as const) {
      for (const lane of laneSeries(group, axis, minimumSeriesLength)) {
        for (const run of splitIntoSeries(lane, axis, seriesBreakRatio, minimumSeriesLength)) {
          const key = JSON.stringify(
            run
              .map((atom) => atom.id)
              .sort()
          );
          // A run both hypotheses found is one series seen twice; its own
          // spread, measured locally, says which way it runs.
          if (!runs.has(key) || seriesAxis(run) === axis) runs.set(key, { axis, atoms: run });
        }
      }
    }

    for (const { axis, atoms: run } of runs.values()) {
      const edges =
        axis === 'y'
          ? ([
              ['x', 'start', (atom: VisualAtom) => atom.xStart],
              ['x', 'end', (atom: VisualAtom) => atom.xEnd],
              ['x', 'center', (atom: VisualAtom) => (atom.xStart + atom.xEnd) / 2],
            ] as const)
          : ([
              ['y', 'start', (atom: VisualAtom) => atom.yStart],
              ['y', 'end', (atom: VisualAtom) => atom.yEnd],
              ['y', 'center', (atom: VisualAtom) => (atom.yStart + atom.yEnd) / 2],
            ] as const);

      for (const [edgeAxis, measure, read] of edges) {
        const entries = run.map((atom) => ({ atom, value: read(atom) }));
        deviations.push(
          ...scoreLevels(
            buildLevels(entries, levelTolerance),
            run.length,
            signature,
            edgeAxis,
            measure,
            levelTolerance
          )
        );
      }

      // Irregular spacing is the same kind of defect seen along the series
      // axis, and the series is already ordered, so it costs nothing to mine.
      const pitchEntries = run.slice(1).map((atom, index) => ({
        atom,
        value: centerOn(atom, axis) - centerOn(run[index]!, axis),
      }));
      if (pitchEntries.length >= minimumSeriesLength) {
        deviations.push(
          ...scoreLevels(
            buildLevels(pitchEntries, levelTolerance),
            run.length,
            signature,
            axis,
            'pitch',
            levelTolerance
          )
        );
      }
    }
  }

  return deviations.sort((left, right) => right.score - left.score);
}
