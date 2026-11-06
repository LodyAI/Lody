/** Restore from an unlocked vault with nothing known about the workspace. No
 * product flow calls this yet, so it changes no create, join or pairing path. */
import { Effect, Result, type Scope } from 'effect';
import {
  Bytes,
  RecoveryVaultError,
  type LedgerView,
  type RecoveryEntryReference,
  type RecoveryVault,
  type WorkspaceRecoveryInput,
  type WorkspaceRestorePlan,
} from '@lody/e2ee-core';
import { wipeRecoveryPackage } from '@lody/e2ee-core/protocol';
import { fromHex } from './bytes';

/** Workspaces this vault can restore: the live entries of its authenticated index. */
export const listVaultWorkspaces = (
  vault: RecoveryVault
): Effect.Effect<readonly RecoveryEntryReference[], unknown> =>
  vault.readIndex().pipe(Effect.map((index) => index.value.entries.filter((ref) => !ref.retired)));

/** What an authenticated package establishes, and the only input to the ports. */
export interface VaultRestoreAnchor {
  readonly genesis: Bytes.GenesisHash;
  readonly membershipId: Bytes.MembershipId;
  readonly recovery: Bytes.SigningPublicKey;
}

/** The platform's connections, opened only once the package names the workspace. */
export interface VaultRestorePorts {
  readonly ledger: () => Effect.Effect<LedgerView, unknown>;
  readonly fetchCurrentEnvelope: WorkspaceRecoveryInput['fetchCurrentEnvelope'];
  readonly installed: WorkspaceRecoveryInput['installed'];
  readonly submitOriginalAsRecovery: WorkspaceRestorePlan['submitOriginalAsRecovery'];
  readonly acquirePersonal: WorkspaceRestorePlan['acquirePersonal'];
}

export interface VaultRestoreInput {
  readonly vault: RecoveryVault;
  readonly local: WorkspaceRecoveryInput['local'];
  readonly reference: RecoveryEntryReference;
  readonly personalSigner: WorkspaceRecoveryInput['personalSigner'];
  readonly ports: (
    anchor: VaultRestoreAnchor
  ) => Effect.Effect<VaultRestorePorts, unknown, Scope.Scope>;
}

/**
 * Build a restore plan whose genesis comes only from the authenticated package.
 * Core then verifies the ledger from it, the package checkpoint and the current
 * epoch commitment before R admits the new device. Private keys are wiped here.
 */
export const prepareVaultRestore = Effect.fnUntraced(function* (input: VaultRestoreInput) {
  const { anchor, trust } = yield* Effect.acquireUseRelease(
    input.vault.readEntry(input.reference),
    (bundle) =>
      Effect.try({
        try: () => ({
          anchor: {
            genesis: Result.getOrThrow(Bytes.genesisHash(fromHex(bundle.genesis))),
            membershipId: Result.getOrThrow(Bytes.membershipId(fromHex(bundle.membershipId))),
            recovery: Result.getOrThrow(Bytes.signingPublicKey(bundle.signingPublic)),
          },
          trust: { ...bundle.trust, genesisRecord: new Uint8Array(bundle.trust.genesisRecord) },
        }),
        catch: () => new RecoveryVaultError({ code: 'authentication' }),
      }),
    (bundle) => Effect.sync(() => wipeRecoveryPackage(bundle))
  );
  const ports = yield* input.ports(anchor);
  const plan: WorkspaceRestorePlan = {
    workflow: {
      vault: input.vault,
      local: input.local,
      genesis: anchor.genesis,
      membershipId: anchor.membershipId,
      personalSigner: input.personalSigner,
      ledger: ports.ledger,
      installed: ports.installed,
      trust,
      fetchCurrentEnvelope: ports.fetchCurrentEnvelope,
      // A restore submits only through R; setup belongs to a personal device.
      submitOriginal: () => Effect.fail(new RecoveryVaultError({ code: 'invalid-input' })),
    },
    submitOriginalAsRecovery: ports.submitOriginalAsRecovery,
    acquirePersonal: ports.acquirePersonal,
  };
  return plan;
});
