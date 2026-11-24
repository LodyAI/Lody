import { Deferred, Effect, Exit, FiberMap, Result, Scope } from 'effect';
import type {
  E2eeAppendRecordRequest,
  E2eeAppendRecordReply,
  E2eeWorkspaceHistoryPage,
  E2eeWorkspaceHistoryRequest,
  E2eeWorkspaceBatchReply,
  E2eeAccountPairingMailboxPreview,
} from '@lody/cloud-api';
import { BackendError, type KeyMailbox } from '@lody/e2ee-core/services';
import type { E2eeAccountPairingRuntime, E2eeWorkspaceRuntime } from '@lody/platform';
import {
  accountUserId,
  decodeRecord,
  hashRecordBytes,
  type LedgerView,
} from '@lody/e2ee-core/protocol';
import type {
  AccountPairingApproverFilter,
  AccountPairingApproverBatch,
  AccountPairingApproverWorkspace,
  AccountPairingRequesterFilter,
  AccountPairingRequesterWorkspace,
} from './account-pairing';
import { verifyPersonalHistory } from './admission';
import type { makePersonalDeviceHost } from './host';
import { decodePersonalInvitation, decodePersonalRequest } from './pairing';
import { fromHex, toHex } from './bytes';

/** One-shot authenticated-receiver input. Scope and cryptographic checks remain
 * in KeyReceiver; an absent/empty/mismatched preview delegates to the live mailbox. */
export function accountPairingMailboxPreview(
  mailbox: KeyMailbox['Service'],
  preview: E2eeAccountPairingMailboxPreview
): KeyMailbox['Service'] {
  let available = preview.items.length > 0;
  let statusAvailable = false;
  return {
    put: mailbox.put.bind(mailbox),
    read: mailbox.read.bind(mailbox),
    report: mailbox.report.bind(mailbox),
    repair: mailbox.repair.bind(mailbox),
    fetch: (epoch, cursor, limit) =>
      Effect.suspend(() => {
        const use =
          available && epoch === preview.epoch && cursor === null && preview.items.length <= limit;
        available = false;
        statusAvailable = use;
        if (!use) return mailbox.fetch(epoch, cursor, limit);
        return Effect.try({
          try: () => ({
            items: preview.items.map((item) => ({
              sender: item.sender,
              frame: fromHex(item.frameHex),
            })),
            next: null,
          }),
          catch: (cause) => cause,
        }).pipe(
          Effect.mapError(
            () => new BackendError({ service: 'KeyMailbox', reason: 'invalid-response' })
          )
        );
      }),
    status: (slot) =>
      Effect.suspend(() => {
        if (
          statusAvailable &&
          slot.genesis === preview.slot.genesis &&
          slot.epoch === preview.slot.epoch &&
          slot.recipient === preview.slot.recipient
        ) {
          return Effect.succeed({ ...preview.slot });
        }
        return mailbox.status(slot);
      }),
  };
}

/** Batch transport still delegates every original and local settlement to its
 * workspace's existing verifier. Missing/ambiguous batch replies use exact retries. */
export function makeAccountPairingBatch(ports: {
  history(
    items: E2eeWorkspaceHistoryRequest[]
  ): Effect.Effect<E2eeWorkspaceBatchReply<E2eeWorkspaceHistoryPage>, unknown>;
  append(
    items: E2eeAppendRecordRequest[]
  ): Effect.Effect<E2eeWorkspaceBatchReply<E2eeAppendRecordReply>, unknown>;
}): AccountPairingApproverBatch {
  const indexed = <A>(reply: E2eeWorkspaceBatchReply<A>, ids: readonly string[]) =>
    Effect.try({
      try: () => {
        if (
          reply.items.length !== ids.length ||
          new Set(reply.items.map((item) => item.workspaceId)).size !== ids.length ||
          reply.items.some((item) => !ids.includes(item.workspaceId))
        )
          throw fail('invalid-input');
        return new Map(reply.items.map((item) => [item.workspaceId, item]));
      },
      catch: (cause) => cause,
    });
  const ingest = (workspace: AccountPairingApproverWorkspace, page?: E2eeWorkspaceHistoryPage) =>
    page && workspace.ingestHistory
      ? workspace.ingestHistory(page)
      : (workspace.refresh?.() ?? Effect.fail(fail('unsupported')));
  return {
    refresh: Effect.fnUntraced(function* (workspaces) {
      const reply = yield* ports.history(
        workspaces.map((workspace) => ({
          workspaceId: workspace.workspaceId,
          ...(workspace.checkpoint?.position ? { after: workspace.checkpoint.position } : {}),
        }))
      );
      const items = yield* indexed(
        reply,
        workspaces.map((workspace) => workspace.workspaceId)
      );
      return new Map(
        yield* Effect.forEach(
          workspaces,
          (workspace) => {
            const item = items.get(workspace.workspaceId)!;
            return Effect.map(
              Effect.result(
                item.status === 'ok' ? ingest(workspace, item.result) : Effect.fail(fail(item.code))
              ),
              (result) => [workspace.workspaceId, result] as const
            );
          },
          { concurrency: 4 }
        )
      );
    }),
    append: Effect.fnUntraced(function* (workspaces) {
      const reply = yield* ports.append(
        workspaces.map(({ workspace, requestId, record, credentialHash }) => ({
          workspaceId: workspace.workspaceId,
          requestId,
          recordHex: toHex(record),
          credentialHash: toHex(credentialHash),
        }))
      );
      const items = yield* indexed(
        reply,
        workspaces.map(({ workspace }) => workspace.workspaceId)
      );
      return new Map(
        yield* Effect.forEach(
          workspaces,
          ({ workspace, record }) => {
            const item = items.get(workspace.workspaceId)!;
            const settle = Effect.gen(function* () {
              if (item.status !== 'ok') return yield* Effect.fail(fail(item.code));
              yield* ingest(workspace, item.result.historyPage);
              if (!workspace.settleAppend) return yield* Effect.fail(fail('unsupported'));
              yield* workspace.settleAppend(record);
            });
            return Effect.map(
              Effect.result(settle),
              (result) => [workspace.workspaceId, result] as const
            );
          },
          { concurrency: 4 }
        )
      );
    }),
  };
}

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
   * the verified genesis record and membership. `history` is the complete public signed
   * history the workflow verified; a host that verifies it again from its own pinned
   * genesis may prepare a replacement identity when it classifies the retained one as
   * revoked or its member removed. Without that classification nothing is replaced. */
  prepareAccountIdentity(pin: {
    readonly genesisRecordHex: string;
    readonly membershipId: string;
    readonly history?: readonly E2eeWorkspaceHistoryPage[];
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
    readonly history?: readonly E2eeWorkspaceHistoryPage[];
  }): Effect.Effect<void, unknown>;
  /** Installs from the complete verified history, for an approval row without an
   * invitation (a Member approver). `endorser` is the signer of the authenticated
   * admission record when that record is an ordinary signed record. */
  acceptAccountHistory?(input: {
    readonly genesisRecordHex: string;
    readonly membershipId: string;
    readonly pairingSessionId: string;
    readonly pages: readonly E2eeWorkspaceHistoryPage[];
    readonly endorser?: string;
  }): Effect.Effect<void, unknown>;
  /** Optional: open and receive keys from a preview before refreshing if needed. */
  activate?(preview?: E2eeAccountPairingMailboxPreview): Effect.Effect<void, unknown>;
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
      Effect.map(
        host.prepareAccount({
          genesisRecordHex: pin.genesisRecordHex,
          membershipId: pin.membershipId,
          ...(pin.history ? { history: pin.history } : {}),
        }),
        (prepared) => {
          const request = decodePersonalRequest(prepared.requestHex);
          return {
            signingPublicKey: fromHex(request.signingPublicKey),
            encryptionPublicKey: fromHex(request.encryptionPublicKey),
            possessionProof: fromHex(request.possessionSignature),
            credentialHash: fromHex(request.credentialHash),
          };
        }
      ),
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
        ...(input.history ? { history: input.history } : {}),
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
   * personal identity there and needs no pairing. `hint` is the routing hint being listed. */
  host: (
    workspaceId: string,
    hint: AccountPairingWorkspaceHint
  ) => Effect.Effect<AccountPairingIdentityHost | null, unknown>;
  history: (
    request: E2eeWorkspaceHistoryRequest
  ) => Effect.Effect<E2eeWorkspaceHistoryPage, unknown>;
  /** Optional batch transport. Failed batches retain the single-history fallback. */
  historyBatch?: (
    items: E2eeWorkspaceHistoryRequest[]
  ) => Effect.Effect<E2eeWorkspaceBatchReply<E2eeWorkspaceHistoryPage>, unknown>;
  /** The signed-in account; its encoded user ID finds this account's ledger member. */
  accountId: string;
  diagnostics?: (tag: string, error: unknown) => void;
  /** Verifies the complete history from the trusted genesis pin; defaults to
   * `verifyPersonalHistory`. A host may map its failures to its own public codes. */
  verifyHistory?: (
    pin: { workspaceId: string; genesisHash: string; genesisRecordHex: string },
    pages: readonly E2eeWorkspaceHistoryPage[]
  ) => Effect.Effect<LedgerView, unknown>;
}): (
  hints?: readonly AccountPairingWorkspaceHint[],
  filter?: AccountPairingRequesterFilter
) => Effect.Effect<readonly AccountPairingRequesterWorkspace[], unknown> {
  const remember = input.diagnostics ?? (() => {});
  const cachedByWorkspace = new Map<
    string,
    {
      genesisHash: string;
      genesisRecordHex: string;
      history: E2eeWorkspaceHistoryPage[];
      view: LedgerView;
      length: number;
      headHash: string;
      position: string;
    }
  >();
  const firstPages = new Map<string, E2eeWorkspaceHistoryPage>();
  const pagesFrom = Effect.fnUntraced(function* (
    workspaceId: string,
    firstPage: E2eeWorkspaceHistoryPage
  ) {
    const all: E2eeWorkspaceHistoryPage[] = [firstPage];
    let cursor = firstPage.nextCursor ?? undefined;
    for (let index = 1; cursor && index < 256; index++) {
      const page = yield* input.history({
        workspaceId,
        cursor,
        checkpoint: firstPage.checkpoint,
      });
      all.push(page);
      if (page.nextCursor === null) return all;
      cursor = page.nextCursor;
    }
    if (cursor) return yield* Effect.fail(fail('ledger_budget_exceeded'));
    return all;
  });
  const pages = Effect.fnUntraced(function* (workspaceId: string) {
    const prefetched = firstPages.get(workspaceId);
    firstPages.delete(workspaceId);
    const firstPage = prefetched ?? (yield* input.history({ workspaceId }));
    return yield* pagesFrom(workspaceId, firstPage);
  });
  /** The full signed history, verified from the genesis this device already trusts.
   * When `identity()` already verified a prefix, `accept()` asks only for records
   * after `position` and re-verifies or reuses the prefix without re-downloading. */
  const verified = Effect.fnUntraced(function* (hint: AccountPairingWorkspaceHint) {
    const cached = cachedByWorkspace.get(hint.workspaceId);
    let history: E2eeWorkspaceHistoryPage[] | undefined;
    if (cached && cached.genesisHash === hint.genesisHash && cached.position) {
      const prefetched = firstPages.get(hint.workspaceId);
      firstPages.delete(hint.workspaceId);
      const deltaFirst =
        prefetched ??
        (yield* input.history({
          workspaceId: hint.workspaceId,
          after: cached.position,
        }));
      if (deltaFirst.startIndex === cached.length) {
        const deltaPages = yield* pagesFrom(hint.workspaceId, deltaFirst);
        const appended = deltaPages.some((page) => page.recordsHex.length > 0);
        if (
          !appended &&
          deltaFirst.checkpoint.length === cached.length &&
          deltaFirst.checkpoint.headHash === cached.headHash
        ) {
          return {
            history: cached.history,
            view: cached.view,
            genesisRecordHex: cached.genesisRecordHex,
          };
        }
        const nonEmptyDelta = deltaPages.filter((page) => page.recordsHex.length > 0);
        const combined = [...cached.history, ...nonEmptyDelta];
        const finalPosition = deltaPages.at(-1)?.position;
        if (combined.length <= 256 && deltaPages.at(-1)?.nextCursor === null) {
          history = combined.map((page, index) => ({
            ...page,
            checkpoint: deltaFirst.checkpoint,
            nextCursor: index < combined.length - 1 ? (page.nextCursor ?? page.position) : null,
            ...(index === combined.length - 1 && finalPosition ? { position: finalPosition } : {}),
          }));
        }
      } else if (deltaFirst.startIndex === 0) {
        history = yield* pagesFrom(hint.workspaceId, deltaFirst);
      }
    }
    if (!history) history = yield* pages(hint.workspaceId);
    const genesisRecordHex = history[0]?.recordsHex[0];
    if (!genesisRecordHex) return yield* Effect.fail(fail('invalid-ledger'));
    const view = yield* (input.verifyHistory ?? verifyPersonalHistory)(
      { workspaceId: hint.workspaceId, genesisHash: hint.genesisHash, genesisRecordHex },
      history
    );
    const lastPage = history.at(-1);
    if (lastPage?.position) {
      cachedByWorkspace.set(hint.workspaceId, {
        genesisHash: hint.genesisHash,
        genesisRecordHex,
        history,
        view,
        length: lastPage.checkpoint.length,
        headHash: lastPage.checkpoint.headHash,
        position: lastPage.position,
      });
    }
    return { history, view, genesisRecordHex };
  });
  /** This account's single active membership in a verified view. A wrong answer
   * from the service only makes the possession proof fail; it is never pinned. */
  const membership = Effect.fnUntraced(function* (view: LedgerView) {
    const userId = accountUserId(input.accountId);
    if (Result.isFailure(userId)) return yield* Effect.fail(fail('missing-binding'));
    const mine = [...view.inspectState().members.entries()].filter(([, member]) =>
      member.userId.equals(userId.success)
    );
    if (mine.length !== 1) return yield* Effect.fail(fail('missing-binding'));
    return mine[0]![0];
  });

  return Effect.fnUntraced(function* (
    hints?: readonly AccountPairingWorkspaceHint[],
    filter?: AccountPairingRequesterFilter
  ) {
    const result: AccountPairingRequesterWorkspace[] = [];
    const byId = new Map<string, AccountPairingWorkspaceHint>();
    for (const hint of input.workspaces()) byId.set(hint.workspaceId, hint);
    for (const hint of hints ?? [])
      if (!byId.has(hint.workspaceId)) byId.set(hint.workspaceId, hint);
    // Never open a workspace host this step cannot use.
    const listed = [...byId.values()].filter(
      (hint) =>
        (filter?.workspaceId === undefined || filter.workspaceId === hint.workspaceId) &&
        (!filter?.geneses || filter.geneses.has(hint.genesisHash))
    );
    // Bounded parallel lookups; the result keeps the hint order.
    const hosts = yield* Effect.forEach(
      listed,
      (hint) =>
        input.host(hint.workspaceId, hint).pipe(
          Effect.catch((error) => {
            remember('account-pairing-host', error);
            return Effect.succeed(null);
          })
        ),
      { concurrency: 4 }
    );
    const missing = listed.filter(
      (hint, index) => hosts[index] && !cachedByWorkspace.has(hint.workspaceId)
    );
    if (input.historyBatch && missing.length) {
      const batch = yield* Effect.result(
        input.historyBatch(missing.map(({ workspaceId }) => ({ workspaceId })))
      );
      if (Result.isSuccess(batch))
        for (const item of batch.success.items) {
          if (
            item.status === 'ok' &&
            missing.some(
              (hint) =>
                hint.workspaceId === item.workspaceId &&
                hint.genesisHash === item.result.genesisHash
            ) &&
            item.result.workspaceId === item.workspaceId
          )
            firstPages.set(item.workspaceId, item.result);
        }
    }
    const prepareHistoryBatch = input.historyBatch
      ? Effect.fnUntraced(function* (workspaceIds: readonly string[]) {
          const wanted = listed.filter(
            (hint, index) =>
              hosts[index] &&
              workspaceIds.includes(hint.workspaceId) &&
              !firstPages.has(hint.workspaceId)
          );
          if (!wanted.length) return;
          const batch = yield* input.historyBatch!(
            wanted.map(({ workspaceId }) => {
              const cached = cachedByWorkspace.get(workspaceId);
              return { workspaceId, ...(cached?.position ? { after: cached.position } : {}) };
            })
          );
          for (const item of batch.items)
            if (
              item.status === 'ok' &&
              item.result.workspaceId === item.workspaceId &&
              wanted.some(
                (hint) =>
                  hint.workspaceId === item.workspaceId &&
                  hint.genesisHash === item.result.genesisHash
              )
            )
              firstPages.set(item.workspaceId, item.result);
        })
      : undefined;
    for (const [index, hint] of listed.entries()) {
      const host = hosts[index];
      if (!host || host.genesisHash !== hint.genesisHash) continue;
      result.push({
        workspaceId: hint.workspaceId,
        name: hint.name,
        genesis: fromHex(hint.genesisHash),
        ...(prepareHistoryBatch ? { prepareHistoryBatch } : {}),
        identity: () =>
          Effect.gen(function* () {
            const checked = yield* verified(hint);
            const membershipId = yield* membership(checked.view);
            const identity = yield* host.prepareAccountIdentity({
              genesisRecordHex: checked.genesisRecordHex,
              membershipId,
              history: checked.history,
            });
            return {
              signingPublicKey: identity.signingPublicKey,
              encryptionPublicKey: identity.encryptionPublicKey,
              possessionProof: identity.possessionProof,
              credentialHash: identity.credentialHash,
            };
          }),
        acceptHistory: host.acceptAccountHistory
          ? (admissionRecordHash, hints) =>
              Effect.gen(function* () {
                const checked = yield* verified(hint);
                const record = checked.history
                  .flatMap((page) => page.recordsHex)
                  .map(fromHex)
                  .find(
                    (bytes) =>
                      toHex(hashRecordBytes(bytes).toBytes()) === toHex(admissionRecordHash)
                  );
                if (!record) return yield* Effect.fail(fail('missing-binding'));
                const decoded = decodeRecord(record);
                const pairingSessionId = toHex(admissionRecordHash).slice(0, 32);
                const pending = yield* host.pendingPersonalJoin();
                if (pending && pending.pairingSessionId !== pairingSessionId)
                  return yield* Effect.fail(fail('pairing-journal-busy'));
                yield* host.acceptAccountHistory!({
                  genesisRecordHex: checked.genesisRecordHex,
                  membershipId: yield* membership(checked.view),
                  pairingSessionId,
                  pages: checked.history,
                  ...(Result.isSuccess(decoded) && decoded.success.body.type === 'ordinary'
                    ? { endorser: toHex(decoded.success.body.signer.toBytes()) }
                    : {}),
                });
                if (host.activate)
                  yield* host
                    .activate(hints?.mailboxPreview)
                    .pipe(
                      Effect.catch((error) =>
                        Effect.sync(() => remember('account-pairing-activate', error))
                      )
                    );
                return undefined;
              })
          : undefined,
        accept: (invitation, admissionRecordHash, hints) =>
          Effect.gen(function* () {
            const cached = cachedByWorkspace.get(hint.workspaceId);
            let inline: Uint8Array | undefined;
            if (
              cached?.genesisHash === hint.genesisHash &&
              hints?.admissionRecordHex &&
              hints.admissionRecordHex.length <= 16384 &&
              /^(?:[0-9a-f]{2})+$/.test(hints.admissionRecordHex)
            ) {
              const bytes = fromHex(hints.admissionRecordHex);
              if (toHex(hashRecordBytes(bytes).toBytes()) === toHex(admissionRecordHash))
                inline = bytes;
            }
            const checked =
              inline && cached
                ? {
                    view: cached.view,
                    genesisRecordHex: cached.genesisRecordHex,
                    history: cached.history,
                  }
                : yield* verified(hint);
            const record =
              inline ??
              checked.history
                .flatMap((page) => page.recordsHex)
                .map(fromHex)
                .find(
                  (bytes) => toHex(hashRecordBytes(bytes).toBytes()) === toHex(admissionRecordHash)
                );
            if (!record) return yield* Effect.fail(fail('missing-binding'));
            const decoded = decodeRecord(record);
            if (
              Result.isFailure(decoded) ||
              decoded.success.body.type !== 'ordinary' ||
              (inline &&
                (decoded.success.body.operation.type !== 'admitDevice' ||
                  decoded.success.body.operation.kind !== 'personal'))
            )
              return yield* Effect.fail(fail('invalid-ledger'));
            const pairingSessionId = toHex(admissionRecordHash).slice(0, 32);
            // An unrelated unfinished per-workspace exchange keeps its journal:
            // this workspace is reported blocked instead of overwritten.
            const pending = yield* host.pendingPersonalJoin();
            if (pending && pending.pairingSessionId !== pairingSessionId)
              return yield* Effect.fail(fail('pairing-journal-busy'));
            let qualifiedHistory: E2eeWorkspaceHistoryPage[] | undefined;
            if (inline && cached && decoded.success.body.previousHash.equals(cached.view.head)) {
              const receipt = Result.try({
                try: () => decodePersonalInvitation(toHex(invitation)),
                catch: (cause) => cause,
              });
              if (
                Result.isSuccess(receipt) &&
                receipt.success.length === cached.length + 1 &&
                toHex(receipt.success.head.toBytes()) === toHex(admissionRecordHash)
              ) {
                const checkpoint = {
                  headHash: toHex(admissionRecordHash),
                  length: cached.length + 1,
                };
                qualifiedHistory = [
                  ...cached.history.map((page) => ({
                    ...page,
                    checkpoint,
                    nextCursor: page.nextCursor ?? page.position,
                  })),
                  {
                    workspaceId: hint.workspaceId,
                    genesisHash: hint.genesisHash,
                    checkpoint,
                    startIndex: cached.length,
                    recordsHex: [toHex(inline)],
                    position: receipt.success.offset,
                    nextCursor: null,
                  },
                ];
              }
            }
            yield* host.acceptAccountInvitation({
              invitationHex: toHex(invitation),
              endorser: toHex(decoded.success.body.signer.toBytes()),
              genesisRecordHex: checked.genesisRecordHex,
              membershipId: yield* membership(checked.view),
              pairingSessionId,
              ...(qualifiedHistory ? { history: qualifiedHistory } : {}),
            });
            if (host.activate)
              yield* host
                .activate(hints?.mailboxPreview)
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
    settle(
      record: Uint8Array,
      refresh?: boolean
    ): Effect.Effect<'committed' | 'lost' | 'unknown', unknown>;
    checkpoint?(): Effect.Effect<{ headHash: string; length: number; position?: string }, unknown>;
    ingest?(page: E2eeWorkspaceHistoryPage): Effect.Effect<void, unknown>;
    prepareDelivery?(
      recipient: string
    ): Effect.Effect<{ id: string; frameHex: string } | null, unknown>;
    invitation(record: Uint8Array): Effect.Effect<Uint8Array | null, unknown>;
    access(): Effect.Effect<{ workspaceId: string; credential: string }, unknown>;
  };
  refresh(): Effect.Effect<unknown, unknown>;
  /** This session's existing key round (receive, reports, distribution, repair). Its
   * distributor targets only devices of the verified ledger and journals each envelope,
   * so a later round retries the same id and bytes. `distribute` only reconciles and
   * sends this device's deliveries; an implementation without modes runs a full round. */
  keyRound(
    mode?: 'full' | 'distribute',
    recipients?: readonly string[]
  ): Effect.Effect<unknown, unknown>;
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
/** One ledger catch-up. Timing out cancels it and the round still runs. */
export const ACCOUNT_APPROVAL_REFRESH_TIMEOUT_MS = 30_000;
/** Member key delivery backoff: eight retries over about 14 minutes. The first ones are
 * short, so a requester waiting for its key is not held back by a transient refusal right
 * after approval; the tail keeps the desktop's 5 min cap. */
export const KEY_DELIVERY_RETRY_DELAYS = [
  500, 1_500, 4_000, 10_000, 40_000, 160_000, 300_000, 300_000,
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
  historyBatch?: (
    items: E2eeWorkspaceHistoryRequest[]
  ) => Effect.Effect<E2eeWorkspaceBatchReply<E2eeWorkspaceHistoryPage>, unknown>;
  appendRecordsBatch?: (
    items: E2eeAppendRecordRequest[]
  ) => Effect.Effect<E2eeWorkspaceBatchReply<E2eeAppendRecordReply>, unknown>;
  /** Observes the background key delivery started after each committed admission. */
  onKeyDelivery?: (event: AccountPairingKeyDeliveryEvent) => void;
  /** Due-retry schedule; tests inject `sleep` instead of waiting. */
  keyDeliveryRetry?: {
    readonly delays?: readonly number[];
    readonly sleep?: (ms: number) => Effect.Effect<void>;
  };
  /** Bounded local diagnostics for failures no caller awaits (a background release). */
  diagnostics?: (scope: string, cause: unknown) => void;
}): (
  filter?: AccountPairingApproverFilter
) => Effect.Effect<readonly AccountPairingApproverWorkspace[], unknown> {
  const batch =
    input.historyBatch && input.appendRecordsBatch
      ? makeAccountPairingBatch({ history: input.historyBatch, append: input.appendRecordsBatch })
      : undefined;
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
  /** One delivery per workspace and device. Its fibers are detached from the approval
   * that starts them (the approval returns first) and leave the map when they end; a
   * new delivery for the same device interrupts and awaits the previous one. */
  const deliveries = Effect.runSync(
    Effect.provideService(FiberMap.make<string, void, never>(), Scope.Scope, Scope.makeUnsafe())
  );
  // Sessions opened before a later workspace fails are not returned, so the caller
  // cannot release them: release them here on any failure.
  const list = Effect.fnUntraced(function* (
    opened: AccountPairingApproverSession[],
    filter?: AccountPairingApproverFilter
  ) {
    const result: AccountPairingApproverWorkspace[] = [];
    const listed = input
      .workspaces()
      .filter(
        (hint) =>
          (!filter?.workspaceIds || filter.workspaceIds.has(hint.workspaceId)) &&
          (!filter?.geneses || filter.geneses.has(hint.genesisHash))
      );
    // Bounded parallel lookups in hint order. A failed lookup does not interrupt the
    // others: lookups already running settle and are recorded as opened, so the caller's
    // release covers them; lookups not yet started are skipped.
    let failed = false;
    const exits = yield* Effect.forEach(
      listed,
      (hint) =>
        Effect.suspend(() =>
          failed
            ? Effect.succeed(Exit.succeed(null))
            : Effect.exit(
                input.session(hint.workspaceId).pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      if (Exit.isFailure(exit)) failed = true;
                      else if (exit.value) opened.push(exit.value);
                    })
                  )
                )
              )
        ),
      { concurrency: 4 }
    );
    const failure = exits.find(Exit.isFailure);
    if (failure) return yield* Effect.failCause(failure.cause);
    for (const [index, hint] of listed.entries()) {
      const exit = exits[index]!;
      const session = Exit.isSuccess(exit) ? exit.value : null;
      if (!session) continue;
      const approval = session.accountApproval;
      const { workspaceId } = hint;
      const boundary = approval.checkpoint
        ? yield* Effect.result(approval.checkpoint())
        : undefined;
      result.push({
        workspaceId,
        name: hint.name,
        genesis: fromHex(hint.genesisHash),
        signingPublicKey: session.binding.device.toBytes(),
        ...(boundary && Result.isSuccess(boundary) ? { checkpoint: boundary.success } : {}),
        ...(batch && approval.ingest ? { batch } : {}),
        ...(approval.ingest
          ? { ingestHistory: (page: E2eeWorkspaceHistoryPage) => approval.ingest!(page) }
          : {}),
        settleAppend: (record) =>
          Effect.gen(function* () {
            const settled = yield* approval.settle(record, false);
            if (settled !== 'committed')
              return yield* Effect.fail(
                fail(settled === 'lost' ? 'admission-lost' : 'append_unconfirmed')
              );
          }),
        ...(approval.prepareDelivery
          ? {
              prepareDelivery: (recipient: Uint8Array) =>
                approval.prepareDelivery!(toHex(recipient)),
            }
          : {}),
        delivered: (recipient, requestId) =>
          Effect.sync(() =>
            input.onKeyDelivery?.({
              workspaceId,
              requestId,
              device: toHex(recipient),
              state: 'delivered',
            })
          ),
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
            const page = Result.isSuccess(appended)
              ? (appended.success as E2eeAppendRecordReply | null)?.historyPage
              : undefined;
            if (page && approval.ingest) yield* approval.ingest(page);
            const settled = yield* approval.settle(record, !(page && approval.ingest));
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
            const deliveryKey = `${workspaceId}:${device}`;
            // The replaced delivery has released its session once this returns.
            yield* FiberMap.remove(deliveries, deliveryKey);
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
            const acquire = Effect.suspend(() => input.session(workspaceId)).pipe(
              Effect.orElseSucceed(() => null)
            );
            const release = (held: AccountPairingApproverSession | null) =>
              held ? releaseQuietly(held, 'account-pairing-key-delivery-release') : Effect.void;
            const owner = toHex(session.binding.device.toBytes());
            // The mailbox refuses a sender behind the ledger, so a retry catches up first.
            // The round then resends the saved original or supersedes it from the new ledger;
            // a failed or timed-out catch-up does not skip the round.
            const attempt = (held: AccountPairingApproverSession | null, retry: number) =>
              Effect.gen(function* () {
                if (!held) return 'e2ee_key_delivery_closed';
                if (toHex(held.binding.device.toBytes()) !== owner)
                  return 'e2ee_key_delivery_owner_changed';
                if (retry > 0)
                  yield* Effect.result(
                    held.refresh().pipe(Effect.timeoutOption(ACCOUNT_APPROVAL_REFRESH_TIMEOUT_MS))
                  );
                // The first attempt only distributes: the admission just committed on this
                // already-current device, so receive/repair would only delay the envelope.
                // A retry runs the full round, which first receives a key this device lacks.
                const round = yield* Effect.result(
                  held.keyRound(retry === 0 ? 'distribute' : 'full', [device])
                );
                const evidence = yield* Effect.result(held.keyDeliveryEvidence(device));
                if (Result.isSuccess(evidence) && evidence.success === 'delivered')
                  return 'delivered';
                if (Result.isFailure(round)) return keyDeliveryCode(round.failure);
                return Result.isSuccess(evidence)
                  ? evidence.success
                  : keyDeliveryCode(evidence.failure);
              });
            // The first hold is taken before approval continues, so the workflow may
            // release its own listing session without closing the reader underneath.
            let first: AccountPairingApproverSession | null = yield* acquire;
            const takeFirst = Effect.sync(() => {
              const held = first;
              first = null;
              return held;
            });
            // Completes when attempt 0 ends, however it ends, and never after a backoff.
            const firstPass = yield* Deferred.make<void>();
            const deliver = Effect.gen(function* () {
              for (let retry = 0; ; retry++) {
                // Each attempt holds its own session only while it runs, so the delivery
                // never keeps a reader open across the backoff.
                const code = yield* Effect.acquireUseRelease(
                  retry === 0 ? takeFirst : acquire,
                  (held) => attempt(held, retry),
                  release
                );
                if (retry === 0) yield* Deferred.succeed(firstPass, undefined);
                if (code === 'delivered') return report('delivered');
                if (
                  code === 'e2ee_key_delivery_closed' ||
                  code === 'e2ee_key_delivery_owner_changed' ||
                  TERMINAL_KEY_DELIVERY.has(code) ||
                  retry >= delays.length
                )
                  return report('ended', code);
                report('retrying', code);
                yield* sleep(delays[retry]!);
              }
            }).pipe(
              Effect.catchDefect((defect) =>
                Effect.sync(() => report('ended', keyDeliveryCode(defect)))
              ),
              Effect.ensuring(
                Effect.suspend(() =>
                  Deferred.succeed(firstPass, undefined).pipe(Effect.andThen(release(first)))
                )
              )
            );
            report('running');
            yield* FiberMap.run(deliveries, deliveryKey, deliver);
            return Deferred.await(firstPass);
          }),
      });
    }
    return result;
  });
  return (filter?: AccountPairingApproverFilter) => {
    const opened: AccountPairingApproverSession[] = [];
    return list(opened, filter).pipe(
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
