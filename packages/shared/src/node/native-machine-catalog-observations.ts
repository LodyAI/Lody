import type { RepoClient } from '@loro-dev/loro-repo-client';
import { MachineCatalogError } from '../machine-catalog';

type Subscription = {
  readonly isClosed: boolean;
  readonly currentValue: unknown;
  unsubscribe(): Promise<void>;
};
export type NativeMachineCatalogObservation = {
  retire(): void;
  close(): Promise<void>;
  retryCleanup(): Promise<void>;
};
export class NativeMachineCatalogCleanupError extends AggregateError {
  readonly code = 'cleanup_unconfirmed';
  constructor(
    errors: readonly unknown[],
    private readonly retry: () => Promise<void>
  ) {
    super(errors, 'Native machine catalog cleanup is unconfirmed');
  }
  retryCleanup() {
    return this.retry();
  }
}

/** Local fencing and remote release are separate facts. SDK 0.1.0 forgets a
 * handle before sending unsubscribe, so its second call cannot prove release.
 * A failed attempt remains owned until its original ACK or subsequent loss of
 * the transport carrying that locally forgotten subscription. */
export function createNativeMachineCatalogObservations(
  client: Pick<RepoClient, 'onConnectionStateChange' | 'connectionState'>,
  timeoutMs = 10_000
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid cleanup timeout');
  const leases = new Set<NativeMachineCatalogObservation>();
  let retired = false,
    closing: Promise<void> | undefined;
  const bounded = (work: Promise<void>, retry: () => Promise<void>) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new NativeMachineCatalogCleanupError([], retry)),
        timeoutMs
      );
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(new NativeMachineCatalogCleanupError([error], retry));
        }
      );
    });
  const acquire = async <Handle extends Subscription>(
    start: () => Promise<Handle>,
    fence: () => void
  ) => {
    if (retired) throw new MachineCatalogError('access_denied');
    let locallyRetired = false,
      started = false,
      confirmed = false;
    let subscription: Handle | undefined,
      acquisitionFailed = false;
    let fenceFailed = false,
      fenceFailure: unknown;
    let acquisitionFailure: unknown,
      releaseFailure: unknown,
      releaseFailed = false;
    let releaseAttempt: Promise<void> | undefined,
      lostTransport = false;
    let proveLoss!: () => void;
    const loss = new Promise<void>((resolve) => {
      proveLoss = resolve;
    });
    const proof = () => {
      if ((acquisitionFailed || subscription?.isClosed) && client.connectionState !== 'connected') {
        lostTransport = true;
        proveLoss();
      }
    };
    const detachProof = client.onConnectionStateChange(proof);
    const acquisition = Promise.resolve().then(async () => {
      if (locallyRetired) {
        confirmed = true;
        return;
      }
      started = true;
      try {
        subscription = await start();
      } catch (error) {
        acquisitionFailed = true;
        acquisitionFailure = error;
        proof();
        throw error;
      }
    });
    // Always observe the raw acquisition even if the caller retires its waiter.
    void acquisition.catch(() => undefined);
    const finish = () => {
      confirmed = true;
      detachProof();
      if (!fenceFailed) leases.delete(lease);
    };
    const release = async (): Promise<void> => {
      try {
        await acquisition;
      } catch {
        /* The failed request still needs proof. */
      }
      if (confirmed || lostTransport || !started) {
        finish();
        return;
      }
      if (acquisitionFailed) throw acquisitionFailure;
      if (!subscription) throw new Error('Native machine subscription acquisition unresolved');
      if (releaseFailed && subscription.isClosed) throw releaseFailure;
      if (!releaseAttempt || (releaseFailed && !subscription.isClosed)) {
        releaseFailed = false;
        // Call exactly once, synchronously with retirement of the SDK handle.
        try {
          releaseAttempt = Promise.resolve(subscription.unsubscribe());
        } catch (error) {
          releaseAttempt = Promise.reject(error);
        }
        releaseAttempt = releaseAttempt.catch((error) => {
          releaseFailed = true;
          releaseFailure = error;
          proof();
          throw error;
        });
        void releaseAttempt.catch(() => undefined);
        proof();
      }
      await Promise.race([releaseAttempt, loss]);
      finish();
    };
    const localRetire = () => {
      if (!locallyRetired || fenceFailed) {
        locallyRetired = true;
        try {
          fence();
          fenceFailed = false;
        } catch (error) {
          fenceFailed = true;
          fenceFailure = error;
        }
      }
    };
    const lease: NativeMachineCatalogObservation = {
      retire() {
        localRetire();
        // Failure is retained by this lease, not treated as successful close.
        void release().catch(() => undefined);
      },
      close() {
        localRetire();
        return bounded(
          release().then(() => {
            if (fenceFailed) throw fenceFailure;
          }),
          () => lease.close()
        );
      },
      retryCleanup() {
        return lease.close();
      },
    };
    leases.add(lease);
    try {
      await acquisition;
      if (locallyRetired || retired) {
        await lease.close();
        throw new MachineCatalogError('access_denied');
      }
      return {
        observation: lease,
        currentValue: () => subscription!.currentValue,
        handle: subscription!,
      };
    } catch (error) {
      try {
        await lease.close();
      } catch (cleanup) {
        throw new NativeMachineCatalogCleanupError([error, cleanup], () => lease.close());
      }
      throw error;
    }
  };
  const retire = () => {
    retired = true;
    for (const lease of leases) lease.retire();
  };
  const close = (): Promise<void> => {
    retire();
    if (closing) return closing;
    const pending = Promise.allSettled([...leases].map((lease) => lease.close())).then(
      (results) => {
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (failures.length) throw new NativeMachineCatalogCleanupError(failures, close);
      }
    );
    closing = pending;
    void pending.catch(() => {
      if (closing === pending) closing = undefined;
    });
    return pending;
  };
  return { acquire, retire, close, retryCleanup: close };
}
