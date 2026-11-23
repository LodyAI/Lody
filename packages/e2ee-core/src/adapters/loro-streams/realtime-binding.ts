import { Deferred, Effect } from 'effect';
import * as Bytes from '../../internal/foundation/bytes';
import { ContentError } from '../../internal/foundation/errors';
import { disposeEpochKey } from '../../internal/foundation/epoch-key';
import { inspectContentFrame } from '../../internal/foundation/content-format';
import { parseContentFrame } from '../../internal/foundation/content-format';
import { verifyParsedContentSignature } from '../../internal/foundation/signature';
import type { DeviceSigner } from '../../internal/foundation/signing';
import { requireLedgerContinuation, type LedgerView } from '../../internal/ledger';
import {
  openRpcRequestContent,
  openRpcResponseContent,
  sealRpcRequestContent,
  sealRpcResponseContent,
} from '../../internal/content/realtime';

/** Scoped opaque RPC crypto for trusted hosts. The caller supplies an independently
 * bound resource and enforces machine ownership, body limits, expiry, freshness,
 * correlation and method authorization. This binding admits current non-recovery readers;
 * only execution methods require write authority and an execution journal. Never expose this as arbitrary-sign IPC.
 * Each key read transfers ownership; all keys and temporary plaintext are released.
 * The containing Scope drains admitted crypto before custody may close. */
export const makeRealtimeContentBinding = Effect.fnUntraced(function* (input: {
  readonly genesis: Bytes.GenesisHash;
  readonly resource: string;
  readonly signer: DeviceSigner;
  readonly ledger: () => Effect.Effect<LedgerView, unknown>;
  readonly readEpochKey: (epoch: number) => Effect.Effect<Bytes.EpochKey, unknown>;
}) {
  const active = new Set<Deferred.Deferred<void>>();
  let closed = false;
  const fail = () => new ContentError({ code: closed ? 'closed' : 'unauthorized' });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      for (const done of active) yield* Deferred.await(done);
    })
  );
  const lease = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        if (closed) yield* fail();
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
  const current = Effect.fnUntraced(function* () {
    if (closed) yield* fail();
    const view = yield* input.ledger();
    yield* Effect.fromResult(requireLedgerContinuation(view, view));
    if (closed || !view.genesis.equals(input.genesis)) yield* fail();
    return view;
  });
  const permitted = (view: LedgerView, signer: Bytes.SigningPublicKey) =>
    Effect.gen(function* () {
      const state = view.inspectState();
      const device = state.devices.get(hex(signer.toBytes()));
      if (
        !device ||
        device.kind === 'recovery' ||
        !state.members.has(hex(device.membershipId.toBytes()))
      )
        yield* fail();
    });

  const withKey = <A, E, R>(epoch: number, work: (key: Bytes.EpochKey) => Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(input.readEpochKey(epoch), work, (key) =>
      Effect.sync(() => disposeEpochKey(key))
    );
  const seal = (plaintext: Uint8Array, purpose: 'request' | 'response', epoch?: number) =>
    lease(
      Effect.acquireUseRelease(
        Effect.sync(() => Uint8Array.from(plaintext)),
        (owned) =>
          Effect.gen(function* () {
            const view = yield* current();
            yield* permitted(view, input.signer.publicKey);
            const selected = epoch ?? view.inspectState().epoch.number;
            if (selected !== view.inspectState().epoch.number) yield* fail();
            const frame = yield* withKey(selected, (epochKey) =>
              (purpose === 'request' ? sealRpcRequestContent : sealRpcResponseContent)({
                scope: {
                  genesis: hex(input.genesis.toBytes()),
                  resource: input.resource,
                  epoch: selected,
                },
                epochKey,
                signer: input.signer,
                plaintext: owned,
              })
            );
            const latest = yield* current();
            yield* Effect.fromResult(requireLedgerContinuation(view, latest));
            yield* permitted(latest, input.signer.publicKey);
            if (latest.inspectState().epoch.number !== selected) yield* fail();
            return frame;
          }),
        (owned) => Effect.sync(() => owned.fill(0))
      )
    );
  const open = (
    frame: Uint8Array,
    purpose: 'request' | 'response',
    expected?: string,
    epoch?: number
  ) =>
    lease(
      Effect.gen(function* () {
        const view = yield* current();
        const contentPurpose = purpose === 'request' ? 'rpc-request' : 'rpc-response';
        const metadata = yield* Effect.fromResult(inspectContentFrame(frame, contentPurpose));
        const selected = epoch ?? view.inspectState().epoch.number;
        if (metadata.epoch !== selected || (expected !== undefined && metadata.device !== expected))
          yield* fail();
        const signer = yield* Effect.fromResult(
          Bytes.signingPublicKey(
            Uint8Array.from(metadata.device.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
          )
        );
        yield* permitted(view, signer);
        const scope = {
          genesis: hex(input.genesis.toBytes()),
          resource: input.resource,
          epoch: selected,
        };
        const parsed = yield* Effect.fromResult(parseContentFrame(frame, contentPurpose));
        yield* Effect.fromResult(
          verifyParsedContentSignature(parsed, { ...scope, purpose: contentPurpose }, signer)
        );
        const plaintext = yield* withKey(selected, (epochKey) =>
          Effect.fromResult(
            (purpose === 'request' ? openRpcRequestContent : openRpcResponseContent)({
              scope,
              epochKey,
              expectedSigner: signer,
              frame,
            })
          )
        );
        yield* Effect.gen(function* () {
          const latest = yield* current();
          yield* Effect.fromResult(requireLedgerContinuation(view, latest));
          yield* permitted(latest, signer);
          if (purpose === 'request' && latest.inspectState().epoch.number !== selected)
            yield* fail();
        }).pipe(Effect.onError(() => Effect.sync(() => plaintext.fill(0))));
        return { plaintext, signer: metadata.device, epoch: selected };
      })
    );
  return {
    /** Seal current-epoch purpose 8; retain the returned original before send. */
    sealRequest: (plaintext: Uint8Array) => seal(plaintext, 'request'),
    /** Seal purpose 9 at the original request epoch; incompatible rotation refuses. */
    sealResponse: (plaintext: Uint8Array, epoch: number) => seal(plaintext, 'response', epoch),
    /** Authenticate current purpose 8; returned plaintext is caller-owned and must be wiped. */
    openRequest: (frame: Uint8Array) => open(frame, 'request'),
    /** Authenticate purpose 9 against the original target signer/epoch, still currently valid. */
    openResponse: (frame: Uint8Array, signer: string, epoch: number) =>
      open(frame, 'response', signer, epoch),
  };
});

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
