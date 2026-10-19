import { Effect, Result } from 'effect';
import * as Bytes from '../foundation/bytes';
import { LedgerError } from '../ledger/errors';
import type { LedgerView } from '../ledger';
import {
  signLedgerSnapshot,
  authenticateLedgerSnapshotEvidence,
  verifyLedgerSnapshot,
  snapshotTrustFromView,
} from '../ledger/snapshot';
import type { DeviceSigner } from '../foundation/signing';
import { validLedgerOffset } from '../ledger/feed-page';
/** Imported through an independently authenticated invitation/QR, never selected
 * by the mailbox response or by a row that accompanies the snapshot. */
export interface WorkspaceInvitation {
  readonly workspaceId: string;
  readonly genesis: Bytes.GenesisHash;
  readonly endorser: Bytes.SigningPublicKey;
}
/** A signed manager snapshot delivered with an invitation, plus the transport offset to continue reading from. */
export interface WorkspaceInvitationSnapshot {
  readonly workspaceId: string;
  readonly snapshot: Uint8Array;
  readonly head: Bytes.RecordHash;
  readonly length: number;
  readonly headSignature: Bytes.Signature;
  /** Only transport position. The signed head and every suffix parent are verified. */
  readonly offset: string;
}
/** The channel that carries an invitation snapshot from the issuing manager to the invitee, keyed by request id. */
export interface WorkspaceInvitationMailbox {
  put(
    requestId: Bytes.RequestId,
    receipt: WorkspaceInvitationSnapshot
  ): Effect.Effect<void, unknown>;
  read(requestId: Bytes.RequestId): Effect.Effect<WorkspaceInvitationSnapshot | null, unknown>;
}
const failure = () => new LedgerError({ code: 'unauthorized' });
/** Explicitly approved invitation trust model: the pinned personal device
 * endorses complete state. Its claimed active Owner/Admin role is structurally
 * checked, but this does not prove remote freshness or an honest endorser. */
export function verifyWorkspaceInvitationSnapshot(
  pin: WorkspaceInvitation,
  source: WorkspaceInvitationSnapshot
) {
  return Result.gen(function* () {
    const workspaceId = pin.workspaceId,
      receivedId = source.workspaceId;
    if (
      !workspaceId ||
      workspaceId.length > 256 ||
      receivedId !== workspaceId ||
      !validLedgerOffset(source.offset)
    )
      return yield* Result.fail(failure());
    const genesis = yield* Bytes.genesisHash(pin.genesis.toBytes()),
      endorser = yield* Bytes.signingPublicKey(pin.endorser.toBytes());
    const raw = source.snapshot;
    if (!(raw instanceof Uint8Array) || raw.length < 1 || raw.length > 2 * 1024 * 1024)
      return yield* Result.fail(failure());
    const bytes = new Uint8Array(raw);
    const identity = {
      genesis,
      endorser,
      head: yield* Bytes.recordHash(source.head.toBytes()),
      length: source.length,
      headSignature: yield* Bytes.signature(source.headSignature.toBytes()),
    };
    const evidence = yield* authenticateLedgerSnapshotEvidence(bytes, identity);
    const view = yield* verifyLedgerSnapshot({
      snapshot: bytes,
      trust: {
        ...identity,
        source: 'external-confirmation',
        membershipId: evidence.claims.membershipId,
        role: evidence.claims.role,
        kind: 'personal',
        stateDigest: evidence.stateDigest,
      },
    });
    return Object.freeze({
      view,
      snapshot: Object.freeze({
        bytes,
        trust: yield* snapshotTrustFromView(view, endorser, identity.headSignature),
        offset: source.offset,
      }),
      pin: Object.freeze({ workspaceId, genesis, endorser }),
    });
  });
}
/** Issue a workspace invitation: this manager device signs a snapshot of the current verified state, stores it in the invitation mailbox under the request id and reads it back. The invitee verifies it with `verifyWorkspaceInvitationSnapshot`. */
export const issueWorkspaceInvitation = Effect.fn('E2eeWorkspace.issueInvitation')(
  function* (input: {
    readonly workspaceId: string;
    readonly signer: DeviceSigner;
    readonly ledger: () => Effect.Effect<LedgerView, unknown>;
    readonly offset: () => Effect.Effect<string, unknown>;
    readonly requestId: Bytes.RequestId;
    readonly mailbox: WorkspaceInvitationMailbox;
  }) {
    const workspaceId = input.workspaceId,
      signer = input.signer,
      ledger = input.ledger,
      offset = input.offset,
      requestId = yield* Effect.fromResult(Bytes.requestId(input.requestId.toBytes()));
    const mailbox = Object.freeze({
      put: input.mailbox.put.bind(input.mailbox),
      read: input.mailbox.read.bind(input.mailbox),
    });
    const signed = yield* signLedgerSnapshot({ signer, ledger });
    const pin = Object.freeze({ workspaceId, genesis: signed.genesis, endorser: signed.endorser });
    const receipt = Object.freeze({
      workspaceId,
      snapshot: new Uint8Array(signed.snapshot),
      head: signed.head,
      length: signed.length,
      headSignature: signed.headSignature,
      offset: yield* offset(),
    });
    yield* Effect.fromResult(verifyWorkspaceInvitationSnapshot(pin, receipt));
    const current = yield* ledger();
    if (!current.head.equals(signed.head) || current.length !== signed.length)
      return yield* failure();
    yield* mailbox.put(requestId, receipt);
    const saved = yield* mailbox.read(requestId);
    if (!saved) return yield* failure();
    const actual = yield* Effect.fromResult(verifyWorkspaceInvitationSnapshot(pin, saved));
    if (
      !actual.view.head.equals(signed.head) ||
      actual.view.length !== signed.length ||
      saved.offset !== receipt.offset ||
      saved.snapshot.length !== receipt.snapshot.length ||
      saved.snapshot.some((byte, index) => byte !== receipt.snapshot[index])
    )
      return yield* failure();
    return Object.freeze({ pin, receipt });
  }
);
