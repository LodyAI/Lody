import {
  buildManagedPreviewViewerUrl,
  setPreviewQueryParamInUrl,
  type PreviewTarget,
} from '@lody/shared';
import { formatErrorMessage } from '@/utils/format-error';

const TUNNEL_ROUND_TRIP_TIMEOUT_MS = 10_000;
const TUNNEL_ROUND_TRIP_MAX_REDIRECTS = 5;

export const VISUAL_ANNOTATION_RUNTIME_RESPONSE_HEADER = 'x-lody-preview-runtime';
export const VISUAL_ANNOTATION_RUNTIME_RESPONSE_VERSION = 'visual-annotation-v1';
export const PREVIEW_PROXY_RESPONSE_HEADER = 'x-lody-preview-proxy';
export const PREVIEW_PROXY_RESPONSE_VERSION = '1';

const isRedirectResponse = (response: Response): boolean =>
  response.status >= 300 && response.status < 400;

export async function verifyPreviewTunnelRoundTrip(args: {
  publicUrl: string;
  target: PreviewTarget;
}): Promise<void> {
  const gateway = new URL(args.publicUrl);
  const initialViewerUrl = buildManagedPreviewViewerUrl(gateway, args.target);
  const authorizationParams = [...gateway.searchParams.entries()];
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(
      new Error(`Preview public route round-trip exceeded ${TUNNEL_ROUND_TRIP_TIMEOUT_MS} ms limit`)
    );
  }, TUNNEL_ROUND_TRIP_TIMEOUT_MS);
  timeout.unref?.();

  let viewerUrl = initialViewerUrl;
  try {
    for (
      let redirectCount = 0;
      redirectCount <= TUNNEL_ROUND_TRIP_MAX_REDIRECTS;
      redirectCount += 1
    ) {
      let response: Response;
      try {
        response = await fetch(viewerUrl, {
          method: 'GET',
          headers: new Headers({ accept: 'text/html' }),
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        throw new Error(
          `Preview public route round-trip failed for ${initialViewerUrl.host}: ${formatErrorMessage(error)}`,
          { cause: error }
        );
      }

      if (
        response.headers.get(PREVIEW_PROXY_RESPONSE_HEADER) === PREVIEW_PROXY_RESPONSE_VERSION ||
        response.headers.get(VISUAL_ANNOTATION_RUNTIME_RESPONSE_HEADER) ===
          VISUAL_ANNOTATION_RUNTIME_RESPONSE_VERSION
      ) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }

      if (isRedirectResponse(response)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
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

      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Preview public route round-trip failed for ${initialViewerUrl.host}: HTTP ${response.status} did not return the preview proxy marker. Verify wildcard DNS and the Preview Worker route.`
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}
