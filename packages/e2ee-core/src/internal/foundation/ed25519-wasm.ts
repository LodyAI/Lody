import { ED25519_WASM_BASE64 } from './ed25519-wasm.generated';

/**
 * Strict Ed25519 compiled from Rust (wasm/ed25519-strict) with exactly the
 * pure-JS rules: canonical nonzero prime-subgroup A and R, S < L, cofactored
 * equation. Not injectable: the module is either compiled from the embedded
 * bytes or, where runtime compilation is forbidden (Cloudflare Workers), the
 * same packaged file compiled by the bundler through the `./cloudflare` entry.
 * Either way it is used only after it passes known-answer checks. Otherwise
 * every call returns undefined and callers use the pure-JS path, with
 * identical results.
 */
type Exports = {
  readonly memory: WebAssembly.Memory;
  input(length: number): number;
  key_ok(): number;
  verify(messageLength: number, keyChecked: number): number;
};

let loaded: Exports | null | undefined;
let provided: WebAssembly.Module | undefined;
let enabled = true;

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
const hex = (value: string) => {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(value.slice(2 * i, 2 * i + 2), 16);
  return bytes;
};

// Deterministic vectors (one key, one message): a valid signature, one whose R
// has a torsion component yet satisfies the cofactored equation, a small-order
// key and a non-canonical encoding. A module that disagrees with any is unused.
const KNOWN = {
  key: 'f437183a2eb72c079cd477de1d29c2536838a552ac45c0a013395716a024d554',
  message: '6c6f64792d653265652065643235353139206b6e6f776e20616e73776572',
  valid:
    'c5f5ae1f5e6d5fdb7f08528089a607c6a7b2226c75205d3d1f692ad452644ea9a2fd9f2288a8b4a0fee38e67cc0852c06a4a00f45e757662a5c1976ae4f1c500',
  torsionR:
    'e31bf514eb41af934cdb61a8ae588b29deeaf21be78382d8b9ac13493f1c262eeaf133195258fb02b95ce41855758eb432e1f527cb8b6e5ab8364d2515f1100e',
  smallOrderKey: 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  nonCanonicalKey: 'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
};
/** Tests only: the vectors the loader checks a module against. */
export const ED25519_KNOWN_ANSWERS = KNOWN;

const invoke = (fn: Function, ...args: number[]): number =>
  Number(Reflect.apply(fn, undefined, args) as unknown);

/** The verifier's exports, or null for a module of another shape. */
function verifierExports(value: WebAssembly.Exports): Exports | null {
  const { memory, input, key_ok: keyOk, verify } = value;
  return memory instanceof WebAssembly.Memory &&
    typeof input === 'function' &&
    typeof keyOk === 'function' &&
    typeof verify === 'function'
    ? {
        memory,
        input: (length) => invoke(input, length),
        key_ok: () => invoke(keyOk),
        verify: (messageLength, keyChecked) => invoke(verify, messageLength, keyChecked),
      }
    : null;
}

function passesKnownAnswers(exports: Exports): boolean {
  const key = hex(KNOWN.key);
  const message = hex(KNOWN.message);
  const tampered = message.map((byte, index) => (index === 0 ? byte ^ 1 : byte));
  const valid = hex(KNOWN.valid);
  const torsion = hex(KNOWN.torsionR);
  const verify = (k: Uint8Array, m: Uint8Array, s: Uint8Array, checked: number) =>
    call(exports, [k, s, m], () => exports.verify(m.length, checked));
  const keyOk = (k: Uint8Array) => call(exports, [k], () => exports.key_ok());
  return (
    keyOk(key) &&
    !keyOk(hex(KNOWN.smallOrderKey)) &&
    !keyOk(hex(KNOWN.nonCanonicalKey)) &&
    [0, 1].every(
      (checked) =>
        verify(key, message, valid, checked) &&
        !verify(key, tampered, valid, checked) &&
        !verify(key, message, torsion, checked)
    ) &&
    !verify(hex(KNOWN.smallOrderKey), message, valid, 0)
  );
}

function instance(): Exports | null {
  if (!enabled) return null;
  if (loaded === undefined) {
    loaded = null;
    try {
      const module = provided ?? new WebAssembly.Module(decode(ED25519_WASM_BASE64));
      const exports = verifierExports(new WebAssembly.Instance(module).exports);
      loaded = exports && passesKnownAnswers(exports) ? exports : null;
    } catch {
      loaded = null;
    }
  }
  return loaded;
}

function call(exports: Exports, parts: readonly Uint8Array[], run: () => number): boolean {
  const length = parts.reduce((total, part) => total + part.length, 0);
  // Grows memory if needed, so take the view after this call.
  const pointer = exports.input(length);
  const target = new Uint8Array(exports.memory.buffer, pointer, length);
  let offset = 0;
  for (const part of parts) {
    target.set(part, offset);
    offset += part.length;
  }
  const accepted = run() === 1;
  target.fill(0);
  return accepted;
}

/**
 * Internal to the `./cloudflare` entry, which passes the packaged module its
 * bundler compiled. Ignored once a module is in use; replaces a failed load.
 */
export function provideEd25519WasmModule(module: WebAssembly.Module): void {
  if (loaded) return;
  provided = module;
  loaded = undefined;
}

/** Whether strict Ed25519 runs in WebAssembly here (false: pure-JS fallback). */
export function ed25519WasmActive(): boolean {
  return instance() !== null;
}

/** Valid signing key (canonical, not small order, prime-order subgroup), or undefined without WebAssembly. */
export function wasmSigningKeyValid(key: Uint8Array): boolean | undefined {
  const exports = instance();
  if (!exports || key.length !== 32) return undefined;
  return call(exports, [key], () => exports.key_ok());
}

/**
 * Strict verification result, or undefined without WebAssembly. Pass
 * `keyChecked` only for a key `signingPublicKey` already accepted: it skips the
 * repeated prime-subgroup check of A (still decoded canonically).
 */
export function wasmVerifyStrict(
  key: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
  keyChecked = false
): boolean | undefined {
  const exports = instance();
  if (!exports || key.length !== 32 || signature.length !== 64) return undefined;
  return call(exports, [key, signature, message], () =>
    exports.verify(message.length, keyChecked ? 1 : 0)
  );
}

/** Tests and benchmarks only: compare against the pure-JS path. Not exported by any entry. */
export function setEd25519WasmEnabled(value: boolean): void {
  enabled = value;
}

/** Tests only: forget the loaded module so the next call loads again. */
export function resetEd25519WasmForTests(): void {
  loaded = undefined;
  provided = undefined;
}
