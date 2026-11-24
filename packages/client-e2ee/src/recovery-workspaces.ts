import { Deferred, Effect, Exit, Option, Result } from 'effect';
import { readWorkspaceRecoveryProgress, type RecoveryVault } from '@lody/e2ee-core';
import type { RecoveryVaultLocalStore } from '@lody/e2ee-core/services';
import { api, type E2eeWorkspaceHistoryPage } from '@lody/cloud-api';
import {
  accountPairingOffer,
  verifyPersonalHistory,
  type PersonalPairingOffer,
} from '@lody/e2ee-client';
import {
  readRecoveryHistory,
  recoveryRestoreIncomplete,
  restoreOutcome,
  type VaultWorkspaceRestoreResult,
} from '@lody/e2ee-client/recovery-restore';
import { recoveryFetchEnvelope } from '@lody/e2ee-client/vault-replacement';
import {
  Bytes,
  getCommittedEpochStagingKey,
  hashRecordBytes,
  wipeRecoveryPackage,
} from '@lody/e2ee-core/protocol';
import { decodeEpochStagedGroup, ownEpochStagedGroupKey } from '@lody/e2ee-core/host';
import { personalEntryPins } from './entry-pins';
import type { PersonalEntryRecovery } from './entry';
import {
  makeClientRecovery,
  type ClientRecoveryOptions,
  type ClientRecoveryUnlock,
} from './recovery';
import { clientRecoveryJournal } from './recovery-journal';
import { hex, raw, historyPage } from './network';
/** One workspace's result: a restore outcome, or a setup's `recoverable` /
 * `not-admitted` (a setup that did not finish is `Pending`, `Failed` or `Unconfirmed`). */
export type RecoveryWorkspaceResult =
  | VaultWorkspaceRestoreResult
  | {
      readonly workspaceId: string;
      readonly name: string;
      readonly outcome: 'recoverable' | 'not-admitted';
      readonly partialEpochKey?: never;
    };
export type RecoveryWorkspaceProgress = {
  results: RecoveryWorkspaceResult[];
  waiting: boolean;
  pending: boolean;
};
/** This device's recovery state for one workspace, read from its own journal without V. */
export type RecoveryWorkspaceStatus =
  | { readonly kind: 'notSet' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'verified'; readonly update: number }
  | { readonly kind: 'unknown' };
/** Non-secret account plan. `covered` workspaces have a usable identity on this device. */
export type RecoveryWorkspacePlan = {
  readonly hasVault: boolean;
  readonly replacing: boolean;
  readonly methods?: {
    readonly hasFile: boolean;
    readonly hasPassword: boolean;
    readonly hasPasskey: boolean | null;
  };
  readonly covered: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: RecoveryWorkspaceStatus;
  }[];
  readonly uncovered: readonly { readonly id: string; readonly name: string }[];
};
export type RecoveryPasskeyState = {
  readonly passkeys: readonly { readonly entryId: string; readonly label: string }[];
  /** Removals this device began but did not finish: these may still unlock the vault. */
  readonly pending: readonly { readonly entryId: string; readonly label: string }[];
};
type Observe = (progress: RecoveryWorkspaceProgress) => void;
const workspaceWait = '30 seconds';
const rpcTimeout = '90 seconds';
export type RecoveryWorkspacesOptions = ClientRecoveryOptions & {
  readonly commands: PersonalEntryRecovery;
};
/** One vault unlock for the selected workspaces. The caller fixes platform and passkey; pins use that platform's constant namespace. */
export function makeRecoveryWorkspaces(options: RecoveryWorkspacesOptions) {
  const failure = () =>
    new Error(options.platform === 'web' ? 'e2ee_browser_unlock_failed' : 'e2ee_recovery_failed');
  const recovery = makeClientRecovery(options);
  const pins = personalEntryPins(`lody-e2ee:${options.platform}:v1:entry-pins`);
  let disposed = false;
  const check = () => {
    const current = options.currentSession();
    if (
      disposed ||
      !options.enabled() ||
      current?.accountId !== options.accountId ||
      current.sessionId !== options.sessionId
    ) {
      throw failure();
    }
  };
  const request = <A>(work: () => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        check();
        const value = await work();
        check();
        return value;
      },
      catch: () => failure(),
    });
  const rpc = <A>(work: () => Promise<A>) =>
    request(work).pipe(
      Effect.interruptible,
      Effect.timeoutOrElse({
        duration: rpcTimeout,
        orElse: () => Effect.fail(failure()),
      }),
      Effect.interruptible
    );
  const workspaceList = () => rpc(() => options.client.query(api.e2eeMembers.workspaces, {}));
  const pages = (workspaceId: string) =>
    readRecoveryHistory<E2eeWorkspaceHistoryPage, Error>((next) =>
      rpc(async () =>
        historyPage.parse(
          await options.client.action(api.e2eeWorkspaces.history, {
            workspaceId,
            ...(next ? { cursor: next.cursor, checkpoint: next.checkpoint } : {}),
          })
        )
      )
    );
  const envelope = (
    workspaceId: string,
    view: () => Effect.Effect<import('@lody/e2ee-core').LedgerView, unknown>
  ) =>
    recoveryFetchEnvelope({
      mailbox: (credential) => ({
        fetch: (epoch, cursor, limit) =>
          rpc(() =>
            options.client.query(api.e2eeMailbox.fetch, {
              workspaceId,
              credential,
              epoch,
              cursor,
              limit,
            })
          ).pipe(
            Effect.map((reply) => ({
              items: reply.items.map((row) => ({ sender: row.sender, frame: raw(row.frameHex) })),
            }))
          ),
      }),
      deliver: () => Effect.void,
      staged: (credential, epoch) =>
        Effect.gen(function* () {
          const key = getCommittedEpochStagingKey(yield* view(), epoch);
          if (Result.isFailure(key)) return null;
          // The verified locator also carries a local signer; only the four wire
          // fields belong in Convex arguments. The group is still verified by core.
          const wireKey = yield* Effect.fromResult(ownEpochStagedGroupKey(key.success));
          const group = yield* rpc(() =>
            options.client.query(api.e2eeEpochStaging.readGroup, {
              workspaceId,
              credential,
              key: wireKey,
            })
          );
          return group === null ? null : yield* Effect.fromResult(decodeEpochStagedGroup(group));
        }),
    });
  type Kind = 'restore' | 'setup';
  type Workspace = { id: string; name: string; genesisHash: string };
  const attempt = (
    kind: Kind,
    workspace: Workspace,
    vault: RecoveryVault,
    local: RecoveryVaultLocalStore['Service']
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (kind === 'restore') {
          const reference = (yield* vault.readIndex()).value.entries.find(
            (ref) => !ref.retired && ref.genesis === workspace.genesisHash
          );
          if (!reference) return { outcome: 'not-backed-up' } as const;
          const offer = yield* Effect.acquireUseRelease(
            vault.readEntry(reference),
            (bundle) =>
              Effect.sync(() =>
                accountPairingOffer(
                  {
                    workspaceId: workspace.id,
                    genesis: Result.getOrThrow(Bytes.genesisHash(raw(bundle.genesis))),
                  },
                  {
                    genesisRecordHex: hex(bundle.trust.genesisRecord),
                    membershipId: bundle.membershipId,
                  }
                )
              ),
            (bundle) => Effect.sync(() => wipeRecoveryPackage(bundle))
          );
          const read = () => pages(workspace.id);
          const view = () => Effect.flatMap(read(), (rows) => verifyPersonalHistory(offer, rows));
          const fetchCurrentEnvelope = envelope(workspace.id, view);
          const routed = () =>
            Effect.map(pins.read(options.accountId, workspace.id), (pin) =>
              pin && pin.phase !== 'cancelled' ? pin.offer : undefined
            );
          const restoreVia = (retained: PersonalPairingOffer | undefined) =>
            Effect.tryPromise({
              try: async () => {
                check();
                const value = await restoreWith(retained);
                check();
                return value;
              },
              catch: (error) => error,
            });
          const restoreWith = (retained: PersonalPairingOffer | undefined) =>
            options.commands.restore(workspace.id, retained ?? offer, {
              vault,
              local,
              reference,
              offer: retained,
              pages: read,
              fetchCurrentEnvelope,
              submitOriginalAsRecovery: (record, _identity, credential, credentialHash) =>
                Effect.acquireUseRelease(
                  Effect.succeed(credential),
                  (borrowed) =>
                    Effect.gen(function* () {
                      const existing = yield* read();
                      if (existing.some((page) => page.recordsHex.includes(hex(record))))
                        return { outcome: 'Committed' as const, record: record.slice() };
                      const signerCredential = hex(borrowed);
                      const reply = yield* rpc(() =>
                        options.client.action(api.e2eeWorkspaces.appendRecord, {
                          workspaceId: workspace.id,
                          requestId: hex(hashRecordBytes(record).toBytes()),
                          recordHex: hex(record),
                          credentialHash,
                          signerCredential,
                        })
                      );
                      return {
                        outcome:
                          reply.status === 'committed'
                            ? ('Committed' as const)
                            : ('Conflict' as const),
                        record: record.slice(),
                      };
                    }),
                  (borrowed) => Effect.sync(() => borrowed.fill(0))
                ),
            });
          const retained = yield* routed();
          const result = yield* restoreVia(retained).pipe(
            Effect.catchIf(
              (error) =>
                retained !== undefined &&
                error instanceof Error &&
                error.message === 'e2ee_device_revoked',
              () =>
                Effect.flatMap(routed(), (next) =>
                  next === undefined ? restoreVia(undefined) : Effect.fail(failure())
                )
            ),
            Effect.mapError(() => failure())
          );
          return restoreOutcome(result);
        }
        // A reused session may have been opened for reading. Authorize every backup
        // against the current replacement state before borrowing workspace keys.
        const state = yield* rpc(() =>
          options.client.query(api.e2eeRecoveryVault.replacementState, {})
        );
        if (vault.vaultId !== state.current || state.replacing !== null)
          return yield* Effect.fail(failure());
        const pin = yield* pins.read(options.accountId, workspace.id);
        if (pin?.phase !== 'ready') return { outcome: 'not-admitted' } as const;
        const result = yield* request(() =>
          options.commands.setup(workspace.id, {
            vault,
            local,
            fetchCurrentEnvelope: envelope(workspace.id, () =>
              Effect.flatMap(pages(workspace.id), (rows) => verifyPersonalHistory(pin.offer, rows))
            ),
            submitOriginal: (record, registration) =>
              rpc(() =>
                options.client.action(api.e2eeWorkspaces.appendRecord, {
                  workspaceId: workspace.id,
                  requestId: hex(hashRecordBytes(record).toBytes()),
                  recordHex: hex(record),
                  ...(registration
                    ? { credentialHash: hex(registration.recoveryCredentialHash) }
                    : {}),
                })
              ).pipe(
                Effect.map((reply) => ({
                  outcome:
                    reply.status === 'committed' ? ('Committed' as const) : ('Conflict' as const),
                  record: record.slice(),
                }))
              ),
          })
        );
        return {
          outcome:
            result.outcome === 'Committed' && result.recoverable
              ? ('recoverable' as const)
              : ('Pending' as const),
        };
      })
    );
  type Run = (
    kind: Kind,
    unlock: ClientRecoveryUnlock,
    selected: readonly string[],
    observe?: Observe,
    reserved?: boolean
  ) => Effect.Effect<RecoveryWorkspaceResult[], unknown>;
  let active: { ready: Deferred.Deferred<Run, unknown> } | undefined;
  const batch = (
    kind: Kind,
    unlock: ClientRecoveryUnlock,
    selected: readonly string[],
    observe?: Observe
  ): Effect.Effect<RecoveryWorkspaceResult[], unknown> =>
    Effect.suspend(() => {
      check();
      if (active)
        return Effect.flatMap(Deferred.await(active.ready), (run) =>
          run(kind, unlock, selected, observe)
        );
      const owner = { ready: Deferred.makeUnsafe<Run, unknown>() };
      active = owner;
      return recovery
        .withVault(unlock, false, (vault, _passkey, local) =>
          Effect.scoped(
            Effect.gen(function* () {
              const scope = yield* Effect.scope;
              const idle = Deferred.makeUnsafe<void>();
              // Reserve the first batch before publishing this session to later callers.
              let pending = 1;
              let accepting = true;
              const jobs = new Map<
                string,
                { kind: Kind; done: Deferred.Deferred<RecoveryWorkspaceResult> }
              >();
              const release = () => {
                if (--pending === 0) {
                  accepting = false;
                  if (active === owner) active = undefined;
                  Deferred.doneUnsafe(idle, Effect.void);
                }
              };
              const run: Run = (nextKind, nextUnlock, ids, observe, reserved = false) =>
                Effect.suspend(() => {
                  // Admission and retirement are synchronous; never fork into a closing Scope.
                  if (!accepting) return batch(nextKind, nextUnlock, ids, observe);
                  if (!reserved) pending++;
                  return Effect.gen(function* () {
                    const results = new Map<string, RecoveryWorkspaceResult>();
                    const unfinished = new Set<string>();
                    let chosen: Workspace[] = [];
                    const snapshot = () =>
                      chosen.flatMap((w) => (results.has(w.id) ? [{ ...results.get(w.id)! }] : []));
                    const emit = () => {
                      try {
                        observe?.({
                          results: snapshot(),
                          waiting: results.size < chosen.length,
                          pending: unfinished.size > 0,
                        });
                      } catch {
                        /* A view cannot cancel a producer or replace its result. */
                      }
                    };
                    const work = yield* Effect.gen(function* () {
                      const visible = yield* workspaceList();
                      chosen = visible.filter((w) => ids.includes(w.id));
                      return yield* Effect.forEach(chosen, (workspace) =>
                        Effect.gen(function* () {
                          let job = jobs.get(workspace.id);
                          if (job && job.kind !== nextKind) {
                            results.set(workspace.id, {
                              workspaceId: workspace.id,
                              name: workspace.name,
                              outcome: 'Unconfirmed',
                            });
                            return { workspace, done: undefined };
                          }
                          if (!job) {
                            job = {
                              kind: nextKind,
                              done: Deferred.makeUnsafe<RecoveryWorkspaceResult>(),
                            };
                            const owned = job;
                            jobs.set(workspace.id, owned);
                            pending++;
                            yield* Effect.gen(function* () {
                              const result = yield* Effect.exit(
                                attempt(nextKind, workspace, vault, local)
                              );
                              // Remove settled attempts: failure/Pending must remain retryable.
                              if (jobs.get(workspace.id) === owned) jobs.delete(workspace.id);
                              const settled: RecoveryWorkspaceResult = {
                                workspaceId: workspace.id,
                                name: workspace.name,
                                ...(Exit.isSuccess(result)
                                  ? result.value
                                  : { outcome: 'Failed' as const }),
                              };
                              yield* Deferred.succeed(owned.done, settled);
                            }).pipe(
                              Effect.ensuring(Effect.sync(release)),
                              Effect.uninterruptible,
                              Effect.forkIn(scope)
                            );
                          }
                          unfinished.add(workspace.id);
                          return { workspace, done: job.done };
                        })
                      );
                    }).pipe(Effect.ensuring(Effect.sync(release)));
                    emit();
                    yield* Effect.forEach(
                      work,
                      ({ workspace, done }) =>
                        !done
                          ? Effect.void
                          : Effect.gen(function* () {
                              // Only this waiter is interruptible. The original producer, vault,
                              // PRF, journal and submitted bytes remain owned until real settlement.
                              const local = yield* Deferred.await(done).pipe(
                                Effect.timeoutOption(workspaceWait),
                                Effect.interruptible
                              );
                              if (Option.isNone(local)) {
                                results.set(workspace.id, {
                                  workspaceId: workspace.id,
                                  name: workspace.name,
                                  outcome: 'Unconfirmed',
                                });
                                emit();
                              }
                              const result = Option.isSome(local)
                                ? local.value
                                : yield* Deferred.await(done);
                              results.set(workspace.id, result);
                              unfinished.delete(workspace.id);
                              emit();
                            }),
                      { concurrency: 'unbounded' }
                    );
                    return snapshot();
                  }).pipe(Effect.uninterruptible);
                });
              yield* Deferred.succeed(owner.ready, run);
              return yield* run(kind, unlock, selected, observe, true).pipe(
                Effect.ensuring(Deferred.await(idle))
              );
            })
          )
        )
        .pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (active === owner) active = undefined;
              if (Exit.isFailure(exit)) yield* Deferred.failCause(owner.ready, exit.cause);
            })
          ),
          Effect.uninterruptible
        );
    });
  const passkeyState = (vault: RecoveryVault) =>
    Effect.gen(function* () {
      const passkeys = (yield* vault.listPasskeys()).map(({ entryId, label }) => ({
        entryId,
        label,
      }));
      const pending = (yield* vault.pendingPasskeyRemovals()).map(({ entryId, label }) => ({
        entryId,
        label,
      }));
      return { passkeys, pending } satisfies RecoveryPasskeyState;
    });
  // Same rule as the desktop plan: only a recoverable row with a tested key update is
  // verified; an undecodable row is unknown rather than hiding every other workspace.
  const plan = (): Effect.Effect<RecoveryWorkspacePlan, unknown> =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* rpc(() =>
          options.client.query(api.e2eeRecoveryVault.replacementState, {})
        );
        const visible = yield* workspaceList();
        const local = yield* clientRecoveryJournal(options.accountId, check, options.platform);
        const progress = state.current
          ? yield* readWorkspaceRecoveryProgress(local, state.current)
          : [];
        const covered: RecoveryWorkspacePlan['covered'][number][] = [];
        const uncovered: { id: string; name: string }[] = [];
        for (const workspace of visible) {
          // A pin or restore marker that cannot be read is unknown and not acted on.
          const usable = yield* Effect.exit(
            Effect.gen(function* () {
              const pin = yield* pins.read(options.accountId, workspace.id);
              if (pin?.phase !== 'ready') return false;
              return !(yield* recoveryRestoreIncomplete(local, workspace.id));
            })
          );
          const row = { id: workspace.id, name: workspace.name };
          if (Exit.isFailure(usable)) {
            covered.push({ ...row, status: { kind: 'unknown' } });
            continue;
          }
          if (!usable.value) {
            uncovered.push(row);
            continue;
          }
          const found = progress.find((entry) => entry.genesis === workspace.genesisHash);
          covered.push({
            ...row,
            status: !found
              ? { kind: 'notSet' }
              : found.stage === 'unknown'
                ? { kind: 'unknown' }
                : found.stage === 'recoverable' && found.testedEpoch !== null
                  ? { kind: 'verified', update: found.testedEpoch }
                  : { kind: 'saved' },
          });
        }
        yield* Effect.try({ try: check, catch: failure });
        return {
          ...(state.current ? { methods: yield* recovery.methods(state.current) } : {}),
          hasVault: state.current !== null,
          replacing: state.replacing !== null,
          covered,
          uncovered,
        };
      })
    ).pipe(Effect.mapError(() => failure()));
  return {
    ...recovery,
    listWorkspaces: () => workspaceList(),
    plan,
    /** Open the vault and report only its non-secret identity and live workspace count. */
    inspect: (unlock: ClientRecoveryUnlock) =>
      recovery.withVault(unlock, false, (vault) =>
        Effect.map(vault.readIndex(), (index) => ({
          vaultId: vault.vaultId,
          workspaces: index.value.entries.filter((entry) => !entry.retired).length,
        }))
      ),
    passkeys: (unlock: ClientRecoveryUnlock) => recovery.withVault(unlock, false, passkeyState),
    /** An unfinished removal is reported as such, never as removed or as a plain failure.
     * A confirmed removal stands even when the list cannot be read again: it is returned
     * without lists, so the caller drops its old list and reads it with a fresh unlock. */
    removePasskey: (
      unlock: ClientRecoveryUnlock,
      entryId: string
    ): Effect.Effect<({ removed: boolean } & RecoveryPasskeyState) | { removed: true }, unknown> =>
      recovery.withVault(unlock, true, (vault) =>
        Effect.gen(function* () {
          const removed = yield* Effect.exit(vault.removePasskey(entryId));
          const state = yield* Effect.exit(passkeyState(vault));
          if (Exit.isFailure(state)) {
            if (Exit.isSuccess(removed)) return { removed: true as const };
            return yield* Effect.failCause(removed.cause);
          }
          if (
            Exit.isFailure(removed) &&
            !state.value.pending.some((row) => row.entryId === entryId)
          )
            return yield* Effect.failCause(removed.cause);
          return { removed: Exit.isSuccess(removed), ...state.value };
        })
      ),
    restore: (unlock: ClientRecoveryUnlock, selected: readonly string[], observe?: Observe) =>
      batch('restore', unlock, [...selected], observe),
    setup: (unlock: ClientRecoveryUnlock, selected: readonly string[], observe?: Observe) =>
      batch('setup', unlock, [...selected], observe),
    dispose: () => {
      disposed = true;
      recovery.dispose();
    },
  };
}
