import { describe, expect, it } from 'vitest';
import { CliRuntimeStateSchema } from '@lody/shared/electron-ipc';
import { CliRuntimeStateReporter } from './cli-runtime-state';

describe('CLI runtime state: encrypted outage windows', () => {
  it('publishes the window ends the desktop shows, and drops them once access is confirmed', () => {
    let now = 1_000;
    const reporter = new CliRuntimeStateReporter({ pid: 7, now: () => now });
    expect(reporter.snapshot().e2eeAccessWindows).toBeUndefined();

    reporter.setE2eeAccessWindow('workspace-a', {
      executionUntilMs: 4 * 3_600_000,
      readUntilMs: 24 * 3_600_000,
    });
    now = 2_000;
    const relying = reporter.snapshot();
    // The desktop parses this snapshot with the shared schema before reading the window.
    expect(CliRuntimeStateSchema.parse(relying).e2eeAccessWindows).toEqual({
      'workspace-a': { executionUntilMs: 4 * 3_600_000, readUntilMs: 24 * 3_600_000 },
    });

    // The same window again is not a change.
    reporter.setE2eeAccessWindow('workspace-a', {
      executionUntilMs: 4 * 3_600_000,
      readUntilMs: 24 * 3_600_000,
    });
    expect(reporter.snapshot().updatedAtMs).toBe(relying.updatedAtMs);

    reporter.setE2eeAccessWindow('workspace-a', undefined);
    expect(reporter.snapshot().e2eeAccessWindows).toBeUndefined();
  });
});
