import { Context, type Effect } from 'effect';
import type { SnapshotAdmissionError } from '../pure/errors';
import type { SnapshotHeader, SnapshotTxView } from '../pure/snapshot-admission';

export class SnapshotStore extends Context.Service<
  SnapshotStore,
  {
    readonly exclusive: <A>(
      streamKey: string,
      work: (tx: SnapshotTxView) => A
    ) => Effect.Effect<A, SnapshotAdmissionError>;
  }
>()('@lody/e2ee-core/SnapshotStore') {}

export class SnapshotAuthenticator extends Context.Service<
  SnapshotAuthenticator,
  {
    readonly authenticate: (
      scope: import('../content').ContentScope,
      inner: Uint8Array,
      additionalData: Uint8Array
    ) => Effect.Effect<SnapshotHeader, SnapshotAdmissionError>;
  }
>()('@lody/e2ee-core/SnapshotAuthenticator') {}

export class SnapshotWriteGate extends Context.Service<
  SnapshotWriteGate,
  {
    readonly mayWrite: (author: { readonly device: string }) => boolean;
  }
>()('@lody/e2ee-core/SnapshotWriteGate') {}

export class AdmissionClock extends Context.Service<
  AdmissionClock,
  {
    readonly now: () => number;
  }
>()('@lody/e2ee-core/AdmissionClock') {}
