import { fingerprintsEqual, isSecurityFingerprint, type FailureFingerprint } from './fingerprint';

export interface MinimizeResult<T> {
  readonly items: readonly T[];
  readonly originalSize: number;
  readonly finalSize: number;
  readonly trials: number;
  readonly budget: number;
}

/**
 * Bounded delta debugging. Each candidate is re-executed. A shrink that
 * turns a security fingerprint into harness-error or a different rule is
 * rejected. Not a global shortest-counterexample search.
 */
export async function minimizeCounterexample<T>(input: {
  items: readonly T[];
  fingerprint: FailureFingerprint;
  run: (candidate: readonly T[]) => Promise<{ fingerprint: FailureFingerprint | null }>;
  keep?: (item: T, index: number, items: readonly T[]) => boolean;
  maxTrials?: number;
}): Promise<MinimizeResult<T>> {
  if (!isSecurityFingerprint(input.fingerprint)) {
    throw new Error('minimize-not-security-fingerprint');
  }
  const budget = input.maxTrials ?? 64;
  let current = input.items.slice();
  let trials = 0;

  const allowed = async (candidate: readonly T[]): Promise<boolean> => {
    if (candidate.length === 0) return false;
    if (trials >= budget) return false;
    trials += 1;
    const result = await input.run(candidate);
    if (!result.fingerprint) return false;
    if (!isSecurityFingerprint(result.fingerprint)) return false;
    return fingerprintsEqual(input.fingerprint, result.fingerprint);
  };

  const required = (item: T, index: number, items: readonly T[]): boolean =>
    input.keep?.(item, index, items) === true;

  let progress = true;
  while (progress && current.length > 1) {
    if (trials >= budget) break;
    progress = false;
    const chunk = Math.max(1, Math.floor(current.length / 2));
    for (let start = 0; start < current.length; start += chunk) {
      if (trials >= budget) break;
      const removed = current.slice(start, start + chunk);
      if (removed.some((item, offset) => required(item, start + offset, current))) continue;
      const candidate = current.slice(0, start).concat(current.slice(start + chunk));
      if (candidate.length >= current.length) continue;
      if (await allowed(candidate)) {
        current = candidate;
        progress = true;
        break;
      }
    }
    if (progress) continue;
    for (let index = 0; index < current.length; index++) {
      if (trials >= budget) break;
      if (required(current[index]!, index, current)) continue;
      const candidate = current.slice(0, index).concat(current.slice(index + 1));
      if (await allowed(candidate)) {
        current = candidate;
        progress = true;
        break;
      }
    }
  }

  return {
    items: current,
    originalSize: input.items.length,
    finalSize: current.length,
    trials,
    budget,
  };
}
