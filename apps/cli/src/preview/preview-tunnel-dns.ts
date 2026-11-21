import { Resolver } from 'node:dns/promises';

// Give fresh records time to publish without making local/split DNS a hard
// requirement for a proxy-backed HTTP route. Leave most of the 90s startup
// deadline for the existing authenticated public probe.
const DNS_PUBLICATION_BUDGET_MS = 10_000;

/** Check publication without populating the OS/proxy's hostname negative cache.
 * Uses the configured DNS servers; never pins the HTTP destination or changes SNI.
 */
export async function waitForPreviewDns(
  hostname: string,
  signal: AbortSignal,
  onDiagnostic?: (message: string) => void
): Promise<void> {
  signal.throwIfAborted();
  const resolver = new Resolver({ timeout: 2_000, tries: 1 });
  const startedAt = performance.now();
  let attempts = 0;
  let lastOutcome = 'none';
  const diagnostic = () =>
    `query=A; attempts=${attempts}; elapsedMs=${Math.round(performance.now() - startedAt)}; lastOutcome=${lastOutcome}`;
  const deadline = new AbortController();
  const dnsSignal = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), DNS_PUBLICATION_BUDGET_MS);
  const cancel = () => resolver.cancel();
  dnsSignal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      dnsSignal.throwIfAborted();
      try {
        attempts += 1;
        const addresses = await resolver.resolve4(hostname);
        dnsSignal.throwIfAborted();
        lastOutcome = addresses.length > 0 ? 'resolved' : 'empty';
        if (addresses.length > 0) {
          onDiagnostic?.(`dns host=${hostname}; published=true; ${diagnostic()}`);
          return;
        }
      } catch (error) {
        dnsSignal.throwIfAborted();
        const code =
          error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'UNKNOWN';
        lastOutcome = /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'UNKNOWN';
        // Some proxy-only networks disallow direct DNS. This is a startup
        // optimization, not a new network requirement: keep the existing HTTP
        // verifier in that case. Negative answers retry within the budget.
        if (code !== 'ENOTFOUND' && code !== 'ENODATA') {
          onDiagnostic?.(
            `dns host=${hostname}; unavailable=${lastOutcome}; using public probe; ${diagnostic()}`
          );
          return;
        }
      }
      onDiagnostic?.(`dns host=${hostname}; published=false; ${diagnostic()}`);
      await waitForPreviewRetry(dnsSignal);
    }
  } catch (error) {
    signal.throwIfAborted();
    if (!deadline.signal.aborted) throw error;
    onDiagnostic?.(
      `dns host=${hostname}; publication budget expired; using public probe; ${diagnostic()}`
    );
  } finally {
    clearTimeout(timer);
    dnsSignal.removeEventListener('abort', cancel);
    resolver.cancel();
  }
}

export function waitForPreviewRetry(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 500);
    signal.addEventListener('abort', abort, { once: true });
  });
}
