import { expect, test } from '@playwright/test';

import { discoverVisualRepetition } from '../../src/lib/geometry-discovery/visual-capture';
import {
  buildGeometryCapture,
  GEOMETRY_REPRESENTATIVE_CAPTURE,
  observeGeometryPlanEntry,
} from './support/geometry-capture-plan';

test('projects browser-measured primitives into visual discovery across DOM structures', async ({
  page,
}) => {
  await page.setContent(`
    <style>
      body { margin: 0; }
      .row { height: 48px; padding-left: 24px; }
      .mark { display: block; width: 16px; height: 16px; background: black; }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    </style>
    <main data-geometry-discovery-scope="fixture">
      <span class="sr-only">Accessible label</span>
      <div class="row"><span class="mark"></span></div>
      <div class="row"><span class="mark"></span></div>
      <div class="row"><span class="mark"></span></div>
      <section class="row" style="padding-left:28px"><i class="mark"></i></section>
      <div class="row"><span class="mark"></span></div>
    </main>
  `);
  const observation = await observeGeometryPlanEntry(page, {
    ...GEOMETRY_REPRESENTATIVE_CAPTURE,
    captureId: 'synthetic-browser',
    semanticObservations: false,
  });
  const artifact = JSON.parse(
    JSON.stringify({ version: 1, captures: [buildGeometryCapture(observation)] })
  );
  const result = discoverVisualRepetition(artifact).captures[0]!;
  expect(result.atoms.map((atom) => atom.label)).not.toContain('Accessible label');
  const shifted = result.atoms.find((atom) => atom.kind === 'shape' && atom.xStart === 28);
  expect(shifted).toBeDefined();
  expect(
    result.deviations.find(
      (deviation) =>
        deviation.atomId === shifted!.id && deviation.axis === 'x' && deviation.measure === 'start'
    )
  ).toMatchObject({
    expected: 24,
    value: 28,
    delta: 4,
    dominantSupport: 4,
    peerSupport: 1,
  });
});
