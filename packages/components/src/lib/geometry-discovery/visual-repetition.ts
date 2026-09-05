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
 * A rendered box. `id` exists so a finding can be named across runs and never
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

/**
 * Width is left out on purpose. A row's label is as wide as its text, so
 * keying on width would split one visual series into one group per string
 * length and leave nothing to compare.
 */
function visualSignature(atom: VisualAtom, heightTolerance: number): string {
  const height = atom.yEnd - atom.yStart;
  const bucket = heightTolerance > 0 ? Math.round(height / heightTolerance) : height;
  return `${normalizeKind(atom.kind)}|h${bucket}`;
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
  axis: 'x' | 'y',
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
        seriesSize,
        score: (delta * dominantSupport) / peerSupport,
      });
    }
  }
  return deviations;
}

/**
 * Splits one signature group into runs that read as a single series. Members
 * are ordered along the series axis and cut where the gap jumps far past the
 * run's own median gap.
 */
function splitIntoSeries(
  atoms: readonly VisualAtom[],
  axis: 'x' | 'y',
  breakRatio: number,
  minimumLength: number
): VisualAtom[][] {
  const center = (atom: VisualAtom) =>
    axis === 'y' ? (atom.yStart + atom.yEnd) / 2 : (atom.xStart + atom.xEnd) / 2;
  const ordered = [...atoms].sort((left, right) => center(left) - center(right));
  const gaps: number[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    gaps.push(center(ordered[index]!) - center(ordered[index - 1]!));
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
 * Orientation is measured, not declared: whichever axis the boxes spread along
 * is the series axis, and the expectations worth mining are the ones
 * perpendicular to it. Mining the series axis itself would only rediscover
 * that a list advances down the page.
 */
function seriesAxis(atoms: readonly VisualAtom[]): 'x' | 'y' {
  const xs = atoms.map((atom) => (atom.xStart + atom.xEnd) / 2);
  const ys = atoms.map((atom) => (atom.yStart + atom.yEnd) / 2);
  const spread = (values: readonly number[]) => Math.max(...values) - Math.min(...values);
  return spread(ys) >= spread(xs) ? 'y' : 'x';
}

export function mineVisualDeviations(
  atoms: readonly VisualAtom[],
  options: VisualRepetitionOptions = {}
): readonly VisualDeviation[] {
  const minimumSeriesLength = options.minimumSeriesLength ?? DEFAULTS.minimumSeriesLength;
  const levelTolerance = options.levelTolerance ?? DEFAULTS.levelTolerance;
  const heightTolerance = options.heightTolerance ?? DEFAULTS.heightTolerance;
  const seriesBreakRatio = options.seriesBreakRatio ?? DEFAULTS.seriesBreakRatio;

  const groups = new Map<string, VisualAtom[]>();
  for (const atom of atoms) {
    const signature = visualSignature(atom, heightTolerance);
    const group = groups.get(signature);
    if (group) group.push(atom);
    else groups.set(signature, [atom]);
  }

  const deviations: VisualDeviation[] = [];
  for (const [signature, group] of groups) {
    if (group.length < minimumSeriesLength) continue;
    const axis = seriesAxis(group);
    for (const run of splitIntoSeries(group, axis, seriesBreakRatio, minimumSeriesLength)) {
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
      const along = (atom: VisualAtom) =>
        axis === 'y' ? (atom.yStart + atom.yEnd) / 2 : (atom.xStart + atom.xEnd) / 2;
      const pitchEntries = run.slice(1).map((atom, index) => ({
        atom,
        value: along(atom) - along(run[index]!),
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
