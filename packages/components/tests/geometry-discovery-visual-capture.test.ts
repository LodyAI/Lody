import { describe, expect, it } from 'vitest';

import type {
  GeometryCapture,
  GeometryCapturedBlockCandidate,
} from '../src/lib/geometry-constraint-system';
import {
  createGeometryFindings,
  observeGeometryCaptures,
} from '../src/lib/geometry-constraint-system';
import {
  discoverVisualRepetition,
  projectVisualAtoms,
} from '../src/lib/geometry-discovery/visual-capture';

function capture(captureId: string, lefts: number[]): GeometryCapture {
  const blockCandidates = lefts.flatMap((left, index) =>
    (['block-start', 'block-center', 'visual-center', 'block-end'] as const).map(
      (anchor): GeometryCapturedBlockCandidate => ({
        primitiveId: `dom-${index}`,
        elementId: `element-${index}`,
        label: `Label ${index}`,
        locator: { role: index === 3 ? 'link' : 'button' },
        rowId: `row-${index}`,
        rowFamily: index === 3 ? 'different-structure' : 'usual-structure',
        kind: 'image',
        space: 'ink',
        anchor,
        coordinate: 100 + index * 80 + (anchor === 'block-end' ? 24 : 0),
        xStart: left,
        xEnd: left + 24,
        yStart: 100 + index * 80,
        yEnd: 124 + index * 80,
      })
    )
  );
  const scope = {
    key: 'scope',
    identity: 'scope',
    source: 'auto' as const,
    depth: 1,
    rect: { x: 0, y: 0, width: 500, height: 800 },
    candidates: [],
    blockCandidates,
  };
  return {
    captureId,
    surfaceFamily: 'workspace',
    surface: 'fixture',
    storyId: 'synthetic',
    viewport: { width: 500, height: 800 },
    deviceScaleFactor: 2,
    screenshot: '',
    scopes: [scope, { ...scope, key: 'parent', depth: 0 }],
  };
}

describe('visual capture discovery', () => {
  it('counts primitives once across anchors and scopes, preserving measured rectangles', () => {
    const input = capture('one', [24, 24, 24, 28, 24]);
    const atoms = projectVisualAtoms(input);
    expect(atoms).toHaveLength(5);
    expect(atoms[3]).toEqual({
      id: 'dom-3',
      kind: 'image',
      xStart: 28,
      xEnd: 52,
      yStart: 340,
      yEnd: 364,
    });
    const result = discoverVisualRepetition({ version: 1, captures: [input] });
    expect(result.captures[0]!.deviations.find((item) => item.measure === 'start')).toMatchObject({
      atomId: 'dom-3',
      expected: 24,
      value: 28,
      dominantSupport: 4,
      peerSupport: 1,
      dominantAtomIds: ['dom-0', 'dom-1', 'dom-2', 'dom-4'],
      peerAtomIds: ['dom-3'],
      seriesSize: 5,
    });
  });

  it('keeps reused DOM ids and coordinate expectations local to each capture', () => {
    const result = discoverVisualRepetition({
      version: 1,
      captures: [
        capture('light', [24, 24, 24, 28, 24]),
        capture('dark', [100, 100, 100, 100, 100]),
      ],
    });
    expect(result.captures[0]!.deviations.length).toBeGreaterThan(0);
    expect(result.captures[1]!.deviations).toEqual([]);
  });

  it('keeps untriaged visual candidates outside the finding output', () => {
    const input = { version: 1 as const, captures: [capture('one', [24, 24, 24, 28, 24])] };
    const original = structuredClone(input);
    const visual = discoverVisualRepetition(input);
    expect(visual.captures[0]!.deviations.length).toBeGreaterThan(0);
    expect(input).toEqual(original);
    expect(createGeometryFindings(input, observeGeometryCaptures(input)).findings).toEqual([]);
  });
});
