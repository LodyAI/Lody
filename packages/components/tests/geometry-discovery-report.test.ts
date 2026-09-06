// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import template from '../scripts/templates/chat-workspace-geometry-report.html?raw';
import {
  mineVisualDeviations,
  type VisualAtom,
} from '../src/lib/geometry-discovery/visual-repetition';

afterEach(() => document.body.replaceChildren());

type ReportAtom = VisualAtom & { label: string };

/**
 * Runs the shipped report renderer against its real DOM, without a Storybook
 * server: the default review queue is a policy that only exists in the
 * template, so asserting it anywhere else would assert a copy of it.
 */
function renderVisualReport(captures: readonly { captureId: string; atoms: readonly ReportAtom[] }[]) {
  const payload = {
    generatedAt: '2026-01-01T00:00:00Z',
    viewport: { width: 500, height: 500 },
    visualRepetition: {
      captures: captures.map((capture) => ({
        ...capture,
        deviations: mineVisualDeviations(capture.atoms),
        viewport: { width: 500, height: 500 },
        deviceScaleFactor: 1,
      })),
    },
    details: [],
    coverage: { scope: 'synthetic', captures: [], exclusions: [] },
    findingDiff: { current: [], new: [], changed: [], resolved: [] },
    qualityMetrics: {},
    pixelWitnesses: [],
    contractProposals: [],
  };
  const html = template.replace('__GEOMETRY_REPORT_DATA__', JSON.stringify(payload));
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)![1]!;
  // The template ships as one HTML file with an inline script, so running that
  // exact script — from this repository, never from input — is the whole point.
  // eslint-disable-next-line typescript-eslint/no-implied-eval -- runs the shipped renderer
  new Function(html.match(/<script>([\s\S]*?)<\/script>/)![1]!)();
  return {
    cards: () => [...document.querySelectorAll<HTMLDetailsElement>('#visual-candidates > details')],
    summaries: () =>
      [...document.querySelectorAll('#visual-candidates > details > summary')].map(
        (summary) => summary.textContent ?? ''
      ),
    showAll: () => {
      const filter = document.querySelector<HTMLSelectElement>('#visual-evidence-filter')!;
      filter.value = 'all';
      filter.dispatchEvent(new Event('change'));
    },
    showMore: () => document.getElementById('visual-more')!.dispatchEvent(new Event('click')),
    deviations: payload.visualRepetition.captures.map((capture) => capture.deviations),
  };
}

function column(lefts: readonly number[]): ReportAtom[] {
  return lefts.map((left, index) => ({
    id: `atom-${index}`,
    label: `Item ${index}`,
    kind: 'image',
    xStart: left,
    xEnd: left + 24,
    yStart: index * 80,
    yEnd: index * 80 + 24,
  }));
}

it('shows singleton deviations by default while preserving folded measurements and capture boundaries', () => {
  const atoms = [24, 24, 24, 28].map((x, index) => ({
    id: `atom-${index}`,
    label: `Item ${index}`,
    kind: 'image',
    xStart: x,
    xEnd: x + 24,
    yStart: index * 80 + (index === 3 ? 7 : 0),
    yEnd: index * 80 + (index === 3 ? 7 : 0) + 16,
  }));
  const report = renderVisualReport([
    { captureId: 'light', atoms },
    { captureId: 'dark', atoms },
  ]);
  // Edge + pitch in each capture; every deviation here stands alone, and the
  // old `peerSupport >= 2` default queue showed none of them.
  expect(report.cards()).toHaveLength(4);
  const edgeCard = report.cards().find((card) =>
    card.querySelector('summary')!.textContent!.includes('x-start')
  )!;
  edgeCard.open = true;
  edgeCard.dispatchEvent(new Event('toggle'));
  const measurements = edgeCard.querySelector('.visual-measurements')!;
  expect(measurements.querySelectorAll('p')).toHaveLength(3);
  expect(measurements.textContent).toContain('x-start');
  expect(measurements.textContent).toContain('x-end');
  expect(measurements.textContent).toContain('x-center');
  expect(measurements.textContent).toContain('peer support 1');
  expect(measurements.textContent).toContain('Item 0 (atom-0)');

  const captureFilter = document.querySelector<HTMLSelectElement>('#visual-capture-filter')!;
  captureFilter.value = 'dark';
  captureFilter.dispatchEvent(new Event('change'));
  expect(report.cards()).toHaveLength(2);
  expect(
    report.summaries().every((summary) => summary.includes('dark'))
  ).toBe(true);
  report.showAll();
  expect(report.cards()).toHaveLength(report.deviations[1]!.length);
});

it('bounds isolated candidates per capture without touching peer-supported ones or the raw JSON', () => {
  // Ten rows each off the dominant edge by their own amount, so each is its own
  // level with peer support of one, plus two rows that agree with each other.
  const lefts = [100, 100, 100, 100, 100, 100, 100, 100];
  for (let step = 1; step <= 10; step += 1) lefts.push(100 + step * 4);
  const noisy = column([...lefts, 150, 150]);
  const report = renderVisualReport([
    { captureId: 'noisy', atoms: noisy },
    { captureId: 'quiet', atoms: column([100, 100, 100, 108, 100, 100]) },
  ]);

  const sharedLevel = ['Item 18', 'Item 19'];
  const isolated = (summaries: readonly string[]) =>
    summaries.filter(
      (summary) =>
        summary.includes('noisy') && !sharedLevel.some((label) => summary.includes(label))
    );
  // Five per capture, and the budget is spent on the highest-scoring ones: the
  // furthest row in, the smallest offsets out.
  expect(isolated(report.summaries())).toHaveLength(5);
  expect(report.summaries().some((summary) => summary.includes('Item 17'))).toBe(true);
  expect(report.summaries().some((summary) => summary.includes('Item 8'))).toBe(false);
  // The pair that shares a level keeps the guarantee the old queue gave it.
  expect(
    sharedLevel.every((label) => report.summaries().some((summary) => summary.includes(label)))
  ).toBe(true);
  // A budget is per capture, so one noisy screen cannot drain a quiet one.
  expect(report.summaries().some((summary) => summary.includes('quiet'))).toBe(true);

  // Nothing was removed from discovery: the raw view still holds every one.
  const withheld = report.deviations[0]!.length + report.deviations[1]!.length;
  expect(report.cards().length).toBeLessThan(withheld);
  report.showAll();
  report.showMore();
  report.showMore();
  expect(report.cards()).toHaveLength(withheld);
});
