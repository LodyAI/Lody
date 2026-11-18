import type { Flock } from '@loro-dev/flock-wasm/base64';
import type { StreamsClient } from '@loro-dev/streams-client';
import { decodeFrames } from '../frames.ts';

const byteOffset = (value: string | undefined) =>
  value && /^\d{1,20}$/.test(value) ? BigInt(value) : undefined;

// HEAD is an optional optimization. Unknown sizes/offsets and unavailable
// metadata retain the safe incremental path; normal reads own auth/retry.
export async function preferCatalogSnapshot(
  client: Pick<StreamsClient, 'head'>,
  offset: string,
  snapshotBytes: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const current = byteOffset(offset);
  if (current === undefined || snapshotBytes <= 0) return false;
  try {
    const head = await client.head({
      signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    });
    signal.throwIfAborted();
    if (!head.ok) return false;
    const snapshot = byteOffset(head.result.snapshotOffset);
    const tail = byteOffset(head.result.nextOffset);
    if (
      snapshot === undefined ||
      tail === undefined ||
      snapshot <= current ||
      tail < snapshot
    )
      return false;
    const snapshotCost = BigInt(Math.ceil(snapshotBytes / 2)) + tail - snapshot;
    const threshold = snapshotCost > 256n * 1024n ? snapshotCost : 256n * 1024n;
    return tail - current > threshold;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

// A size estimate must not turn a usable old replica into a terminal limit.
// Keep it until the optional replacement is complete and within its budget.
export async function readCatalogRefresh(
  client: Pick<StreamsClient, 'head' | 'bootstrap'>,
  offset: string,
  snapshotBytes: number,
  limit: number,
  signal: AbortSignal,
) {
  if (!(await preferCatalogSnapshot(client, offset, snapshotBytes, signal)))
    return;
  try {
    const fresh = await client.bootstrap({ signal });
    signal.throwIfAborted();
    if (!fresh.ok || !fresh.result.upToDate) return;
    const size =
      (fresh.result.snapshot?.body.length ?? 0) +
      fresh.result.updates.reduce((sum, part) => sum + part.body.length, 0);
    if (size <= limit) return fresh.result;
  } catch {
    signal.throwIfAborted();
  }
}

// Keep one clock across all parts in a bootstrap, not a new slice per part.
// Individual JSON/Wasm operations remain atomic; yield between frames and
// around binary snapshot imports so queued native pings get a macrotask.
export function catalogImportCheckpoint(signal: AbortSignal) {
  let started = performance.now();
  return async (force = false) => {
    signal.throwIfAborted();
    if (force || performance.now() - started >= 12) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      started = performance.now();
    }
  };
}

export async function importCatalogUpdates(
  flock: Flock,
  bytes: Uint8Array,
  checkpoint: ReturnType<typeof catalogImportCheckpoint>,
) {
  const decoder = new TextDecoder();
  for (const frame of decodeFrames(bytes)) {
    await checkpoint();
    flock.importJson(JSON.parse(decoder.decode(frame)));
  }
  await checkpoint();
}

// Only machine initialization uses these slots. Metadata and live reads never
// queue behind slow historical machines. The caller releases at first sync.
export function catalogBootstrapSlots(limit = 2) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (signal: AbortSignal) => {
    signal.throwIfAborted();
    return new Promise<() => void>((resolve, reject) => {
      const abort = () => {
        const index = waiting.indexOf(admit);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      const admit = () => {
        signal.removeEventListener('abort', abort);
        active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          active--;
          waiting.shift()?.();
        });
      };
      signal.addEventListener('abort', abort, { once: true });
      if (active < limit) admit();
      else waiting.push(admit);
    });
  };
}
