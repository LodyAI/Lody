import { Result } from 'effect';
import type { PayloadProtectionOpenInput } from '@loro-dev/streams-crdt';
import { ContentError, inspectContentFrame } from '@lody/e2ee-core/protocol';

/** How far ahead of the verified epoch an unverified content frame may point and still
 * count as ledger lag (Streams faster than the ledger feed) rather than forgery. */
export const LEDGER_LOOKAHEAD_EPOCHS = 4;
/** Minimum spacing between pending-key / ledger-lag receptions of one workspace. */
export const RECEIVE_KEY_COOLDOWN_MS = 3_000;
/** Upper bound on waiting for a content catch-up round before failing the open. */
export const CONTENT_CATCH_UP_TIMEOUT_MS = 30_000;

export type ContentKeyPendingState = 'pending' | 'installed' | false;

function untilAborted<A>(work: Promise<A>, signals: readonly AbortSignal[]): Promise<A> {
  return new Promise<A>((resolve, reject) => {
    const detach = () => {
      for (const signal of signals) signal.removeEventListener('abort', onAbort);
    };
    function onAbort(this: AbortSignal) {
      detach();
      reject(this.reason);
    }
    const aborted = signals.find((signal) => signal.aborted);
    if (aborted) {
      work.catch(() => {});
      reject(aborted.reason);
      return;
    }
    for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        detach();
        resolve(value);
      },
      (error) => {
        detach();
        reject(error);
      }
    );
  });
}

export type ContentLedgerCatchUpOptions = {
  readonly isClosed: () => boolean;
  readonly keyPending: (
    epoch: number,
    unknownAuthority: boolean
  ) => Promise<ContentKeyPendingState>;
  readonly catchUp: () => Promise<void>;
  readonly now?: () => number;
  readonly cooldownMs?: number;
  readonly timeoutMs?: number;
};

/**
 * Bounded-lookahead content catch-up for CLI Streams rooms, matching desktop/portable:
 * only a frame whose room purpose parses and whose unverified epoch is classified as a
 * missing installed key or bounded ledger lag for an active local member device may wait
 * for one spaced workspace refresh, then retry opening once.
 */
export function makeContentLedgerCatchUp(options: ContentLedgerCatchUpOptions) {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? RECEIVE_KEY_COOLDOWN_MS;
  const timeoutMs = options.timeoutMs ?? CONTENT_CATCH_UP_TIMEOUT_MS;
  const stopped = new AbortController();
  let reception: Promise<void> | undefined;
  let lastReception: number | undefined;

  const receive = () =>
    (reception ??= (async () => {
      const deadline = new AbortController();
      const timer = setTimeout(
        () => deadline.abort(new Error('e2ee_key_pending_timeout')),
        timeoutMs
      );
      timer.unref?.();
      let spacing: ReturnType<typeof setTimeout> | undefined;
      try {
        // Clamped: a wall clock moved backwards never stretches the spacing.
        const wait =
          lastReception === undefined
            ? 0
            : Math.min(cooldownMs, lastReception + cooldownMs - now());
        if (wait > 0)
          await untilAborted(
            new Promise<void>((resolve) => {
              spacing = setTimeout(resolve, wait);
              spacing.unref?.();
            }),
            [stopped.signal, deadline.signal]
          );
      } catch (error) {
        if (spacing !== undefined) clearTimeout(spacing);
        clearTimeout(timer);
        throw error;
      }
      try {
        await untilAborted(options.catchUp(), [stopped.signal, deadline.signal]);
      } catch (error) {
        if (options.isClosed() || stopped.signal.aborted || deadline.signal.aborted) throw error;
        // A failed round can still have installed the key (e.g. from a staged
        // group); the single retry below decides.
      } finally {
        lastReception = now();
        clearTimeout(timer);
      }
    })().finally(() => {
      reception = undefined;
    }));

  return {
    close: () => {
      if (!stopped.signal.aborted) stopped.abort(new Error('e2ee_closed'));
    },
    openWithCatchUp: async <A>(
      model: 'loro' | 'flock',
      frame: PayloadProtectionOpenInput,
      open: () => Promise<A>
    ): Promise<A> => {
      try {
        return await open();
      } catch (error) {
        if (
          options.isClosed() ||
          stopped.signal.aborted ||
          !(error instanceof ContentError) ||
          (error.code !== 'unauthorized' && error.code !== 'missing-read-key')
        )
          throw error;
        const snapshot = frame.context?.kind === 'snapshot';
        const metadata = inspectContentFrame(
          frame.sealed,
          model === 'loro'
            ? snapshot
              ? 'doc-snapshot'
              : 'doc-update'
            : snapshot
              ? 'flock-snapshot'
              : 'flock-update'
        );
        if (Result.isFailure(metadata)) throw error;
        const state = await options
          .keyPending(metadata.success.epoch, error.code === 'unauthorized')
          .catch(() => false as const);
        if (!state) throw error;
        if (state === 'pending') await receive();
        if (options.isClosed() || stopped.signal.aborted) throw new Error('e2ee_closed');
        return open();
      }
    },
  };
}
