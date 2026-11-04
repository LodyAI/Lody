import { Effect } from 'effect';
import type { LocalLoroFlockLike } from '../local-loro-data-plane-server';
import type { FlockVersionVector } from '../local-loro-data-plane';

/** Genuine Flock SDK boundary. No AbortSignal contract exists: retain the
 * producer until the actual Promise settles, even after its consumer closes. */
export const exportLocalFlock = (flock: LocalLoroFlockLike, from: FlockVersionVector) =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: () => Promise.resolve(flock.exportJson(from)),
      catch: (error) => error,
    })
  );
