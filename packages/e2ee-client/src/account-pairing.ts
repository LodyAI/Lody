import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { Effect, Exit, Result, Semaphore } from 'effect';
import type {
  E2eeAccountPairingReplies,
  E2eeAccountPairingRequests,
  E2eeDeviceAccess,
} from '@lody/cloud-api';
import {
  PAIRING_REQUEST_MAX_LIFETIME_MS,
  checkPairingRequestLifetime,
  decodePairingApproval,
  decodePairingRequest,
  derivePairingKeys,
  disposePairingKeys,
  encodePairingApproval,
  encodePairingRequest,
  encodePairingSecret,
  formatPairingString,
  hashRecordBytes,
  pairingApprovalTag,
  pairingRequestDigest,
  pairingRequestTag,
  parsePairingString,
  verifyPairingApprovalTag,
  verifyPairingRequestTag,
  type PairingKeys,
  type PairingRequest,
  type PairingRequestRow,
} from '@lody/e2ee-core/protocol';
import { fromHex, toHex } from './bytes';

/**
 * Account-wide personal device pairing, shared by every host (foundations Spec,
 * "Account-wide personal device pairing"). The relay is untrusted: every request
 * and approval is authenticated with tags keyed from the pairing secret, the
 * expiry is checked against this device's clock, and terminal states are local.
 *
 * - The pairing secret never touches disk. A restart loses it, which ends that
 *   request locally; a used or finished lookup ID is recorded and never reused.
 * - The approver journals each workspace's exact signed admission before any
 *   network step and retries those bytes; it never signs a workspace twice.
 * - The request tag is verified again immediately before every signature, and the
 *   new device verifies the approval tag before installing anything.
 */

const hex = toHex;
const raw = fromHex;
const sha256 = (value: Uint8Array): Uint8Array => nobleSha256(value);
/** Typed refusals the UI explains (`@lody/platform` `E2eeAccountPairingErrorCode`). */
export type AccountPairingRefusal = 'pairing-tampered' | 'pairing-expired' | 'pairing-used';
const fail = (code: AccountPairingRefusal | 'invalid-input' | 'storage' | 'corrupt') =>
  Object.assign(new Error(`e2ee_${code}`), { code });
/** Failures that refuse the whole approval rather than one workspace: the signed-in
 * account changed, the request was tampered with, or it expired. Shared by every
 * per-workspace step so refresh and signing classify the same way. */
const refusesApproval = (error: unknown) => {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code: unknown }).code
      : null;
  return (
    code === 'account_mismatch' ||
    code === 'pairing-tampered' ||
    code === 'pairing-expired' ||
    (error instanceof Error && /\be2ee_account_mismatch\b/.test(error.message))
  );
};
function fromResult<A>(
  result: Result.Result<A, unknown>,
  code: Parameters<typeof fail>[0]
): Effect.Effect<A, Error> {
  return Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(fail(code));
}

/** Relay calls (`e2eeAccountPairing`); the desktop cloud client implements them. */
export interface AccountPairingRelay {
  submit(
    input: E2eeAccountPairingRequests['submit']
  ): Effect.Effect<E2eeAccountPairingReplies['submit'], unknown>;
  read(lookupId: string): Effect.Effect<E2eeAccountPairingReplies['read'], unknown>;
  decline(requestId: string): Effect.Effect<unknown, unknown>;
  publish(input: E2eeAccountPairingRequests['publish']): Effect.Effect<unknown, unknown>;
  claim(lookupId: string): Effect.Effect<E2eeAccountPairingReplies['claim'], unknown>;
}

/** One workspace where this device is an active personal device. */
export interface AccountPairingApproverWorkspace {
  readonly workspaceId: string;
  readonly name: string;
  readonly genesis: Uint8Array;
  /** This device's signing key in the workspace; it signs the admission. */
  readonly signingPublicKey: Uint8Array;
  /** Optional network step before signing: pull the verified ledger forward. The
   * request's tag and expiry are checked again after it, before any signature. */
  refresh?(): Effect.Effect<void, unknown>;
  /** Prepares and signs one personal `AdmitDevice` for the row against the latest
   * verified ledger. No network; the caller journals the result before using it. */
  sign(row: PairingRequestRow): Effect.Effect<{ requestId: string; record: Uint8Array }, unknown>;
  /** Appends the exact journaled original, bound to the new device's credential hash,
   * then refreshes the verified ledger. Repeating it is safe and never re-signs. */
  append(
    requestId: string,
    record: Uint8Array,
    credentialHash: Uint8Array
  ): Effect.Effect<void, unknown>;
  /** A signed snapshot invitation once the admission is verified in the ledger, or
   * `null` while it cannot be delivered yet. */
  invitation(record: Uint8Array): Effect.Effect<Uint8Array | null, unknown>;
  /** Device access for the relay; it never leaves the main process. */
  access(): Effect.Effect<E2eeDeviceAccess, unknown>;
}

/** One encrypted workspace of the account on the new device. */
export interface AccountPairingRequesterWorkspace {
  readonly workspaceId: string;
  readonly name: string;
  readonly genesis: Uint8Array;
  /** The retained identity for this workspace, created once and reused by every
   * later request; never replaced here. */
  identity(): Effect.Effect<Omit<PairingRequestRow, 'genesis'>, unknown>;
  /** Verifies the invitation against the approved admission record and installs it. */
  accept(invitation: Uint8Array, admissionRecordHash: Uint8Array): Effect.Effect<void, unknown>;
}

type Terminal = 'approved' | 'declined' | 'expired' | 'cancelled';
type RequestRow = {
  lookup_id: string;
  request: Uint8Array;
  request_tag: string;
  expires_at: number;
  direction: string;
};
type AdmissionRow = {
  workspace_id: string;
  signing_key: string;
  genesis: string;
  lookup_id: string;
  request_id: string;
  record: Uint8Array;
  invitation: Uint8Array | null;
};

/** One durable request of this device, exactly as first created. */
export interface AccountPairingRequestRecord {
  readonly lookupId: string;
  readonly request: Uint8Array;
  readonly requestTag: string;
  readonly direction: string;
  readonly expiresAt: number;
}
/** One journaled admission, keyed by workspace and the new device's signing key. */
export interface AccountPairingAdmissionRecord {
  readonly workspaceId: string;
  readonly signingKey: string;
  readonly genesis: string;
  readonly lookupId: string;
  readonly requestId: string;
  readonly record: Uint8Array;
  readonly invitation: Uint8Array | null;
}
export type AccountPairingTerminal = Terminal;

/**
 * Durable, account-scoped pairing state. It holds no secret and no private key.
 * Every write is idempotent where stated, and each method commits before it
 * resolves. Hosts implement it over their own storage (SQLite, IndexedDB).
 */
export interface AccountPairingStore {
  /** The first terminal state recorded for a lookup ID, if any. */
  terminal(lookupId: string): Effect.Effect<AccountPairingTerminal | null, unknown>;
  /** Records a terminal state; an existing one is kept (first wins). */
  settle(
    lookupId: string,
    role: 'requester' | 'approver',
    state: AccountPairingTerminal,
    at: number
  ): Effect.Effect<void, unknown>;
  /** This device's most recently created request. */
  latestRequest(): Effect.Effect<AccountPairingRequestRecord | null, unknown>;
  hasRequest(lookupId: string): Effect.Effect<boolean, unknown>;
  /** Fails if the lookup ID already exists. */
  insertRequest(record: AccountPairingRequestRecord): Effect.Effect<void, unknown>;
  joined(lookupId: string): Effect.Effect<ReadonlySet<string>, unknown>;
  addJoined(lookupId: string, workspaceId: string): Effect.Effect<void, unknown>;
  /** The approver's retained copy of the request it authenticated. */
  approvedRequest(
    lookupId: string
  ): Effect.Effect<{ request: Uint8Array; requestTag: string } | null, unknown>;
  /** First copy wins. */
  putApprovedRequest(
    lookupId: string,
    request: Uint8Array,
    requestTag: string
  ): Effect.Effect<void, unknown>;
  admission(
    workspaceId: string,
    signingKey: string
  ): Effect.Effect<AccountPairingAdmissionRecord | null, unknown>;
  /** Fails if this workspace and signing key already have an admission. */
  insertAdmission(record: AccountPairingAdmissionRecord): Effect.Effect<void, unknown>;
  /** Sets the invitation only while none is stored. */
  setAdmissionInvitation(
    workspaceId: string,
    signingKey: string,
    invitation: Uint8Array
  ): Effect.Effect<void, unknown>;
  /** Deletes only that exact admission original. */
  deleteAdmission(
    workspaceId: string,
    signingKey: string,
    requestId: string
  ): Effect.Effect<void, unknown>;
  admissionCount(lookupId: string): Effect.Effect<number, unknown>;
}

export interface AccountPairingState {
  direction: 'requester-shows' | 'approver-shows';
  pairingString: string | null;
  expiresAt: number;
  status: 'waiting' | 'joined' | 'declined' | 'expired';
  workspaces: { workspaceId: string; name: string; state: 'pending' | 'joined' | 'blocked' }[];
}
export interface AccountPairingPreview {
  requestId: string;
  deviceName: string;
  approximateLocation: string | null;
  requestedAt: number;
  expiresAt: number;
  workspaces: { workspaceId: string; name: string }[];
  unavailable: { workspaceId: string; name: string }[];
}
export interface AccountPairingApproval {
  workspaces: {
    workspaceId: string;
    outcome: 'admitted' | 'awaiting-delivery' | 'not-admitted';
  }[];
}

export function makeAccountPairing(input: {
  store: AccountPairingStore;
  account: string;
  deviceName: string;
  relay: AccountPairingRelay;
  approverWorkspaces: () => Effect.Effect<readonly AccountPairingApproverWorkspace[], unknown>;
  requesterWorkspaces: () => Effect.Effect<readonly AccountPairingRequesterWorkspace[], unknown>;
  now?: () => number;
  random?: (size: number) => Uint8Array;
  /** Local diagnostics for isolated failures; causes never reach the caller. */
  diagnostics?: (tag: string, error: unknown) => void;
}) {
  const { store, relay } = input;
  const now = input.now ?? Date.now;
  const random =
    input.random ?? ((size: number) => globalThis.crypto.getRandomValues(new Uint8Array(size)));
  const rememberDesktopE2eeFailure = input.diagnostics ?? (() => {});
  /** Store failures surface as `storage` unless they carry a typed code. */
  const sql = <A>(work: Effect.Effect<A, unknown>): Effect.Effect<A, Error> =>
    Effect.mapError(work, (error) => {
      rememberDesktopE2eeFailure('account-pairing-store', error);
      return error instanceof Error && 'code' in error ? error : fail('storage');
    });
  const toRequestRow = (record: AccountPairingRequestRecord): RequestRow => ({
    lookup_id: record.lookupId,
    request: record.request,
    request_tag: record.requestTag,
    direction: record.direction,
    expires_at: record.expiresAt,
  });
  const toAdmissionRow = (record: AccountPairingAdmissionRecord): AdmissionRow => ({
    workspace_id: record.workspaceId,
    signing_key: record.signingKey,
    genesis: record.genesis,
    lookup_id: record.lookupId,
    request_id: record.requestId,
    record: record.record,
    invitation: record.invitation,
  });
  /** Secrets of this device's own open requests, in memory only. */
  const secrets = new Map<string, Uint8Array>();
  /** Workspaces whose last install attempt found an unrelated unfinished
   * per-workspace pairing on this device; recomputed on every poll. */
  const blocked = new Map<string, Set<string>>();
  /** One pairing operation at a time, so sign-then-journal and accept stay atomic. */
  const serial = Semaphore.makeUnsafe(1);
  /** A parsed code is wiped however the work ends, including failure and interruption. */
  const usingCode = <A, E, R>(code: string, use: (secret: Uint8Array) => Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(parseCode(code), use, (secret) => Effect.sync(() => secret.fill(0)));

  const terminal = (lookupId: string) =>
    Effect.map(sql(store.terminal(lookupId)), (state) => (state ? { state } : undefined));
  /** First terminal state wins; it is never replaced or revived. */
  const settle = (lookupId: string, role: 'requester' | 'approver', state: Terminal) =>
    Effect.flatMap(sql(store.settle(lookupId, role, state, now())), () =>
      Effect.sync(() => {
        if (role === 'requester') secrets.get(lookupId)?.fill(0);
        secrets.delete(lookupId);
      })
    );
  const withKeys = <A, E, R>(
    secret: Uint8Array,
    use: (keys: PairingKeys) => Effect.Effect<A, E, R>
  ) =>
    Effect.acquireUseRelease(fromResult(derivePairingKeys(secret), 'invalid-input'), use, (keys) =>
      Effect.sync(() => disposePairingKeys(keys))
    );
  const parseCode = (code: string) => fromResult(parsePairingString(code), 'invalid-input');

  // ----- New device -----

  const latestRequest = () =>
    Effect.map(store.latestRequest(), (record) => (record ? toRequestRow(record) : undefined));
  const joinedSet = (lookupId: string) => store.joined(lookupId);
  const stateOf = Effect.fnUntraced(function* (row: RequestRow) {
    const request = yield* fromResult(decodePairingRequest(row.request), 'corrupt');
    const workspaces = yield* input.requesterWorkspaces();
    const joined = yield* sql(joinedSet(row.lookup_id));
    const settled = (yield* terminal(row.lookup_id))?.state;
    const secret = secrets.get(row.lookup_id);
    const status: AccountPairingState['status'] =
      settled === 'approved'
        ? 'joined'
        : settled === 'declined'
          ? 'declined'
          : settled
            ? 'expired'
            : 'waiting';
    return {
      direction: request.direction,
      pairingString:
        status === 'waiting' && secret && request.direction === 'requester-shows'
          ? formatPairingString(Result.getOrThrow(encodePairingSecret(secret)))
          : null,
      expiresAt: request.expiresAt,
      status,
      workspaces: request.rows.map((item) => {
        const workspace = workspaces.find(
          (candidate) => hex(candidate.genesis) === hex(item.genesis)
        );
        const workspaceId = workspace?.workspaceId ?? hex(item.genesis);
        return {
          workspaceId,
          name: workspace?.name ?? workspaceId,
          state: joined.has(workspaceId)
            ? ('joined' as const)
            : blocked.get(row.lookup_id)?.has(workspaceId)
              ? ('blocked' as const)
              : ('pending' as const),
        };
      }),
    } satisfies AccountPairingState;
  });
  const submitExact = (row: RequestRow, request: PairingRequest) =>
    Effect.gen(function* () {
      const workspaces = yield* input.requesterWorkspaces();
      yield* relay.submit({
        lookupId: row.lookup_id,
        requestHex: hex(row.request),
        requestTagHex: row.request_tag,
        direction: request.direction,
        deviceName: request.deviceName,
        expiresAt: request.expiresAt,
        workspaces: request.rows.flatMap((item) => {
          const workspace = workspaces.find(
            (candidate) => hex(candidate.genesis) === hex(item.genesis)
          );
          return workspace
            ? [{ workspaceId: workspace.workspaceId, genesisHash: hex(item.genesis) }]
            : [];
        }),
      });
    });
  /** Ends the latest request locally if it is past its own expiry or its secret is gone. */
  const expireStale = Effect.fnUntraced(function* () {
    const row = yield* sql(latestRequest());
    if (!row || (yield* terminal(row.lookup_id))) return row;
    if (now() >= row.expires_at || !secrets.has(row.lookup_id))
      yield* settle(row.lookup_id, 'requester', 'expired');
    return row;
  });

  const requestAccountPairing = Effect.fnUntraced(function* (options: { pairingString?: string }) {
    const current = yield* expireStale();
    const open = current && !(yield* terminal(current.lookup_id));
    if (current && open && options.pairingString === undefined) {
      // Retry the exact original; a retry never extends the request.
      const request = yield* fromResult(decodePairingRequest(current.request), 'corrupt');
      yield* submitExact(current, request);
      return yield* stateOf(current);
    }
    if (current && open) yield* settle(current.lookup_id, 'requester', 'cancelled');
    const secret =
      options.pairingString === undefined ? random(16) : yield* parseCode(options.pairingString);
    const prepared = yield* Effect.onExit(
      withKeys(secret, (keys) =>
        Effect.gen(function* () {
          const lookupId = hex(keys.lookupId);
          const used = yield* sql(store.hasRequest(lookupId));
          if (used || (yield* terminal(lookupId))) return yield* Effect.fail(fail('pairing-used'));
          const workspaces = yield* input.requesterWorkspaces();
          if (workspaces.length === 0) return yield* Effect.fail(fail('invalid-input'));
          const rows: PairingRequestRow[] = [];
          // Each workspace stands alone: one that cannot prepare an identity now
          // (for example a stale list entry) is left out, not the whole request.
          for (const workspace of workspaces) {
            const identity = yield* Effect.result(workspace.identity());
            if (Result.isSuccess(identity))
              rows.push({ genesis: workspace.genesis, ...identity.success });
            else rememberDesktopE2eeFailure('account-pairing-identity', identity.failure);
          }
          if (rows.length === 0) return yield* Effect.fail(fail('invalid-input'));
          const request: PairingRequest = {
            account: input.account,
            lookupId: keys.lookupId,
            direction: options.pairingString === undefined ? 'requester-shows' : 'approver-shows',
            deviceName: input.deviceName,
            expiresAt: now() + PAIRING_REQUEST_MAX_LIFETIME_MS,
            rows,
          };
          const bytes = yield* fromResult(encodePairingRequest(request), 'invalid-input');
          const tag = yield* fromResult(pairingRequestTag(keys, request), 'invalid-input');
          const row: RequestRow = {
            lookup_id: lookupId,
            request: bytes,
            request_tag: hex(tag),
            direction: request.direction,
            expires_at: request.expiresAt,
          };
          // The exact original is durable before any network step.
          yield* sql(
            store.insertRequest({
              lookupId: row.lookup_id,
              request: row.request,
              requestTag: row.request_tag,
              direction: row.direction,
              expiresAt: row.expires_at,
            })
          );
          return { row, request };
        })
      ),
      (exit) =>
        Effect.sync(() => {
          // Only a durably journaled request keeps its secret, and only in memory.
          if (Exit.isSuccess(exit)) secrets.set(exit.value.row.lookup_id, secret);
          else secret.fill(0);
        })
    );
    yield* submitExact(prepared.row, prepared.request);
    return yield* stateOf(prepared.row);
  });

  const accountPairingRequest = Effect.fnUntraced(function* () {
    const row = yield* expireStale();
    if (!row) return null;
    if (yield* terminal(row.lookup_id)) return yield* stateOf(row);
    const request = yield* fromResult(decodePairingRequest(row.request), 'corrupt');
    const secret = secrets.get(row.lookup_id)!;
    const claim = yield* relay.claim(row.lookup_id);
    if (claim?.status === 'declined' && claim.approvals.length === 0) {
      yield* settle(row.lookup_id, 'requester', 'declined');
      return yield* stateOf(row);
    }
    const workspaces = yield* input.requesterWorkspaces();
    const digest = yield* fromResult(pairingRequestDigest(request), 'corrupt');
    yield* withKeys(secret, (keys) =>
      Effect.gen(function* () {
        for (const published of claim?.approvals ?? []) {
          // Anything that fails a check is ignored: the relay may be lying.
          const approval = decodePairingApproval(raw(published.approvalHex));
          if (Result.isFailure(approval)) continue;
          if (
            Result.isFailure(
              verifyPairingApprovalTag(keys, approval.success, raw(published.approvalTagHex))
            ) ||
            hex(approval.success.requestDigest) !== hex(digest)
          )
            continue;
          // The approval is accepted only while this device's own expiry holds.
          if (Result.isFailure(checkPairingRequestLifetime(request, now()))) return;
          for (const approved of approval.success.rows) {
            const workspace = workspaces.find(
              (item) => hex(item.genesis) === hex(approved.genesis)
            );
            if (
              !workspace ||
              !request.rows.some((item) => hex(item.genesis) === hex(approved.genesis))
            )
              continue;
            if ((yield* sql(joinedSet(row.lookup_id))).has(workspace.workspaceId)) continue;
            const invitation = published.invitations.find(
              (item) => item.genesisHash === hex(approved.genesis)
            );
            if (!invitation) continue;
            const bytes = raw(invitation.invitationHex);
            if (hex(sha256(bytes)) !== hex(approved.invitationDigest)) continue;
            // A failure here affects only this workspace; the next poll retries it.
            const accepted = yield* Effect.result(
              workspace.accept(bytes, approved.admissionRecordHash)
            );
            if (Result.isFailure(accepted)) {
              rememberDesktopE2eeFailure('account-pairing-accept', accepted.failure);
              const code =
                accepted.failure &&
                typeof accepted.failure === 'object' &&
                'code' in accepted.failure
                  ? accepted.failure.code
                  : undefined;
              if (code === 'pairing-journal-busy') {
                const set = blocked.get(row.lookup_id) ?? new Set<string>();
                set.add(workspace.workspaceId);
                blocked.set(row.lookup_id, set);
              }
              continue;
            }
            blocked.get(row.lookup_id)?.delete(workspace.workspaceId);
            yield* sql(store.addJoined(row.lookup_id, workspace.workspaceId));
          }
        }
      })
    );
    const joined = yield* sql(joinedSet(row.lookup_id));
    const requested = request.rows.flatMap((item) => {
      const workspace = workspaces.find(
        (candidate) => hex(candidate.genesis) === hex(item.genesis)
      );
      return workspace ? [workspace.workspaceId] : [];
    });
    if (requested.length > 0 && requested.every((id) => joined.has(id)))
      yield* settle(row.lookup_id, 'requester', 'approved');
    else if (now() >= row.expires_at) yield* settle(row.lookup_id, 'requester', 'expired');
    return yield* stateOf(row);
  });

  const cancelAccountPairing = Effect.fnUntraced(function* () {
    const row = yield* sql(latestRequest());
    if (row && !(yield* terminal(row.lookup_id)))
      yield* settle(row.lookup_id, 'requester', 'cancelled');
  });

  // ----- Approving device -----

  /** Fetches the request for a code and authenticates it. Journaled bytes are used
   * on resume, and must equal whatever the relay returns. */
  const authenticate = Effect.fnUntraced(function* (keys: PairingKeys) {
    const lookupId = hex(keys.lookupId);
    const settled = (yield* terminal(lookupId))?.state;
    if (settled === 'expired') return yield* Effect.fail(fail('pairing-expired'));
    if (settled) return yield* Effect.fail(fail('pairing-used'));
    const relayed = yield* relay.read(lookupId);
    const retained = yield* sql(store.approvedRequest(lookupId));
    const journaled = retained
      ? { request: retained.request, request_tag: retained.requestTag }
      : undefined;
    if (
      relayed &&
      journaled &&
      (relayed.requestHex !== hex(journaled.request) ||
        relayed.requestTagHex !== journaled.request_tag)
    )
      return yield* Effect.fail(fail('pairing-tampered'));
    const bytes = journaled
      ? new Uint8Array(journaled.request)
      : relayed
        ? raw(relayed.requestHex)
        : null;
    const tag = journaled?.request_tag ?? relayed?.requestTagHex;
    if (!bytes || !tag) return null;
    const decoded = decodePairingRequest(bytes);
    if (Result.isFailure(decoded)) return yield* Effect.fail(fail('pairing-tampered'));
    const request = decoded.success;
    if (
      Result.isFailure(verifyPairingRequestTag(keys, request, raw(tag))) ||
      hex(request.lookupId) !== lookupId ||
      request.account !== input.account
    )
      return yield* Effect.fail(fail('pairing-tampered'));
    const lifetime = checkPairingRequestLifetime(request, now());
    if (Result.isFailure(lifetime)) {
      if (lifetime.failure.code === 'expired') yield* settle(lookupId, 'approver', 'expired');
      return yield* Effect.fail(fail('pairing-expired'));
    }
    return { lookupId, request, bytes, tag, relayed };
  });

  const accountPairingCode = () =>
    Effect.sync(() => {
      const secret = random(16);
      try {
        return {
          pairingString: formatPairingString(Result.getOrThrow(encodePairingSecret(secret))),
          expiresAt: now() + PAIRING_REQUEST_MAX_LIFETIME_MS,
        };
      } finally {
        secret.fill(0);
      }
    });

  const inspectAccountPairing = (pairingString: string) =>
    usingCode(pairingString, (secret) =>
      withKeys(secret, (keys) =>
        Effect.gen(function* () {
          const found = yield* authenticate(keys);
          if (!found) return null;
          const workspaces = yield* input.approverWorkspaces();
          const preview: AccountPairingPreview = {
            requestId: found.relayed?.requestId ?? found.lookupId,
            deviceName: found.request.deviceName,
            approximateLocation: found.relayed?.approximateLocation ?? null,
            requestedAt:
              found.relayed?.requestedAt ??
              found.request.expiresAt - PAIRING_REQUEST_MAX_LIFETIME_MS,
            expiresAt: found.request.expiresAt,
            workspaces: [],
            unavailable: [],
          };
          for (const item of found.request.rows) {
            const workspace = workspaces.find(
              (candidate) => hex(candidate.genesis) === hex(item.genesis)
            );
            if (workspace)
              preview.workspaces.push({ workspaceId: workspace.workspaceId, name: workspace.name });
            else {
              const hint = found.relayed?.workspaces.find(
                (hinted) => hinted.genesisHash === hex(item.genesis)
              );
              const workspaceId = hint?.workspaceId ?? hex(item.genesis);
              preview.unavailable.push({ workspaceId, name: workspaceId });
            }
          }
          return preview;
        })
      )
    );

  /** Admissions are keyed by workspace and the new device's signing key, not by
   * request: a later request for the same retained identity, for example after the
   * first expired before delivery, reuses the exact original and never re-signs. */
  const admission = (workspaceId: string, signingKey: Uint8Array) =>
    Effect.map(store.admission(workspaceId, hex(signingKey)), (record) =>
      record ? toAdmissionRow(record) : undefined
    );
  const signedFor = (lookupId: string) => store.admissionCount(lookupId);

  const approveAccountPairing = (options: {
    pairingString: string;
    requestId: string;
    workspaceIds: readonly string[];
  }) =>
    usingCode(options.pairingString, (secret) =>
      withKeys(secret, (keys) =>
        Effect.gen(function* () {
          const found = yield* authenticate(keys);
          if (!found) return yield* Effect.fail(fail('pairing-expired'));
          if (found.relayed && found.relayed.requestId !== options.requestId)
            return yield* Effect.fail(fail('invalid-input'));
          const { lookupId, request } = found;
          const all = yield* input.approverWorkspaces();
          const selected = options.workspaceIds.map((id) => {
            const workspace = all.find((item) => item.workspaceId === id);
            const row =
              workspace &&
              request.rows.find((item) => hex(item.genesis) === hex(workspace.genesis));
            return workspace && row ? { workspace, row } : null;
          });
          if (selected.length === 0 || selected.some((item) => !item))
            return yield* Effect.fail(fail('invalid-input'));
          yield* sql(store.putApprovedRequest(lookupId, found.bytes, found.tag));
          const outcomes = new Map<
            string,
            AccountPairingApproval['workspaces'][number]['outcome']
          >();
          // Sign each workspace and identity once; the original is durable before any
          // network step. The caller's permit makes check, sign and journal atomic.
          for (const item of selected) {
            const { workspace, row } = item!;
            const existing = yield* sql(admission(workspace.workspaceId, row.signingPublicKey));
            if (existing) {
              if (existing.genesis !== hex(workspace.genesis))
                return yield* Effect.fail(fail('corrupt'));
              continue;
            }
            // A failed refresh or signature affects only this workspace.
            if (workspace.refresh) {
              const refreshed = yield* Effect.result(workspace.refresh());
              if (Result.isFailure(refreshed)) {
                if (refusesApproval(refreshed.failure))
                  return yield* Effect.fail(refreshed.failure);
                rememberDesktopE2eeFailure('account-pairing-refresh', refreshed.failure);
                outcomes.set(workspace.workspaceId, 'not-admitted');
                continue;
              }
            }
            // Checked again after the network step, immediately before signing.
            if (Result.isFailure(verifyPairingRequestTag(keys, request, raw(found.tag))))
              return yield* Effect.fail(fail('pairing-tampered'));
            const lifetime = checkPairingRequestLifetime(request, now());
            if (Result.isFailure(lifetime)) {
              if (lifetime.failure.code === 'expired') {
                yield* settle(lookupId, 'approver', 'expired');
                return yield* Effect.fail(fail('pairing-expired'));
              }
              return yield* Effect.fail(fail('pairing-tampered'));
            }
            const signed = yield* Effect.result(workspace.sign(row));
            if (Result.isFailure(signed)) {
              if (refusesApproval(signed.failure)) return yield* Effect.fail(signed.failure);
              rememberDesktopE2eeFailure('account-pairing-sign', signed.failure);
              outcomes.set(workspace.workspaceId, 'not-admitted');
              continue;
            }
            yield* sql(
              store.insertAdmission({
                workspaceId: workspace.workspaceId,
                signingKey: hex(row.signingPublicKey),
                genesis: hex(workspace.genesis),
                lookupId,
                requestId: signed.success.requestId,
                record: signed.success.record,
                invitation: null,
              })
            );
          }
          const deliverable: {
            workspace: AccountPairingApproverWorkspace;
            journaled: AdmissionRow;
            invitation: Uint8Array;
          }[] = [];
          for (const item of selected) {
            const { workspace, row } = item!;
            const journaled = yield* sql(admission(workspace.workspaceId, row.signingPublicKey));
            // Not signed in this pass; its outcome is already recorded.
            if (!journaled) continue;
            const appended = yield* Effect.result(
              workspace.append(
                journaled.request_id,
                new Uint8Array(journaled.record),
                row.credentialHash
              )
            );
            if (Result.isFailure(appended)) {
              // The host reports `admission-lost` only when the verified ledger holds
              // a different record in this original's slot: it can never commit, so
              // retire it and let a later approval sign once more after rechecks.
              const code =
                appended.failure &&
                typeof appended.failure === 'object' &&
                'code' in appended.failure
                  ? appended.failure.code
                  : undefined;
              if (code === 'admission-lost')
                yield* sql(
                  store.deleteAdmission(
                    workspace.workspaceId,
                    journaled.signing_key,
                    journaled.request_id
                  )
                );
              outcomes.set(workspace.workspaceId, 'not-admitted');
              continue;
            }
            let invitation: Uint8Array | null = journaled.invitation
              ? new Uint8Array(journaled.invitation)
              : null;
            if (!invitation) {
              invitation = yield* Effect.orElseSucceed(
                workspace.invitation(new Uint8Array(journaled.record)),
                () => null
              );
              if (invitation)
                yield* sql(
                  store.setAdmissionInvitation(
                    workspace.workspaceId,
                    journaled.signing_key,
                    invitation
                  )
                );
            }
            if (!invitation) outcomes.set(workspace.workspaceId, 'awaiting-delivery');
            else deliverable.push({ workspace, journaled, invitation });
          }
          if (deliverable.length > 0) {
            deliverable.sort((a, b) => (a.journaled.genesis < b.journaled.genesis ? -1 : 1));
            const approval = {
              requestDigest: yield* fromResult(pairingRequestDigest(request), 'corrupt'),
              // Each row's record hash binds that workspace's signer; this field
              // names the first one so the approval has a single stable approver key.
              approverSigningPublicKey: deliverable[0]!.workspace.signingPublicKey,
              rows: deliverable.map((item) => ({
                genesis: item.workspace.genesis,
                // The ledger's own record hash, so the new device finds the record.
                admissionRecordHash: hashRecordBytes(
                  new Uint8Array(item.journaled.record)
                ).toBytes(),
                invitationDigest: sha256(item.invitation),
              })),
            };
            const bytes = yield* fromResult(encodePairingApproval(approval), 'invalid-input');
            const tag = yield* fromResult(pairingApprovalTag(keys, approval), 'invalid-input');
            // Never publish an approval this device could not itself verify.
            if (Result.isFailure(verifyPairingApprovalTag(keys, approval, tag)))
              return yield* Effect.fail(fail('corrupt'));
            const invitations: E2eeAccountPairingRequests['publish']['invitations'] = [];
            for (const item of deliverable)
              invitations.push({
                ...(yield* item.workspace.access()),
                genesisHash: item.journaled.genesis,
                invitationHex: hex(item.invitation),
              });
            const published = yield* Effect.result(
              relay.publish({
                lookupId,
                approvalHex: hex(bytes),
                approvalTagHex: hex(tag),
                invitations,
              })
            );
            for (const item of deliverable)
              outcomes.set(
                item.workspace.workspaceId,
                Result.isSuccess(published) ? 'admitted' : 'awaiting-delivery'
              );
          }
          const result = selected.map((item) => ({
            workspaceId: item!.workspace.workspaceId,
            outcome: outcomes.get(item!.workspace.workspaceId) ?? ('not-admitted' as const),
          }));
          if (result.every((item) => item.outcome === 'admitted'))
            yield* settle(lookupId, 'approver', 'approved');
          return { workspaces: result } satisfies AccountPairingApproval;
        })
      )
    );

  const declineAccountPairing = (options: { pairingString: string; requestId: string }) =>
    usingCode(options.pairingString, (secret) =>
      withKeys(secret, (keys) =>
        Effect.gen(function* () {
          const found = yield* authenticate(keys);
          if (!found) return yield* Effect.fail(fail('pairing-expired'));
          const signed = yield* sql(signedFor(found.lookupId));
          // A device that already signed for this request cannot take that back.
          if (signed > 0) return yield* Effect.fail(fail('pairing-used'));
          yield* settle(found.lookupId, 'approver', 'declined');
          yield* relay.decline(options.requestId);
          return undefined;
        })
      )
    );

  const one =
    <A extends unknown[], B, E, R>(work: (...args: A) => Effect.Effect<B, E, R>) =>
    (...args: A) =>
      serial.withPermit(work(...args));
  return {
    requestAccountPairing: one(requestAccountPairing),
    accountPairingRequest: one(accountPairingRequest),
    cancelAccountPairing: one(cancelAccountPairing),
    accountPairingCode,
    inspectAccountPairing: one(inspectAccountPairing),
    approveAccountPairing: one(approveAccountPairing),
    declineAccountPairing: one(declineAccountPairing),
  };
}
