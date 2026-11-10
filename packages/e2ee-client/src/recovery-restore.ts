/** Authenticated recovery helpers for personal-device hosts. Explicit recovery
 * preserves admission and custody checks; product rollout belongs to the host. */
import { Effect, Exit, Result, type Scope } from 'effect';
import {
  Bytes,
  makeWorkspaceRecovery,
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
  readonly checkpoint: unknown;
}

/** Read a complete history. Every continuation carries the first page's checkpoint, so
 * one read describes one fixed ledger. */
export const readRecoveryHistory = Effect.fnUntraced(function* <P extends RecoveryHistoryPage, E>(
  read: (next?: {
    readonly cursor: string;
    readonly checkpoint: P['checkpoint'];
  }) => Effect.Effect<P, E>
) {
  const first = yield* read();
  const pages = [first];
  for (let cursor = first.nextCursor; cursor; cursor = pages.at(-1)!.nextCursor) {
    if (pages.length >= 256) return yield* Effect.fail(new RecoveryVaultError({ code: 'storage' }));
    pages.push(yield* read({ cursor, checkpoint: first.checkpoint }));
  }
  return pages;
});

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

const restoreProgressKey = (workspaceId: string) => `restore-progress/${workspaceId}`;
const RESTORE_OPEN = new TextEncoder().encode('open');
const RESTORE_DONE = new TextEncoder().encode('done');
const isOpen = (value: Uint8Array | null) =>
  value !== null && new TextDecoder().decode(value) === 'open';

/** True while a restore has begun but its keys are not installed. Such a workspace has an
 * identity yet cannot decrypt, so it stays restorable and does not count as set up. */
export const recoveryRestoreIncomplete = (
  local: WorkspaceRecoveryInput['local'],
  workspaceId: string
) => Effect.map(local.read(restoreProgressKey(workspaceId)), isOpen);

/** One workspace a vault can restore onto this device. */
export interface RecoveryRestoreTarget {
  readonly id: string;
  readonly name: string;
  readonly genesisHash: string;
  /**
   * Whether this device already holds an identity for the workspace. `'unknown'` means the
   * check itself failed (for example a busy lease): nothing is restored over it, and the
   * workspace is reported `Failed` so the caller can retry, unless an earlier restore of
   * it is still open, which resumes as usual.
   */
  readonly hasIdentity: () => boolean | 'unknown';
  /** Connect only once the authenticated package names the workspace. */
  readonly connect: (anchor: VaultRestoreAnchor) => Effect.Effect<
    VaultRestorePorts & {
      readonly personal: VaultRestorePorts['personalSigner'] & {
        readonly encryptionPublicKey: Bytes.EncryptionPublicKey;
      };
      readonly recovered: () => readonly (readonly [number, Bytes.EpochKey])[];
      /** Adopt the identity and install the keys. Must be safe to repeat. */
      readonly adopt: (
        recovered: readonly (readonly [number, Bytes.EpochKey])[]
      ) => Effect.Effect<void, unknown>;
    },
    unknown,
    Scope.Scope
  >;
}

/**
 * Restore every workspace a vault covers and this account can name. The genesis comes
 * only from the authenticated package; ledger, checkpoint and key commitment are core's
 * checks. Durable progress keeps a workspace retryable until its keys are installed, and
 * one workspace's failure never stops the others.
 */
export const restoreVaultWorkspaces = Effect.fnUntraced(function* (input: {
  readonly vault: RecoveryVault;
  readonly local: WorkspaceRecoveryInput['local'];
  readonly targets: readonly RecoveryRestoreTarget[];
}) {
  const results: {
    readonly workspaceId: string;
    readonly name: string;
    readonly outcome: string;
  }[] = [];
  for (const reference of yield* listVaultWorkspaces(input.vault)) {
    const target = input.targets.find((row) => row.genesisHash === reference.genesis);
    if (!target) continue;
    const key = restoreProgressKey(target.id);
    const progress = yield* input.local.read(key);
    const identity = target.hasIdentity();
    if (identity === 'unknown' && !isOpen(progress)) {
      results.push({ workspaceId: target.id, name: target.name, outcome: 'Failed' });
      continue;
    }
    if (identity === true && !isOpen(progress)) continue;
    const attempt = Effect.scoped(
      Effect.gen(function* () {
        // A finished marker from an earlier vault must not hide this attempt's failure.
        if (!isOpen(progress)) {
          const opened = yield* input.local.compareAndSwap(key, progress, RESTORE_OPEN);
          if (opened !== 'Committed')
            return yield* Effect.fail(new RecoveryVaultError({ code: 'conflict' }));
        }
        let connected: Effect.Success<ReturnType<RecoveryRestoreTarget['connect']>> | undefined;
        const plan = yield* prepareVaultRestore({
          vault: input.vault,
          local: input.local,
          reference,
          ports: (anchor) =>
            Effect.tap(target.connect(anchor), (ports) =>
              Effect.sync(() => {
                connected = ports;
              })
            ),
        });
        const workflow = yield* makeWorkspaceRecovery(plan.workflow);
        const result = yield* workflow.restoreFromRecovery({
          personal: connected!.personal,
          submitOriginalAsRecovery: plan.submitOriginalAsRecovery,
        });
        if (result.outcome === 'Committed') {
          yield* connected!.adopt(connected!.recovered());
          yield* input.local.compareAndSwap(key, RESTORE_OPEN, RESTORE_DONE);
        }
        return result.outcome as string;
      })
    );
    const exit = yield* Effect.exit(attempt);
    results.push({
      workspaceId: target.id,
      name: target.name,
      outcome: Exit.isSuccess(exit) ? exit.value : 'Failed',
    });
  }
  return results;
});

/** Restore transport for a personal host. The host owns identity and installation;
 * these ports relay only signed history, R envelopes and the exact admission. */
export interface PersonalHostRecoveryInput {
  /** Exact retained offer when repairing an already admitted installation. It cannot replace package pins. */
  readonly offer?: import('./pairing').PersonalPairingOffer;
  readonly vault: RecoveryVault;
  readonly local: WorkspaceRecoveryInput['local'];
  readonly reference: RecoveryEntryReference;
  readonly pages: () => Effect.Effect<import('./admission').PersonalHistoryPages, unknown>;
  readonly fetchCurrentEnvelope: WorkspaceRecoveryInput['fetchCurrentEnvelope'];
  readonly submitOriginalAsRecovery: (
    ...args: [
      ...Parameters<WorkspaceRestorePlan['submitOriginalAsRecovery']>,
      deviceCredentialHash: string,
    ]
  ) => ReturnType<WorkspaceRestorePlan['submitOriginalAsRecovery']>;
}

/** Vault setup transports; personal signing and installed keys remain in the admitted session. */
export type PersonalRecoverySetupInput = Pick<
  WorkspaceRecoveryInput,
  'vault' | 'local' | 'submitOriginal' | 'fetchCurrentEnvelope'
>;
