import { Context, type Effect } from 'effect';
import type { SnapshotAdmissionError } from '../pure/errors';
import type { SnapshotHeader, SnapshotTxView } from '../pure/snapshot-admission';

export class SnapshotStore extends Context.Tag('@lody/e2ee-core/SnapshotStore')<
  SnapshotStore,
  {
    readonly exclusive: <A>(
      streamKey: string,
      work: (tx: SnapshotTxView) => A
    ) => Effect.Effect<A, SnapshotAdmissionError>;
  }
>() {}

export class SnapshotAuthenticator extends Context.Tag('@lody/e2ee-core/SnapshotAuthenticator')<
  SnapshotAuthenticator,
  {
    readonly authenticate: (
      inner: Uint8Array
    ) => Effect.Effect<SnapshotHeader, SnapshotAdmissionError>;
  }
>() {}

export class SnapshotWriteGate extends Context.Tag('@lody/e2ee-core/SnapshotWriteGate')<
  SnapshotWriteGate,
  {
    readonly mayWrite: (author: {
      readonly actor: string;
      readonly memberInstance: string;
      readonly device: string;
    }) => boolean;
  }
>() {}

export class AdmissionClock extends Context.Tag('@lody/e2ee-core/AdmissionClock')<
  AdmissionClock,
  {
    readonly now: () => number;
  }
>() {}
