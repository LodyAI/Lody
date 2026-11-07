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
import { hashRecordBytes, verifyLedger, wipeRecoveryPackage } from '@lody/e2ee-core/protocol';
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
  readonly genesisRecord: Uint8Array;
}

/** The platform's connections, opened only once the package names the workspace. */
export interface VaultRestorePorts {
  /** The new personal device, created once the package names the workspace. */
  readonly personalSigner: WorkspaceRecoveryInput['personalSigner'];
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
            genesisRecord: new Uint8Array(bundle.trust.genesisRecord),
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
      personalSigner: ports.personalSigner,
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

/** One page of the service's ledger history. */
export interface RecoveryHistoryPage {
  readonly startIndex: number;
  readonly recordsHex: readonly string[];
  readonly nextCursor: string | null;
}

/** Replay the complete served history from the package's genesis. Each call rereads it,
 * because a restore must see its own admission. */
export const recoveryLedger =
  (input: {
    readonly genesis: Bytes.GenesisHash;
    readonly pages: () => Effect.Effect<readonly RecoveryHistoryPage[], unknown>;
  }) =>
  () =>
    Effect.gen(function* () {
      const pages = yield* input.pages();
      if (pages[0]?.startIndex !== 0)
        return yield* Effect.fail(new RecoveryVaultError({ code: 'authentication' }));
      const records = pages.flatMap((page) => page.recordsHex).map(fromHex);
      return yield* Effect.fromResult(
        verifyLedger({
          anchor: input.genesis,
          records,
          checkpoint: { head: hashRecordBytes(records.at(-1)!), length: records.length },
        })
      );
    }) as Effect.Effect<LedgerView, unknown>;
