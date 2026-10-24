/** Exact released SDK imports for the isolated Electron performance harness.
 * This has no product/runtime composition consumer. */
export { StreamsCrdt, InMemoryRemoteCursorStore } from '@loro-dev/streams-crdt';
export { createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';
export { startDevServer } from '@loro-dev/sqlite-riverrun';
export const sdkModule = import.meta.resolve('@loro-dev/streams-crdt');
export const loroAdapterModule = import.meta.resolve('@loro-dev/streams-crdt/loro');
