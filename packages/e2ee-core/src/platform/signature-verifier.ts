import { Effect, Layer } from 'effect';
import { hashes, Point, verify as nobleVerify } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import type { SignatureJob, SignatureVerifyExecutor } from '../capabilities';
import { SignatureVerifier, type SignatureJobInput } from '../ports/ledger';
import { ValidationError } from '../pure/errors';
import { keyId } from '../pure/identifiers';
import { SigningFacts } from '../pure/signing-facts';

hashes.sha512 = (message) => sha512(message);

const SIGNING_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
export const DEFAULT_SIGNING_POINT_CACHE_LIMIT = 8192;

/** Instance-owned prime-subgroup point cache. Only this module inserts points,
 * and only after checking them; there is no process-wide default instance. */
export class SigningPointCache {
  readonly #points = new Map<string, Point>();
  readonly enabled: boolean;
  readonly maxEntries: number;
  constructor(options?: { enabled?: boolean; maxEntries?: number }) {
    const maxEntries = options?.maxEntries ?? DEFAULT_SIGNING_POINT_CACHE_LIMIT;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0)
      throw new RangeError('SigningPointCache maxEntries must be a non-negative integer');
    this.enabled = options?.enabled !== false;
    this.maxEntries = maxEntries;
  }
  get size(): number {
    return this.#points.size;
  }
  has(bytes: Uint8Array): boolean {
    return this.enabled && this.#points.has(keyId(bytes));
  }
  static remember(cache: SigningPointCache, bytes: Uint8Array, point: Point): void {
    if (!cache.enabled || cache.maxEntries === 0) return;
    if (cache.#points.size >= cache.maxEntries) {
      const first = cache.#points.keys().next().value;
      if (first !== undefined) cache.#points.delete(first);
    }
    cache.#points.set(keyId(bytes), point);
  }
}

function validSigningPoint(
  bytes: Uint8Array,
  cache: SigningPointCache | undefined,
  facts: SigningFacts
): boolean {
  if (bytes.byteLength !== SIGNING_KEY_BYTES) return false;
  if (facts.has(bytes) || cache?.has(bytes)) return true;
  try {
    const point = Point.fromBytes(bytes, false);
    if (point.isSmallOrder() || !point.isTorsionFree()) return false;
    if (cache) SigningPointCache.remember(cache, bytes, point);
    return true;
  } catch {
    return false;
  }
}

/** Strict Ed25519: canonical prime-subgroup A and R, `zip215: false`. */
export function verifySignature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
  cache?: SigningPointCache,
  facts = SigningFacts.empty
): boolean {
  if (signature.byteLength !== SIGNATURE_BYTES) return false;
  if (!validSigningPoint(publicKey, cache, facts)) return false;
  try {
    if (!Point.fromBytes(signature.subarray(0, 32), false).isTorsionFree()) return false;
  } catch {
    return false;
  }
  try {
    return nobleVerify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

const trustedExecutors = new WeakSet<SignatureVerifyExecutor>();

export function isTrustedSignatureVerifyExecutor(executor: SignatureVerifyExecutor): boolean {
  return trustedExecutors.has(executor);
}

/** Only sequential/Node factories may call this. Do not re-export from the package. */
export function trustSignatureVerifyExecutor<T extends SignatureVerifyExecutor>(executor: T): T {
  trustedExecutors.add(executor);
  return executor;
}

export function createSequentialSignatureVerify(
  cache?: SigningPointCache
): SignatureVerifyExecutor {
  return trustSignatureVerifyExecutor(
    Object.freeze({
      async verify(jobs: readonly SignatureJob[]): Promise<boolean[]> {
        return jobs.map((job) => verifySignature(job.pk, job.msg, job.sig, cache));
      },
    })
  );
}

/** Stateless: no shared point cache. */
export const sequentialSignatureVerify: SignatureVerifyExecutor = createSequentialSignatureVerify();

function ownJobs(jobs: readonly SignatureJobInput[]): SignatureJobInput[] {
  return jobs.map((job) => ({
    ...job,
    publicKey: new Uint8Array(job.publicKey),
    message: new Uint8Array(job.message),
    signature: new Uint8Array(job.signature),
  }));
}

function rejected(job: SignatureJobInput): ValidationError {
  return new ValidationError({ code: job.code ?? 'bad-signature', position: job.position });
}

/** In-process verifier. The optional cache is owned by the caller or the Layer. */
export function makeSignatureVerifier(options?: {
  readonly cache?: SigningPointCache;
}): SignatureVerifier['Type'] {
  const cache = options?.cache;
  return SignatureVerifier.of({
    verify: ({ publicKey, message, signature }) => {
      const ownedMessage = new Uint8Array(message);
      return Effect.suspend(() =>
        verifySignature(publicKey.toBytes(), ownedMessage, signature.toBytes(), cache)
          ? Effect.void
          : Effect.fail(new ValidationError({ code: 'bad-signature' }))
      );
    },
    verifyMany: (jobs, facts) => {
      const owned = ownJobs(jobs);
      return Effect.suspend(() => {
        for (const job of owned) {
          if (!verifySignature(job.publicKey, job.message, job.signature, cache, facts))
            return Effect.fail(rejected(job));
        }
        return Effect.void;
      });
    },
  });
}

/** Batch verifier over a trusted executor (for example the Node worker pool).
 * Executor faults are defects; a malformed verdict list is `invalid-operation`. */
export function makeExecutorSignatureVerifier(
  executor: SignatureVerifyExecutor
): Effect.Effect<SignatureVerifier['Type'], ValidationError> {
  if (!isTrustedSignatureVerifyExecutor(executor))
    return Effect.fail(new ValidationError({ code: 'invalid-operation' }));
  const run = (jobs: SignatureJobInput[]) =>
    Effect.gen(function* () {
      if (jobs.length === 0) return;
      const results = yield* Effect.promise(() =>
        executor.verify(
          jobs.map((job) => ({ pk: job.publicKey, msg: job.message, sig: job.signature }))
        )
      );
      if (!Array.isArray(results) || results.length !== jobs.length)
        return yield* Effect.fail(new ValidationError({ code: 'invalid-operation' }));
      const index = results.findIndex((ok) => ok !== true);
      if (index >= 0) return yield* Effect.fail(rejected(jobs[index]!));
    });
  return Effect.succeed(
    SignatureVerifier.of({
      verify: ({ publicKey, message, signature }) =>
        run([
          {
            publicKey: publicKey.toBytes(),
            message: new Uint8Array(message),
            signature: signature.toBytes(),
          },
        ]),
      verifyMany: (jobs) => run(ownJobs(jobs)),
    })
  );
}

/** Fresh cache per Layer build, never a shared live default. */
export const signatureVerifierLayer: Layer.Layer<SignatureVerifier> = Layer.sync(
  SignatureVerifier,
  () => makeSignatureVerifier({ cache: new SigningPointCache() })
);
