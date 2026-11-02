/**
 * `@lody/e2ee-core/cloudflare` — for Cloudflare Workers (workerd), which forbid
 * compiling WebAssembly from bytes at runtime. Import this entry once in the
 * Worker: the bundler (wrangler) compiles the packaged strict Ed25519 module at
 * deploy time, and core uses it after its known-answer checks. Without this
 * entry, core verifies correctly in pure JS, only slower. Other runtimes do not
 * need it.
 *
 * @module
 */
import ed25519 from '../../wasm/ed25519-strict/ed25519_strict.wasm';
import {
  ed25519WasmActive as active,
  provideEd25519WasmModule,
} from '../internal/foundation/ed25519-wasm';

provideEd25519WasmModule(ed25519);

/** Whether strict Ed25519 verification runs in WebAssembly in this isolate (false: the pure-JS fallback is in use). */
export const ed25519WasmActive = (): boolean => active();
