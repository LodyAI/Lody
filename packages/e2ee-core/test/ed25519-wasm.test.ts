import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { Point, etc, hashes, utils, verify } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Protocol from '@lody/e2ee-core/protocol';
import {
  ED25519_KNOWN_ANSWERS,
  ed25519WasmActive,
  provideEd25519WasmModule,
  resetEd25519WasmForTests,
  setEd25519WasmEnabled,
  wasmSigningKeyValid,
  wasmVerifyStrict,
} from '../src/internal/foundation/ed25519-wasm';
import {
  ED25519_WASM_BASE64,
  ED25519_WASM_SHA256,
} from '../src/internal/foundation/ed25519-wasm.generated';
import { signingPublicKey } from '../src/internal/foundation/bytes';
import { verifySignature } from '../src/internal/foundation/signature';

hashes.sha512 = sha512;
const toNumber = (bytes: Uint8Array) => {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
};
const le = (n: bigint) => {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++, n >>= 8n) bytes[i] = Number(n & 0xffn);
  return bytes;
};

// Independent reference with the pure-JS rules core enforces (bytes.ts, signature.ts).
const L = Point.CURVE().n;
const P = Point.CURVE().p;
const nobleKey = (key: Uint8Array) => {
  try {
    const point = Point.fromBytes(key, false);
    return !point.isSmallOrder() && point.isTorsionFree();
  } catch {
    return false;
  }
};
const nobleVerify = (key: Uint8Array, message: Uint8Array, signature: Uint8Array) => {
  if (!nobleKey(key)) return false;
  try {
    const s = toNumber(signature.subarray(32));
    const r = Point.fromBytes(signature.subarray(0, 32), false);
    if (s >= L || r.is0() || !r.isTorsionFree()) return false;
    return verify(signature, message, key, { zip215: false });
  } catch {
    return false;
  }
};
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const modL = (bytes: Uint8Array) => etc.mod(toNumber(bytes), L);

/** Small-order points: all eight torsion points. */
const torsion = (() => {
  const points = new Map<string, Point>();
  // T has order 8; its multiples are the whole torsion subgroup.
  const t8 = Point.fromBytes(
    etc.hexToBytes('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a'),
    false
  );
  let point = Point.ZERO;
  for (let i = 0; i < 8; i++, point = point.add(t8)) points.set(point.toHex(), point);
  return [...points.values()];
})();

/** Signature with an arbitrary nonce point R (may be off the prime subgroup). */
function craft(secret: Uint8Array, message: Uint8Array, mutateR: (r: Point) => Point) {
  const { scalar, pointBytes } = utils.getExtendedPublicKey(secret);
  const nonce = modL(randomBytes(64));
  const r = mutateR(Point.BASE.multiply(nonce));
  const rBytes = r.toBytes();
  const k = modL(sha512(concat(rBytes, pointBytes, message)));
  const s = etc.mod(nonce + k * scalar, L);
  return { key: pointBytes, signature: concat(rBytes, le(s)) };
}

function nodeSigned(size: number) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const message = new Uint8Array(randomBytes(size));
  return { key, message, signature: new Uint8Array(sign(null, message, privateKey)) };
}

/** Non-canonical encodings: y + p (only for y < 19) and x = 0 with the sign bit set. */
const nonCanonical = (() => {
  const encodings: Uint8Array[] = [];
  for (let y = 0n; y < 19n; y++)
    for (const signBit of [0, 0x80]) {
      const bytes = le(y + P);
      bytes[31]! |= signBit;
      encodings.push(bytes);
    }
  for (const y of [1n, P - 1n]) {
    const bytes = le(y);
    bytes[31]! |= 0x80;
    encodings.push(bytes);
  }
  return encodings;
})();

const packagedWasm = new URL('../wasm/ed25519-strict/ed25519_strict.wasm', import.meta.url);
const fromHex = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
/** Hand-assembled module with the verifier's exports that accepts everything. */
const ACCEPT_ALL = fromHex(
  '0061736d01000000' +
    '0110' +
    '03' +
    '60017f017f' +
    '6000017f' +
    '60027f7f017f' +
    '0304' +
    '03000102' +
    '0503010001' +
    '0724' +
    '04' +
    '066d656d6f72790200' +
    '05696e7075740000' +
    '066b65795f6f6b0001' +
    '0676657269667900' +
    '02' +
    '0a10' +
    '03' +
    '040041000b' +
    '040041010b' +
    '040041010b'
);

describe('WebAssembly strict Ed25519', () => {
  it('reports through the protocol entry whether WebAssembly is in use', () => {
    // Node compiles from bytes, so core uses WebAssembly; the entry reads the same state.
    expect(Protocol.ed25519WasmActive()).toBe(true);
    resetEd25519WasmForTests();
    setEd25519WasmEnabled(false);
    try {
      expect(Protocol.ed25519WasmActive()).toBe(false);
    } finally {
      setEd25519WasmEnabled(true);
      resetEd25519WasmForTests();
    }
    expect(Protocol.ed25519WasmActive()).toBe(true);
  });
  it('embeds and packages exactly the module its build recorded', () => {
    const bytes = Buffer.from(ED25519_WASM_BASE64, 'base64');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(ED25519_WASM_SHA256);
    expect(readFileSync(packagedWasm)).toEqual(bytes);
    expect(wasmSigningKeyValid(new Uint8Array(32))).toBe(false);
  });

  it('needs no input to tell the canonical-encoding check apart from the subgroup rules', () => {
    // Non-canonical encodings exist only for y < 19 (y + p < 2^255) and x = 0.
    // None of those points is of prime order, so the subgroup rules already
    // reject every non-canonical A or R; the explicit check is defense in depth.
    for (let y = 0n; y < 19n; y++)
      for (const signBit of [0, 0x80]) {
        const bytes = le(y);
        bytes[31]! |= signBit;
        let point: Point | undefined;
        try {
          point = Point.fromBytes(bytes, false);
        } catch {
          continue;
        }
        expect(point.isSmallOrder() || !point.isTorsionFree()).toBe(true);
      }
  });

  it('agrees with the pure-JS key rules on valid, small-order, mixed-order, non-canonical and random keys', () => {
    const keys: Uint8Array[] = [
      ...Array.from({ length: 50 }, () => nodeSigned(0).key),
      ...torsion.map((point) => point.toBytes()),
      ...nonCanonical,
    ];
    const valid = Point.fromBytes(nodeSigned(0).key, false);
    for (const t of torsion.slice(1)) keys.push(valid.add(t).toBytes());
    for (let i = 0; i < 500; i++) keys.push(new Uint8Array(randomBytes(32)));
    for (const key of keys) expect([key, wasmSigningKeyValid(key)]).toEqual([key, nobleKey(key)]);
    expect(keys.filter((key) => wasmSigningKeyValid(key)).length).toBeGreaterThan(50);
  });

  it('agrees with the pure-JS verification on valid, tampered and adversarial signatures', () => {
    const cases: { key: Uint8Array; message: Uint8Array; signature: Uint8Array }[] = [];
    for (const size of [0, 1, 300, 8192, 20_000]) cases.push(nodeSigned(size));
    for (let i = 0; i < 40; i++) {
      const base = nodeSigned(64);
      cases.push(base);
      const flip = (bytes: Uint8Array, at: number) => {
        const copy = bytes.slice();
        copy[at % copy.length]! ^= 1 << (i % 8);
        return copy;
      };
      cases.push({ ...base, message: flip(base.message, i) });
      cases.push({ ...base, signature: flip(base.signature, i) });
      cases.push({ ...base, signature: flip(base.signature, 32 + i) });
      cases.push({ ...base, key: flip(base.key, i) });
      // S + L: same equation, non-canonical scalar.
      const s = toNumber(base.signature.subarray(32)) + L;
      cases.push({ ...base, signature: concat(base.signature.subarray(0, 32), le(s)) });
    }
    const secret = utils.randomSecretKey();
    const message = new Uint8Array(randomBytes(32));
    // Valid under the cofactored equation, but R has a torsion component.
    for (const t of torsion.slice(1)) {
      const mixed = { message, ...craft(secret, message, (r) => r.add(t)) };
      // Only the prime-subgroup rule rejects these; they exercise it, not the equation.
      expect(verify(mixed.signature, message, mixed.key, { zip215: false })).toBe(true);
      cases.push(mixed);
    }
    // Small-order R and A, and non-canonical R.
    for (const t of torsion) cases.push({ message, ...craft(secret, message, () => t) });
    for (const encoding of nonCanonical) {
      const base = nodeSigned(32);
      cases.push({ ...base, signature: concat(encoding, base.signature.subarray(32)) });
      cases.push({ ...base, key: encoding });
    }
    const honest = craft(secret, message, (r) => r);
    cases.push({ message, ...honest });
    for (const { key, message: m, signature } of cases) {
      const expected = nobleVerify(key, m, signature);
      expect(wasmVerifyStrict(key, m, signature)).toBe(expected);
      // The pre-checked entry may skip only the key's subgroup check.
      if (nobleKey(key)) expect(wasmVerifyStrict(key, m, signature, true)).toBe(expected);
    }
    expect(wasmVerifyStrict(honest.key, message, honest.signature)).toBe(true);
  });

  it('gives core the same results and error codes with and without WebAssembly', () => {
    const inputs = [nodeSigned(100), { ...nodeSigned(100), message: new Uint8Array(3) }];
    const secret = utils.randomSecretKey();
    const message = new Uint8Array(randomBytes(32));
    inputs.push({ message, ...craft(secret, message, (r) => r.add(torsion[1]!)) });
    const run = () =>
      inputs.map(({ key, message: m, signature }) => {
        const result = verifySignature(key, m, signature);
        return result._tag === 'Success' ? 'ok' : result.failure.code;
      });
    const withWasm = run();
    setEd25519WasmEnabled(false);
    try {
      expect(run()).toEqual(withWasm);
      const random = new Uint8Array(randomBytes(32));
      const pure = signingPublicKey(random);
      setEd25519WasmEnabled(true);
      expect(signingPublicKey(random)._tag).toBe(pure._tag);
    } finally {
      setEd25519WasmEnabled(true);
    }
    expect(withWasm).toEqual(['ok', 'bad-signature', 'bad-signature']);
  });

  it('uses only modules that pass its known-answer vectors, which test the strict rules', () => {
    const k = ED25519_KNOWN_ANSWERS;
    const key = fromHex(k.key);
    const message = fromHex(k.message);
    expect(nobleVerify(key, message, fromHex(k.valid))).toBe(true);
    // Accepted by the bare cofactored equation, rejected only by the subgroup rule.
    expect(verify(fromHex(k.torsionR), message, key, { zip215: false })).toBe(true);
    expect(nobleVerify(key, message, fromHex(k.torsionR))).toBe(false);
    expect(nobleKey(fromHex(k.smallOrderKey))).toBe(false);
    expect(nobleKey(fromHex(k.nonCanonicalKey))).toBe(false);

    // It instantiates and accepts anything; only the known answers reject it.
    const cheat = new WebAssembly.Instance(new WebAssembly.Module(ACCEPT_ALL)).exports as {
      verify(length: number, checked: number): number;
      key_ok(): number;
    };
    expect([cheat.verify(0, 0), cheat.key_ok()]).toEqual([1, 1]);
    resetEd25519WasmForTests();
    try {
      provideEd25519WasmModule(new WebAssembly.Module(ACCEPT_ALL));
      expect(ed25519WasmActive()).toBe(false);
      expect(wasmVerifyStrict(key, message, fromHex(k.torsionR))).toBeUndefined();
    } finally {
      resetEd25519WasmForTests();
    }
    expect(ed25519WasmActive()).toBe(true);
  });

  it('falls back to pure JS where compiling from bytes is forbidden, and uses a provided packaged module', () => {
    const compiled = new WebAssembly.Module(readFileSync(packagedWasm));
    const Original = WebAssembly.Module;
    const signed = nodeSigned(64);
    resetEd25519WasmForTests();
    // workerd: "Wasm code generation disallowed by embedder".
    (WebAssembly as { Module: unknown }).Module = function () {
      throw new WebAssembly.CompileError('Wasm code generation disallowed by embedder');
    };
    try {
      expect(ed25519WasmActive()).toBe(false);
      const result = verifySignature(signed.key, signed.message, signed.signature);
      expect(result._tag).toBe('Success');
      provideEd25519WasmModule(compiled);
      expect(ed25519WasmActive()).toBe(true);
      expect(wasmVerifyStrict(signed.key, signed.message, signed.signature)).toBe(true);
    } finally {
      (WebAssembly as { Module: unknown }).Module = Original;
      resetEd25519WasmForTests();
    }
  });
});
