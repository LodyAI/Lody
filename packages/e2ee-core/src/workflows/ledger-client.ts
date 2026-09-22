import { Effect } from 'effect';
import { DeviceSigner, JournalStore, LedgerTransport, SignatureVerifier } from '../ports/ledger';
import { genesisHash, type GenesisHash, type EpochKey, type SigningPublicKey } from '../pure/bytes';
import * as envelopes from './epoch-envelope';
import type { PreparedEpochEnvelope } from '../pure/epoch-envelope';
import type { DeliveryId } from '../pure/bytes';
import { keyId } from '../pure/identifiers';
import { deliverFrame } from './key-delivery';
import { resumeEpochRotation, rotateEpoch } from './epoch-rotation';
import type { CreateLedgerCommand, LedgerCommand } from '../pure/commands';
import { encodeGenesisBody, encodeSignedRecord } from '../pure/ledger-schema';
import { hashRecordBytes, recordSigningBytes } from '../pure/wire-crypto';
import type { ClientError } from '../pure/errors';
import { LedgerEngine, type SnapshotBootstrap } from './ledger-engine';

export type { CommandOutcome, ResumeOutcome, SnapshotBootstrap } from './ledger-engine';
type Dependencies = JournalStore | LedgerTransport | DeviceSigner | SignatureVerifier;

/** Safe intent API. The single engine also serves the temporary Promise adapter. */
export class LedgerClient {
  private constructor(
    private readonly engine: LedgerEngine,
    private readonly signer: DeviceSigner['Type']
  ) {}

  private static bind(
    engine: Effect.Effect<
      LedgerEngine,
      ClientError,
      JournalStore | LedgerTransport | SignatureVerifier
    >
  ): Effect.Effect<LedgerClient, ClientError, Dependencies> {
    return Effect.gen(function* () {
      const signer = yield* DeviceSigner;
      return new LedgerClient(yield* engine, signer);
    });
  }

  /** Promise-adapter bridge. The engine already owns journal/transport. */
  static fromEngine(engine: LedgerEngine, signer: DeviceSigner['Type']) {
    return new LedgerClient(engine, signer);
  }

  /** Creates the local ledger journal, not a remote publication or key backup. */
  static create(
    command: CreateLedgerCommand
  ): Effect.Effect<LedgerClient, ClientError, Dependencies> {
    const { userId, membershipId, encryptionPublicKey, epochCommitment } = command;
    return Effect.gen(function* () {
      const signer = yield* DeviceSigner;
      const body = yield* encodeGenesisBody({
        signer: signer.publicKey.toBytes(),
        userId: userId.toBytes(),
        membershipId: membershipId.toBytes(),
        encryptionPublicKey: encryptionPublicKey.toBytes(),
        epochCommitment: epochCommitment.toBytes(),
      });
      const signature = yield* signer.sign(recordSigningBytes(body));
      const genesisRecord = yield* encodeSignedRecord(body, signature.toBytes());
      const anchor = yield* genesisHash(hashRecordBytes(genesisRecord));
      // The engine verifies the signature and genesis rules before saving anything.
      const engine = yield* LedgerEngine.create({ anchor, genesisRecord });
      return new LedgerClient(engine, signer);
    });
  }

  /** Explicit audit/import boundary for an independently supplied signed genesis. */
  static importGenesis(input: {
    readonly anchor: GenesisHash;
    readonly genesisRecord: Uint8Array;
  }) {
    return LedgerClient.bind(LedgerEngine.create(input));
  }

  static restore(anchor: GenesisHash) {
    return LedgerClient.bind(LedgerEngine.restore(anchor));
  }

  static createFromSnapshot(input: SnapshotBootstrap) {
    return LedgerClient.bind(LedgerEngine.createFromSnapshot(input));
  }

  execute(command: LedgerCommand) {
    return this.engine.execute(command, this.signer);
  }
  refresh() {
    return this.engine.refresh();
  }
  resume() {
    return this.engine.resume(this.signer.publicKey);
  }

  resumeEpochRotation() {
    return resumeEpochRotation(this.engine, this.signer.publicKey);
  }

  rotateEpoch() {
    return rotateEpoch(this.engine, this.signer);
  }

  prepareEpochEnvelope(recipient: SigningPublicKey, key: EpochKey) {
    return envelopes.prepareEpochEnvelope(this, this.signer, recipient, key);
  }

  sendEpochKey(recipient: SigningPublicKey, key: EpochKey) {
    return envelopes.sendEpochKey(this, this.signer, recipient, key);
  }

  /** Looks up the current secret and the recipient encryption key from the verified view. */
  sendCurrentEpochKey(recipient: SigningPublicKey) {
    return envelopes.sendCurrentEpochKey(this, this.signer, recipient);
  }

  openEpochEnvelope(sender: SigningPublicKey, frame: Uint8Array) {
    return envelopes.openEpochEnvelope(this, this.signer.publicKey, sender, frame);
  }

  /** Persists the verified secret before reporting installation. Does not export the key. */
  receiveEpochKey(sender: SigningPublicKey, frame: Uint8Array) {
    return envelopes.installEpochEnvelope(this, this.signer.publicKey, sender, frame);
  }

  /** Persists prepared bytes; success means exact remote readback, not recipient installation. */
  deliverEpochEnvelope(id: DeliveryId, envelope: PreparedEpochEnvelope) {
    return deliverFrame(keyId(id.toBytes()), envelope.toBytes(), (bytes) =>
      envelopes.authorizeEpochDelivery(this, this.signer.publicKey, envelope.recipient, bytes)
    );
  }

  /** Requires neither the epoch secret nor HPKE entropy; never regenerates a saved frame. */
  resumeEpochDelivery(id: DeliveryId, recipient: SigningPublicKey) {
    return deliverFrame(keyId(id.toBytes()), undefined, (bytes) =>
      envelopes.authorizeEpochDelivery(this, this.signer.publicKey, recipient, bytes)
    );
  }
}
