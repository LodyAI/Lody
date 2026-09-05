import type { GeometryCapture, GeometryCaptureArtifact } from '../geometry-constraint-system';
import { mineVisualDeviations, type VisualAtom } from './visual-repetition';

/**
 * Project one capture, never a matrix: DOM ordinals and visual series are local
 * to a page. Block candidates retain the complete measured primitive rectangle,
 * including primitives outside rows; anchor coordinates are not box extents.
 */
export function projectVisualAtoms(capture: GeometryCapture): VisualAtom[] {
  const atoms = new Map<string, VisualAtom>();
  for (const scope of capture.scopes) {
    for (const candidate of scope.blockCandidates ?? []) {
      if (atoms.has(candidate.primitiveId)) continue;
      atoms.set(candidate.primitiveId, {
        id: candidate.primitiveId,
        kind: candidate.kind ?? 'unknown',
        xStart: candidate.xStart,
        xEnd: candidate.xEnd,
        yStart: candidate.yStart,
        yEnd: candidate.yEnd,
      });
    }
  }
  return [...atoms.values()];
}

/** Discovery evidence only. No finding identity, ledger status or gate verdict. */
export function discoverVisualRepetition(artifact: GeometryCaptureArtifact) {
  return {
    version: 1 as const,
    captures: artifact.captures.map((capture) => {
      const atoms = projectVisualAtoms(capture);
      const evidence = new Map(
        capture.scopes.flatMap((scope) =>
          (scope.blockCandidates ?? []).map(
            (candidate) => [candidate.primitiveId, candidate] as const
          )
        )
      );
      return {
        captureId: capture.captureId,
        surface: capture.surface,
        storyId: capture.storyId,
        viewport: capture.viewport,
        deviceScaleFactor: capture.deviceScaleFactor,
        dimensions: capture.dimensions,
        screenshot: capture.screenshot,
        atoms: atoms.map((atom) => {
          const candidate = evidence.get(atom.id)!;
          const node = candidate.boxModelNodeRef
            ? capture.boxModelNodes?.[candidate.boxModelNodeRef]
            : undefined;
          return {
            ...atom,
            label: candidate.label,
            scope: candidate.sectionScope,
            component: node?.component,
            className: node?.className,
          };
        }),
        deviations: mineVisualDeviations(atoms),
      };
    }),
  };
}
