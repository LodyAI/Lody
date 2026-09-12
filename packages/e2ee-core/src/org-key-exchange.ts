import type { ChainSnapshot, TrustAnchor } from './chain';
import { ControlLogClient, type ControlStore, type ControlStream } from './client';
import { commitEpochKey } from './epoch-keys';
import {
  KeyEnvelopeCipher,
  inspectKeyEnvelope,
  MAX_KEY_ENVELOPE_BYTES,
  type KeyEnvelopeAuthority,
  type KeyEnvelopeContext,
  type KeyRecipient,
} from './key-envelope';
import { ownerManagedTeamPolicy, type TeamState } from './team';
import { invariant } from './wire';
import type { ContentAuthor } from './content';

export interface OrgKeyPreparation {
  readonly epoch: number;
  readonly sender: ContentAuthor;
  readonly recipient: KeyRecipient;
  readonly secret: Uint8Array;
  readonly signingKey: CryptoKey;
}

function recipientKey(state: TeamState, recipient: KeyRecipient): string {
  const member = state.members.get(recipient.actor);
  invariant(member?.instance === recipient.memberInstance, 'inactive-key-recipient');
  if (recipient.kind === 'recovery') {
    invariant(recipient.id === recipient.actor, 'wrong-recovery-recipient');
    return member.recoveryEncryptionKey;
  }
  invariant(recipient.kind === 'device', 'invalid-key-recipient');
  const device = member.devices.get(recipient.id);
  invariant(device !== undefined, 'inactive-key-recipient');
  return device.encryptionKey;
}

function authority(state: TeamState, context: KeyEnvelopeContext): KeyEnvelopeAuthority {
  const member = state.members.get(context.sender.actor);
  invariant(member?.instance === context.sender.memberInstance, 'inactive-key-sender');
  const device = member.devices.get(context.sender.device);
  invariant(device?.kind === 'personal' && device.canManage, 'key-sender-management-required');
  const ownRecipient =
    context.sender.actor === context.recipient.actor &&
    context.sender.memberInstance === context.recipient.memberInstance;
  invariant(
    ownRecipient ||
      member.role === 'admin' ||
      (member.role === 'owner' &&
        state.owner.userId === context.sender.actor &&
        state.owner.instance === context.sender.memberInstance),
    'key-sender-role-required'
  );
  return {
    senderSigningKey: device.signingKey,
    recipientEncryptionKey: recipientKey(state, context.recipient),
  };
}

function commitment(state: TeamState, epoch: number): string {
  invariant(Number.isSafeInteger(epoch) && epoch >= 0, 'invalid-key-epoch');
  const value = state.epochs.get(epoch);
  invariant(value !== undefined, 'unpublished-epoch');
  return value;
}

/** Concrete Org authorization around the existing envelope cipher. Preparation is NOT
 * transmission; open returns a verified temporary key, NOT durable installation/activation.
 * The application must enforce its trusted freshness/session lease, with no implicit TTL. */
export class OrgKeyExchange {
  private readonly client: ControlLogClient<TeamState>;
  private readonly genesis: string;
  private generation = 0;
  constructor(
    anchor: TrustAnchor<TeamState>,
    store: ControlStore,
    stream: ControlStream,
    private readonly assertFresh: (snapshot: ChainSnapshot<TeamState>) => void
  ) {
    this.genesis = anchor.genesis;
    this.client = new ControlLogClient(anchor, ownerManagedTeamPolicy, store, stream);
  }

  /** Call on logout/known revocation; cancels in-flight work, never extends a freshness lease. */
  invalidate(): void {
    this.generation++;
  }

  private check(snapshot: ChainSnapshot<TeamState>, generation: number): void {
    invariant(generation === this.generation, 'key-exchange-invalidated');
    // The hook may inspect but cannot mutate the verified state used for authority decisions.
    this.assertFresh(structuredClone(snapshot));
    invariant(generation === this.generation, 'key-exchange-invalidated');
  }

  async prepare(
    input: OrgKeyPreparation
  ): Promise<{ context: KeyEnvelopeContext; frame: Uint8Array }> {
    invariant(
      input.secret instanceof Uint8Array && input.secret.length === 32,
      'invalid-epoch-key'
    );
    const secret = new Uint8Array(input.secret);
    const sender = { ...input.sender };
    const recipient = { ...input.recipient };
    const { epoch, signingKey } = input;
    const generation = this.generation;
    try {
      let snapshot = await this.client.read();
      this.check(snapshot, generation);
      const context: KeyEnvelopeContext = {
        genesis: this.genesis,
        epoch,
        controlHead: snapshot.head,
        sender,
        recipient,
      };
      const expected = commitment(snapshot.state, epoch);
      invariant(epoch === snapshot.state.epochs.size - 1, 'not-current-epoch');
      const trusted = authority(snapshot.state, context);
      invariant((await commitEpochKey(this.genesis, secret)) === expected, 'epoch-key-mismatch');
      const cipher = new KeyEnvelopeCipher({
        authorize: () => {
          this.check(snapshot, generation);
          return authority(snapshot.state, context);
        },
      });
      const frame = await cipher.seal(context, secret, signingKey);
      snapshot = await this.client.read();
      this.check(snapshot, generation);
      invariant(
        epoch === snapshot.state.epochs.size - 1 && commitment(snapshot.state, epoch) === expected,
        'key-epoch-changed'
      );
      const current = authority(snapshot.state, context);
      invariant(
        current.senderSigningKey === trusted.senderSigningKey &&
          current.recipientEncryptionKey === trusted.recipientEncryptionKey,
        'key-authority-changed'
      );
      return { context, frame };
    } finally {
      secret.fill(0);
    }
  }

  async open(
    expected: KeyEnvelopeContext,
    frame: Uint8Array,
    recipientKeys: CryptoKeyPair
  ): Promise<Uint8Array> {
    const context = structuredClone(expected);
    invariant(context.genesis === this.genesis, 'wrong-key-org');
    invariant(
      frame instanceof Uint8Array && frame.length <= MAX_KEY_ENVELOPE_BYTES,
      'invalid-key-envelope'
    );
    const bytes = new Uint8Array(frame);
    const keys = { publicKey: recipientKeys.publicKey, privateKey: recipientKeys.privateKey };
    const generation = this.generation;
    const evidence = await this.client.readAtHead(context.controlHead);
    let snapshot = evidence.snapshot;
    this.check(snapshot, generation);
    invariant(evidence.atHead !== null, 'unknown-key-control-head');
    const historic = evidence.atHead;
    const trusted = authority(historic.state, context);
    const committed = commitment(historic.state, context.epoch);
    const checkRecipient = () => {
      this.check(snapshot, generation);
      invariant(
        recipientKey(snapshot.state, context.recipient) === trusted.recipientEncryptionKey,
        'key-recipient-changed'
      );
      invariant(commitment(snapshot.state, context.epoch) === committed, 'epoch-authority-changed');
    };
    checkRecipient();
    let secret: Uint8Array | undefined;
    try {
      secret = await new KeyEnvelopeCipher({
        authorize: () => {
          checkRecipient();
          return trusted;
        },
      }).open(context, keys, bytes);
      invariant((await commitEpochKey(this.genesis, secret)) === committed, 'epoch-key-mismatch');
      snapshot = await this.client.read();
      checkRecipient();
      return new Uint8Array(secret);
    } finally {
      secret?.fill(0);
    }
  }

  /** Reauthorize exact saved ciphertext before dispatch. Call the returned synchronous
   * guard immediately before the network call, with no intervening await. It is not a token. */
  async authorizeDispatch(frame: Uint8Array): Promise<() => void> {
    const context = inspectKeyEnvelope(frame);
    invariant(context.genesis === this.genesis, 'wrong-key-org');
    const bytes = new Uint8Array(frame);
    const generation = this.generation;
    const evidence = await this.client.readAtHead(context.controlHead);
    let snapshot = evidence.snapshot;
    this.check(snapshot, generation);
    invariant(evidence.atHead !== null, 'unknown-key-control-head');
    const trusted = authority(evidence.atHead.state, context);
    const committed = commitment(evidence.atHead.state, context.epoch);
    const check = () => {
      this.check(snapshot, generation);
      invariant(
        context.epoch === snapshot.state.epochs.size - 1 &&
          commitment(snapshot.state, context.epoch) === committed,
        'key-epoch-changed'
      );
      const current = authority(snapshot.state, context);
      invariant(
        current.senderSigningKey === trusted.senderSigningKey &&
          current.recipientEncryptionKey === trusted.recipientEncryptionKey,
        'key-authority-changed'
      );
    };
    check();
    await new KeyEnvelopeCipher({
      authorize: () => {
        check();
        return trusted;
      },
    }).verifyForSend(context, bytes);
    snapshot = await this.client.read();
    check();
    return check;
  }
}
