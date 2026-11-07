/** Whole-vault replacement: every workspace proves its new R before any old R is
 * revoked, and the old vault retires last. No product flow calls this yet. */
import { Effect } from 'effect';
import {
  Bytes,
  type RecoveryCredentialRegistration,
  type RecoverySubmitResult,
  type WorkspaceRecoveryInput,
} from '@lody/e2ee-core';
import { hashRecordBytes } from '@lody/e2ee-core/protocol';
import { fromHex, toHex } from './bytes';

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

/** Submit a recovery record to the service, which registers R's credential hash with
 * R's admission. A record refused for its position reports Conflict; a failure stays
 * unknown, and core resends the same original. */
export const recoverySubmitOriginal =
  (input: {
    readonly append: (request: {
      readonly requestId: string;
      readonly recordHex: string;
      readonly credentialHash?: string;
    }) => Effect.Effect<{ readonly status: 'committed' | 'conflict' }, unknown>;
    readonly refresh: () => Effect.Effect<void, unknown>;
  }) =>
  (record: Uint8Array, registration: RecoveryCredentialRegistration | null) =>
    Effect.gen(function* () {
      const reply = yield* input.append({
        requestId: toHex(hashRecordBytes(record).toBytes()),
        recordHex: toHex(record),
        ...(registration ? { credentialHash: toHex(registration.recoveryCredentialHash) } : {}),
      });
      yield* input.refresh();
      return {
        outcome: reply.status === 'committed' ? 'Committed' : 'Conflict',
        record: new Uint8Array(record),
      } satisfies RecoverySubmitResult as RecoverySubmitResult;
    });

/** Read R's envelope from its mailbox as R. After a new admission nothing may be there
 * yet, so ask this device to deliver once. A delivery still on its way is Pending, not a
 * failure. */
export const recoveryFetchEnvelope =
  (input: {
    readonly mailbox: (credential: string) => {
      readonly fetch: (
        epoch: number,
        cursor: string | null,
        limit: number
      ) => Effect.Effect<
        {
          readonly items: readonly { readonly sender: string; readonly frame: Uint8Array }[];
        },
        unknown
      >;
    };
    readonly deliver: () => Effect.Effect<void, unknown>;
  }): WorkspaceRecoveryInput['fetchCurrentEnvelope'] =>
  (_recipient, epoch, _identity, credential) =>
    Effect.gen(function* () {
      const mailbox = input.mailbox(toHex(credential));
      let page = yield* mailbox.fetch(epoch, null, 100);
      if (page.items.length === 0) {
        yield* input.deliver();
        page = yield* mailbox.fetch(epoch, null, 100);
      }
      const row = page.items[0];
      if (!row) return { pending: true } as const;
      return {
        sender: yield* Effect.fromResult(Bytes.signingPublicKey(fromHex(row.sender))),
        frame: row.frame,
      };
    }).pipe(Effect.ensuring(Effect.sync(() => credential.fill(0))));
