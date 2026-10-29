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
import { VerifiedLedger } from '@lody/e2ee-core';
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

const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
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
        const checked = yield* Effect.fromResult(verifyPersonalApproval(p.offer, invitation));
        approval = {
          kind: 'snapshot',
          offer: p.offer,
          invitation,
          view: checked.view,
          originalOrigin: {
            invitation,
            endorser: Result.getOrThrow(Bytes.signingPublicKey(fromHex(p.offer.endorser))),
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
        return yield* verifyApproval(p, saved, pages);
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
  return Object.freeze({
    close: () => close,
    prepare: (offer: PersonalPairingOffer, replacement = false) =>
      run(prepare(offer, replacement).pipe(Effect.map(publicPrepared))),
    begin: (offer: PersonalPairingOffer, replacement = false) =>
      run(Effect.flatMap(prepare(offer, replacement), (p) => exchangeOriginal(p, 'begin'))),
    claim: (offer: PersonalPairingOffer, replacement = false) =>
      run(
        Effect.gen(function* () {
          const p = yield* prepare(offer, replacement);
          const existing = yield* pairings.load(key(p, 'approval'));
          return existing
            ? (yield* loadApproval(p), { status: 'approved' as const })
            : yield* exchangeOriginal(p, 'claim');
        })
      ),
    cancel: (offer: PersonalPairingOffer, replacement = false) =>
      run(Effect.flatMap(prepare(offer, replacement), (p) => exchangeOriginal(p, 'cancel'))),
    scope: platform.scope,
    capabilities: Object.freeze({
      rpc: !!platform.rpc,
      contentToken: !!platform.contentToken,
      machineSharing: !!platform.machineSharing,
    }),
    open: (offer: PersonalPairingOffer, replacement = false, existingOnly = false) =>
      run(
        Effect.gen(function* () {
          const p = yield* prepare(offer, replacement, existingOnly),
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
