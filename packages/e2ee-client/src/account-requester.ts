import { Effect, Result } from 'effect';
import type { E2eeWorkspaceHistoryPage, E2eeWorkspaceHistoryRequest } from '@lody/cloud-api';
import type { E2eeAccountPairingRuntime, E2eeWorkspaceRuntime } from '@lody/platform';
import { decodeRecord, hashRecordBytes } from '@lody/e2ee-core/protocol';
import type { AccountPairingRequesterWorkspace } from './account-pairing';
import { verifyPersonalHistory } from './admission';
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
  /** Optional: open, refresh and run one key round right after installing. */
  activate?(): Effect.Effect<void, unknown>;
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
  accountIdentity: () => Effect.Effect<{ readonly cryptoUserId: string }, unknown>;
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
    const { cryptoUserId } = yield* input.accountIdentity();
    const mine = [...view.inspectState().members.entries()].filter(
      ([, member]) => toHex(member.userId.toBytes()) === cryptoUserId
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
