import { Effect, Result } from 'effect';
import type {
  E2eeAppendRecordRequest,
  E2eeWorkspaceHistoryPage,
  E2eeWorkspaceHistoryRequest,
} from '@lody/cloud-api';
import type { E2eeAccountPairingRuntime, E2eeWorkspaceRuntime } from '@lody/platform';
import { accountUserId, decodeRecord, hashRecordBytes } from '@lody/e2ee-core/protocol';
import type {
  AccountPairingApproverWorkspace,
  AccountPairingRequesterWorkspace,
} from './account-pairing';
import { verifyPersonalHistory } from './admission';
import type { makePersonalDeviceHost } from './host';
import { decodePersonalRequest } from './pairing';
import { fromHex, toHex } from './bytes';

/**
 * New-device side of account-wide pairing on a portable host (mobile, Web). The
 * shared workflow (`./account-pairing`) owns tags, expiry and terminal states; this
 * module turns one workspace's host into its requester port, and routes an account's
 * runtime calls to per-workspace runtimes. Identity protection is never chosen here:
 * each workspace host keeps its platform's own custody (Keychain/Keystore, web-crypto).
 */

const fail = (code: string) => Object.assign(new Error(`e2ee_${code}`), { code });

/** The account-pairing identity of one workspace on this device. */
export interface AccountPairingIdentity {
  readonly signingPublicKey: Uint8Array;
  readonly encryptionPublicKey: Uint8Array;
  /** Proves possession for `membershipId` (core `prepareDeviceAdmission`). */
  readonly possessionProof: Uint8Array;
  readonly credentialHash: Uint8Array;
}

/**
 * One workspace's portable host, as account pairing uses it. Implemented by the
 * personal device host over its platform's custody; every method stays within that
 * one pinned account/workspace/genesis.
 */
export interface AccountPairingIdentityHost {
  readonly workspaceId: string;
  readonly genesisHash: string;
  /** Creates this workspace's identity once, or reuses the retained one, bound to
   * the verified genesis record and membership. Never replaces an identity. */
  prepareAccountIdentity(pin: {
    readonly genesisRecordHex: string;
    readonly membershipId: string;
  }): Effect.Effect<AccountPairingIdentity, unknown>;
  /** An unfinished per-workspace pairing exchange already journaled on this device. */
  pendingPersonalJoin(): Effect.Effect<{ readonly pairingSessionId: string } | null, unknown>;
  /** Verifies the snapshot invitation against `endorser` and this device's admission,
   * then installs it. `pairingSessionId` keys the journal; it is request-independent. */
  acceptAccountInvitation(input: {
    readonly invitationHex: string;
    readonly endorser: string;
    readonly genesisRecordHex: string;
    readonly membershipId: string;
    readonly pairingSessionId: string;
  }): Effect.Effect<void, unknown>;
  /** Installs from the complete verified history, for an approval row without an
   * invitation (a Member approver). */
  acceptAccountHistory?(input: {
    readonly genesisRecordHex: string;
    readonly membershipId: string;
    readonly pairingSessionId: string;
    readonly pages: readonly E2eeWorkspaceHistoryPage[];
  }): Effect.Effect<void, unknown>;
  /** Optional: open, refresh and run one key round right after installing. */
  activate?(): Effect.Effect<void, unknown>;
}

/** The portable personal device host of one workspace, as account pairing uses it.
 * Identity protection stays with the host's platform custody. */
export function personalHostAccountPairing(
  host: Pick<
    Effect.Success<ReturnType<typeof makePersonalDeviceHost>>,
    'scope' | 'prepareAccount' | 'acceptAccount' | 'acceptAccountHistory'
  >
): AccountPairingIdentityHost {
  return {
    workspaceId: host.scope.workspaceId,
    genesisHash: toHex(host.scope.genesis.toBytes()),
    prepareAccountIdentity: (pin) =>
      Effect.map(host.prepareAccount(pin), (prepared) => {
        const request = decodePersonalRequest(prepared.requestHex);
        return {
          signingPublicKey: fromHex(request.signingPublicKey),
          encryptionPublicKey: fromHex(request.encryptionPublicKey),
          possessionProof: fromHex(request.possessionSignature),
          credentialHash: fromHex(request.credentialHash),
        };
      }),
    // Not tracked on portable hosts yet: an unfinished per-workspace join there is
    // not reported as blocked (recorded limit).
    pendingPersonalJoin: () => Effect.succeed(null),
    acceptAccountHistory: (input) =>
      host.acceptAccountHistory({
        genesisRecordHex: input.genesisRecordHex,
        membershipId: input.membershipId,
        pages: input.pages,
      }),
    acceptAccountInvitation: (input) =>
      host.acceptAccount({
        genesisRecordHex: input.genesisRecordHex,
        membershipId: input.membershipId,
        invitationHex: input.invitationHex,
        endorser: input.endorser,
      }),
  };
}

export interface AccountPairingWorkspaceHint {
  readonly workspaceId: string;
  readonly name: string;
  readonly genesisHash: string;
}

/**
 * Requester ports for the shared workflow. For each workspace the device is not yet
 * in, the identity proves possession for the membership that the verified history
 * assigns to this account's crypto user. On accept, the admission record is found
 * by its tag-authenticated ledger hash and its signer becomes the endorser.
 */
export function makePortableAccountPairingRequester(input: {
  workspaces: () => readonly AccountPairingWorkspaceHint[];
  /** The workspace's host, or `null` when this device already has an active
   * personal identity there and needs no pairing. */
  host: (workspaceId: string) => Effect.Effect<AccountPairingIdentityHost | null, unknown>;
  history: (
    request: E2eeWorkspaceHistoryRequest
  ) => Effect.Effect<E2eeWorkspaceHistoryPage, unknown>;
  /** The signed-in account; its encoded user ID finds this account's ledger member. */
  accountId: string;
  diagnostics?: (tag: string, error: unknown) => void;
}): () => Effect.Effect<readonly AccountPairingRequesterWorkspace[], unknown> {
  const remember = input.diagnostics ?? (() => {});
  const pages = Effect.fnUntraced(function* (workspaceId: string) {
    const all: E2eeWorkspaceHistoryPage[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 256; index++) {
      const page = yield* input.history({
        workspaceId,
        ...(cursor ? { cursor } : {}),
        ...(all[0] ? { checkpoint: all[0].checkpoint } : {}),
      });
      all.push(page);
      if (page.nextCursor === null) return all;
      cursor = page.nextCursor;
    }
    return yield* Effect.fail(fail('ledger_budget_exceeded'));
  });
  /** The full signed history, verified from the genesis this device already trusts. */
  const verified = Effect.fnUntraced(function* (hint: AccountPairingWorkspaceHint) {
    const history = yield* pages(hint.workspaceId);
    const genesisRecordHex = history[0]?.recordsHex[0];
    if (!genesisRecordHex) return yield* Effect.fail(fail('invalid-ledger'));
    const view = yield* verifyPersonalHistory(
      { workspaceId: hint.workspaceId, genesisHash: hint.genesisHash, genesisRecordHex },
      history
    );
    return { history, view, genesisRecordHex };
  });
  /** This account's single active membership in a verified view. A wrong answer
   * from the service only makes the possession proof fail; it is never pinned. */
  const membership = Effect.fnUntraced(function* (
    view: Effect.Success<ReturnType<typeof verified>>['view']
  ) {
    const userId = accountUserId(input.accountId);
    if (Result.isFailure(userId)) return yield* Effect.fail(fail('missing-binding'));
    const mine = [...view.inspectState().members.entries()].filter(([, member]) =>
      member.userId.equals(userId.success)
    );
    if (mine.length !== 1) return yield* Effect.fail(fail('missing-binding'));
    return mine[0]![0];
  });

  return Effect.fnUntraced(function* () {
    const result: AccountPairingRequesterWorkspace[] = [];
    for (const hint of input.workspaces()) {
      const host = yield* input.host(hint.workspaceId).pipe(
        Effect.catch((error) => {
          remember('account-pairing-host', error);
          return Effect.succeed(null);
        })
      );
      if (!host || host.genesisHash !== hint.genesisHash) continue;
      result.push({
        workspaceId: hint.workspaceId,
        name: hint.name,
        genesis: fromHex(hint.genesisHash),
        identity: () =>
          Effect.gen(function* () {
            const checked = yield* verified(hint);
            const membershipId = yield* membership(checked.view);
            const identity = yield* host.prepareAccountIdentity({
              genesisRecordHex: checked.genesisRecordHex,
              membershipId,
            });
            return {
              signingPublicKey: identity.signingPublicKey,
              encryptionPublicKey: identity.encryptionPublicKey,
              possessionProof: identity.possessionProof,
              credentialHash: identity.credentialHash,
            };
          }),
        acceptHistory: host.acceptAccountHistory
          ? (admissionRecordHash) =>
              Effect.gen(function* () {
                const checked = yield* verified(hint);
                const found = checked.history
                  .flatMap((page) => page.recordsHex)
                  .some(
                    (recordHex) =>
                      toHex(hashRecordBytes(fromHex(recordHex)).toBytes()) ===
                      toHex(admissionRecordHash)
                  );
                if (!found) return yield* Effect.fail(fail('missing-binding'));
                const pairingSessionId = toHex(admissionRecordHash).slice(0, 32);
                const pending = yield* host.pendingPersonalJoin();
                if (pending && pending.pairingSessionId !== pairingSessionId)
                  return yield* Effect.fail(fail('pairing-journal-busy'));
                yield* host.acceptAccountHistory!({
                  genesisRecordHex: checked.genesisRecordHex,
                  membershipId: yield* membership(checked.view),
                  pairingSessionId,
                  pages: checked.history,
                });
                if (host.activate)
                  yield* host
                    .activate()
                    .pipe(
                      Effect.catch((error) =>
                        Effect.sync(() => remember('account-pairing-activate', error))
                      )
                    );
                return undefined;
              })
          : undefined,
        accept: (invitation, admissionRecordHash) =>
          Effect.gen(function* () {
            const checked = yield* verified(hint);
            const record = checked.history
              .flatMap((page) => page.recordsHex)
              .map(fromHex)
              .find(
                (bytes) => toHex(hashRecordBytes(bytes).toBytes()) === toHex(admissionRecordHash)
              );
            if (!record) return yield* Effect.fail(fail('missing-binding'));
            const decoded = decodeRecord(record);
            if (Result.isFailure(decoded) || decoded.success.body.type !== 'ordinary')
              return yield* Effect.fail(fail('invalid-ledger'));
            const pairingSessionId = toHex(admissionRecordHash).slice(0, 32);
            // An unrelated unfinished per-workspace exchange keeps its journal:
            // this workspace is reported blocked instead of overwritten.
            const pending = yield* host.pendingPersonalJoin();
            if (pending && pending.pairingSessionId !== pairingSessionId)
              return yield* Effect.fail(fail('pairing-journal-busy'));
            yield* host.acceptAccountInvitation({
              invitationHex: toHex(invitation),
              endorser: toHex(decoded.success.body.signer.toBytes()),
              genesisRecordHex: checked.genesisRecordHex,
              membershipId: yield* membership(checked.view),
              pairingSessionId,
            });
            if (host.activate)
              yield* host
                .activate()
                .pipe(
                  Effect.catch((error) =>
                    Effect.sync(() => remember('account-pairing-activate', error))
                  )
                );
            return undefined;
          }),
      });
    }
    return result;
  });
}

type AccountPairingMethods = Required<E2eeAccountPairingRuntime>;
const ACCOUNT_METHODS: readonly (keyof AccountPairingMethods)[] = [
  'requestAccountPairing',
  'accountPairingRequest',
  'cancelAccountPairing',
  'accountPairingCode',
  'inspectAccountPairing',
  'approveAccountPairing',
  'declineAccountPairing',
];

/** One open workspace session of this device, as the account-pairing approver uses
 * it (`accountApproval` of the personal session). */
export interface AccountPairingApproverSession {
  readonly binding: { readonly device: { toBytes(): Uint8Array } };
  readonly accountApproval: {
    sign(row: {
      signingPublicKey: Uint8Array;
      encryptionPublicKey: Uint8Array;
      possessionProof: Uint8Array;
    }): Effect.Effect<{ requestId: string; record: Uint8Array }, unknown>;
    settle(record: Uint8Array): Effect.Effect<'committed' | 'lost' | 'unknown', unknown>;
    invitation(record: Uint8Array): Effect.Effect<Uint8Array | null, unknown>;
    access(): Effect.Effect<{ workspaceId: string; credential: string }, unknown>;
  };
  refresh(): Effect.Effect<unknown, unknown>;
  /** This session's existing key round (receive, reports, distribution, repair). Its
   * distributor targets only devices of the verified ledger and journals each envelope,
   * so a later round retries the same id and bytes. */
  keyRound(): Effect.Effect<unknown, unknown>;
  /** Positive mailbox evidence for `device` at the current epoch: 'delivered', or a
   * public retryable `e2ee_*` code. */
  keyDeliveryEvidence(device: string): Effect.Effect<string, unknown>;
  /** Ends this holder's use; the runtime closes a reader it opened for approval. */
  release?(): Effect.Effect<void, unknown>;
}

/** Background key delivery after an admission commits. `delivered` rests on mailbox
 * evidence for the admitted device, never on a finished round. `retrying` carries the
 * code of the attempt that will be retried; `ended` is final (terminal cause, retry
 * bound, or the approving session is no longer available to this account). */
export interface AccountPairingKeyDeliveryEvent {
  readonly workspaceId: string;
  readonly requestId: string;
  /** The admitted device's signing key, lowercase hex. */
  readonly device: string;
  readonly state: 'running' | 'retrying' | 'delivered' | 'ended';
  /** Public `e2ee_*` code; never a cause, key or token. */
  readonly code?: string;
}
/** The desktop's member delivery backoff: 10 s doubling to a 5 min cap, eight retries. */
const KEY_DELIVERY_RETRY_DELAYS = [
  10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000,
] as const;
/** Causes after which this device can never deliver; retrying would only repeat them. */
const TERMINAL_KEY_DELIVERY = new Set([
  'e2ee_member_removed',
  'e2ee_device_revoked',
  'e2ee_missing-binding',
  'e2ee_restart-required',
]);
const keyDeliveryCode = (cause: unknown) => {
  const code =
    cause && typeof cause === 'object' && 'code' in cause
      ? (cause as { code: unknown }).code
      : null;
  return typeof code === 'string' && /^[a-z0-9_-]{1,64}$/.test(code)
    ? `e2ee_${code}`
    : 'e2ee_key_delivery_failed';
};

/**
 * Approver ports for the shared workflow on a portable host. Each workspace where
 * this device has an open, admitted personal session signs the new device's
 * `AdmitDevice` locally, appends the journaled original bound to the new device's
 * credential hash, and delivers a snapshot invitation (Owner/Admin) or none (Member).
 */
export function makePortableAccountPairingApprover(input: {
  workspaces: () => readonly AccountPairingWorkspaceHint[];
  /** This device's admitted session in the workspace, or `null` when it has none. */
  session: (workspaceId: string) => Effect.Effect<AccountPairingApproverSession | null, unknown>;
  /** The account-authenticated ledger append. */
  appendRecord: (request: E2eeAppendRecordRequest) => Effect.Effect<unknown, unknown>;
  /** Observes the background key delivery started after each committed admission. */
  onKeyDelivery?: (event: AccountPairingKeyDeliveryEvent) => void;
  /** Due-retry schedule; tests inject `sleep` instead of waiting. */
  keyDeliveryRetry?: {
    readonly delays?: readonly number[];
    readonly sleep?: (ms: number) => Effect.Effect<void>;
  };
  /** Bounded local diagnostics for failures no caller awaits (a background release). */
  diagnostics?: (scope: string, cause: unknown) => void;
}): () => Effect.Effect<readonly AccountPairingApproverWorkspace[], unknown> {
  const remember = (scope: string) => (cause: unknown) =>
    Effect.sync(() => {
      try {
        input.diagnostics?.(scope, cause);
      } catch {
        /* Diagnostics never fail the caller. */
      }
    });
  const releaseQuietly = (session: AccountPairingApproverSession, scope: string) =>
    session.release ? session.release().pipe(Effect.catch(remember(scope))) : Effect.void;
  // Sessions opened before a later workspace fails are not returned, so the caller
  // cannot release them: release them here on any failure.
  const list = Effect.fnUntraced(function* (opened: AccountPairingApproverSession[]) {
    const result: AccountPairingApproverWorkspace[] = [];
    for (const hint of input.workspaces()) {
      const session = yield* input.session(hint.workspaceId);
      if (!session) continue;
      opened.push(session);
      const approval = session.accountApproval;
      const { workspaceId } = hint;
      result.push({
        workspaceId,
        name: hint.name,
        genesis: fromHex(hint.genesisHash),
        signingPublicKey: session.binding.device.toBytes(),
        refresh: () => Effect.asVoid(session.refresh()),
        sign: (row) => approval.sign(row),
        append: (requestId, record, credentialHash) =>
          Effect.gen(function* () {
            const appended = yield* Effect.result(
              input.appendRecord({
                workspaceId,
                requestId,
                recordHex: toHex(record),
                credentialHash: toHex(credentialHash),
              })
            );
            // Verified reads beat lost acknowledgements: settle from the ledger.
            const settled = yield* approval.settle(record);
            if (settled === 'committed') return undefined;
            if (settled === 'lost') return yield* Effect.fail(fail('admission-lost'));
            if (Result.isFailure(appended)) return yield* Effect.fail(appended.failure);
            return yield* Effect.fail(fail('append_unconfirmed'));
          }),
        invitation: (record) => approval.invitation(record),
        access: () => approval.access(),
        // Failures reach the workflow, which records them; a failed close stays retryable.
        release: () => session.release?.() ?? Effect.void,
        // Approval returns first; the session's own key round sends the new device the
        // current epoch key, as on the desktop. Each attempt ends with mailbox evidence;
        // anything short of `delivered` is retried on the bounded due schedule. Every
        // retry asks for the session again, so a signed-out or switched account ends the
        // delivery and a closed reader is reopened by the runtime. The delivery is bound
        // to the approving session's own device: a session of another account for the
        // same workspace (its own device) ends it before any call. A failure never undoes
        // the admission.
        deliverKeys: (deviceBytes, requestId) =>
          Effect.gen(function* () {
            const device = toHex(deviceBytes);
            const delays = input.keyDeliveryRetry?.delays ?? KEY_DELIVERY_RETRY_DELAYS;
            const sleep = input.keyDeliveryRetry?.sleep ?? ((ms: number) => Effect.sleep(ms));
            const report = (state: AccountPairingKeyDeliveryEvent['state'], code?: string) => {
              try {
                input.onKeyDelivery?.({
                  workspaceId,
                  requestId,
                  device,
                  state,
                  ...(code ? { code } : {}),
                });
              } catch {
                /* An observer never affects delivery. */
              }
            };
            // Each attempt holds its own session only while it runs and releases it
            // afterwards, so the delivery never keeps a reader open across the backoff.
            const acquire = () =>
              Effect.suspend(() => input.session(workspaceId)).pipe(
                Effect.orElseSucceed(() => null)
              );
            const release = (current: AccountPairingApproverSession) =>
              releaseQuietly(current, 'account-pairing-key-delivery-release');
            const attempt = (current: AccountPairingApproverSession) =>
              Effect.gen(function* () {
                const round = yield* Effect.result(current.keyRound());
                const evidence = yield* Effect.result(current.keyDeliveryEvidence(device));
                if (Result.isSuccess(evidence) && evidence.success === 'delivered')
                  return 'delivered';
                if (Result.isFailure(round)) return keyDeliveryCode(round.failure);
                return Result.isSuccess(evidence)
                  ? evidence.success
                  : keyDeliveryCode(evidence.failure);
              }).pipe(Effect.ensuring(release(current)));
            const owner = toHex(session.binding.device.toBytes());
            // The first hold is taken before approval continues, so the workflow may
            // release its own listing session without closing the reader underneath.
            const first = yield* acquire();
            const deliver = Effect.gen(function* () {
              let current: AccountPairingApproverSession | null = first;
              for (let retry = 0; ; retry++) {
                if (!current) return report('ended', 'e2ee_key_delivery_closed');
                if (toHex(current.binding.device.toBytes()) !== owner) {
                  yield* release(current);
                  return report('ended', 'e2ee_key_delivery_owner_changed');
                }
                const code = yield* attempt(current);
                if (code === 'delivered') return report('delivered');
                if (TERMINAL_KEY_DELIVERY.has(code) || retry >= delays.length)
                  return report('ended', code);
                report('retrying', code);
                yield* sleep(delays[retry]!);
                current = yield* acquire();
              }
            });
            report('running');
            void Effect.runPromise(deliver).catch((cause: unknown) =>
              report('ended', keyDeliveryCode(cause))
            );
          }),
      });
    }
    return result;
  });
  return () => {
    const opened: AccountPairingApproverSession[] = [];
    return list(opened).pipe(
      Effect.onError(() =>
        Effect.forEach(opened, (session) => releaseQuietly(session, 'account-pairing-release'), {
          discard: true,
        })
      )
    );
  };
}

/**
 * One account-level `E2eeWorkspaceRuntime` over per-workspace runtimes. Only the
 * listed `methods` exist: callers detect capabilities by presence, so nothing is
 * advertised that per-workspace runtimes do not implement. Each routes by the
 * workspace ID in its first argument (or that argument's `workspaceId`); account
 * pairing methods go to `accountPairing`. A call naming no open workspace is refused.
 */
export function makeAccountE2eeRuntime(input: {
  runtimeFor: (workspaceId: string) => E2eeWorkspaceRuntime | undefined;
  methods: readonly Exclude<keyof E2eeWorkspaceRuntime, 'account' | keyof AccountPairingMethods>[];
  account: E2eeWorkspaceRuntime['account'];
  accountPairing?: E2eeAccountPairingRuntime;
}): E2eeWorkspaceRuntime {
  const workspaceOf = (args: readonly unknown[]): string | undefined => {
    const first = args[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object' && 'workspaceId' in first) {
      const id = (first as { workspaceId: unknown }).workspaceId;
      return typeof id === 'string' ? id : undefined;
    }
    return undefined;
  };
  const runtime: Record<string, unknown> = { account: input.account };
  for (const name of input.methods)
    runtime[name] = (...args: unknown[]) => {
      const workspaceId = workspaceOf(args);
      const target = workspaceId ? input.runtimeFor(workspaceId) : undefined;
      const method = target?.[name];
      if (typeof method !== 'function') return Promise.reject(fail('unsupported'));
      return (method as (...values: unknown[]) => unknown).apply(target, args);
    };
  for (const name of ACCOUNT_METHODS) {
    const method = input.accountPairing?.[name];
    if (method) runtime[name] = method.bind(input.accountPairing);
  }
  return runtime as unknown as E2eeWorkspaceRuntime;
}
