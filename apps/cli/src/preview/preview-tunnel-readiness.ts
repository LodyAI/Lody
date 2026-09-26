import { isIP } from 'node:net';
import {
  buildManagedPreviewViewerUrl,
  setPreviewQueryParamInUrl,
  type PreviewTarget,
} from '@lody/shared';
import { formatErrorMessage } from '@/utils/format-error';
import { waitForPreviewDns, waitForPreviewRetry } from './preview-tunnel-dns';

// Fresh Quick Tunnel routes can take over a minute to accept TLS after allocation.
const TUNNEL_ROUND_TRIP_TIMEOUT_MS = 90_000;
const TUNNEL_HEALTH_TIMEOUT_MS = 5_000;
const TUNNEL_ROUND_TRIP_MAX_REDIRECTS = 5;

export const VISUAL_ANNOTATION_RUNTIME_RESPONSE_HEADER = 'x-lody-preview-runtime';
export const VISUAL_ANNOTATION_RUNTIME_RESPONSE_VERSION = 'visual-annotation-v1';
export const PREVIEW_PROXY_RESPONSE_HEADER = 'x-lody-preview-proxy';
export const PREVIEW_PROXY_RESPONSE_VERSION = '1';
export const PREVIEW_PROBE_HEADER = 'x-lody-preview-probe';

// Fetch messages can contain credentials. Inspect bounded causes/aggregate
// branches, retaining only errno codes and validated connection addresses.
function networkFailures(error: unknown) {
  const failures: Array<{ code: string; address?: string }> = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  let complete = true;
  while (pending.length && seen.size < 32) {
    const current = pending.shift();
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      /^[A-Z0-9_]{1,80}$/.test(current.code)
    ) {
      const address =
        'address' in current &&
        typeof current.address === 'string' &&
        !current.address.includes('%') &&
        isIP(current.address)
          ? current.address
          : undefined;
      failures.push({ code: current.code, address });
    }
    if (current.cause !== undefined) pending.push(current.cause);
    if (current instanceof AggregateError) {
      if (current.errors.length > 32) complete = false;
      pending.push(...current.errors.slice(0, 32));
    }
  }
  return { failures, complete: complete && pending.length === 0 };
}

function networkErrorCodes(error: unknown): string {
  return (
    networkFailures(error)
      .failures.map(({ code, address }) =>
        address ? `${code} (IPv${isIP(address)} ${address})` : code
      )
      .join(' -> ') || 'network error (no code)'
  );
}

function isTransientNetworkError(error: unknown): boolean {
  const { failures, complete } = networkFailures(error);
  return (
    complete &&
    failures.length > 0 &&
    failures.every(({ code }) =>
      [
        'ENOTFOUND',
        'EAI_AGAIN',
        'ENETUNREACH',
        'EHOSTUNREACH',
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_SOCKET',
      ].includes(code)
    )
  );
}

async function fetchReadyRoute(
  url: URL,
  signal: AbortSignal,
  fetcher: typeof fetch,
  waitForPropagation: boolean,
  observe: (outcome: string, completed: boolean) => void
): Promise<Response> {
  while (true) {
    signal.throwIfAborted();
    observe('request pending', false);
    try {
      const response = await fetcher(url, {
        method: 'GET',
        headers: { accept: 'text/html', [PREVIEW_PROBE_HEADER]: '1' },
        redirect: 'manual',
        signal,
      });
      observe(
        `HTTP ${response.status}; proxyMarker=${response.headers.get(PREVIEW_PROXY_RESPONSE_HEADER) === PREVIEW_PROXY_RESPONSE_VERSION}; cloudflare=${response.headers.get('server') === 'cloudflare'}`,
        true
      );
      if (
        !waitForPropagation ||
        response.headers.get(PREVIEW_PROXY_RESPONSE_HEADER) === PREVIEW_PROXY_RESPONSE_VERSION ||
        response.headers.get('server') !== 'cloudflare' ||
        ![502, 503, 530].includes(response.status)
      )
        return response;
      await response.body?.cancel();
    } catch (error) {
      signal.throwIfAborted();
      observe(networkErrorCodes(error), true);
      if (!waitForPropagation || !isTransientNetworkError(error)) throw error;
    }
    await waitForPreviewRetry(signal);
  }
}

const isRedirectResponse = (response: Response): boolean =>
  response.status >= 300 && response.status < 400;

export async function verifyPreviewTunnelRoundTrip(args: {
  publicUrl: string;
  target: PreviewTarget;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  mode?: 'readiness' | 'health';
  registered?: Promise<void>;
  onDiagnostic?: (message: string) => void;
}): Promise<void> {
  const gateway = new URL(args.publicUrl);
  const initialViewerUrl = buildManagedPreviewViewerUrl(gateway, args.target);
  const authorizationParams = [...gateway.searchParams.entries()];
  const controller = new AbortController();
  const startedAt = performance.now();
  let attempts = 0;
  let lastOutcome = 'none';
  let pending = false;
  const diagnostic = () =>
    `attempts=${attempts}; elapsedMs=${Math.round(performance.now() - startedAt)}; pending=${pending}; lastOutcome=${lastOutcome}`;
  const observe = (outcome: string, completed: boolean) => {
    pending = !completed;
    if (completed) lastOutcome = outcome;
    else attempts += 1;
    args.onDiagnostic?.(`${args.mode ?? 'readiness'} host=${gateway.host}; ${diagnostic()}`);
  };
  const waitForPropagation = args.mode !== 'health';
  const timeoutMs = waitForPropagation ? TUNNEL_ROUND_TRIP_TIMEOUT_MS : TUNNEL_HEALTH_TIMEOUT_MS;
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Preview public route round-trip exceeded ${timeoutMs} ms limit`));
  }, timeoutMs);
  timeout.unref?.();
  const signal = args.signal
    ? AbortSignal.any([controller.signal, args.signal])
    : controller.signal;

  let viewerUrl = initialViewerUrl;
  try {
    if (waitForPropagation && gateway.hostname.endsWith('.trycloudflare.com')) {
      signal.throwIfAborted();
      let abort = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
      });
      signal.addEventListener('abort', abort, { once: true });
      try {
        await Promise.race([
          Promise.all([
            args.registered,
            waitForPreviewDns(gateway.hostname, signal, args.onDiagnostic),
          ]),
          aborted,
        ]);
      } finally {
        signal.removeEventListener('abort', abort);
      }
      signal.throwIfAborted();
    }
    for (
      let redirectCount = 0;
      redirectCount <= TUNNEL_ROUND_TRIP_MAX_REDIRECTS;
      redirectCount += 1
    ) {
      let response: Response;
      try {
        response = await fetchReadyRoute(
          viewerUrl,
          signal,
          args.fetch ?? fetch,
          waitForPropagation,
          observe
        );
      } catch (error) {
        throw new Error(
          `Preview public route round-trip failed for ${initialViewerUrl.host}: ${signal.aborted ? formatErrorMessage(signal.reason) : networkErrorCodes(error)}; ${diagnostic()}`,
          { cause: error }
        );
      }

      if (response.headers.get(PREVIEW_PROXY_RESPONSE_HEADER) === PREVIEW_PROXY_RESPONSE_VERSION) {
        await response.body?.cancel();
        return;
      }

      if (isRedirectResponse(response)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) {
          throw new Error(
            `Preview public route round-trip failed for ${initialViewerUrl.host}: HTTP ${response.status} omitted the redirect location`
          );
        }
        if (redirectCount === TUNNEL_ROUND_TRIP_MAX_REDIRECTS) {
          throw new Error(
            `Preview public route round-trip failed for ${initialViewerUrl.host}: too many redirects`
          );
        }
        let redirected = new URL(location, viewerUrl);
        if (redirected.origin !== initialViewerUrl.origin) {
          throw new Error(
            `Preview public route round-trip failed for ${initialViewerUrl.host}: redirect left the isolated preview origin`
          );
        }
        for (const [name, value] of authorizationParams) {
          redirected = setPreviewQueryParamInUrl(redirected, name, value);
        }
        viewerUrl = redirected;
        continue;
      }

      await response.body?.cancel();
      throw new Error(
        `Preview public route round-trip failed for ${initialViewerUrl.host}: HTTP ${response.status} did not return the preview proxy marker.`
      );
    }
  } finally {
    clearTimeout(timeout);
    // A failed registration also cancels any DNS query still running in parallel.
    controller.abort();
  }
}
