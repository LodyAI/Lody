import { Data, Effect } from 'effect';
import {
  isSecurityFingerprint,
  preserveSecurityFailure,
  type FailureFingerprint,
} from './fingerprint';
export class MinimizeError extends Data.TaggedError('MinimizeError')<{
  readonly code: 'invalid-budget' | 'not-security' | 'unmeasured-trigger';
}> {}
export interface MinimizeResult<T> {
  readonly items: readonly T[];
  readonly originalSize: number;
  readonly finalSize: number;
  readonly trials: number;
  readonly budget: number;
  readonly coverage: 'complete' | 'partial';
  readonly uncertain: readonly string[];
}
const own = (value: FailureFingerprint): FailureFingerprint =>
  Object.freeze({
    rules: Object.freeze([...value.rules]),
    confidentiality: value.confidentiality,
    integrity: value.integrity,
    durability: value.durability,
    detectability: value.detectability,
    related: Object.freeze({
      ledgerRecords: value.related.ledgerRecords,
      unverifiedAccepted: value.related.unverifiedAccepted,
      cursorAhead: value.related.cursorAhead,
      durableLoss: value.related.durableLoss,
      wrongContext: value.related.wrongContext,
    }),
  });
/** Finite sequential delta debugging, not a replay/action executor or globally
 * minimal proof. Array ownership is independent; generic items must already be
 * immutable, independently owned actions. Runs are caller-owned Effects, no hidden
 * Promise runtime, retry, timeout or error-to-pass fallback. */
export function minimizeCounterexample<T, E, R>(input: {
  readonly items: readonly T[];
  readonly fingerprint: FailureFingerprint;
  readonly run: (
    candidate: readonly T[]
  ) => Effect.Effect<{ readonly fingerprint: FailureFingerprint | null }, E, R>;
  readonly keep?: (item: T, index: number, items: readonly T[]) => boolean;
  readonly maxTrials?: number;
}): Effect.Effect<MinimizeResult<T>, MinimizeError | E, R> {
  return Effect.gen(function* () {
    const original = own(input.fingerprint),
      run = input.run,
      keep = input.keep;
    const budget = input.maxTrials ?? 64;
    let current: readonly T[] = Object.freeze([...input.items]);
    const originalSize = current.length;
    if (!Number.isSafeInteger(budget) || budget < 0)
      return yield* new MinimizeError({ code: 'invalid-budget' });
    if (!isSecurityFingerprint(original)) return yield* new MinimizeError({ code: 'not-security' });
    if (!preserveSecurityFailure(original, original).preserved)
      return yield* new MinimizeError({ code: 'unmeasured-trigger' });
    let trials = 0;
    let measured = original;
    const allowed = (candidate: readonly T[]) =>
      Effect.gen(function* () {
        if (candidate.length === 0 || trials >= budget) return false;
        trials++;
        const result = yield* run(Object.freeze([...candidate]));
        if (result.fingerprint === null) return false;
        const snapshot = own(result.fingerprint);
        const preservation = preserveSecurityFailure(original, snapshot);
        if (!preservation.preserved) return false;
        measured = snapshot;
        return true;
      });
    const required = (item: T, index: number) => keep?.(item, index, current) === true;
    let progress = true;
    while (progress && current.length > 1) {
      if (trials >= budget) break;
      progress = false;
      const chunk = Math.max(1, Math.floor(current.length / 2));
      for (let start = 0; start < current.length; start += chunk) {
        if (trials >= budget) break;
        if (
          current.slice(start, start + chunk).some((item, offset) => required(item, start + offset))
        )
          continue;
        const candidate = [...current.slice(0, start), ...current.slice(start + chunk)];
        if (candidate.length >= current.length) continue;
        if (yield* allowed(candidate)) {
          current = Object.freeze(candidate);
          progress = true;
          break;
        }
      }
      if (progress) continue;
      for (let index = 0; index < current.length; index++) {
        if (trials >= budget) break;
        if (required(current[index]!, index)) continue;
        const candidate = [...current.slice(0, index), ...current.slice(index + 1)];
        if (yield* allowed(candidate)) {
          current = Object.freeze(candidate);
          progress = true;
          break;
        }
      }
    }
    const preserved = preserveSecurityFailure(original, measured);
    return {
      items: current,
      originalSize,
      finalSize: current.length,
      trials,
      budget,
      coverage: preserved.coverage,
      uncertain: preserved.uncertain,
    };
  });
}
