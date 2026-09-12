import type { TrustAnchor } from './chain';
import {
  ControlLogClient,
  type ControlStore,
  type ControlStream,
  type SubmitResult,
} from './client';
import { ContentCipher, type ContentAuthor } from './content';
import { commitEpochKey, sealEpochHistory, type VerifiedEpochKeys } from './epoch-keys';
import { decodeTeamAction, encodeTeamAction } from './team-codec';
import { ownerManagedTeamPolicy, type TeamState } from './team';
import { checkHex, decodeRecord, invariant, WebCryptoControl } from './wire';

/** Atomic protected candidate/outbox store, never an ordinary control-only journal. */
export interface EpochPublicationStore extends ControlStore {
  withCandidate(
    wire: string,
    secret: Uint8Array,
    history?: Uint8Array | null
  ): Promise<ControlStore>;
  findCandidate(operationId: string): Promise<string | null>;
}
export interface EpochPublicationIntent {
  /** A caller-retained random 16-byte ID. Reuse this exact intent on retry. */
  readonly operationId: string;
  readonly previous: string;
}
export interface EpochPublicationAuthor extends ContentAuthor {
  readonly signingKey: CryptoKey;
}
export interface EpochPublicationResult extends SubmitResult<TeamState> {
  readonly wire: string;
  readonly epoch: number;
}

/** Owner/Admin publication only: never distributes keys, activates a transport, or
 * interprets a historical committed result as current permission to release secrets. */
export class EpochPublisher {
  private readonly anchor: TrustAnchor<TeamState>;
  constructor(
    anchor: TrustAnchor<TeamState>,
    private readonly store: EpochPublicationStore,
    private readonly stream: ControlStream,
    private readonly previousKeys?: VerifiedEpochKeys
  ) {
    this.anchor = structuredClone(anchor);
  }
  private client(store: ControlStore = this.store) {
    return new ControlLogClient(this.anchor, ownerManagedTeamPolicy, store, this.stream);
  }
  private async submit(
    wire: string,
    store: ControlStore = this.store
  ): Promise<EpochPublicationResult> {
    const action = decodeTeamAction(decodeRecord(wire).event);
    invariant(action.type === 'epoch.publish', 'not-epoch-publication');
    const result = await this.client(store).submit(wire);
    return { ...result, wire, epoch: action.epoch };
  }
  async publish(
    intent: EpochPublicationIntent,
    author: EpochPublicationAuthor
  ): Promise<EpochPublicationResult> {
    // Capture UI-owned inputs before any asynchronous storage/crypto operations.
    const { operationId, previous } = intent;
    const identity = { ...author };
    checkHex(operationId, 16);
    checkHex(previous, 32);
    const existing = await this.store.findCandidate(operationId);
    if (existing !== null) {
      const { event } = decodeRecord(existing);
      invariant(
        event.genesis === this.anchor.genesis &&
          event.previous === previous &&
          event.operationId === operationId &&
          event.actor === identity.actor &&
          event.memberInstance === identity.memberInstance &&
          event.device === identity.device,
        'publication-intent-mismatch'
      );
      return this.submit(existing);
    }
    const pending = await this.store.exclusive(async (tx) => (await tx.load())?.pending ?? null);
    invariant(pending === null, 'pending-attempt-exists');
    const snapshot = await this.client().read();
    invariant(snapshot.head === previous, 'stale-publication-head');
    const state = snapshot.state;
    const member = state.members.get(identity.actor);
    invariant(
      member?.instance === identity.memberInstance &&
        (member.role === 'admin' ||
          (member.role === 'owner' &&
            state.owner.userId === identity.actor &&
            state.owner.instance === identity.memberInstance)),
      'rotator-required'
    );
    invariant(member.devices.get(identity.device)?.kind === 'personal', 'inactive-personal-device');
    invariant(
      member.devices.get(identity.device)?.canManage === true,
      'device-management-required'
    );
    const secret = new Uint8Array(32);
    let previousKey: Uint8Array | undefined;
    try {
      const epoch = state.epochs.size;
      if (epoch > 0) {
        invariant(this.previousKeys !== undefined, 'previous-epoch-key-required');
        previousKey = this.previousKeys.read(epoch - 1);
        invariant(
          (await commitEpochKey(this.anchor.genesis, previousKey)) === state.epochs.get(epoch - 1),
          'epoch-key-mismatch'
        );
      }
      crypto.getRandomValues(secret);
      const commitment = await commitEpochKey(this.anchor.genesis, secret);
      const wire = await new WebCryptoControl().sign(
        {
          genesis: this.anchor.genesis,
          previous,
          operationId,
          actor: identity.actor,
          memberInstance: identity.memberInstance,
          device: identity.device,
          ...encodeTeamAction({
            type: 'epoch.publish',
            configVersion: state.owner.configVersion,
            epoch,
            commitment,
          }),
        },
        [{ id: 'actor-device', key: identity.signingKey }]
      );
      const history =
        previousKey === undefined
          ? null
          : await sealEpochHistory(
              new ContentCipher({
                authorize: (header) => {
                  invariant(
                    header.actor === identity.actor &&
                      header.memberInstance === identity.memberInstance &&
                      header.device === identity.device,
                    'history-author-mismatch'
                  );
                  return member.devices.get(identity.device)!.signingKey;
                },
              }),
              {
                genesis: this.anchor.genesis,
                epoch,
                epochKey: secret,
                previousKey,
                author: identity,
                signingKey: identity.signingKey,
              }
            );
      if (epoch > 0) this.previousKeys!.read(epoch - 1).fill(0);
      const prepared = await this.store.withCandidate(wire, secret, history);
      secret.fill(0);
      // This driver refreshes and verifies again after key generation/signing.
      // Any newer head conflicts; never rebuild a publication around it.
      return await this.submit(wire, prepared);
    } finally {
      secret.fill(0);
      previousKey?.fill(0);
    }
  }

  /** Resume without generating a secret or accessing signing keys. */
  async resume(): Promise<EpochPublicationResult> {
    const wire = await this.store.exclusive(async (tx) => (await tx.load())?.pending ?? null);
    invariant(wire !== null, 'no-pending-attempt');
    // Pin the observed bytes: another caller cannot make us resume a different operation.
    return this.submit(wire);
  }
}
