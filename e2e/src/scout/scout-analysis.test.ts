import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeScoutCheckpoints,
  isSustainedPostGcGrowth,
  ordinaryLeastSquaresSlope,
  theilSenSlopeAtIterations,
} from './scout-analysis.js';
import type { RuntimeSnapshot } from '../support/resource-probe.js';

function snapshot(cliResidentSetBytes: number): RuntimeSnapshot {
  return {
    capturedAt: '2026-01-01T00:00:00.000Z',
    kind: 'post-gc',
    main: {
      heapUsedBytes: 100,
      heapTotalBytes: 100,
      privateBytes: 100,
      residentSetBytes: 100,
    },
    electronProcesses: [],
    processTree: [
      {
        pid: 2,
        parentPid: 1,
        kind: 'bundled-cli',
        cpuPercent: 0,
        residentSetBytes: cliResidentSetBytes,
      },
    ],
    renderer: {
      domNodes: 10,
      documents: 1,
      eventListeners: 10,
      jsHeapUsedBytes: 100,
      jsHeapTotalBytes: 100,
      layoutCount: 0,
      recalcStyleCount: 0,
      taskDurationSeconds: 0,
      longTaskCount: 0,
      longTaskDurationMs: 0,
      paintCount: 0,
    },
  };
}

void describe('Scout trend classification', () => {
  void it('requires repeated post-GC growth rather than one high-water mark', () => {
    assert.equal(
      isSustainedPostGcGrowth(
        {
          samples: 5,
          first: 100,
          last: 160,
          netChange: 60,
          slopePerCheckpoint: 15,
          positiveDeltaRatio: 1,
          nonDecreasingDeltaRatio: 1,
        },
        20
      ),
      true
    );
    assert.equal(
      isSustainedPostGcGrowth(
        {
          samples: 5,
          first: 100,
          last: 105,
          netChange: 5,
          slopePerCheckpoint: 10,
          positiveDeltaRatio: 0.75,
          nonDecreasingDeltaRatio: 0.75,
        },
        20
      ),
      false
    );
    assert.equal(
      isSustainedPostGcGrowth(
        {
          samples: 5,
          first: 1024 * 1024 * 1024,
          last: 1072 * 1024 * 1024,
          netChange: 48 * 1024 * 1024,
          slopePerCheckpoint: 12 * 1024 * 1024,
          positiveDeltaRatio: 1,
          nonDecreasingDeltaRatio: 1,
        },
        16 * 1024 * 1024
      ),
      true
    );
  });

  void it('treats plateaus as consistent with sustained growth', () => {
    assert.equal(
      isSustainedPostGcGrowth(
        {
          samples: 6,
          first: 100,
          last: 400,
          netChange: 300,
          slopePerCheckpoint: 60,
          positiveDeltaRatio: 0.6,
          nonDecreasingDeltaRatio: 1,
        },
        100
      ),
      true
    );
  });

  void it('keeps CLI working-set growth observational without hiding its trend', () => {
    const checkpoints = [1, 2, 3, 4].map((iteration) => {
      const value = iteration * 16 * 1024 * 1024;
      return {
        journey: 'session' as const,
        iteration,
        phase: 'measure' as const,
        active: snapshot(value),
        postGc: snapshot(value),
      };
    });
    const result = analyzeScoutCheckpoints(checkpoints);
    const cli = result.metrics.find((metric) => metric.metric === 'cli.residentSetBytes');

    assert.equal(cli?.analysisKind, 'observational');
    assert.equal(cli?.postGc.netChange, 48 * 1024 * 1024);
    assert.equal(cli?.suspected, false);
    assert.deepEqual(result.suspectedTrends, []);
  });
});

void describe('ordinaryLeastSquaresSlope', () => {
  void it('keeps an explicit comparison estimator for ablation', () => {
    assert.equal(ordinaryLeastSquaresSlope([10, 20, 30, 40]), 10);
    assert.equal(ordinaryLeastSquaresSlope([10]), 0);
  });
});

void describe('theilSenSlopeAtIterations', () => {
  void it('normalizes uneven checkpoints to one user journey', () => {
    assert.equal(theilSenSlopeAtIterations([100, 150, 200, 220], [5, 10, 15, 17]), 10);
    assert.equal(theilSenSlopeAtIterations([100], [5]), 0);
    assert.throws(() => theilSenSlopeAtIterations([100, 110], [5]));
  });
});
