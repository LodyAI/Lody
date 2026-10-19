import { Effect } from 'effect';
import { InstalledEpochHistory } from '../../internal/keys/installed-keys';
import { VerifiedLedger } from '../../internal/ledger/verified-ledger';
import { makeStreamsUpdateBinding } from '../../internal/content/streams';
import { DeviceIdentity, WorkspaceScope } from '../../services/workspace';

export { makeStreamsUpdateBinding };

/** Options of {@link streamsDocumentBinding}. */
export interface StreamsDocumentBindingOptions {
  /** Stable logical document id (not a transport URL). */
  readonly resource: string;
  readonly model: 'loro' | 'flock';
  /** A number pins writes to that epoch; `'current'` selects the genuine current epoch per seal. */
  readonly writeEpoch: number | 'current';
}

/**
 * The payload-protection binding a `@loro-dev/streams-crdt` 0.17 document uses
 * to seal updates (header 3) and snapshots (header 4) and to open what it
 * reads, wired to this composition's services: the device signer, the verified
 * ledger and installed epoch keys (including recovered history).
 *
 * Every seal checks current write permission before encryption and again after
 * signing; every open verifies the historical signature before requesting a
 * key and the AEAD after. Lives in the caller's Scope, which awaits active
 * operations on close. See {@link makeStreamsUpdateBinding} for the callback form.
 *
 * Requires `WorkspaceScope`, `DeviceIdentity`, `VerifiedLedger` and
 * `InstalledEpochHistory`.
 *
 * @category Loro Streams adapters
 */
export const streamsDocumentBinding = Effect.fnUntraced(function* (
  options: StreamsDocumentBindingOptions
) {
  const { genesis } = yield* WorkspaceScope;
  const { signer } = yield* DeviceIdentity;
  const ledger = yield* VerifiedLedger;
  const history = yield* InstalledEpochHistory;
  return yield* makeStreamsUpdateBinding({
    ...options,
    genesis,
    signer,
    ledger: () => ledger.current(),
    readEpochKey: (epoch) => history.read(epoch),
  });
});
