import { writeFile } from 'node:fs/promises';

import { test } from '@playwright/test';

import type { GeometryObservationCache } from '../../src/lib/geometry-constraint-system';
import {
  GEOMETRY_REPRESENTATIVE_CAPTURE,
  runGeometryCapturePlan,
} from './support/geometry-capture-plan';

test('dump one real capture', async ({ browser }) => {
  test.setTimeout(600_000);
  const observationCache: GeometryObservationCache = new Map();
  const blockedRequests: string[] = [];
  const capture = await runGeometryCapturePlan(browser, [GEOMETRY_REPRESENTATIVE_CAPTURE], {
    observationCache,
    blockedRequests,
  });
  await writeFile(
    '/tmp/geom-run/capture-one.json',
    `${JSON.stringify(capture, null, 2)}\n`,
    'utf8'
  );
});
