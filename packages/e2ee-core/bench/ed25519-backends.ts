/**
 * Verify-backend probe. Does not change Ledger.verify.
 * Runs noble JS, Node OpenSSL, dalek Wasm scalar, dalek Wasm SIMD when the
 * fixture instantiates. A simd128 marker describes the build target, not
 * evidence that verification executes SIMD instructions. These probes do not
 * establish equivalence with the core verifier's full acceptance policy.
 */
import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import {
  Point,
  getPublicKey,
  sign as nobleSign,
  verify as nobleVerify,
  utils,
  hashes,
} from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

hashes.sha512 = (message) => sha512(message);

const here = dirname(fileURLToPath(import.meta.url));

/** GoogleChromeLabs wasm-feature-detect simd module (not a 0xfd15 stub). */
const SIMD_FEATURE_WASM = Uint8Array.of(
  0,
  97,
  115,
  109,
  1,
  0,
  0,
  0,
  1,
  5,
  1,
  96,
  0,
  1,
  123,
  3,
  2,
  1,
  0,
  10,
  10,
  1,
  8,
  0,
  65,
  0,
  253,
  15,
  253,
  98,
  11
);

function wasmSimdRuntime(): boolean {
  try {
    return WebAssembly.validate(SIMD_FEATURE_WASM);
  } catch {
    return false;
  }
}

function ed25519Spki(publicKey: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey)]);
}

function loadDalek(path: string) {
  const bytes = readFileSync(path);
  if (!WebAssembly.validate(bytes)) throw new Error(`wasm-invalid:${path}`);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  const memory = instance.exports.memory as WebAssembly.Memory;
  const verifyFn = instance.exports.verify as (
    pk: number,
    sig: number,
    msg: number,
    n: number
  ) => number;
  const heap = (instance.exports.__heap_base as WebAssembly.Global).value as number;
  const simdMarker = Buffer.from(bytes).includes('simd128');
  return {
    simdMarker,
    bytes: bytes.byteLength,
    validate: true,
    verify(pk: Uint8Array, sig: Uint8Array, msg: Uint8Array): boolean {
      const buf = new Uint8Array(memory.buffer);
      buf.set(pk, heap);
      buf.set(sig, heap + 32);
      buf.set(msg, heap + 96);
      try {
        return verifyFn(heap, heap + 32, heap + 96, msg.byteLength) === 1;
      } catch {
        return false;
      }
    },
  };
}

function timeSync(n: number, fn: (i: number) => boolean) {
  const t0 = performance.now();
  let ok = 0;
  for (let i = 0; i < n; i++) if (fn(i)) ok += 1;
  return { ok, ms: Number((performance.now() - t0).toFixed(2)) };
}

async function main() {
  const n = Number(process.argv.find((a) => a.startsWith('--n='))?.slice(4) ?? 800);
  const messages: Uint8Array[] = [];
  const publicKeys: Uint8Array[] = [];
  const signatures: Uint8Array[] = [];
  const opensslKeys: ReturnType<typeof createPublicKey>[] = [];
  for (let i = 0; i < n; i++) {
    const seed = utils.randomSecretKey();
    const pub = getPublicKey(seed);
    const msg = crypto.getRandomValues(new Uint8Array(32));
    const sig = nobleSign(msg, seed);
    messages.push(msg);
    publicKeys.push(pub);
    signatures.push(sig);
    opensslKeys.push(createPublicKey({ key: ed25519Spki(pub), format: 'der', type: 'spki' }));
  }

  const nobleStrict = (i: number) => {
    try {
      const A = Point.fromBytes(publicKeys[i]!, false);
      if (A.isSmallOrder() || !A.isTorsionFree()) return false;
      return nobleVerify(signatures[i]!, messages[i]!, publicKeys[i]!, { zip215: false });
    } catch {
      return false;
    }
  };
  const openssl = (i: number) => {
    try {
      return nodeVerify(null, messages[i]!, opensslKeys[i]!, signatures[i]!);
    } catch {
      return false;
    }
  };

  const simdPath = join(here, 'fixtures/dalek-verify-simd.wasm');
  const scalarPath = join(here, 'fixtures/dalek-verify-scalar.wasm');
  let dalekSimd: ReturnType<typeof loadDalek> | null = null;
  let dalekScalar: ReturnType<typeof loadDalek> | null = null;
  let simdLoadError: string | null = null;
  try {
    if (existsSync(simdPath)) dalekSimd = loadDalek(simdPath);
    else simdLoadError = 'missing-fixture';
  } catch (error) {
    simdLoadError = String(error);
    dalekSimd = null;
  }
  try {
    if (existsSync(scalarPath)) dalekScalar = loadDalek(scalarPath);
  } catch {
    dalekScalar = null;
  }

  const nobleBits = Array.from({ length: n }, (_, i) => nobleStrict(i));
  const openBits = Array.from({ length: n }, (_, i) => openssl(i));
  const simdBits = dalekSimd
    ? Array.from({ length: n }, (_, i) =>
        dalekSimd!.verify(publicKeys[i]!, signatures[i]!, messages[i]!)
      )
    : [];
  const scalarBits = dalekScalar
    ? Array.from({ length: n }, (_, i) =>
        dalekScalar!.verify(publicKeys[i]!, signatures[i]!, messages[i]!)
      )
    : [];

  function agree(a: boolean[], b: boolean[]) {
    let same = 0;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) same += 1;
      else diff += 1;
    }
    return { agree: same, disagree: diff };
  }

  const tampered = signatures.map((sig) => {
    const next = new Uint8Array(sig);
    const first = next[0];
    if (first === undefined) throw new Error('empty-signature');
    next[0] = first ^ 1;
    return next;
  });
  const low = new Uint8Array(32);
  low[31] = 1;

  nobleStrict(0);
  openssl(0);
  if (dalekSimd) dalekSimd.verify(publicKeys[0]!, signatures[0]!, messages[0]!);
  if (dalekScalar) dalekScalar.verify(publicKeys[0]!, signatures[0]!, messages[0]!);

  const timings: Record<
    string,
    { ok: number; ms: number; threads?: number; simdExecutionVerified?: boolean }
  > = {
    js_single_noble: timeSync(n, nobleStrict),
    native_openssl: timeSync(n, openssl),
  };
  if (dalekScalar) {
    timings.wasm_scalar_dalek = timeSync(n, (i) =>
      dalekScalar!.verify(publicKeys[i]!, signatures[i]!, messages[i]!)
    );
  }
  if (dalekSimd) {
    timings.wasm_simd_dalek = {
      ...timeSync(n, (i) => dalekSimd!.verify(publicKeys[i]!, signatures[i]!, messages[i]!)),
      simdExecutionVerified: false,
    };
  }

  const workers = Math.min(8, availableParallelism());
  if (dalekSimd && n >= 32) {
    const t0 = performance.now();
    const size = Math.ceil(n / workers);
    const slices = [];
    for (let i = 0; i < n; i += size) slices.push({ start: i, end: Math.min(n, i + size) });
    const wasmBytes = readFileSync(simdPath);
    const parts = await Promise.all(
      slices.map(
        (slice) =>
          new Promise<boolean[]>((resolve, reject) => {
            const worker = new Worker(new URL('./ed25519-wasm-worker.mjs', import.meta.url), {
              workerData: {
                wasm: wasmBytes,
                jobs: Array.from({ length: slice.end - slice.start }, (_, j) => ({
                  pk: publicKeys[slice.start + j],
                  sig: signatures[slice.start + j],
                  msg: messages[slice.start + j],
                })),
              },
            });
            worker.once('message', (ok: unknown) => {
              void worker.terminate();
              if (!Array.isArray(ok) || ok.length !== slice.end - slice.start) {
                reject(new Error('sig-worker-shape'));
                return;
              }
              resolve(ok as boolean[]);
            });
            worker.once('error', reject);
          })
      )
    );
    const flat = parts.flat();
    timings.wasm_simd_multithread = {
      ok: flat.filter(Boolean).length,
      ms: Number((performance.now() - t0).toFixed(2)),
      threads: workers,
      simdExecutionVerified: false,
    };
  }

  const report = {
    env: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      availableParallelism: availableParallelism(),
      wasmSimdRuntime: wasmSimdRuntime(),
      ed25519_dalek: '2.2.0',
      noble_ed25519: '3.2.0',
    },
    n,
    simd: {
      featureDetectModule: wasmSimdRuntime(),
      fixture: existsSync(simdPath) ? simdPath : null,
      simdMarkerInArtifact: dalekSimd?.simdMarker ?? false,
      loadError: simdLoadError,
      simdExecutionVerified: false,
    },
    semantics: {
      nobleVsOpenssl: agree(nobleBits, openBits),
      nobleVsDalekSimd: simdBits.length ? agree(nobleBits, simdBits) : null,
      nobleVsDalekScalar: scalarBits.length ? agree(nobleBits, scalarBits) : null,
      tamperedTrue: {
        noble: tampered.reduce(
          (c, sig, i) =>
            c + (nobleVerify(sig, messages[i]!, publicKeys[i]!, { zip215: false }) ? 1 : 0),
          0
        ),
        simd: dalekSimd
          ? tampered.reduce(
              (c, sig, i) => c + (dalekSimd!.verify(publicKeys[i]!, sig, messages[i]!) ? 1 : 0),
              0
            )
          : null,
      },
      lowOrderA: {
        noble: (() => {
          try {
            return nobleVerify(signatures[0]!, messages[0]!, low, { zip215: false });
          } catch {
            return false;
          }
        })(),
        simd: dalekSimd ? dalekSimd.verify(low, signatures[0]!, messages[0]!) : null,
      },
    },
    timingsMs: timings,
    ledgerVerifyUnchanged: true,
    bar100msTicked: false,
    note: 'OpenSSL and dalek are references. Ledger.verify stays noble zip215:false. Shared-memory Wasm not enabled (no imported shared memory; production COOP/COEP unchanged).',
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
