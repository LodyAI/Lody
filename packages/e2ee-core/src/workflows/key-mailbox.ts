import { Effect } from 'effect';
import {
  EpochMailboxIndexStore,
  MailboxAuthority,
  type KeyMailboxRemote,
} from '../ports/key-mailbox';
import type { KeyDeliveryRemote } from '../ports/key-delivery';
import { SignatureVerifier } from '../ports/ledger';
import { signature, type SigningPublicKey } from '../pure/bytes';
import { TransportError, ValidationError, type ClientError } from '../pure/errors';
import { keyId } from '../pure/identifiers';
import { recipientEncryptionKey, decodeEnvelopeFrame } from '../pure/epoch-envelope';
import { checkDeliveryId } from '../pure/key-delivery';
import {
  boundedPage,
  checkInstallationContext,
  checkLocalPublication,
  decodeInstallationReport,
  envelopeRouting,
  fromHex,
  mailboxDigest,
  mailboxStatus,
  newEntry,
  projectMailbox,
  replaceEntry,
  slotId,
  type MailboxDocument,
  type MailboxSlot,
} from '../pure/key-mailbox';
import type { LedgerView } from '../pure/records';

const deliveryError = (e: ClientError) => {
  if (
    e._tag === 'ValidationError' ||
    e._tag === 'TransportError' ||
    e._tag === 'StreamProtocolError'
  )
    return e;
  if (e._tag === 'StorageError')
    return new TransportError({ operation: 'deliver', code: e.reason });
  return new ValidationError({
    code: e._tag === 'AuthorizationError' ? 'unauthorized' : 'invalid-operation',
  });
};
const unauthorized = () => Effect.fail(new ValidationError({ code: 'unauthorized' }));
/** Reference admission workflow. The hosting adapter supplies the authenticated principal,
 * NEVER from request JSON. Atomic index/ciphertext writes are local to this store.
 * Authority refresh is an external ledger read, not an atomic permission-chain cutoff. */
export class KeyMailboxHost {
  private constructor(
    private readonly store: EpochMailboxIndexStore['Service'],
    private readonly authority: MailboxAuthority['Service'],
    private readonly verifier: SignatureVerifier['Service']
  ) {}
  static make = Effect.gen(function* () {
    return new KeyMailboxHost(
      yield* EpochMailboxIndexStore,
      yield* MailboxAuthority,
      yield* SignatureVerifier
    );
  });
  private transaction<A, E, R>(
    principal: SigningPublicKey | null,
    work: (
      doc: MailboxDocument,
      view: LedgerView
    ) => Effect.Effect<readonly [A, MailboxDocument], E, R>
  ) {
    return this.store.exclusive((tx) =>
      Effect.gen({ self: this }, function* () {
        const view = yield* this.authority.current;
        if (principal && !view.inspectState().devices.has(keyId(principal.toBytes())))
          return yield* unauthorized();
        const doc = yield* Effect.fromResult(projectMailbox(yield* tx.load, view));
        const [value, next] = yield* work(doc, view);
        yield* Effect.uninterruptible(tx.save(next));
        return value;
      })
    );
  }
  /** Startup/projection recovery, using verified ledger increments. */
  reconcileProjection() {
    return this.transaction(null, (doc) => Effect.succeed([undefined, doc] as const));
  }
  remote(principal: SigningPublicKey): KeyMailboxRemote['Service'] & KeyDeliveryRemote['Service'] {
    const principalId = keyId(principal.toBytes());
    const target = (doc: MailboxDocument, slot: MailboxSlot) => ({
      ...slot,
      status: mailboxStatus(doc, slot),
      revision: doc.entries.find((e) => slotId(e) === slotId(slot))?.revision ?? 0,
    });
    return {
      status: (slot) =>
        this.transaction(principal, (doc, view) =>
          slot.genesis === keyId(view.genesis.toBytes())
            ? Effect.succeed([target(doc, slot), doc] as const)
            : unauthorized()
        ),
      list: (kind, cursor, limit) =>
        this.transaction(principal, (doc) =>
          Effect.gen(function* () {
            const p = doc.projection!;
            const all = p.recipients.map((recipient) =>
              target(doc, { genesis: p.genesis, epoch: p.epoch, recipient })
            );
            const page = yield* Effect.fromResult(
              boundedPage(
                all.filter((r) =>
                  kind === 'needsEnvelope'
                    ? r.status === 'NeedsEnvelope'
                    : r.status === 'EnvelopeStored'
                ),
                cursor,
                limit
              )
            );
            return [page, doc] as const;
          })
        ),
      fetch: (epoch, cursor, limit) =>
        this.transaction(principal, (doc, view) =>
          Effect.gen(function* () {
            if (epoch !== view.inspectState().epoch.number) return yield* unauthorized();
            const row = doc.entries.find((e) => e.epoch === epoch && e.recipient === principalId);
            const envelopes = (row?.envelopes ?? [])
              .filter((e) => !row!.rejected.includes(e.digest))
              .map((e) => ({ sender: e.sender, frame: fromHex(e.frame) }));
            const page = yield* Effect.fromResult(boundedPage(envelopes, cursor, limit));
            return [page, doc] as const;
          })
        ),
      put: (id, input) => {
        const frame = new Uint8Array(input);
        return this.transaction(principal, (doc, view) =>
          Effect.gen({ self: this }, function* () {
            yield* Effect.fromResult(checkDeliveryId(id));
            const routing = yield* Effect.fromResult(envelopeRouting(frame));
            const state = view.inspectState();
            if (
              routing.sender !== principalId ||
              routing.genesis !== keyId(state.genesis) ||
              routing.epoch !== state.epoch.number
            )
              return yield* unauthorized();
            yield* Effect.fromResult(
              recipientEncryptionKey(state, principal.toBytes(), fromHex(routing.recipient))
            );
            const parts = yield* Effect.fromResult(
              decodeEnvelopeFrame(
                {
                  genesis: state.genesis,
                  epoch: routing.epoch,
                  sender: principal.toBytes(),
                  recipient: fromHex(routing.recipient),
                },
                frame
              )
            );
            yield* this.verifier.verify({
              publicKey: principal,
              message: parts.signingBytes,
              signature: yield* Effect.fromResult(signature(parts.signature)),
            });
            // Refresh immediately before commit after async verification; projection rejects rollback.
            const latest = yield* this.authority.current;
            const projected = yield* Effect.fromResult(projectMailbox(doc, latest));
            const after = latest.inspectState();
            if (after.epoch.number !== routing.epoch) return yield* unauthorized();
            yield* Effect.fromResult(
              recipientEncryptionKey(after, principal.toBytes(), fromHex(routing.recipient))
            );
            const row =
              projected.entries.find((e) => slotId(e) === slotId(routing)) ?? newEntry(routing);
            const digest = mailboxDigest(frame);
            if (row.envelopes.some((e) => e.digest === digest))
              return [undefined, projected] as const;
            // DeliveryId is sender correlation, never a unique ciphertext identity or authority.
            const next = replaceEntry(projected, {
              ...row,
              envelopes: [
                ...row.envelopes,
                { id, sender: principalId, digest, frame: keyId(frame) },
              ],
            });
            return [undefined, next] as const;
          })
        ).pipe(Effect.mapError(deliveryError));
      },
      read: (id) =>
        this.transaction(principal, (doc) =>
          Effect.succeed([
            (() => {
              const frame = doc.entries
                .flatMap((e) => e.envelopes)
                .find((e) => e.id === id && e.sender === principalId);
              return frame ? fromHex(frame.frame) : null;
            })(),
            doc,
          ] as const)
        ).pipe(Effect.mapError(deliveryError)),
      report: (input, publicationInput) => {
        const bytes = new Uint8Array(input),
          publication = publicationInput && new Uint8Array(publicationInput);
        return this.transaction(principal, (doc, view) =>
          Effect.gen({ self: this }, function* () {
            const parsed = yield* Effect.fromResult(decodeInstallationReport(bytes));
            const c = parsed.context;
            if (c.recipient !== principalId) return yield* unauthorized();
            yield* this.verifier.verify({
              publicKey: parsed.recipient,
              message: parsed.message,
              signature: parsed.signature,
            });
            const latest = yield* this.authority.current;
            yield* Effect.fromResult(checkInstallationContext(latest, c));
            const projected = yield* Effect.fromResult(projectMailbox(doc, latest));
            const row = projected.entries.find((e) => slotId(e) === slotId(c)) ?? newEntry(c);
            if (c.revision !== row.revision) return yield* unauthorized();
            if (c.source._tag === 'Envelope') {
              const source = c.source;
              if (
                !row.envelopes.some(
                  (e) => e.sender === source.sender && e.digest === source.frameDigest
                ) ||
                row.rejected.includes(source.frameDigest)
              )
                return yield* unauthorized();
            } else {
              if (!publication) return yield* unauthorized();
              yield* Effect.fromResult(checkLocalPublication(view, c, publication));
            }
            const exact = keyId(bytes);
            return [
              undefined,
              replaceEntry(projected, {
                ...row,
                reportedRevision: c.revision,
                reports: row.reports.includes(exact) ? row.reports : [...row.reports, exact],
              }),
            ] as const;
          })
        );
      },
      repair: (slot, requestId, rejectedDigest) =>
        this.transaction(principal, (doc) =>
          Effect.gen(function* () {
            if (
              slot.recipient !== principalId ||
              requestId.length === 0 ||
              requestId.length > 256 ||
              !['NeedsEnvelope', 'EnvelopeStored', 'InstallationReported'].includes(
                mailboxStatus(doc, slot)
              )
            )
              return yield* unauthorized();
            const row = doc.entries.find((e) => slotId(e) === slotId(slot)) ?? newEntry(slot);
            const existingRepair = row.repairs.find((r) => r.requestId === requestId);
            if (existingRepair) {
              if (existingRepair.rejectedDigest !== (rejectedDigest ?? null))
                return yield* Effect.fail(new ValidationError({ code: 'replay' }));
              return [undefined, doc] as const;
            }
            if (rejectedDigest && !row.envelopes.some((e) => e.digest === rejectedDigest))
              return yield* unauthorized();
            return [
              undefined,
              replaceEntry(doc, {
                ...row,
                revision: row.revision + 1,
                reportedRevision: null,
                repairs: [...row.repairs, { requestId, rejectedDigest: rejectedDigest ?? null }],
                rejected: rejectedDigest
                  ? [...new Set([...row.rejected, rejectedDigest])]
                  : row.rejected,
              }),
            ] as const;
          })
        ),
    };
  }
}
