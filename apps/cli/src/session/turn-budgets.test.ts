import { describe, expect, it } from 'vitest';
import { TURN_BUDGETS } from './turn-budgets';

describe('turn release budgets', () => {
  it('ends a Git observation before the shared workspace-statistics budget', () => {
    expect(TURN_BUDGETS.gitObservationMs).toBeLessThan(TURN_BUDGETS.workspaceStatsMs);
  });

  it('writes shutdown release receipts inside the CLI shutdown budget', () => {
    expect(
      TURN_BUDGETS.shutdownReleaseWaitMs + TURN_BUDGETS.shutdownForcedWriteMs
    ).toBeLessThanOrEqual(TURN_BUDGETS.cliShutdownMs);
  });
});
