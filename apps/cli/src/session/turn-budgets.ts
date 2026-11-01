/**
 * Every bounded wait on the turn-release and shutdown paths, in one place.
 *
 * Ordering is part of the contract and `turn-budgets.test.ts` pins it:
 * - one Git observation command ends before the shared workspace-statistics budget,
 *   so a stuck probe is terminated by its own timeout and cannot write late;
 * - the shutdown release wait plus forced failed-release writes fit inside the CLI
 *   shutdown budget, so release receipts land before the process exits;
 * - Desktop's quit grace (`CLI_QUIT_GRACE_MS` in
 *   `apps/electron/src/main/services/cli-service.ts`, 10 s) stays above
 *   `cliShutdownMs`; it lives in another package, so keep that by review.
 */
export const TURN_BUDGETS = {
  /** One Git observation command (status, diff, branch). */
  gitObservationMs: 15_000,
  /** All workspace-reading results of one turn, shared by every end path. */
  workspaceStatsMs: 20_000,
  /** One post-release bookkeeping stage, and the yielded-finalization wait. */
  bookkeepingMs: 30_000,
  /** ACP prompt drain after Stop before the Agent is terminated instead. */
  cancelDrainMs: 5_000,
  /** Terminating a disconnected or retired Agent, and each background cleanup step. */
  agentCleanupMs: 5_000,
  /** Shutdown: wait for active releases before forcing failed receipts. */
  shutdownReleaseWaitMs: 6_000,
  /** Shutdown: forced failed-release writes. */
  shutdownForcedWriteMs: 1_000,
  /** Whole CLI shutdown, including the coordinator drain. */
  cliShutdownMs: 7_000,
} as const;
