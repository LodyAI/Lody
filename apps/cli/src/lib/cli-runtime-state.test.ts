import { describe, expect, it } from 'vitest';
import type { CliRuntimeWorkspace } from '@lody/shared';
import { CliRuntimeStateReporter } from './cli-runtime-state';

function workspace(
  backendConnection: CliRuntimeWorkspace['backendConnection']
): CliRuntimeWorkspace {
  return {
    id: 'workspace-1',
    name: 'Alpha',
    slug: 'alpha',
    role: 'owner',
    backendConnection,
  };
}

describe('CliRuntimeStateReporter connection age', () => {
  it('preserves one backend outage across connecting and disconnected states', () => {
    let nowMs = 1_000;
    const reporter = new CliRuntimeStateReporter({ now: () => nowMs });

    expect(reporter.snapshot().connectionAges?.backendNotConnectedSinceMs).toBe(1_000);

    nowMs = 5_000;
    reporter.setBackendConnection('disconnected');
    expect(reporter.snapshot().connectionAges?.backendNotConnectedSinceMs).toBe(1_000);

    nowMs = 9_000;
    reporter.setBackendConnection('connecting');
    expect(reporter.snapshot().connectionAges?.backendNotConnectedSinceMs).toBe(1_000);

    reporter.setBackendConnection('connected');
    expect(reporter.snapshot().connectionAges?.backendNotConnectedSinceMs).toBeUndefined();

    nowMs = 12_000;
    reporter.setBackendConnection('disconnected');
    expect(reporter.snapshot().connectionAges?.backendNotConnectedSinceMs).toBe(12_000);
  });

  it('tracks each workspace outage independently and resets it on connection', () => {
    let nowMs = 1_000;
    const reporter = new CliRuntimeStateReporter({ now: () => nowMs });

    reporter.setConnectedWorkspaces([workspace('disconnected')]);
    expect(reporter.snapshot().connectionAges?.workspaceNotConnectedSinceMs?.['workspace-1']).toBe(
      1_000
    );

    nowMs = 5_000;
    reporter.setConnectedWorkspaces([workspace('reconnecting')]);
    expect(reporter.snapshot().connectionAges?.workspaceNotConnectedSinceMs?.['workspace-1']).toBe(
      1_000
    );

    reporter.setConnectedWorkspaces([workspace('connected')]);
    expect(
      reporter.snapshot().connectionAges?.workspaceNotConnectedSinceMs?.['workspace-1']
    ).toBeUndefined();

    nowMs = 12_000;
    reporter.setConnectedWorkspaces([workspace('reconnecting')]);
    expect(reporter.snapshot().connectionAges?.workspaceNotConnectedSinceMs?.['workspace-1']).toBe(
      12_000
    );
  });

  it('omits cloud connection ages when the platform has no backend', () => {
    const reporter = new CliRuntimeStateReporter({
      now: () => 1_000,
      trackBackendConnectionAge: false,
    });

    reporter.setConnectedWorkspaces([workspace('disconnected')]);
    expect(reporter.snapshot().connectionAges).toBeUndefined();
  });
});
