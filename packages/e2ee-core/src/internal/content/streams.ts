import { Deferred, Effect, Result } from 'effect';
import type {
  PayloadProtectionOpenInput,
  PayloadProtectionSealInput,
  PayloadProtectionSealResult,
} from '@loro-dev/streams-crdt';
import * as Bytes from '../foundation/bytes';
import { disposeEpochKey } from '../foundation/epoch-key';
import { keyId } from '../foundation/identifiers';
import { ContentError } from '../foundation/errors';
import { epochHistoryPacket, requireLedgerContinuation, type LedgerView } from '../ledger';
import { commitEpochKey } from '../keys/history';
import type { DeviceSigner } from '../foundation/signing';
import {
  CONTENT_OVERHEAD_BYTES,
  encodeSnapshotContinuationOffset,
  MAX_CONTENT_BYTES,
  copyContentAdditionalData,
  inspectContentFrame,
  parseContentFrame,
  contentSigningBytes,
  type ContentScope,
} from '../foundation/content-format';
import { documentKeyForScope, scopedDocumentKey } from './document-key';
import { openContentAead } from '../crypto/content';
import { admitDocument, authenticateDocument, openDocument, sealDocument } from './index';
import { verifySignatureEffect, NativeSignatureError } from '../foundation/signature';
import { bytesEqual } from '../foundation/cbor';

const error = (code: string) => new ContentError({ code });
// Released catalog SDK permits at most 4KiB total provider overhead. Generic content
// v0 still supports the full u16 field; this adapter must fit its public contract.
const STREAMS_MAX_SEAL_OVERHEAD_BYTES = 4096;
const STREAMS_MAX_SNAPSHOT_OFFSET_BYTES =
  STREAMS_MAX_SEAL_OVERHEAD_BYTES - CONTENT_OVERHEAD_BYTES - 2 - 1;
/** Header3 marks updates; header4 marks snapshots. The authoritative snapshot
 * position lives in the signed content header, never the provider marker. */
export function makeStreamsUpdateBinding(input: {
  readonly genesis: Bytes.GenesisHash;
  readonly resource: string;
  readonly model: 'loro' | 'flock';
  /** A number pins writes to that epoch; current selects from each genuine ledger read. */
  readonly writeEpoch: number | 'current';
  readonly signer: DeviceSigner;
  readonly ledger: () => Effect.Effect<LedgerView, unknown>;
  /** Each successful read transfers a fresh owned opaque epoch key; never return a store's borrowed key. */
  readonly readEpochKey: (epoch: number) => Effect.Effect<Bytes.EpochKey, unknown>;
}) {
  return Effect.gen(function* () {
    const anchor = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
    const writeEpoch =
      input.writeEpoch === 'current'
        ? 'current'
        : yield* Effect.fromResult(Bytes.epochNumber(input.writeEpoch));
    const resource = input.resource;
    const model = input.model;
    if (model !== 'loro' && model !== 'flock') return yield* error('invalid-streams-model');
    const signer: DeviceSigner = Object.freeze({
      publicKey: yield* Effect.fromResult(Bytes.signingPublicKey(input.signer.publicKey.toBytes())),
      sign: input.signer.sign.bind(input.signer),
    });
    const lookup = input.ledger;
    const readKey = input.readEpochKey;
    let closed = false;
    let observed: LedgerView | undefined;
    const active = new Set<Deferred.Deferred<void>>();
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closed = true;
        for (const done of active) yield* Deferred.await(done);
      })
    );
    const guard = () => (closed ? Effect.fail(error('closed')) : Effect.void);
    const lease = <A, E, R>(work: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          yield* guard();
          const done = yield* Deferred.make<void>();
          active.add(done);
          return done;
        }),
        () => work,
        (done) =>
          Effect.gen(function* () {
            active.delete(done);
            yield* Deferred.succeed(done, undefined);
          })
      );
    const ledger = () =>
      Effect.gen(function* () {
        yield* guard();
        const view = yield* lookup().pipe(Effect.mapError(() => error('unauthorized')));
        yield* guard();
        // Authenticate provenance before inspecting any view field.
        yield* Effect.fromResult(requireLedgerContinuation(view, view));
        if (writeEpoch !== 'current')
          yield* Effect.fromResult(epochHistoryPacket(view, writeEpoch));
        if (!anchor.equals(view.genesis)) return yield* error('content-context-mismatch');
        if (observed) yield* Effect.fromResult(requireLedgerContinuation(observed, view));
        observed = view;
        return view;
      }).pipe(Effect.mapError(() => error('unauthorized')));
    const context = (
      value: PayloadProtectionSealInput['context']
    ): Result.Result<
      | { readonly kind: 'update_batch'; readonly header: Uint8Array }
      | {
          readonly kind: 'snapshot';
          readonly header: Uint8Array;
          readonly continuationOffset: string;
        },
      ContentError
    > => {
      if (value?.protocol !== 'loro-streams-crdt-payload-protection' || value.version !== 2)
        return Result.fail(error('unsupported-streams-context'));
      if (value.kind === 'update_batch' && value.continuationOffset === undefined)
        return Result.succeed({ kind: value.kind, header: new Uint8Array([3]) });
      if (
        value.kind === 'snapshot' &&
        typeof value.continuationOffset === 'string' &&
        value.continuationOffset.length <= STREAMS_MAX_SNAPSHOT_OFFSET_BYTES
      )
        return Result.map(encodeSnapshotContinuationOffset(value.continuationOffset), () => ({
          kind: 'snapshot' as const,
          header: new Uint8Array([4]),
          continuationOffset: value.continuationOffset!,
        }));
      return Result.fail(
        error(value.kind === 'snapshot' ? 'invalid-snapshot-offset' : 'unsupported-streams-context')
      );
    };
    const scope = (number: number, kind: 'update_batch' | 'snapshot'): ContentScope => ({
      genesis: keyId(anchor.toBytes()),
      resource,
      epoch: number,
      docEpoch: 0,
      purpose:
        model === 'loro'
          ? kind === 'snapshot'
            ? 'doc-snapshot'
            : 'doc-update'
          : kind === 'snapshot'
            ? 'flock-snapshot'
            : 'flock-update',
    });
    const withKey = <A, E, R>(
      view: LedgerView,
      number: number,
      kind: 'update_batch' | 'snapshot',
      use: (key: import('./document-key').DocumentKey) => Effect.Effect<A, E, R>
    ) =>
      Effect.acquireUseRelease(
        readKey(number).pipe(Effect.mapError(() => error('missing-read-key'))),
        (owned) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* guard();
              const packet = yield* Effect.fromResult(epochHistoryPacket(view, number));
              const commitment = yield* Effect.fromResult(commitEpochKey(anchor, number, owned));
              if (!packet.commitment.equals(commitment)) return yield* error('commitment-mismatch');
              const key = yield* scopedDocumentKey(scope(number, kind), owned);
              return yield* use(key);
            })
          ),
        (owned) => Effect.sync(() => disposeEpochKey(owned))
      );
    const openAuthenticated = (request: PayloadProtectionOpenInput) =>
      lease(
        Effect.gen(function* () {
          const selected = yield* Effect.fromResult(context(request.context));
          if (
            !(request.header instanceof Uint8Array) ||
            !bytesEqual(request.header, selected.header)
          )
            return yield* error('unsupported-streams-header');
          const metadata = yield* Effect.fromResult(
            inspectContentFrame(request.sealed, scope(0, selected.kind).purpose)
          );
          const frame = new Uint8Array(request.sealed);
          const binding = yield* Effect.fromResult(
            copyContentAdditionalData(request.additionalData)
          );
          const view = yield* ledger();
          // Untrusted epoch metadata cannot trigger key lookup until fixed historical authentication succeeds.
          const authenticated = yield* Effect.fromResult(
            authenticateDocument(view, scope(metadata.epoch, selected.kind), frame, binding)
          );
          return yield* withKey(view, metadata.epoch, selected.kind, (key) =>
            Effect.gen(function* () {
              const opened = yield* Effect.fromResult(
                selected.kind === 'snapshot'
                  ? Result.gen(function* () {
                      // frame and binding are owned copies already authenticated above.
                      const parsed = yield* parseContentFrame(
                        frame,
                        scope(metadata.epoch, selected.kind).purpose
                      );
                      const leaf = yield* documentKeyForScope(
                        key,
                        scope(metadata.epoch, selected.kind)
                      );
                      const plaintext = yield* openContentAead(
                        leaf,
                        authenticated.header,
                        parsed.nonce,
                        parsed.ciphertext,
                        binding
                      );
                      return { header: authenticated.header, plaintext };
                    })
                  : openDocument(view, scope(metadata.epoch, selected.kind), key, frame, binding)
              );
              return yield* Effect.acquireUseRelease(
                Effect.succeed(opened.plaintext),
                (plaintext) =>
                  Effect.gen(function* () {
                    if (
                      selected.kind === 'snapshot' &&
                      opened.header.continuationOffset !== selected.continuationOffset
                    )
                      return yield* error('invalid-snapshot-offset');
                    const latest = yield* ledger();
                    // The owned snapshot frame was authenticated before key lookup.
                    // Genuine ledger continuation preserves its historical author.
                    if (selected.kind !== 'snapshot')
                      yield* Effect.fromResult(
                        authenticateDocument(
                          latest,
                          scope(metadata.epoch, selected.kind),
                          frame,
                          binding
                        )
                      );
                    return { plaintext: new Uint8Array(plaintext), author: authenticated.author };
                  }),
                (plaintext) => Effect.sync(() => plaintext.fill(0))
              );
            })
          );
        })
      );
    return Object.freeze({
      maxSealOverheadBytes: STREAMS_MAX_SEAL_OVERHEAD_BYTES,
      seal: (request: PayloadProtectionSealInput) =>
        lease(
          Effect.gen(function* () {
            const selected = yield* Effect.fromResult(context(request.context));
            if (
              !(request.plaintext instanceof Uint8Array) ||
              request.plaintext.byteLength > MAX_CONTENT_BYTES
            )
              return yield* error('content-too-large');
            const header = selected.header;
            const binding = yield* Effect.fromResult(
              Result.try({
                try: () => request.additionalData(new Uint8Array(header)),
                catch: () => error('invalid-streams-aad'),
              }).pipe(Result.flatMap(copyContentAdditionalData))
            );
            return yield* Effect.acquireUseRelease(
              Effect.sync(() => new Uint8Array(request.plaintext)),
              (plaintext) =>
                Effect.gen(function* () {
                  const view = yield* ledger();
                  const epoch =
                    writeEpoch === 'current' ? view.inspectState().epoch.number : writeEpoch;
                  const sealed = yield* withKey(view, epoch, selected.kind, (key) =>
                    sealDocument({
                      scope: scope(epoch, selected.kind),
                      documentKey: key,
                      signer,
                      ledger,
                      plaintext,
                      additionalData: binding,
                      ...(selected.kind === 'snapshot'
                        ? { continuationOffset: selected.continuationOffset }
                        : {}),
                    })
                  );
                  yield* guard();
                  return { header, sealed } satisfies PayloadProtectionSealResult;
                }),
              (plaintext) => Effect.sync(() => plaintext.fill(0))
            );
          })
        ),
      /** Verified historical author plus owned plaintext; this grants no execution permission. */
      openAuthenticated,
      open: (request: PayloadProtectionOpenInput) =>
        openAuthenticated(request).pipe(Effect.map((opened) => opened.plaintext)),
    });
  });
}

/** Decode only released catalog streams-crdt update framing and header3. Atomic
 * preflight of a bounded batch; caller sends these returned originals unchanged.
 * Snapshot/legacy headers, plaintext, unknown kind and empty batches are refused.
 * No SDK private import, key lookup, decryption or injected signature verifier. */
function captureStreamsUpdateBatch(input: {
  readonly genesis: Bytes.GenesisHash;
  readonly resource: string;
  readonly model: 'loro' | 'flock';
  readonly view: LedgerView;
  readonly device: Bytes.SigningPublicKey;
  readonly body: Uint8Array;
}) {
  return Result.gen(function* () {
    const candidate = input.body,
      view = input.view,
      genesis = input.genesis,
      resource = input.resource,
      model = input.model,
      device = input.device;
    if (
      !(candidate instanceof Uint8Array) ||
      candidate.length > MAX_CONTENT_BYTES ||
      !candidate.length ||
      !['loro', 'flock'].includes(model)
    )
      return yield* Result.fail(error('invalid-streams-batch'));
    // Own before inspecting; one capture cannot be substituted during processing.
    const body = new Uint8Array(candidate);
    const admissions: { scope: ContentScope; frame: Uint8Array; aad: Uint8Array }[] = [];
    let at = 0,
      count = 0;
    const aadDomain = new TextEncoder().encode('loro-streams-crdt-payload-protection/v2\0');
    while (at < body.length) {
      if (body.length - at < 4 || ++count > 100)
        return yield* Result.fail(error('invalid-streams-batch'));
      const size = new DataView(body.buffer).getUint32(at, false);
      at += 4;
      if (size < 12 || size > body.length - at)
        return yield* Result.fail(error('invalid-streams-batch'));
      const item = body.subarray(at, at + size);
      at += size;
      if (
        item[0] !== 76 ||
        item[1] !== 83 ||
        item[2] !== 67 ||
        item[3] !== 69 ||
        item[4] !== 2 ||
        item[5] !== 1 ||
        item[6] !== 0 ||
        item[7] !== 1 ||
        item[8] !== 0 ||
        item[9] !== 0 ||
        item[10] !== 3
      )
        return yield* Result.fail(error('unsupported-streams-header'));
      const frame = item.subarray(11);
      const metadata = yield* inspectContentFrame(frame);
      const aad = new Uint8Array(aadDomain.length + 11);
      aad.set(aadDomain);
      aad.set(item.subarray(0, 11), aadDomain.length);
      admissions.push({
        scope: {
          genesis: keyId(genesis.toBytes()),
          resource,
          epoch: metadata.epoch,
          docEpoch: 0,
          purpose: model === 'loro' ? 'doc-update' : 'flock-update',
        },
        frame,
        aad,
      });
    }
    return { body, view, device, admissions };
  });
}
type StreamsAdmission = Parameters<typeof captureStreamsUpdateBatch>[0];
/** Host check of a released catalog streams-crdt update batch: framing, header 3, signatures and current write permission of every frame, all or nothing, before the host forwards the unchanged bytes. */
export function admitStreamsUpdateBatch(input: StreamsAdmission) {
  return Result.gen(function* () {
    const captured = yield* captureStreamsUpdateBatch(input);
    for (const row of captured.admissions)
      yield* admitDocument(captured.view, row.scope, row.frame, captured.device, row.aad);
    return captured.body;
  });
}
type SnapshotAdmission = Omit<StreamsAdmission, 'body'> & {
  readonly body: Uint8Array;
  /** Actual host-selected snapshot path position, never inferred from the frame. */
  readonly continuationOffset: string;
};
function captureStreamsSnapshot(input: SnapshotAdmission) {
  return Result.gen(function* () {
    if (!(input.body instanceof Uint8Array) || input.body.length > MAX_CONTENT_BYTES)
      return yield* Result.fail(error('invalid-streams-snapshot'));
    const body = new Uint8Array(input.body);
    if (
      body.length < 12 ||
      body[0] !== 76 ||
      body[1] !== 83 ||
      body[2] !== 67 ||
      body[3] !== 69 ||
      body[4] !== 2 ||
      body[5] !== 2 ||
      body[8] !== 0 ||
      body[9] !== 0 ||
      !['loro', 'flock'].includes(input.model)
    )
      return yield* Result.fail(error('invalid-streams-snapshot'));
    const length = new DataView(body.buffer).getUint16(6, false);
    yield* encodeSnapshotContinuationOffset(input.continuationOffset);
    const expected = new Uint8Array([4]);
    if (length !== expected.length || !bytesEqual(body.subarray(10, 10 + length), expected))
      return yield* Result.fail(error('invalid-snapshot-offset'));
    const frame = body.subarray(10 + length);
    const metadata = yield* inspectContentFrame(
      frame,
      input.model === 'loro' ? 'doc-snapshot' : 'flock-snapshot'
    );
    if (metadata.continuationOffset !== input.continuationOffset)
      return yield* Result.fail(error('invalid-snapshot-offset'));
    const domain = new TextEncoder().encode('loro-streams-crdt-payload-protection/v2\0');
    const aad = new Uint8Array(domain.length + 10 + length);
    aad.set(domain);
    aad.set(body.subarray(0, 10 + length), domain.length);
    return {
      body,
      view: input.view,
      device: input.device,
      admissions: [
        {
          scope: {
            genesis: keyId(input.genesis.toBytes()),
            resource: input.resource,
            epoch: metadata.epoch,
            docEpoch: 0,
            purpose: input.model === 'loro' ? 'doc-snapshot' : 'flock-snapshot',
          } satisfies ContentScope,
          frame,
          aad,
        },
      ],
    };
  });
}
/** Current host writer admission, not decryption or authority derived from snapshot metadata. */
export function admitStreamsSnapshot(input: SnapshotAdmission) {
  return Result.gen(function* () {
    const captured = yield* captureStreamsSnapshot(input);
    for (const row of captured.admissions)
      yield* admitDocument(captured.view, row.scope, row.frame, captured.device, row.aad);
    return captured.body;
  });
}
/** Fixed native signature work; current view selection remains the caller's responsibility. */
export const admitStreamsUpdateBatchEffect = Effect.fnUntraced(function* (input: StreamsAdmission) {
  const captured = yield* Effect.fromResult(captureStreamsUpdateBatch(input));
  return yield* admitCapturedEffect(captured);
});
/** Effect form of `admitStreamsSnapshot` that verifies signatures cooperatively. */
export const admitStreamsSnapshotEffect = Effect.fnUntraced(function* (input: SnapshotAdmission) {
  const captured = yield* Effect.fromResult(captureStreamsSnapshot(input));
  return yield* admitCapturedEffect(captured);
});
/** Historical signature/context only, for an already admitted exact original.
 * This does not grant a new snapshot write or refresh an admission lease. */
export const authenticateStreamsSnapshotEffect = Effect.fnUntraced(function* (
  input: SnapshotAdmission
) {
  const captured = yield* Effect.fromResult(captureStreamsSnapshot(input));
  return yield* admitCapturedEffect(captured, false);
});
const admitCapturedEffect = Effect.fnUntraced(function* (
  captured: Result.Result.Success<ReturnType<typeof captureStreamsUpdateBatch>>,
  writing = true
) {
  yield* Effect.fromResult(
    Result.mapError(requireLedgerContinuation(captured.view, captured.view), () =>
      error('unauthorized')
    )
  );
  for (const row of captured.admissions) {
    const parsed = yield* Effect.fromResult(parseContentFrame(row.frame, row.scope.purpose));
    const message = yield* Effect.fromResult(
      contentSigningBytes(row.scope, parsed.unsigned, row.aad)
    );
    const sig = Uint8Array.from(parsed.signatureHex.match(/../g)!, (byte) => parseInt(byte, 16));
    yield* verifySignatureEffect(captured.device.toBytes(), message, sig).pipe(
      Effect.catch((cause) =>
        cause instanceof NativeSignatureError
          ? Effect.fail(error('native-unavailable'))
          : Effect.void
      )
    );
    // Keep the same authority/context/error kernel after mathematical verification.
    if (writing)
      yield* Effect.fromResult(
        admitDocument(captured.view, row.scope, row.frame, captured.device, row.aad)
      );
    else {
      const author = yield* Effect.fromResult(
        authenticateDocument(captured.view, row.scope, row.frame, row.aad)
      );
      if (author.header.device !== keyId(captured.device.toBytes()))
        return yield* error('unauthorized');
    }
  }
  return captured.body;
});
