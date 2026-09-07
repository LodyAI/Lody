import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseProcessTable,
  selectProcessTree,
  summarizeTrend,
  theilSenSlope,
} from './resource-probe.js';

void describe('process tree evidence', () => {
  void it('keeps descendants and removes raw commands', () => {
    const rows = parseProcessTable(`
      20 1 1000 1.5 /Applications/Electron app.js
      21 20 2000 2.5 Electron Helper --type=renderer
      22 20 3000 3.5 Electron resources/cli/index.js start --secret redacted-at-output
      23 22 4000 4.5 codex app-server --token never-retained
      24 22 5000 5.5 node /fixture/scripted-acp.mjs --fixture-data synthetic
      99 1 9000 9.5 unrelated
    `);
    assert.deepEqual(selectProcessTree(rows, 20), [
      {
        pid: 20,
        parentPid: 1,
        residentSetBytes: 1_024_000,
        cpuPercent: 1.5,
        kind: 'electron-main',
      },
      { pid: 21, parentPid: 20, residentSetBytes: 2_048_000, cpuPercent: 2.5, kind: 'renderer' },
      { pid: 22, parentPid: 20, residentSetBytes: 3_072_000, cpuPercent: 3.5, kind: 'bundled-cli' },
      {
        pid: 23,
        parentPid: 22,
        residentSetBytes: 4_096_000,
        cpuPercent: 4.5,
        kind: 'agent-runtime',
      },
      {
        pid: 24,
        parentPid: 22,
        residentSetBytes: 5_120_000,
        cpuPercent: 5.5,
        kind: 'agent-runtime',
      },
    ]);
  });
});

void describe('theilSenSlope', () => {
  void it('reports growth per checkpoint', () => {
    assert.equal(theilSenSlope([100, 110, 120, 130]), 10);
  });

  void it('does not invent a trend without two checkpoints', () => {
    assert.equal(theilSenSlope([]), 0);
    assert.equal(theilSenSlope([42]), 0);
  });

  void it('resists one noisy checkpoint', () => {
    assert.equal(theilSenSlope([100, 110, 1_000, 130, 140]), 10);
  });
});

void describe('summarizeTrend', () => {
  void it('reports net growth and directional consistency', () => {
    const summary = summarizeTrend([100, 110, 105, 120]);
    assert.deepEqual(
      { ...summary, slopePerCheckpoint: undefined },
      {
        samples: 4,
        first: 100,
        last: 120,
        netChange: 20,
        slopePerCheckpoint: undefined,
        positiveDeltaRatio: 2 / 3,
        nonDecreasingDeltaRatio: 2 / 3,
      }
    );
    assert.ok(Math.abs(summary.slopePerCheckpoint - 35 / 6) <= Number.EPSILON * 8);
  });
});
