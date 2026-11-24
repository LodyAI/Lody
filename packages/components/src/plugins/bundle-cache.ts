import {
  MAX_PACKED_CLIENT_BUNDLE_BYTES,
  receiveClientBundle,
  unpackClientBundle,
} from '@lody/shared/plugins/digest';
export type ReadBundlePage = (
  offset: number,
  signal: AbortSignal
) => ReturnType<Parameters<typeof receiveClientBundle>[1]>;
interface Transfer {
  controller: AbortController;
  waiting: number;
  result: Promise<VerifiedBundle>;
}
const packed = new WeakMap<VerifiedBundle, Uint8Array>();
export function verifiedPackedBytes(files: VerifiedBundle) {
  const bytes = packed.get(files);
  if (!bytes) throw Error('Unverified bundle');
  return bytes.slice();
}
export type VerifiedBundle = (path: string) => Uint8Array;

/** One cache per custody scope; only verified bytes can be read by an installation. */
export class VerifiedBundleCache {
  private readonly pending = new Map<string, Transfer>();
  private readonly cached = new Map<string, { read: VerifiedBundle; size: number }>();
  private bytes = 0;
  constructor(private readonly budget = 4 * MAX_PACKED_CLIENT_BUNDLE_BYTES) {}
  async load(
    pluginId: string,
    digest: string,
    page: ReadBundlePage,
    signal?: AbortSignal
  ): Promise<VerifiedBundle> {
    signal?.throwIfAborted();
    const key = JSON.stringify([pluginId, digest]);
    const hit = this.cached.get(key);
    if (hit) {
      this.cached.delete(key);
      this.cached.set(key, hit);
      return hit.read;
    }
    let transfer = this.pending.get(key);
    if (!transfer) {
      const controller = new AbortController();
      const result = receiveClientBundle(digest, (offset) => {
        controller.signal.throwIfAborted();
        return page(offset, controller.signal);
      })
        .then((bytes) => {
          controller.signal.throwIfAborted();
          const read = unpackClientBundle(bytes);
          packed.set(read, bytes);
          this.cached.set(key, { read, size: bytes.length });
          this.bytes += bytes.length;
          // Eviction releases the cache reference, not assets held by a mounted installation.
          for (const [id, entry] of this.cached) {
            if (this.bytes <= this.budget) break;
            this.bytes -= entry.size;
            this.cached.delete(id);
          }
          return read;
        })
        .finally(() => {
          if (this.pending.get(key)?.controller === controller) this.pending.delete(key);
        });
      transfer = { controller, result, waiting: 0 };
      this.pending.set(key, transfer);
    }
    transfer.waiting++;
    let onAbort: (() => void) | undefined;
    try {
      return await (signal
        ? Promise.race([
            transfer.result,
            new Promise<never>((_, reject) => {
              onAbort = () => reject(signal.reason);
              if (signal.aborted) onAbort();
              else signal.addEventListener('abort', onAbort, { once: true });
            }),
          ])
        : transfer.result);
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      if (--transfer.waiting === 0 && this.pending.get(key) === transfer) {
        this.pending.delete(key);
        transfer.controller.abort();
      }
    }
  }
}
