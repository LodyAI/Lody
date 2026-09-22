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
  const captured = { ...input, body: new Uint8Array(input.body) };
  return Effect.gen(function* () {
    const checked = yield* checkSnapshotPut(captured);
    const store = yield* SnapshotStore;
    const retry = yield* store
      .exclusive(checked.streamKey, (tx) => existingSnapshot(tx, checked.offset, checked.body))
      .pipe(Effect.flatten);
    if (retry) return retry;
    const clock = yield* AdmissionClock;
    yield* checkSnapshotLease(clock.now(), checked.leaseIssuedAt, checked.leaseExpiresAt);
    const inner = yield* parseLsceSnapshot(checked.body);
    const authenticator = yield* SnapshotAuthenticator;
    const header = yield* authenticator.authenticate(inner);
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
          mayWrite: gate.mayWrite(header),
          time: clock.now(),
          leaseIssuedAt: checked.leaseIssuedAt,
          leaseExpiresAt: checked.leaseExpiresAt,
        })
      )
      .pipe(Effect.flatten);
  }).pipe(Effect.withSpan('e2ee.snapshot.admit'));
}
