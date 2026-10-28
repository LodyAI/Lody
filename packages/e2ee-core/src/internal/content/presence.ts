import { Deferred, Effect } from 'effect';
import {
  Bytes,
  ContentError,
  contentPermissions,
  requireLedgerContinuation,
  epochHistoryPacket,
  commitEpochKey,
  inspectContentFrame,
  verifyContentSignature,
  sealPresenceContent,
  openPresenceContent,
  type DeviceSigner,
  type LedgerView,
} from '../../protocol';
import { disposeEpochKey } from '../foundation/epoch-key';

/** Purpose-7 crypto boundary for one independently selected workspace room.
 * Current non-Guest personal/machine membership is checked before and after
 * crypto. Owns returned key copies and drains admitted work on Scope close.
 * Application body, identity binding, TTL and replay policy belong to the caller.
 */
export const makePresenceContentBinding = Effect.fnUntraced(function* (input: {
  readonly genesis: Bytes.GenesisHash;
  readonly resource: string;
  readonly signer: DeviceSigner;
  readonly ledger: () => Effect.Effect<LedgerView, unknown>;
  readonly readEpochKey: (epoch: number) => Effect.Effect<Bytes.EpochKey, unknown>;
}) {
  const genesis = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
  const signer = { publicKey: input.signer.publicKey, sign: input.signer.sign.bind(input.signer) };
  const resource = input.resource;
  const fail = () => new ContentError({ code: 'presence-unavailable' });
  let closed = false;
  let previous: LedgerView | undefined;
  const active = new Set<Deferred.Deferred<void>>();
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      for (const done of active) yield* Deferred.await(done);
    })
  );
  const lease = <A, E>(work: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        if (closed) return yield* fail();
        const done = yield* Deferred.make<void>();
        active.add(done);
        return done;
      }),
      () => work,
      (done) =>
        Effect.sync(() => {
          active.delete(done);
          Deferred.doneUnsafe(done, Effect.void);
        })
    );
  const ledger = Effect.fnUntraced(function* () {
    if (closed) return yield* fail();
    const view = yield* input
      .ledger()
      .pipe(Effect.mapError(() => new ContentError({ code: 'presence-local-unavailable' })));
    yield* Effect.fromResult(requireLedgerContinuation(previous ?? view, view));
    if (!genesis.equals(view.genesis))
      return yield* new ContentError({ code: 'presence-local-unavailable' });
    previous = view;
    return view;
  });
  const authorize = Effect.fnUntraced(function* (view: LedgerView, key: Bytes.SigningPublicKey) {
    const permission = yield* Effect.fromResult(contentPermissions(view, key));
    if (!permission.maySealNewContent) return yield* fail();
    return undefined;
  });
  const scope = (epoch: number) => ({
    genesis: Array.from(genesis.toBytes(), (b) => b.toString(16).padStart(2, '0')).join(''),
    resource,
    epoch,
  });
  const withKey = Effect.fnUntraced(function* <A, E>(
    view: LedgerView,
    epoch: number,
    use: (key: Bytes.EpochKey) => Effect.Effect<A, E>
  ) {
    // Future epochs are invalid input. A missing retained publication/key for a
    // known epoch means this receiver cannot determine liveness.
    if (epoch > view.inspectState().epoch.number)
      return yield* new ContentError({ code: 'invalid-presence-epoch' });
    const publication = yield* Effect.fromResult(epochHistoryPacket(view, epoch)).pipe(
      Effect.mapError(() => new ContentError({ code: 'presence-local-unavailable' }))
    );
    return yield* Effect.acquireUseRelease(
      input
        .readEpochKey(epoch)
        .pipe(Effect.mapError(() => new ContentError({ code: 'presence-local-unavailable' }))),
      (key) =>
        Effect.gen(function* () {
          const commitment = yield* Effect.fromResult(commitEpochKey(genesis, epoch, key));
          if (!publication.commitment.equals(commitment))
            return yield* new ContentError({ code: 'presence-local-unavailable' });
          return yield* use(key);
        }),
      (key) => Effect.sync(() => disposeEpochKey(key))
    );
  });
  return {
    seal: (plaintext: Uint8Array, epoch: number) =>
      lease(
        Effect.gen(function* () {
          const view = yield* ledger();
          yield* authorize(view, signer.publicKey);
          if (!(plaintext instanceof Uint8Array) || plaintext.byteLength > 65536)
            return yield* fail();
          const frame = yield* withKey(view, epoch, (key) =>
            sealPresenceContent({ scope: scope(epoch), epochKey: key, signer, plaintext })
          );
          yield* authorize(yield* ledger(), signer.publicKey);
          if (closed) return yield* fail();
          return frame;
        })
      ),
    open: <A, E>(
      source: Uint8Array,
      use: (opened: {
        plaintext: Uint8Array;
        signer: Bytes.SigningPublicKey;
        view: LedgerView;
      }) => Effect.Effect<A, E>
    ) =>
      lease(
        Effect.gen(function* () {
          if (!(source instanceof Uint8Array) || source.byteLength > 65536 + 143)
            return yield* fail();
          const frame = Uint8Array.from(source);
          const metadata = yield* Effect.fromResult(inspectContentFrame(frame, 'presence'));
          const key = yield* Effect.fromResult(
            Bytes.signingPublicKey(
              Uint8Array.from(metadata.device.match(/../g) ?? [], (b) => parseInt(b, 16))
            )
          );
          const view = yield* ledger();
          yield* authorize(view, key);
          yield* Effect.fromResult(
            verifyContentSignature(frame, { ...scope(metadata.epoch), purpose: 'presence' }, key)
          );
          return yield* Effect.acquireUseRelease(
            withKey(view, metadata.epoch, (epochKey) =>
              Effect.fromResult(
                openPresenceContent({
                  scope: scope(metadata.epoch),
                  epochKey,
                  expectedSigner: key,
                  frame,
                })
              )
            ),
            (plaintext) =>
              Effect.gen(function* () {
                const latest = yield* ledger();
                yield* authorize(latest, key);
                if (closed) return yield* fail();
                return yield* use({ plaintext, signer: key, view: latest });
              }),
            (plaintext) => Effect.sync(() => plaintext.fill(0))
          );
        })
      ),
  };
});
