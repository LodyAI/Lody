/** Only host navigation identity survives replacement; a token never references plugin code. */
type Generation = { keys: Map<string, AbortController>; claimed: Set<string> };
const generations = new WeakMap<AbortSignal, Generation>();
export function beginShellGeneration(signal: AbortSignal, previous?: AbortSignal) {
  const generation = {
    keys: (previous && generations.get(previous)?.keys) || new Map<string, AbortController>(),
    claimed: new Set<string>(),
  };
  if (previous) generations.delete(previous);
  generations.set(signal, generation);
}
export function shellIdentity(signal: AbortSignal, key: string) {
  signal.throwIfAborted();
  if (!generations.has(signal)) {
    beginShellGeneration(signal);
    signal.addEventListener('abort', () => endShellGeneration(signal), { once: true });
  }
  const g = generations.get(signal)!;
  g.claimed.add(key);
  let id = g.keys.get(key);
  if (!id) {
    id = new AbortController();
    g.keys.set(key, id);
  }
  return id.signal;
}
export function finishShellGeneration(signal: AbortSignal) {
  const g = generations.get(signal);
  if (g)
    for (const [key, id] of g.keys)
      if (!g.claimed.has(key)) {
        id.abort();
        g.keys.delete(key);
      }
}
export function endShellGeneration(signal: AbortSignal) {
  const g = generations.get(signal);
  if (g) {
    for (const id of g.keys.values()) id.abort();
    g.keys.clear();
    generations.delete(signal);
  }
}
