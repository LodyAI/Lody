import { inspectContentFrame } from '../pure/content-frame';
import { SnapshotAdmissionError } from '../pure/errors';
import { Result } from 'effect';
import { Effect } from 'effect';
import {
  AdmissionClock,
  SnapshotAuthenticator,
  SnapshotStore,
  SnapshotWriteGate,
} from '../ports/snapshot';
import {
  checkSnapshotLease,
  checkSnapshotPut,
  commitSnapshotAdmission,
  existingSnapshot,
  parseLsceSnapshot,
  type SnapshotPut,
} from '../pure/snapshot-admission';

/** Verify outside the lock; re-check lease, identity and write rights inside it. */
export function admitSnapshot(input: SnapshotPut) {
  const captured = checkSnapshotPut(input);
  return Effect.gen(function* () {
    const checked = yield* Effect.fromResult(captured);
    const store = yield* SnapshotStore;
    // Early rejection of different bytes at an admitted offset. Exact retries still
    // authenticate below: only the signing device may retry.
    const retry = yield* store
      .exclusive(checked.streamKey, (tx) => existingSnapshot(tx, checked.offset, checked.body))
      .pipe(Effect.flatMap(Effect.fromResult));
    const clock = yield* AdmissionClock;
    if (!retry)
      yield* Effect.fromResult(
        checkSnapshotLease(clock.now(), checked.leaseIssuedAt, checked.leaseExpiresAt)
      );
    const { inner, additionalData } = yield* Effect.fromResult(parseLsceSnapshot(checked.body));
    const authenticator = yield* SnapshotAuthenticator;
    const metadata = yield* Effect.fromResult(
      Result.mapError(
        inspectContentFrame(inner),
        (e) => new SnapshotAdmissionError({ code: e.code })
      )
    );
    const header = yield* authenticator.authenticate(
      {
        genesis: checked.expectedGenesis,
        resource: checked.expectedResource,
        epoch: metadata.epoch,
        purpose: checked.expectedPurpose,
      },
      inner,
      additionalData
    );
    const gate = yield* SnapshotWriteGate;
    return yield* store
      .exclusive(checked.streamKey, (tx) =>
        commitSnapshotAdmission(tx, {
          offset: checked.offset,
          body: checked.body,
          header,
          submittingDevice: checked.submittingDevice,
          expectedGenesis: checked.expectedGenesis,
          expectedResource: checked.expectedResource,
          expectedPurpose: checked.expectedPurpose,
          mayWrite: gate.mayWrite(header),
          time: clock.now(),
          leaseIssuedAt: checked.leaseIssuedAt,
          leaseExpiresAt: checked.leaseExpiresAt,
        })
      )
      .pipe(Effect.flatMap(Effect.fromResult));
  }).pipe(Effect.withSpan('e2ee.snapshot.admit'));
}
