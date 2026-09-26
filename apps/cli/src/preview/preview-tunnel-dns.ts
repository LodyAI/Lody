import { Resolver } from 'node:dns/promises';

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
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      try {
        const addresses = await resolver.resolve4(hostname);
        signal.throwIfAborted();
        if (addresses.length > 0) {
          onDiagnostic?.(`dns host=${hostname}; published=true`);
          return;
        }
      } catch (error) {
        signal.throwIfAborted();
        const code =
          error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'UNKNOWN';
        // Some proxy-only networks disallow direct DNS. This is a startup
        // optimization, not a new network requirement: keep the existing HTTP
        // verifier in that case. A real negative answer must not warm its cache.
        if (code !== 'ENOTFOUND' && code !== 'ENODATA') {
          const safeCode = /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'UNKNOWN';
          onDiagnostic?.(`dns host=${hostname}; unavailable=${safeCode}; using public probe`);
          return;
        }
      }
      onDiagnostic?.(`dns host=${hostname}; published=false`);
      await waitForPreviewRetry(signal);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
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
