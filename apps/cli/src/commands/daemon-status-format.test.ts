import { describe, expect, it } from 'vitest';
import type { CliRuntimeState } from '@lody/shared';
import { formatDaemonBackendStatus, type DaemonStatusPalette } from './daemon-status-format';

const palette: DaemonStatusPalette = {
  success: (value) => `<green>${value}</green>`,
  warning: (value) => `<yellow>${value}</yellow>`,
  error: (value) => `<red>${value}</red>`,
  muted: (value) => `<gray>${value}</gray>`,
};

const runtimeState = (overrides: Partial<CliRuntimeState> = {}): CliRuntimeState => ({
  schemaVersion: 1,
  phase: 'running',
  pid: 123,
  updatedAtMs: 1,
  issues: [],
  ...overrides,
});

describe('formatDaemonBackendStatus', () => {
  it('reports a red error after a connection stays unavailable for one minute', () => {
    expect(
      formatDaemonBackendStatus(
        runtimeState({
          backend: {
            authorization: 'authorized',
            connection: 'connecting',
          },
          connectionAges: {
            backendNotConnectedSinceMs: 60_000,
            workspaceNotConnectedSinceMs: { 'workspace-1': 30_000 },
          },
          connectedWorkspaces: [
            {
              id: 'workspace-1',
              name: 'Alpha',
              slug: 'alpha',
              role: 'owner',
              backendConnection: 'reconnecting',
            },
          ],
        }),
        { palette, nowMs: 120_000 }
      )
    ).toEqual([
      '  Backend Auth: <green>authorized</green>',
      '  Backend Link: <red>connecting (1m)</red>',
      '<red>  Backend Error: not connected for 1m</red>',
      '  Workspaces:   1',
      '    - Alpha (alpha) [owner]',
      '      ID: workspace-1',
      '      Backend: <red>reconnecting (1m 30s)</red>',
      '<red>      Error: not connected for 1m 30s</red>',
    ]);
  });

  it('does not claim backend state for an older daemon payload', () => {
    expect(formatDaemonBackendStatus(runtimeState(), { palette })).toEqual([
      '  Backend Auth: <gray>unknown</gray>',
      '  Backend Link: <gray>unknown</gray>',
      '  Workspaces:   <gray>unavailable</gray>',
    ]);
  });
});
