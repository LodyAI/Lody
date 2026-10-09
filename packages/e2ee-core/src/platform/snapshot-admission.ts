import { Effect, Layer } from 'effect';
import type { ContentAuthor, ContentCipher, ContentHeader } from '../content';
import { ControlLogError } from '../pure/legacy-error';
import { SnapshotAdmissionError } from '../pure/errors';
import type { SnapshotPublicationStore } from '../snapshot-publication-store';
import {
  AdmissionClock,
  SnapshotAuthenticator,
  SnapshotStore,
  SnapshotWriteGate,
} from '../ports/snapshot';

function snapshotFailure(error: unknown): Effect.Effect<never, SnapshotAdmissionError> {
  if (error instanceof SnapshotAdmissionError) return Effect.fail(error);
  if (error instanceof ControlLogError)
    return Effect.fail(new SnapshotAdmissionError({ code: error.code }));
  if (
    error instanceof Error &&
    (error.message === 'snapshot-store-busy' || error.message === 'snapshot-transaction-ended')
  )
    return Effect.fail(new SnapshotAdmissionError({ code: error.message }));
  return Effect.die(error);
}

export function snapshotStoreLayer(store: SnapshotPublicationStore): Layer.Layer<SnapshotStore> {
  return Layer.succeed(SnapshotStore, {
    exclusive: (streamKey, work) =>
      Effect.try({
        try: () => store.transaction(streamKey, work),
        catch: (error) => error,
      }).pipe(Effect.catch(snapshotFailure)),
  });
}

export function snapshotAuthenticatorLayer(
  cipher: ContentCipher
): Layer.Layer<SnapshotAuthenticator> {
  return Layer.succeed(SnapshotAuthenticator, {
    authenticate: (scope, inner, additionalData) => {
      const owned = new Uint8Array(inner);
      const binding = new Uint8Array(additionalData);
      return Effect.tryPromise({
        try: () => cipher.authenticate(scope, owned, binding) as Promise<ContentHeader>,
        catch: (error) => error,
      }).pipe(Effect.catch(snapshotFailure));
    },
  });
}

export function snapshotWriteGateLayer(
  mayWriteDocument: (author: Pick<ContentAuthor, 'device'>) => boolean
): Layer.Layer<SnapshotWriteGate> {
  return Layer.succeed(SnapshotWriteGate, { mayWrite: mayWriteDocument });
}

export function admissionClockLayer(now: () => number): Layer.Layer<AdmissionClock> {
  return Layer.succeed(AdmissionClock, { now });
}
