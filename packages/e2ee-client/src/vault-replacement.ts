/** Whole-vault replacement: every workspace proves its new R before any old R is
 * revoked, and the old vault retires last. No product flow calls this yet. */
import { Effect } from 'effect';

/** One workspace's recovery owner, bound to the new vault. */
export interface VaultReplacementWorkspace {
  readonly name: string;
  readonly setup: () => Effect.Effect<
    { readonly outcome: string; readonly status: { readonly recoverable: boolean } },
    unknown
  >;
  readonly revokeOtherRecoveryDevices: () => Effect.Effect<{ readonly outcome: string }, unknown>;
}

export type VaultReplacementResult =
  | { readonly outcome: 'Committed' }
  /** Stopped at this workspace. Rerunning resumes; nothing is signed twice. */
  | { readonly outcome: 'Pending'; readonly step: 'setup' | 'revoke'; readonly workspace: string };

/** Safe to rerun from any point: each step resumes from its own durable journal. */
export const replaceAccountVault = Effect.fnUntraced(function* (input: {
  readonly workspaces: readonly VaultReplacementWorkspace[];
  /** Make the new vault current. Runs once every old R is revoked. */
  readonly finish: () => Effect.Effect<void, unknown>;
}) {
  for (const workspace of input.workspaces) {
    const result = yield* workspace.setup();
    if (result.outcome !== 'Committed' || !result.status.recoverable)
      return {
        outcome: 'Pending',
        step: 'setup',
        workspace: workspace.name,
      } satisfies VaultReplacementResult as VaultReplacementResult;
  }
  for (const workspace of input.workspaces) {
    const result = yield* workspace.revokeOtherRecoveryDevices();
    if (result.outcome !== 'Committed')
      return {
        outcome: 'Pending',
        step: 'revoke',
        workspace: workspace.name,
      } satisfies VaultReplacementResult as VaultReplacementResult;
  }
  yield* input.finish();
  return { outcome: 'Committed' } satisfies VaultReplacementResult as VaultReplacementResult;
});
