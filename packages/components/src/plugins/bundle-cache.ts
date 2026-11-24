import { MAX_PACKED_CLIENT_BUNDLE_BYTES, receiveClientBundle } from '@lody/shared/plugins/digest';
export type ReadBundlePage = (
  offset: number,
  signal: AbortSignal
) => ReturnType<Parameters<typeof receiveClientBundle>[1]>;
interface Transfer {
  controller: AbortController;
  waiting: number;
  result: Promise<VerifiedBundle>;
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
          const read = unpack(bytes);
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
function unpack(bytes: Uint8Array): VerifiedBundle {
  const header = new TextEncoder().encode('lody-client-bundle-v1\0');
  if (!header.every((b, i) => bytes[i] === b)) throw new Error('Invalid plugin bundle');
  const files = new Map<string, Uint8Array>();
  let offset = header.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function part() {
    const length = view.getUint32(offset);
    offset += 4;
    if (length > bytes.length - offset) throw new Error('Truncated plugin bundle');
    const data = bytes.subarray(offset, offset + length);
    offset += length;
    return data;
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (offset < bytes.length) {
    const path = decoder.decode(part());
    if (files.has(path)) throw new Error('Duplicate bundle path');
    files.set(path, part());
  }
  return (path) => {
    const file = files.get(path);
    if (!file) throw new Error('Unknown bundle file');
    return file.slice();
  };
}
