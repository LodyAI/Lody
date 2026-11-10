import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Scope,
  Semaphore,
  Result,
} from 'effect';
import { VerifiedLedger, makeWorkspaceRecovery, memoryRecoveryEpochKeys } from '@lody/e2ee-core';
import { wipeRecoveryPackage, accountUserId, prepareJoinRequest } from '@lody/e2ee-core/protocol';
import type { E2eeMemberOffer } from '@lody/cloud-api';
import { encodeMemberKeyPackage, memberPairingOffer, MemberOfferSchema } from './member';
import { prepareVaultRestore, type PersonalHostRecoveryInput } from './recovery-restore';
import { Bytes, requireLedgerContinuation } from '@lody/e2ee-core/protocol';
import {
  ClientApprovalEvidenceStore,
  ClientCustodyWriter,
  ClientInstallationStore,
  ClientPairingOriginalStore,
  DeviceIdentity,
  WorkspaceScope,
  LedgerPinStore,
  LedgerSync,
  LedgerViewSource,
  LedgerViewSourceError,
} from '@lody/e2ee-core/services';
import {
  PersonalHostPlatform,
  PersonalHostRemote,
  type PersonalApproval,
  type PersonalExchange,
  type PersonalExchangeResponse,
} from './platform';
import {
  acquirePersonalCustody,
  decode,
  openPreparedIdentity,
  preparePersonalIdentity,
  sameBinding,
  type PreparedPersonalIdentity,
} from './installation';
import { assertPersonalAdmission, verifyPersonalHistory, captureHistoryPages } from './admission';
import {
  decodePersonalInvitation,
  verifyPersonalApproval,
  verifyPersonalRequest,
  type PersonalPairingOffer,
} from './pairing';
import { openPersonalSession } from './session';
import { fail } from './errors';
import { toHex, fromHex } from './bytes';
import { sha256 } from '@noble/hashes/sha2.js';
import { qualifyPersonalLedgerOrigin } from './ledger';

const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
/** Account-wide pairing has no per-workspace offer: the identity is prepared before
 * any approver is known. Its fixed offer carries this placeholder endorser; the real
 * one comes, tag-authenticated, with the approval and replaces it when verifying. */
export const ACCOUNT_PAIRING_ENDORSER = '00'.repeat(32);
/** The fixed per-workspace offer behind an account-pairing identity, so every later
 * request and reopen finds the same identity and journal. */
export function accountPairingOffer(
  scope: { readonly workspaceId: string; readonly genesis: Bytes.GenesisHash },
  pin: { readonly genesisRecordHex: string; readonly membershipId: string }
): PersonalPairingOffer {
  return {
    version: 1,
    workspaceId: scope.workspaceId,
    genesisHash: toHex(scope.genesis.toBytes()),
    genesisRecordHex: pin.genesisRecordHex,
    endorser: ACCOUNT_PAIRING_ENDORSER,
    membershipId: pin.membershipId,
    pairingSessionId: toHex(
      sha256(new TextEncoder().encode(`lody-e2ee/account-pairing-session/v1\0${scope.workspaceId}`))
    ).slice(0, 32),
  };
}
const parse = <A>(v: Uint8Array) =>
  Effect.try({ try: () => decode(v) as A, catch: (cause) => fail('corrupt', cause) });
const key = (p: PreparedPersonalIdentity, purpose: 'claim' | 'approval') => ({
  ...p.binding,
  pairingSessionId: p.offer.pairingSessionId,
  purpose,
});
/** Portable host of a single independently pinned account/workspace/genesis. No background loop or product activation is implicit. */
export const makePersonalDeviceHost = Effect.fnUntraced(function* () {
  const sourcePlatform = yield* PersonalHostPlatform;
  const platform = Object.freeze({
    ...sourcePlatform,
    scope: Object.freeze({ ...sourcePlatform.scope }),
    custody: sourcePlatform.custody.bind(sourcePlatform),
    control: sourcePlatform.control.bind(sourcePlatform),
    keys: sourcePlatform.keys.bind(sourcePlatform),
    evidence: sourcePlatform.evidence.bind(sourcePlatform),
    rpc: sourcePlatform.rpc?.bind(sourcePlatform),
    contentToken: sourcePlatform.contentToken?.bind(sourcePlatform),
    machineSharing: sourcePlatform.machineSharing?.bind(sourcePlatform),
    drainOld: sourcePlatform.drainOld?.bind(sourcePlatform),
  });
  const remote = yield* PersonalHostRemote,
    pairings = yield* ClientPairingOriginalStore,
    installations = yield* ClientInstallationStore,
    writer = yield* ClientCustodyWriter;
  if (
    remote.accountId !== platform.scope.accountId ||
    installations.scope.accountId !== platform.scope.accountId ||
    installations.scope.workspaceId !== platform.scope.workspaceId ||
    !installations.scope.genesis.equals(platform.scope.genesis)
  )
    return yield* fail('scope-mismatch');
  // Capture trusted factories/capabilities once. Later object mutation cannot redirect in-flight ownership.
  const exchange = remote.exchange.bind(remote),
    history = remote.history?.bind(remote),
    drainOld = platform.drainOld?.bind(platform);
  const parent = yield* Scope.Scope;
  const owner = yield* Scope.fork(parent),
    operations = yield* Scope.fork(parent);
  const fibers = yield* Scope.provide(FiberSet.make(), operations),
    serial = yield* Semaphore.make(1);
  let closed = false;
  const guard = Effect.suspend(() => (closed ? Effect.fail(fail('closed')) : Effect.void));
  const close = yield* Effect.cached(
    Effect.uninterruptible(
      Effect.gen(function* () {
        closed = true;
        const exits = [
          yield* Effect.exit(Scope.close(operations, Exit.void)),
          yield* Effect.exit(Scope.close(owner, Exit.void)),
        ];
        const reasons = exits.flatMap((e) => (Exit.isFailure(e) ? e.cause.reasons : []));
        if (reasons.length) yield* Effect.failCause(Cause.fromReasons(reasons));
      })
    )
  );
  yield* Effect.addFinalizer(() => close.pipe(Effect.orDie));
  const run = <A, E>(work: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      yield* guard;
      const fiber = yield* FiberSet.run(
        fibers,
        serial.withPermit(
          Effect.gen(function* () {
            yield* guard;
            const value = yield* work;
            yield* guard;
            return value;
          })
        )
      );
      return yield* Fiber.join(fiber);
    });
  const base = Context.make(PersonalHostPlatform, platform).pipe(
    Context.add(ClientInstallationStore, installations),
    Context.add(ClientCustodyWriter, writer),
    Context.add(ClientPairingOriginalStore, pairings)
  );
  const prepare = (offer: PersonalPairingOffer, replacement = false, existingOnly = false) =>
    Effect.scoped(
      preparePersonalIdentity(offer, replacement, existingOnly).pipe(Effect.provide(base))
    );
  const publicPrepared = (p: PreparedPersonalIdentity) =>
    Object.freeze({
      workspaceId: p.binding.workspaceId,
      pairingSessionId: p.offer.pairingSessionId,
      signingPublicKey: toHex(p.binding.device.toBytes()),
      requestHex: p.requestHex,
    });
  const withIdentity = <A, E, R>(
    p: PreparedPersonalIdentity,
    use: (
      identity: Effect.Success<ReturnType<typeof openPreparedIdentity>>
    ) => Effect.Effect<A, E, R>
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { custody } = yield* acquirePersonalCustody(p).pipe(Effect.provide(base));
        const identity = yield* openPreparedIdentity(p, custody);
        return yield* use(identity);
      })
    );
  const evidence = (
    p: PreparedPersonalIdentity,
    identity: Effect.Success<ReturnType<typeof openPreparedIdentity>>
  ) =>
    Layer.build(
      platform.evidence(p.binding).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(WorkspaceScope, { genesis: p.binding.genesis }),
            Layer.succeed(DeviceIdentity, {
              signer: identity.device,
              encryptionKeyPair: identity.device.encryption,
            })
          )
        )
      )
    ).pipe(Effect.map((ctx) => Context.get(ctx, ClientApprovalEvidenceStore)));
  const verifyApproval = (
    p: PreparedPersonalIdentity,
    descriptor: {
      kind: string;
      invitationHex?: string;
      origin?: { invitationHex: string; endorser: string };
      /** Account pairing only: the approver named by the authenticated approval. */
      endorser?: string;
    },
    pages?: unknown
  ) =>
    Effect.gen(function* () {
      const request = yield* Effect.fromResult(verifyPersonalRequest(p.offer, p.requestHex));
      let approval: PersonalApproval;
      if (descriptor.kind === 'snapshot' && typeof descriptor.invitationHex === 'string') {
        const invitation = yield* Effect.try({
          try: () => decodePersonalInvitation(descriptor.invitationHex!),
          catch: (cause) => fail('invalid-input', cause),
        });
        const endorser =
          p.offer.endorser === ACCOUNT_PAIRING_ENDORSER ? descriptor.endorser : p.offer.endorser;
        if (!endorser) return yield* fail('approval-required');
        const pinned = { ...p.offer, endorser };
        const checked = yield* Effect.fromResult(verifyPersonalApproval(pinned, invitation));
        approval = {
          kind: 'snapshot',
          // The ledger re-verifies this snapshot from `offer`: it carries the real endorser.
          offer: pinned,
          invitation,
          view: checked.view,
          originalOrigin: {
            invitation,
            endorser: Result.getOrThrow(Bytes.signingPublicKey(fromHex(endorser))),
          },
        };
      } else if (descriptor.kind === 'history' && Array.isArray(pages)) {
        const view = yield* verifyPersonalHistory(p.offer, pages);
        const originalOrigin = descriptor.origin
          ? yield* Effect.try({
              try: () => ({
                invitation: decodePersonalInvitation(descriptor.origin!.invitationHex),
                endorser: Result.getOrThrow(
                  Bytes.signingPublicKey(fromHex(descriptor.origin!.endorser))
                ),
              }),
              catch: (cause) => fail('corrupt', cause),
            })
          : undefined;
        approval = { kind: 'history', offer: p.offer, pages, view, originalOrigin };
        if (originalOrigin) yield* qualifyPersonalLedgerOrigin(approval);
      } else return yield* fail('approval-required');
      yield* Effect.fromResult(assertPersonalAdmission(p.binding, request, approval.view));
      return approval;
    });
  const loadApproval = (p: PreparedPersonalIdentity) =>
    withIdentity(p, (identity) =>
      Effect.gen(function* () {
        const row = yield* pairings.load(key(p, 'approval'));
        if (!row) return yield* fail('approval-required');
        const saved = yield* parse<{
          version: number;
          offer: PersonalPairingOffer;
          requestHex: string;
          kind: string;
          invitationHex?: string;
          origin?: { invitationHex: string; endorser: string };
          endorser?: string;
        }>(row.original);
        if (
          saved.version !== 1 ||
          saved.requestHex !== p.requestHex ||
          JSON.stringify(saved.offer) !== JSON.stringify(p.offer)
        )
          return yield* fail('conflict');
        let pages: unknown;
        if (saved.kind === 'history') {
          const store = yield* evidence(p, identity),
            chunks = yield* store.load(p.offer.pairingSessionId);
          if (!chunks) return yield* fail('corrupt');
          pages = yield* Effect.forEach(chunks, (chunk) => parse(chunk));
        }
        const approved = yield* verifyApproval(p, saved, pages);
        if (approved.kind !== 'snapshot' || !history) return approved;
        // Keep the immutable approval, feed origin and pin. Only its missing
        // signed prefix is added to the existing bound approval-evidence store.
        const store = yield* evidence(p, identity);
        const chunks = yield* store.load(p.offer.pairingSessionId);
        let proof: unknown[];
        if (chunks) proof = yield* Effect.forEach(chunks, (chunk) => parse(chunk));
        else {
          yield* guard;
          const source = yield* history(identity.credential);
          yield* guard;
          proof = yield* Effect.fromResult(captureHistoryPages(source));
        }
        const qualified = yield* verifyApproval(
          p,
          {
            kind: 'history',
            origin: {
              invitationHex: saved.invitationHex!,
              endorser: approved.offer.endorser,
            },
          },
          proof
        );
        if (!chunks)
          yield* store.retain(
            p.offer.pairingSessionId,
            proof.map((page) => encode(page))
          );
        return qualified;
      })
    );
  const exchangeOriginal = (p: PreparedPersonalIdentity, action: PersonalExchange['action']) =>
    withIdentity(p, (identity) =>
      Effect.gen(function* () {
        const original = {
          version: 1 as const,
          accountId: p.binding.accountId,
          workspaceId: p.binding.workspaceId,
          genesisHash: toHex(p.binding.genesis.toBytes()),
          pairingSessionId: p.offer.pairingSessionId,
          requestHex: p.requestHex,
        };
        const slot = key(p, 'claim');
        const previous = yield* pairings.load(slot);
        if (!previous)
          yield* pairings.compareAndSet(slot, null, {
            revision: 1,
            original: encode(original),
            receipt: null,
          });
        const row = yield* pairings.load(slot);
        if (!row || toHex(row.original) !== toHex(encode(original))) return yield* fail('conflict');
        let response: PersonalExchangeResponse;
        if (row.receipt) response = yield* parse<PersonalExchangeResponse>(row.receipt);
        else {
          yield* guard;
          response = yield* exchange({ ...original, action });
          yield* guard;
          response = yield* Effect.try({
            try: () => {
              if (
                response.invitationHex !== undefined &&
                (typeof response.invitationHex !== 'string' ||
                  response.invitationHex.length > 6 * 1024 * 1024)
              )
                throw fail('invalid-input');
              return {
                version: response.version,
                accountId: response.accountId,
                workspaceId: response.workspaceId,
                genesisHash: response.genesisHash,
                pairingSessionId: response.pairingSessionId,
                requestHex: response.requestHex,
                status: response.status,
                ...(response.invitationHex !== undefined
                  ? { invitationHex: response.invitationHex }
                  : {}),
                ...(response.history !== undefined
                  ? { history: Result.getOrThrow(captureHistoryPages(response.history)) }
                  : {}),
              };
            },
            catch: (cause) => fail('invalid-input', cause),
          });
        }
        // Explicit echo comparison before interpreting relay state. No foreign cleanup or identity replacement.
        if (
          !response ||
          response.version !== 1 ||
          Object.keys(original).some(
            (k) =>
              original[k as keyof typeof original] !== response[k as keyof PersonalExchangeResponse]
          ) ||
          !['pending', 'admitting', 'cancelled', 'conflict', 'approved'].includes(response.status)
        )
          return yield* fail('scope-mismatch');
        if (response.status === 'pending' || response.status === 'admitting')
          return { status: response.status } as const;
        if (response.status === 'approved') {
          if (yield* pairings.load(key(p, 'approval'))) {
            yield* loadApproval(p);
            return { status: 'approved' as const };
          }
          let origin: { invitationHex: string; endorser: string } | undefined;
          if (response.history && p.replacing) {
            let cursor: string | null = null;
            for (let page = 0; page < 256; page++) {
              const entries: Effect.Success<
                ReturnType<ClientPairingOriginalStore['Service']['list']>
              > = yield* pairings.list(p.replacing, cursor, 64);
              for (const entry of entries.entries) {
                if (entry.key.purpose !== 'approval') continue;
                const saved = yield* parse<{
                  version: number;
                  kind: string;
                  offer: PersonalPairingOffer;
                  invitationHex?: string;
                  origin?: { invitationHex: string; endorser: string };
                }>(entry.value.original);
                if (saved.version !== 1) return yield* fail('corrupt');
                const oldOrigin =
                  saved.kind === 'snapshot' && saved.invitationHex
                    ? { invitationHex: saved.invitationHex, endorser: saved.offer.endorser }
                    : saved.origin;
                if (origin && JSON.stringify(origin) !== JSON.stringify(oldOrigin))
                  return yield* fail('conflict');
                origin = oldOrigin;
              }
              if (entries.next === null) break;
              if (page === 255 || entries.next === cursor) return yield* fail('corrupt');
              cursor = entries.next;
            }
          }
          const descriptor = response.history
            ? { kind: 'history' as const, ...(origin ? { origin } : {}) }
            : { kind: 'snapshot' as const, invitationHex: response.invitationHex };
          yield* verifyApproval(p, descriptor, response.history);
          if (response.history) {
            const store = yield* evidence(p, identity);
            yield* store.retain(
              p.offer.pairingSessionId,
              response.history.map((page) => encode(page))
            );
          }
          yield* pairings.compareAndSet(key(p, 'approval'), null, {
            revision: 1,
            original: encode({
              version: 1,
              offer: p.offer,
              requestHex: p.requestHex,
              ...descriptor,
            }),
            receipt: null,
          });
          // Approval evidence may exceed one pairing blob. Its immutable pages live in their own atomic bounded store.
          yield* pairings.compareAndSet(slot, 1, {
            ...row,
            revision: 2,
            receipt: encode({ ...original, status: 'approved' }),
          });
          return { status: 'approved' as const };
        }
        yield* pairings.compareAndSet(slot, 1, {
          ...row,
          revision: 2,
          receipt: encode({ ...original, status: response.status }),
        });
        return { status: response.status } as const;
      })
    );
  const activateReplacement = (p: PreparedPersonalIdentity, approval: PersonalApproval) =>
    Effect.gen(function* () {
      if (!p.replacing) return undefined;
      if (!drainOld || approval.kind !== 'history') return yield* fail('unsupported');
      // Qualify existing durable pins with the replacement's actual full signed history before draining any healthy owner.
      yield* withIdentity(p, (identity) =>
        Effect.gen(function* () {
          const ctx = yield* Layer.build(
            platform.control(p.binding, identity.credential, approval)
          );
          const sync = Context.get(ctx, LedgerSync);
          const checked = yield* Layer.build(
            VerifiedLedger.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(WorkspaceScope, { genesis: p.binding.genesis }),
                  Layer.succeed(LedgerPinStore, Context.get(ctx, LedgerPinStore)),
                  Layer.succeed(LedgerViewSource, {
                    current: () =>
                      sync.current().pipe(
                        Effect.map((s) => s.view),
                        Effect.mapError((cause) => new LedgerViewSourceError({ cause }))
                      ),
                  })
                )
              )
            )
          );
          const view = yield* Context.get(checked, VerifiedLedger).current();
          yield* Effect.fromResult(requireLedgerContinuation(approval.view, view));
          yield* Effect.fromResult(assertPersonalAdmission(p.binding, identity.request, view));
        })
      );
      yield* drainOld(p.replacing);
      yield* guard;
      yield* writer.run(
        Effect.uninterruptible(
          Effect.gen(function* () {
            let old = yield* installations.read();
            if (old && sameBinding(old.binding, p.binding) && old.phase === 'ready')
              return undefined;
            if (!old || !sameBinding(old.binding, p.replacing!)) return yield* fail('conflict');
            if (old.phase !== 'retired') {
              old = { ...old, revision: old.revision + 1, phase: 'retired' };
              yield* installations.compareAndSet(old.revision - 1, old);
            }
            const next = {
              binding: p.binding,
              revision: old.revision + 1,
              phase: 'protected' as const,
              wrapped: p.wrapped,
            };
            yield* installations.replace({ binding: old.binding, revision: old.revision }, next);
            // A lost response is resumed through read; ordinary CAS never changes identity.
            yield* withIdentity({ ...p, replacing: null }, () => Effect.void);
            yield* installations.compareAndSet(next.revision, {
              ...next,
              revision: next.revision + 1,
              phase: 'ready',
            });
            return undefined;
          })
        )
      );
      return undefined;
    });
  /** Account pairing: verify an invitation for the given endorser against this
   * device's prepared identity, and retain it as the approval original. */
  const acceptAccount = (input: {
    genesisRecordHex: string;
    membershipId: string;
    invitationHex: string;
    endorser: string;
  }) =>
    Effect.gen(function* () {
      const p = yield* prepare(accountPairingOffer(platform.scope, input));
      if (yield* pairings.load(key(p, 'approval'))) return yield* loadApproval(p);
      const descriptor = {
        kind: 'snapshot' as const,
        invitationHex: input.invitationHex,
        endorser: input.endorser,
      };
      const approval = yield* withIdentity(p, () => verifyApproval(p, descriptor));
      yield* pairings.compareAndSet(key(p, 'approval'), null, {
        revision: 1,
        original: encode({ version: 1, offer: p.offer, requestHex: p.requestHex, ...descriptor }),
        receipt: null,
      });
      return approval;
    });
  /** Account pairing without an invitation (Member approver): verify the complete
   * signed history and this device's admission, then retain the pages and approval. */
  /** Verify the complete signed history and this identity's admission, then retain
   * the pages and the approval original. */
  const acceptHistoryFor = (p: PreparedPersonalIdentity, source: unknown) =>
    Effect.gen(function* () {
      if (yield* pairings.load(key(p, 'approval'))) return yield* loadApproval(p);
      const pages = yield* Effect.fromResult(captureHistoryPages(source));
      const descriptor = { kind: 'history' as const };
      return yield* withIdentity(p, (identity) =>
        Effect.gen(function* () {
          const approval = yield* verifyApproval(p, descriptor, pages);
          const store = yield* evidence(p, identity);
          yield* store.retain(
            p.offer.pairingSessionId,
            pages.map((page) => encode(page))
          );
          yield* pairings.compareAndSet(key(p, 'approval'), null, {
            revision: 1,
            original: encode({
              version: 1,
              offer: p.offer,
              requestHex: p.requestHex,
              ...descriptor,
            }),
            receipt: null,
          });
          return approval;
        })
      );
    });
  /** Account pairing without an invitation (Member approver): verify the complete
   * signed history and this device's admission, then retain the pages and approval. */
  const acceptAccountHistory = (input: {
    genesisRecordHex: string;
    membershipId: string;
    pages: unknown;
    offer?: PersonalPairingOffer;
  }) =>
    Effect.flatMap(prepare(input.offer ?? accountPairingOffer(platform.scope, input)), (p) =>
      acceptHistoryFor(p, input.pages)
    );
  /** An existing identity for this offer, current or the replacement candidate a member
   * join after an ended one prepares; never creates one. */
  const prepareRetained = (offer: PersonalPairingOffer) =>
    prepare(offer, false, true).pipe(
      Effect.catchIf(
        (error) => (error as { code?: string }).code === 'conflict',
        () => prepare(offer, true, true)
      )
    );
  const restoreRecovery = (input: PersonalHostRecoveryInput) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Package authentication precedes allocating a local device or accepting server pins.
        const pin = yield* Effect.acquireUseRelease(
          input.vault.readEntry(input.reference),
          (bundle) =>
            Effect.succeed({
              genesisHash: bundle.genesis,
              genesisRecordHex: toHex(bundle.trust.genesisRecord),
              membershipId: bundle.membershipId,
            }),
          (bundle) => Effect.sync(() => wipeRecoveryPackage(bundle))
        );
        if (pin.genesisHash !== toHex(platform.scope.genesis.toBytes()))
          return yield* fail('scope-mismatch');
        const offer = input.offer ? { ...input.offer } : accountPairingOffer(platform.scope, pin);
        if (
          offer.workspaceId !== platform.scope.workspaceId ||
          offer.genesisHash !== pin.genesisHash ||
          offer.genesisRecordHex !== pin.genesisRecordHex ||
          offer.membershipId !== pin.membershipId
        )
          return yield* fail('scope-mismatch');
        const current = () =>
          Effect.flatMap(input.pages(), (pages) => verifyPersonalHistory(offer, pages));
        const initial = yield* current();
        const user = yield* Effect.fromResult(accountUserId(platform.scope.accountId));
        const member = initial.inspectState().members.get(pin.membershipId);
        if (!member || !member.userId.equals(user)) return yield* fail('scope-mismatch');
        const p = yield* prepare(offer);
        return yield* withIdentity(p, (identity) =>
          Effect.gen(function* () {
            const keys = memoryRecoveryEpochKeys();
            yield* Effect.addFinalizer(() => Effect.sync(() => keys.dispose()));
            const plan = yield* prepareVaultRestore({
              vault: input.vault,
              local: input.local,
              reference: input.reference,
              ports: (anchor) =>
                Effect.gen(function* () {
                  if (
                    !anchor.genesis.equals(p.binding.genesis) ||
                    toHex(anchor.membershipId.toBytes()) !== pin.membershipId
                  )
                    return yield* fail('scope-mismatch');
                  return {
                    personalSigner: identity.device,
                    ledger: current,
                    fetchCurrentEnvelope: input.fetchCurrentEnvelope,
                    installed: keys,
                    submitOriginalAsRecovery: (record, recovery, credential) =>
                      input.submitOriginalAsRecovery(
                        record,
                        recovery,
                        credential,
                        identity.request.credentialHash
                      ),
                    acquirePersonal: () => Effect.fail(fail('unsupported')),
                  };
                }),
            });
            const workflow = yield* makeWorkspaceRecovery(plan.workflow);
            const result = yield* workflow.restoreFromRecovery({
              personal: { ...identity.device, encryptionPublicKey: identity.device.enc },
              submitOriginalAsRecovery: plan.submitOriginalAsRecovery,
            });
            if (result.outcome !== 'Committed') return { outcome: result.outcome, offer };
            const approval = yield* acceptAccountHistory({
              ...pin,
              offer,
              pages: yield* input.pages(),
            });
            // Only the admitted session installs recovered opaque keys, through the same
            // InstalledEpochKeys commitment/protection/readback boundary as normal reception.
            yield* openPersonalSession(p, approval, keys.entries()).pipe(Effect.provide(base));
            return { outcome: 'Committed' as const, offer };
          })
        );
      })
    );
  /** The member join retained for this identity: the exact invitation and its public
   * key package, written once before any network and reused on every retry. */
  type MemberOriginal = {
    version: 1;
    kind: 'member';
    offer: E2eeMemberOffer;
    keyPackageHex: string;
  };
  const memberOriginal = (p: PreparedPersonalIdentity) =>
    Effect.gen(function* () {
      const row = yield* pairings.load(key(p, 'claim'));
      // A settled join (its terminal receipt written) is over: never pending or claimable.
      if (!row || row.receipt) return null;
      const saved = yield* parse<MemberOriginal>(row.original);
      if (saved.version !== 1 || saved.kind !== 'member') return yield* fail('conflict');
      return saved;
    });
  const memberIdentity = (source: E2eeMemberOffer, settle = false) =>
    Effect.gen(function* () {
      const offer = yield* Effect.try({
        try: () => MemberOfferSchema.parse(source),
        catch: (cause) => fail('invalid-input', cause),
      });
      if (
        offer.workspaceId !== platform.scope.workspaceId ||
        offer.genesisHash !== toHex(platform.scope.genesis.toBytes())
      )
        return yield* fail('scope-mismatch');
      const pairingOffer = yield* Effect.try({
        try: () => memberPairingOffer(platform.scope.accountId, offer),
        catch: (cause) => fail('invalid-input', cause),
      });
      // A new invitation first settles this account's earlier, never-admitted joins.
      if (settle) yield* settleOtherMembers(pairingOffer.pairingSessionId);
      // After an ended join this account's device is pinned to that membership; the new
      // invitation then gets a replacement identity, activated only once admitted.
      const p = yield* prepare(pairingOffer).pipe(
        Effect.catchIf(
          (error) => (error as { code?: string }).code === 'conflict',
          () => prepare(pairingOffer, true)
        )
      );
      return { offer, pairingOffer, p };
    });
  /** Earlier member joins of this identity that the relay confirms ended (rejected,
   * cancelled, expired or revoked) get the exact terminal receipt the installation
   * accepts as settled, so the never-admitted device can request another membership.
   * An admitted join or a still-live request keeps refusing the new invitation. */
  const settleOtherMembers = (keep: string) =>
    Effect.gen(function* () {
      const current = yield* installations.read();
      if (!current) return undefined;
      let cursor: string | null = null;
      for (let page = 0; page < 256; page++) {
        const listed: Effect.Success<ReturnType<ClientPairingOriginalStore['Service']['list']>> =
          yield* pairings.list(current.binding, cursor, 64);
        for (const entry of listed.entries) {
          if (
            entry.key.purpose !== 'claim' ||
            entry.key.pairingSessionId === keep ||
            entry.value.receipt
          )
            continue;
          const saved = yield* parse<{ kind?: string } & Partial<MemberOriginal>>(
            entry.value.original
          );
          if (saved.kind !== 'member') continue;
          if (yield* pairings.load({ ...entry.key, purpose: 'approval' }))
            return yield* fail('conflict');
          const request = yield* pairings.load({ ...entry.key, purpose: 'request' });
          if (!request) return yield* fail('corrupt');
          const { requestHex } = yield* parse<{ requestHex: string }>(request.original);
          const port = platform.members;
          if (!port?.retire) return yield* fail('unsupported');
          yield* guard;
          const reply = yield* port.retire({
            token: saved.offer!.token,
            keyPackageHex: saved.keyPackageHex!,
          });
          yield* guard;
          if (reply.state !== 'cancelled') return yield* fail('conflict');
          yield* pairings.compareAndSet(entry.key, entry.value.revision, {
            ...entry.value,
            revision: entry.value.revision + 1,
            receipt: encode({
              version: 1,
              accountId: entry.key.accountId,
              workspaceId: entry.key.workspaceId,
              genesisHash: toHex(entry.key.genesis.toBytes()),
              pairingSessionId: entry.key.pairingSessionId,
              requestHex,
              status: 'cancelled',
            }),
          });
        }
        if (listed.next === null) break;
        if (page === 255 || listed.next === cursor) return yield* fail('corrupt');
        cursor = listed.next;
      }
      return undefined;
    });
  const relay = () => {
    const port = platform.members;
    return port?.submit && port.claim
      ? Effect.succeed({ submit: port.submit.bind(port), claim: port.claim.bind(port) })
      : Effect.fail(fail('unsupported'));
  };
  /** Joining a team: sign a core JoinRequest with this workspace's prepared device and
   * submit its key package. The original is retained before the network; a retry of the
   * same invitation resubmits it and never signs another. */
  const prepareMember = (source: E2eeMemberOffer) =>
    Effect.gen(function* () {
      const ports = yield* relay();
      const { offer, pairingOffer, p } = yield* memberIdentity(source, true);
      let saved = yield* memberOriginal(p);
      if (saved && JSON.stringify(saved.offer) !== JSON.stringify(offer))
        return yield* fail('conflict');
      if (!saved) {
        const keyPackageHex = yield* withIdentity(p, (identity) =>
          Effect.gen(function* () {
            const request = yield* prepareJoinRequest({
              genesis: p.binding.genesis,
              requestId: Result.getOrThrow(Bytes.requestId(fromHex(pairingOffer.pairingSessionId))),
              userId: yield* Effect.fromResult(accountUserId(platform.scope.accountId)),
              encryptionPublicKey: identity.device.enc,
              expiresAt: offer.expiresAt,
              signer: identity.device,
            });
            // The identity already bound its credential to this request id.
            return encodeMemberKeyPackage({
              request,
              credentialHash: identity.request.credentialHash,
              bindingSignature: fromHex(identity.request.bindingSignature),
            });
          })
        );
        const original: MemberOriginal = { version: 1, kind: 'member', offer, keyPackageHex };
        yield* pairings.compareAndSet(key(p, 'claim'), null, {
          revision: 1,
          original: encode(original),
          receipt: null,
        });
        saved = yield* memberOriginal(p);
        if (!saved || saved.keyPackageHex !== keyPackageHex) return yield* fail('conflict');
      }
      yield* guard;
      const reply = yield* ports.submit({ token: offer.token, keyPackageHex: saved.keyPackageHex });
      yield* guard;
      if (
        reply.accountId !== platform.scope.accountId ||
        reply.workspaceId !== offer.workspaceId ||
        reply.keyPackageHex !== saved.keyPackageHex ||
        reply.requestId !== pairingOffer.pairingSessionId
      )
        return yield* fail('scope-mismatch');
      return { request: reply, offer: pairingOffer };
    });
  /** The join retained behind an identity offer: only an offer this account derived from
   * the retained invitation qualifies, so a personal pairing identity never reads as one. */
  const retainedMember = (pairingOffer: PersonalPairingOffer) =>
    Effect.gen(function* () {
      const p = yield* prepareRetained(pairingOffer);
      const saved = yield* memberOriginal(p);
      if (!saved) return null;
      const derived = yield* Effect.try({
        try: () => memberPairingOffer(platform.scope.accountId, saved.offer),
        catch: (cause) => fail('corrupt', cause),
      });
      if (JSON.stringify(derived) !== JSON.stringify(p.offer)) return yield* fail('conflict');
      return { p, saved };
    });
  /** The relay's `committed` is only a hint: admission is accepted from this device's
   * own verified full signed history, through the same approval original as pairing. */
  const claimMember = (pairingOffer: PersonalPairingOffer, requestId: string) =>
    Effect.gen(function* () {
      const ports = yield* relay();
      const found = yield* retainedMember(pairingOffer);
      if (!found || found.p.offer.pairingSessionId !== requestId)
        return yield* fail('approval-required');
      const { p, saved } = found;
      if (yield* pairings.load(key(p, 'approval'))) {
        yield* loadApproval(p);
        return { state: 'committed' as const };
      }
      yield* guard;
      const reply = yield* ports.claim({ workspaceId: p.binding.workspaceId, requestId });
      yield* guard;
      if (
        reply.accountId !== platform.scope.accountId ||
        reply.workspaceId !== p.binding.workspaceId ||
        reply.requestId !== requestId ||
        reply.keyPackageHex !== saved.keyPackageHex
      )
        return yield* fail('scope-mismatch');
      if (reply.state !== 'committed') return { state: reply.state };
      if (!history) return yield* fail('unsupported');
      const pages = yield* withIdentity(p, (identity) =>
        Effect.gen(function* () {
          yield* guard;
          const pages = yield* history(identity.credential);
          yield* guard;
          return pages;
        })
      );
      yield* acceptHistoryFor(p, pages);
      return { state: 'committed' as const };
    });
  return Object.freeze({
    close: () => close,
    /** Join a team from an independently transferred member invitation. Returns the
     * relay's request and the identity offer to retain for this workspace. */
    prepareMember: (offer: E2eeMemberOffer) => run(prepareMember(offer)),
    /** Accept this device's admission once its signed history shows it; the retained
     * identity offer then opens the workspace like any approved pairing. */
    claimMember: (pairingOffer: PersonalPairingOffer, requestId: string) =>
      run(claimMember(pairingOffer, requestId)),
    /** The retained invitation behind an identity offer, or null for a personal pairing. */
    memberJoin: (pairingOffer: PersonalPairingOffer) =>
      run(
        Effect.map(retainedMember(pairingOffer), (found) =>
          found ? { offer: found.saved.offer, requestId: found.p.offer.pairingSessionId } : null
        )
      ),
    /** Recover this pinned workspace from an authenticated vault; no private key escapes. */
    restoreRecovery: (input: PersonalHostRecoveryInput) => run(restoreRecovery(input)),
    /** Account pairing: create or reuse this workspace's identity for a verified
     * genesis record and membership. Protection comes from the platform's custody. */
    prepareAccount: (pin: { genesisRecordHex: string; membershipId: string }) =>
      run(prepare(accountPairingOffer(platform.scope, pin)).pipe(Effect.map(publicPrepared))),
    acceptAccount: (input: Parameters<typeof acceptAccount>[0]) =>
      run(Effect.asVoid(acceptAccount(input))),
    acceptAccountHistory: (input: Parameters<typeof acceptAccountHistory>[0]) =>
      run(Effect.asVoid(acceptAccountHistory(input))),
    prepare: (offer: PersonalPairingOffer, replacement = false) =>
      run(prepare(offer, replacement).pipe(Effect.map(publicPrepared))),
    begin: (offer: PersonalPairingOffer, replacement = false) =>
      run(Effect.flatMap(prepare(offer, replacement), (p) => exchangeOriginal(p, 'begin'))),
    claim: (offer: PersonalPairingOffer, replacement = false) =>
      run(
        Effect.gen(function* () {
          const p = yield* prepare(offer, replacement);
          const existing = yield* pairings.load(key(p, 'approval'));
          if (existing) {
            yield* loadApproval(p);
            return { status: 'approved' as const };
          }
          const result = yield* exchangeOriginal(p, 'claim');
          if (result.status === 'approved') yield* loadApproval(p);
          return result;
        })
      ),
    cancel: (offer: PersonalPairingOffer, replacement = false) =>
      run(Effect.flatMap(prepare(offer, replacement), (p) => exchangeOriginal(p, 'cancel'))),
    scope: platform.scope,
    capabilities: Object.freeze({
      rpc: !!platform.rpc,
      iroh: !!(platform.rpc && platform.iroh),
      contentToken: !!platform.contentToken,
      machineSharing: !!platform.machineSharing,
      members: !!platform.members,
      memberJoin: !!(platform.members?.submit && platform.members.claim && history),
    }),
    open: (offer: PersonalPairingOffer, replacement = false, existingOnly = false) =>
      run(
        Effect.gen(function* () {
          // A member join's replacement identity opens, and is activated, from its offer.
          const p =
              existingOnly && !replacement
                ? yield* prepareRetained(offer)
                : yield* prepare(offer, replacement, existingOnly),
            approval = yield* loadApproval(p);
          yield* activateReplacement(p, approval);
          yield* guard;
          return yield* Scope.provide(
            openPersonalSession({ ...p, replacing: null }, approval).pipe(Effect.provide(base)),
            owner
          );
        })
      ),
  });
});
