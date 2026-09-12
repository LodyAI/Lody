import type { ControlLogClient } from './client';
import type { ContentCipher } from './content';
import { commitEpochKey, type VerifiedEpochKeys } from './epoch-keys';
import type { TeamState } from './team';
import { decodeTeamAction } from './team-codec';
import { checkHex, decodeRecord, fromHex, invariant, toHex } from './wire';

export interface HistoryPublication {
  readonly publication: string;
  readonly frameHex: string;
}
export interface HistoryPublicationStore {
  /** Exclusive across processes; save must be durable before resolving. */
  exclusive<T>(
    work: (tx: {
      load(operationId: string): Promise<HistoryPublication | null>;
      save(entry: HistoryPublication): Promise<void>;
    }) => Promise<T>
  ): Promise<T>;
}
export interface HistoryPublicationRemote {
  /** Bound by the caller to this Org. Retry the same ID and exact bytes idempotently. */
  put(operationId: string, frame: Uint8Array): Promise<void>;
  /** Read actual stored bytes, not a write acknowledgement. null means not observed. */
  read(operationId: string): Promise<Uint8Array | null>;
}

/** Public ciphertext outbox only, not key delivery or transport activation.
 * The cipher's mandatory policy owns historical sender authorization. */
export class HistoryPublisher {
  constructor(
    private readonly log: ControlLogClient<TeamState>,
    private readonly keys: VerifiedEpochKeys,
    private readonly cipher: ContentCipher,
    private readonly store: HistoryPublicationStore,
    private readonly remote: HistoryPublicationRemote
  ) {}

  /** Supply already sealed bytes once; omit on restart to retry the durable frame. */
  async publish(operationId: string, frame?: Uint8Array): Promise<'observed' | 'unknown'> {
    checkHex(operationId, 16);
    if (frame !== undefined) {
      invariant(frame instanceof Uint8Array && frame.length <= 4234, 'invalid-epoch-history');
    }
    const supplied = frame === undefined ? undefined : toHex(frame);
    return this.store.exclusive(async (tx) => {
      const saved = await tx.load(operationId);
      const evidence = await this.log.readOperation(operationId);
      invariant(evidence.wire !== null, 'epoch-publication-not-observed');
      const event = decodeRecord(evidence.wire).event;
      const action = decodeTeamAction(event);
      invariant(action.type === 'epoch.publish' && action.epoch > 0, 'not-history-publication');
      invariant(
        saved === null || saved.publication === evidence.wire,
        'history-publication-mismatch'
      );
      invariant(
        supplied === undefined || saved === null || saved.frameHex === supplied,
        'history-frame-conflict'
      );
      const frameHex = saved?.frameHex ?? supplied;
      invariant(frameHex !== undefined, 'missing-history-frame');
      checkHex(frameHex);
      invariant(frameHex.length <= 4234 * 2, 'invalid-epoch-history');
      const bytes = fromHex(frameHex);
      const key = this.keys.read(action.epoch);
      let previous: Uint8Array | undefined;
      try {
        invariant(
          (await commitEpochKey(event.genesis, key)) === action.commitment &&
            evidence.snapshot.state.epochs.get(action.epoch) === action.commitment,
          'epoch-key-mismatch'
        );
        previous = (
          await this.cipher.open(
            {
              genesis: event.genesis,
              epoch: action.epoch,
              resource: 'previous-epoch-key',
              purpose: 'epoch-history',
            },
            key,
            bytes
          )
        ).plaintext;
        invariant(
          (await commitEpochKey(event.genesis, previous)) ===
            evidence.snapshot.state.epochs.get(action.epoch - 1),
          'epoch-key-mismatch'
        );
        // Recheck current local eligibility after asynchronous verification.
        this.keys.read(action.epoch).fill(0);
      } finally {
        key.fill(0);
        previous?.fill(0);
      }
      if (saved === null) await tx.save({ publication: evidence.wire, frameHex });
      this.keys.read(action.epoch).fill(0);
      // Upload failure may mean the response was lost after persistence remotely.
      try {
        await this.remote.put(operationId, new Uint8Array(bytes));
      } catch {
        /* reconcile below */
      }
      let observed: Uint8Array | null;
      try {
        observed = await this.remote.read(operationId);
      } catch {
        return 'unknown';
      }
      if (observed === null) return 'unknown';
      invariant(
        observed instanceof Uint8Array &&
          observed.length === bytes.length &&
          toHex(observed) === frameHex,
        'history-remote-mismatch'
      );
      return 'observed';
    });
  }
}
