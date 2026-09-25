import {
  buildManagedPreviewViewerUrl,
  setPreviewQueryParamInUrl,
  type PreviewTarget,
} from '@lody/shared';
import { formatErrorMessage } from '@/utils/format-error';

const TUNNEL_ROUND_TRIP_TIMEOUT_MS = 20_000;
const TUNNEL_HEALTH_TIMEOUT_MS = 5_000;
const TUNNEL_ROUND_TRIP_MAX_REDIRECTS = 5;

export const VISUAL_ANNOTATION_RUNTIME_RESPONSE_HEADER = 'x-lody-preview-runtime';
export const VISUAL_ANNOTATION_RUNTIME_RESPONSE_VERSION = 'visual-annotation-v1';
export const PREVIEW_PROXY_RESPONSE_HEADER = 'x-lody-preview-proxy';
export const PREVIEW_PROXY_RESPONSE_VERSION = '1';
export const PREVIEW_PROBE_HEADER = 'x-lody-preview-probe';

function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    'code' in error &&
    typeof error.code === 'string' &&
    [
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
    ].includes(error.code)
  )
    return true;
  return error.cause !== undefined && error.cause !== error && isTransientNetworkError(error.cause);
}

function waitForReadiness(signal: AbortSignal): Promise<void> {
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

async function fetchReadyRoute(
  url: URL,
  signal: AbortSignal,
  fetcher: typeof fetch,
  waitForPropagation: boolean
): Promise<Response> {
  while (true) {
    signal.throwIfAborted();
    try {
      const response = await fetcher(url, {
        method: 'GET',
        headers: { accept: 'text/html', [PREVIEW_PROBE_HEADER]: '1' },
        redirect: 'manual',
        signal,
      });
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
      if (!waitForPropagation || !isTransientNetworkError(error)) throw error;
    }
    await waitForReadiness(signal);
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
}): Promise<void> {
  const gateway = new URL(args.publicUrl);
  const initialViewerUrl = buildManagedPreviewViewerUrl(gateway, args.target);
  const authorizationParams = [...gateway.searchParams.entries()];
  const controller = new AbortController();
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
          waitForPropagation
        );
      } catch (error) {
        throw new Error(
          `Preview public route round-trip failed for ${initialViewerUrl.host}: ${formatErrorMessage(error)}`,
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
  }
}
