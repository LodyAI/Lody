// The wasm module behind loro-crdt's `bundler` entry. Only the production bundle
// imports it (see lib/loro/wasm-runtime-health.ts); vite-plugin-wasm exposes the
// instance exports, of which only the memory is read.
declare module 'loro-crdt/bundler/loro_wasm_bg.wasm' {
  export const memory: WebAssembly.Memory;
}
