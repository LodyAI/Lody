import { StreamsClient } from '@loro-dev/streams-client';
import { Effect, Exit, Scope } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { type LedgerCheckpoint } from '@lody/e2ee-core';
import { hashRecordBytes } from '@lody/e2ee-core/protocol';
import { LedgerFeedError } from '@lody/e2ee-core';
import { validLedgerOffset } from '@lody/e2ee-core/protocol';
import { verifyLedgerSnapshot, snapshotTrustFromView } from '@lody/e2ee-core/protocol';
import type { SnapshotFeedOrigin } from '@lody/e2ee-core';
import type { DeviceSigner } from '@lody/e2ee-core';
import { makeLabHttpIdentity } from './http-identity';
import { makeLabLedgerActor } from './ledger-actor';
import { makeLabInvitationOrigin } from './invitation-store';
import type { WorkspaceInvitation } from '@lody/e2ee-core';

/** Already-admitted synthetic workspace, existing signed full-prefix stream only.
 * Independently supplied checkpoint authority is never inferred from HTTP metadata,
 * SDK offsets or counts. Caller retains identity. No genesis publication, key/content
 * startup, snapshot bootstrap, vault, custody or production feature is selected. */
export const openLabExistingWorkspace = Effect.fnUntraced(function* (input: {
  readonly baseUrl: string;
  readonly genesis: Bytes.GenesisHash;
  readonly signer: DeviceSigner;
  readonly path: string;
  readonly journalPath: string;
  readonly mode: 'create' | 'open';
  /** Separate trusted durable endpoint on reopen; never borrowed database metadata. */
  readonly expected?: LedgerCheckpoint;
  readonly checkpoint: () => Effect.Effect<LedgerCheckpoint, LedgerFeedError>;
  readonly budget: { readonly maxRecords: number; readonly maxBytes: number };
  /** Independently qualified exact origin; offset is only a transport locator.
   * P09 writes still verify complete history independently. */
  readonly snapshot?: SnapshotFeedOrigin;
  /** Imported QR/link pin is retained independently from the mailbox response. */
  readonly invitation?: {
    readonly pin: WorkspaceInvitation;
    readonly requestId: Bytes.RequestId;
    readonly path: string;
    readonly mode: 'create' | 'open';
  };
  readonly fetch?: typeof fetch;
}) {
  // Capture every mutable caller binding before the first native operation.
  const genesis = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
  const signer = Object.freeze({
    publicKey: yield* Effect.fromResult(Bytes.signingPublicKey(input.signer.publicKey.toBytes())),
    sign: input.signer.sign.bind(input.signer),
  });
  const { baseUrl, path, journalPath, mode, checkpoint } = input;
  const transport = input.fetch;
  const budget = Object.freeze({ ...input.budget });
  const expected = input.expected
    ? Object.freeze({
        head: yield* Effect.fromResult(Bytes.recordHash(input.expected.head.toBytes())),
        length: input.expected.length,
      })
    : undefined;
  if (mode !== 'create' && mode !== 'open')
    return yield* new LedgerFeedError({ code: 'invalid-frame' });
  if (mode === 'open' && !expected) return yield* new LedgerFeedError({ code: 'wrong-parent' });
  const snapshotOrigin = input.snapshot;
  let snapshot: SnapshotFeedOrigin | undefined;
  let snapshotPoint: LedgerCheckpoint | undefined;
  if (snapshotOrigin) {
    const candidate = snapshotOrigin.bytes,
      offset = snapshotOrigin.offset,
      suppliedTrust = snapshotOrigin.trust;
    if (
      !(candidate instanceof Uint8Array) ||
      !candidate.length ||
      candidate.length > 2 * 1024 * 1024 ||
      !validLedgerOffset(offset)
    )
      return yield* new LedgerFeedError({ code: 'invalid-frame' });
    const bytes = new Uint8Array(candidate);
    const view = yield* Effect.fromResult(
      verifyLedgerSnapshot({ snapshot: bytes, trust: suppliedTrust })
    );
    if (!view.genesis.equals(genesis)) return yield* new LedgerFeedError({ code: 'wrong-parent' });
    // Capture external qualification as a private genuine-view token before HTTP
    // awaits; caller mutation cannot switch endorsers or positions during auth.
    const trust =
      suppliedTrust.source === 'verified-view'
        ? suppliedTrust
        : yield* Effect.fromResult(
            snapshotTrustFromView(view, suppliedTrust.endorser, suppliedTrust.headSignature)
          );
    snapshot = Object.freeze({ bytes, offset, trust });
    snapshotPoint = { head: view.head, length: view.length };
  }
  const scope = yield* Scope.make();
  // Parent release, failed acquisition and explicit close share the same completion.
  // A second Scope.close alone would not wait for the first close's finalizers.
  const close = yield* Effect.cached(Scope.close(scope, Exit.void));
  yield* Effect.addFinalizer(() => close);
  return yield* Scope.provide(
    Effect.gen(function* () {
      const identity = yield* makeLabHttpIdentity({ baseUrl, genesis, fetch: transport });
      const auth = yield* identity.authenticate(signer);
      const original = yield* auth.discoverGenesis();
      if (input.invitation) {
        if (snapshot) return yield* new LedgerFeedError({ code: 'invalid-frame' });
        const invited = yield* makeLabInvitationOrigin({
          ...input.invitation,
          mailbox: auth.invitationMailbox,
        });
        if (!invited.view.genesis.equals(genesis))
          return yield* new LedgerFeedError({ code: 'wrong-parent' });
        snapshot = invited.snapshot;
        snapshotPoint = { head: invited.view.head, length: invited.view.length };
      }
      const origin = new URL(auth.url).origin;
      const sdk = new StreamsClient({
        url: `${origin}/ds/${Buffer.from(genesis.toBytes()).toString('hex')}/control`,
        fetch: auth.fetch,
        retry: { maxAttempts: 1 },
      });
      const control = yield* makeLabLedgerActor({
        genesis,
        genesisRecord: original.record,
        path,
        journalPath,
        mode,
        budget,
        expected:
          mode === 'create'
            ? (snapshotPoint ?? { head: hashRecordBytes(original.record), length: 1 })
            : expected!,
        snapshot,
        checkpoint,
        signer,
        stream: { read: sdk.read.bind(sdk), appendCas: sdk.appendCas.bind(sdk) },
      });
      // SDK0.9 CAS has no per-call signal: revoke the native fetch admission before
      // actor/remote finalizers await its raw request, then close SQLite and identity.
      // StreamsClient.close publishes EOF and is never called here.
      yield* Effect.addFinalizer(() => identity.stop());
      yield* control.refresh();
      return Object.freeze({
        control,
        identity: auth,
        genesisRecord: () => new Uint8Array(original.record),
        stop: () => identity.stop(),
        close: () => close,
      });
    }),
    scope
  ).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? close : Effect.void)));
});
