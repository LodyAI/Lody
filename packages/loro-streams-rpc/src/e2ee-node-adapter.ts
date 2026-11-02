import { Effect } from 'effect';
import { E2eeRpcStore } from './e2ee-store';
import type { E2eeRpcOriginals } from './e2ee-node-store';
/** Preserve the existing native store API and failure/retry behavior at its I/O boundary. */
export const nativeRpcStore = (store: E2eeRpcOriginals): E2eeRpcStore['Service'] => {
  const attempt = <A>(work: () => A) =>
    Effect.try({
      try: work,
      catch: (error) => (error instanceof Error ? error : new Error('e2ee_rpc_store')),
    });
  return E2eeRpcStore.of({
    read: (direction, key) => attempt(() => store.read(direction, key)),
    retain: (direction, key, record) => attempt(() => store.retain(direction, key, record)),
    readResponse: (key, sequence) => attempt(() => store.readResponse(key, sequence)),
    retainResponse: (key, sequence, frame) =>
      attempt(() => store.retainResponse(key, sequence, frame)),
    retainResponsePages: (key, frames) => attempt(() => store.retainResponsePages(key, frames)),
    close: () => attempt(() => store.close()),
  });
};
