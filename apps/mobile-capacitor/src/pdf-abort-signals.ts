// PDF.js uses composite signals to remove DOM listeners. Unlike fetch, those
// consumers may retain neither the original signal nor its controller. Each
// PDF caller has an owner controller that aborts on gesture/document teardown.
const activePdfSignals = new Set<AbortSignal>();

export function pdfAbortSignalAny(signals: Iterable<AbortSignal>): AbortSignal {
  const sources = [...signals];
  const signal = AbortSignal.any(sources);
  if (signal.aborted || sources.length === 0) return signal;
  activePdfSignals.add(signal);
  signal.addEventListener('abort', () => activePdfSignals.delete(signal), { once: true });
  return signal;
}
