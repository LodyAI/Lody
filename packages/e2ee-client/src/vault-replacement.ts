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
  readonly revokeOtherRecoveryDevices: (request?: {
    readonly compromised?: boolean;
  }) => Effect.Effect<{ readonly outcome: string }, unknown>;
}

/** A device acts only on workspaces it belongs to. The rest keep their old R, so the
 * warning must name them. */
export const planVaultReplacement = <W extends { readonly id: string }>(
  account: readonly W[],
  device: ReadonlySet<string>
) => ({
  covered: account.filter((workspace) => device.has(workspace.id)),
  uncovered: account.filter((workspace) => !device.has(workspace.id)),
});

export type VaultReplacementResult =
  | { readonly outcome: 'Committed' }
  /** Stopped at this workspace. Rerunning resumes; nothing is signed twice. */
  | { readonly outcome: 'Pending'; readonly step: 'setup' | 'revoke'; readonly workspace: string };

/** Safe to rerun from any point: each step resumes from its own durable journal. */
export const replaceAccountVault = Effect.fnUntraced(function* (input: {
  readonly workspaces: readonly VaultReplacementWorkspace[];
  /** A suspected leak: revoke first, accepting a gap in recovery. Retirement stays last. */
  readonly compromised?: boolean;
  /** Make the new vault current. Runs once every old R is revoked. */
  readonly finish: () => Effect.Effect<void, unknown>;
}) {
  const pending = (step: 'setup' | 'revoke', workspace: string): VaultReplacementResult => ({
    outcome: 'Pending',
    step,
    workspace,
  });
  if (input.compromised)
    for (const workspace of input.workspaces) {
      const result = yield* workspace.revokeOtherRecoveryDevices({ compromised: true });
      if (result.outcome !== 'Committed') return pending('revoke', workspace.name);
    }
  for (const workspace of input.workspaces) {
    const result = yield* workspace.setup();
    if (result.outcome !== 'Committed' || !result.status.recoverable)
      return pending('setup', workspace.name);
  }
  for (const workspace of input.workspaces) {
    const result = yield* workspace.revokeOtherRecoveryDevices();
    if (result.outcome !== 'Committed') return pending('revoke', workspace.name);
  }
  yield* input.finish();
  return { outcome: 'Committed' } satisfies VaultReplacementResult as VaultReplacementResult;
});

/** Give up an unfinished replacement on the device that started it: only its journal
 * tells a new R from an old one. The older vault is untouched. */
export const abandonVaultReplacement = Effect.fnUntraced(function* (input: {
  readonly workspaces: readonly {
    readonly name: string;
    readonly revokeOwnRecoveryDevice: () => Effect.Effect<{ readonly outcome: string }, unknown>;
  }[];
  /** Retire the unfinished vault. Runs once every new R is revoked. */
  readonly abandon: () => Effect.Effect<void, unknown>;
}) {
  for (const workspace of input.workspaces) {
    const result = yield* workspace.revokeOwnRecoveryDevice();
    if (result.outcome !== 'Committed')
      return {
        outcome: 'Pending',
        step: 'revoke',
        workspace: workspace.name,
      } satisfies VaultReplacementResult as VaultReplacementResult;
  }
  yield* input.abandon();
  return { outcome: 'Committed' } satisfies VaultReplacementResult as VaultReplacementResult;
});
