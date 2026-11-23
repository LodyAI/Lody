import { Layer } from 'effect';
import { VerifiedLedger } from './internal/ledger/verified-ledger';
import { InstalledEpochHistory, InstalledEpochKeys } from './internal/keys/installed-keys';
import { KeyReceiver } from './internal/keys/receiver';
import { KeyRepair } from './internal/keys/repair';
import { KeyDistributor } from './internal/keys/distributor';
import { EpochPublisher } from './internal/keys/publisher';
import { LedgerSubmission } from './internal/submission';

/**
 * Every key-lifecycle workflow, wired together:
 * {@link VerifiedLedger}, {@link InstalledEpochKeys},
 * {@link InstalledEpochHistory}, {@link KeyReceiver}, {@link KeyRepair},
 * {@link KeyDistributor}, {@link LedgerSubmission} and {@link EpochPublisher}.
 *
 * Provide it with every port from `@lody/e2ee-core/services` (backend,
 * platform, application and local storage). Workflows are finite: nothing runs
 * in the background; the application decides when to call `resume`, `flush`,
 * `reconcileCurrentEpoch` and friends.
 *
 * @category Composition
 */
export const E2eeWorkflows = Layer.mergeAll(
  KeyRepair.layer,
  KeyDistributor.layer,
  EpochPublisher.layer,
  InstalledEpochHistory.layer
).pipe(
  Layer.provideMerge(KeyReceiver.layer),
  Layer.provideMerge(Layer.mergeAll(InstalledEpochKeys.layer, LedgerSubmission.layer)),
  Layer.provideMerge(VerifiedLedger.layer)
);
