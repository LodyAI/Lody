/** Authenticated recovery helpers for personal-device hosts. Explicit recovery
 * preserves admission and custody checks; product rollout belongs to the host. */
import { Effect, Exit, Result, Schema, type Scope } from 'effect';
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
import { verifyLedger, wipeRecoveryPackage } from '@lody/e2ee-core/protocol';
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
 * available committed epoch before R admits the new device. Private keys are wiped here.
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

const RecoveryCheckpointSchema = Schema.Struct({ headHash: Schema.String, length: Schema.Number });

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
      const { records, checkpoint } = yield* Effect.try({
        try: () => {
          const first = pages[0];
          const point = Result.getOrThrow(
            Schema.decodeUnknownResult(RecoveryCheckpointSchema)(first?.checkpoint)
          );
          if (
            !Number.isSafeInteger(point.length) ||
            point.length < 1 ||
            pages.at(-1)?.nextCursor !== null
          )
            throw new Error('invalid recovery checkpoint');
          const records: Uint8Array[] = [];
          for (const page of pages) {
            const boundary = Result.getOrThrow(
              Schema.decodeUnknownResult(RecoveryCheckpointSchema)(page.checkpoint)
            );
            if (
              page.startIndex !== records.length ||
              boundary.headHash !== point.headHash ||
              boundary.length !== point.length
            )
              throw new Error('inconsistent recovery page');
            records.push(...page.recordsHex.map(fromHex));
          }
          if (records.length !== point.length) throw new Error('incomplete recovery history');
          return {
            records,
            checkpoint: {
              head: Result.getOrThrow(Bytes.recordHash(fromHex(point.headHash))),
              length: point.length,
            },
          };
        },
        catch: () => new RecoveryVaultError({ code: 'authentication' }),
      });
      return yield* Effect.fromResult(verifyLedger({ anchor: input.genesis, records, checkpoint }));
    }) as Effect.Effect<LedgerView, unknown>;

const restoreProgressKey = (workspaceId: string) => `restore-progress/${workspaceId}`;
const RESTORE_OPEN = new TextEncoder().encode('open');
const RESTORE_PARTIAL = new TextEncoder().encode('partial');
const RESTORE_DONE = new TextEncoder().encode('done');
const isOpen = (value: Uint8Array | null) =>
  value !== null && new TextDecoder().decode(value) === 'open';

const isIncomplete = (value: Uint8Array | null) =>
  value !== null && ['open', 'partial'].includes(new TextDecoder().decode(value));

/** True until admission, adoption and current-epoch key recovery have completed.
 * Partial recovery stays retryable through R without another device admission. */
export const recoveryRestoreIncomplete = (
  local: WorkspaceRecoveryInput['local'],
  workspaceId: string
) => Effect.map(local.read(restoreProgressKey(workspaceId)), isIncomplete);

/** Durable progress of one workspace's restore, shared by `restoreVaultWorkspaces` and
 * the personal host's single-workspace restore. `begin` marks the restore open (a
 * finished marker from an earlier vault is reopened, so it cannot hide this attempt's
 * failure); `finish` records `partial` or `done` and fails as `conflict` when another
 * writer moved the marker, so an unrecorded restore is never reported as finished. */
export const recoveryRestoreProgress = (
  local: WorkspaceRecoveryInput['local'],
  workspaceId: string
) => {
  const key = restoreProgressKey(workspaceId);
  return {
    begin: () =>
      Effect.gen(function* () {
        const progress = yield* local.read(key);
        if (isOpen(progress)) return;
        const opened = yield* local.compareAndSwap(key, progress, RESTORE_OPEN);
        if (opened !== 'Committed')
          return yield* Effect.fail(new RecoveryVaultError({ code: 'conflict' }));
      }),
    finish: (partialEpochKey: boolean | undefined) =>
      Effect.gen(function* () {
        const finished = yield* local.compareAndSwap(
          key,
          RESTORE_OPEN,
          partialEpochKey === true ? RESTORE_PARTIAL : RESTORE_DONE
        );
        if (finished !== 'Committed')
          return yield* Effect.fail(new RecoveryVaultError({ code: 'conflict' }));
      }),
  };
};

/** One workspace a vault can restore onto this device. */
export interface RecoveryRestoreTarget {
  readonly id: string;
  readonly name: string;
  readonly genesisHash: string;
  /**
   * Whether this device already holds an identity for the workspace. `'unknown'` means the
   * check itself failed (for example a busy lease): nothing is restored over it, and the
   * workspace is reported `Failed` so the caller can retry, unless an earlier restore of
   * it is open or partial, which resumes as usual.
   */
  readonly hasIdentity: () => boolean | 'unknown';
  /** Optionally stage a raw first history page before package I/O, so independent
   * workspace reads can batch. This grants no trust and allocates no identity;
   * connect must authenticate it against the package and consume it only once. */
  readonly prepareHistory?: () => Effect.Effect<void>;
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

/** One workspace's restore outcome. Only a committed restore can be partial: admitted,
 * with newer epoch keys still to be installed by a later restore. `Unconfirmed` is a
 * wait that ran out while the restore continues; `not-backed-up` means the vault has no
 * package for the workspace. */
export type RestoreOutcome =
  | { readonly outcome: 'Committed'; readonly partialEpochKey?: true }
  | {
      readonly outcome: 'Pending' | 'Conflict' | 'Unconfirmed' | 'Failed' | 'not-backed-up';
      readonly partialEpochKey?: never;
    };

/** A workspace's restore result, keyed by ID because names repeat. */
export type VaultWorkspaceRestoreResult = RestoreOutcome & {
  readonly workspaceId: string;
  readonly name: string;
};

/** The outcome a restore workflow result reports, keeping its partial marker. */
export const restoreOutcome = (result: {
  readonly outcome: 'Committed' | 'Conflict' | 'Pending';
  readonly partialEpochKey?: boolean;
}): RestoreOutcome =>
  result.outcome === 'Committed'
    ? result.partialEpochKey === true
      ? { outcome: 'Committed', partialEpochKey: true }
      : { outcome: 'Committed' }
    : { outcome: result.outcome };

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
  /** Observation only, after that attempt's scope has drained. Observer failure cannot undo it. */
  readonly onResult?: (result: VaultWorkspaceRestoreResult) => Effect.Effect<void>;
}) {
  const results = new Map<number, VaultWorkspaceRestoreResult>();
  const report = Effect.fnUntraced(function* (
    position: number,
    result: VaultWorkspaceRestoreResult
  ) {
    results.set(position, result);
    if (input.onResult) yield* Effect.exit(input.onResult(result));
  });
  const lanes = new Map<
    string,
    Array<{ reference: RecoveryEntryReference; target: RecoveryRestoreTarget; position: number }>
  >();
  const references = yield* listVaultWorkspaces(input.vault);
  for (const [position, reference] of references.entries()) {
    const target = input.targets.find((row) => row.genesisHash === reference.genesis);
    if (!target) continue;
    const lane = lanes.get(target.id) ?? [];
    lane.push({ reference, target, position });
    lanes.set(target.id, lane);
  }
  // Different workspaces own separate journals/identities. Old membership
  // references for one workspace must retain their original serial order.
  yield* Effect.forEach(
    lanes.values(),
    (lane) =>
      Effect.gen(function* () {
        for (const { reference, target, position } of lane) {
          const progress = yield* input.local.read(restoreProgressKey(target.id));
          const identity = target.hasIdentity();
          if (identity === 'unknown' && !isIncomplete(progress)) {
            yield* report(position, {
              workspaceId: target.id,
              name: target.name,
              outcome: 'Failed',
            });
            continue;
          }
          if (identity === true && !isIncomplete(progress)) continue;
          if (target.prepareHistory) yield* target.prepareHistory();
          const attempt = Effect.scoped(
            Effect.gen(function* () {
              const marker = recoveryRestoreProgress(input.local, target.id);
              yield* marker.begin();
              let connected:
                | Effect.Success<ReturnType<RecoveryRestoreTarget['connect']>>
                | undefined;
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
                yield* marker.finish(result.partialEpochKey);
              }
              return restoreOutcome(result);
            })
          );
          const exit = yield* Effect.exit(attempt);
          yield* report(position, {
            workspaceId: target.id,
            name: target.name,
            ...(Exit.isSuccess(exit) ? exit.value : { outcome: 'Failed' as const }),
          });
        }
      }),
    { concurrency: 4, discard: true }
  );
  return [...results].sort(([a], [b]) => a - b).map(([, result]) => result);
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
