type PostMultipartArgs = {
  url: string;
  token: string;
  formData: FormData;
  /** Optional upload-progress callback (0-100). */
  onProgress?: (percent: number) => void;
  /** Prefix for network/abort error messages, e.g. "Image upload". */
  errorLabel: string;
  signal?: AbortSignal;
};

/**
 * POST multipart form data with optional upload-progress events, resolving with
 * the parsed JSON response body (or `null` when it can't be parsed). Rejects on
 * network/abort errors and on non-2xx responses, surfacing a server `error`
 * field when present. Callers validate the response shape themselves.
 *
 * Uses XMLHttpRequest (not fetch) because it is the only way to observe upload
 * progress; callers that don't need progress simply omit `onProgress`.
 */
export function postMultipartWithProgress({
  url,
  token,
  formData,
  onProgress,
  errorLabel,
  signal,
}: PostMultipartArgs): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException(`${errorLabel} aborted`, 'AbortError'));
      return;
    }
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      request.upload.onprogress = null;
      request.onerror = request.onabort = request.onload = null;
    };
    request.open('POST', url);
    request.responseType = 'json';
    request.setRequestHeader('Authorization', `Bearer ${token}`);

    if (onProgress) {
      request.upload.onprogress = (event) => {
        if (!event.lengthComputable) {
          return;
        }
        const ratio = event.total > 0 ? event.loaded / event.total : 0;
        onProgress(Math.max(0, Math.min(100, Math.round(ratio * 100))));
      };
    }

    request.onerror = () => {
      cleanup();
      reject(new Error(`${errorLabel} failed`));
    };
    request.onabort = () => {
      cleanup();
      reject(new DOMException(`${errorLabel} aborted`, 'AbortError'));
    };

    request.onload = () => {
      cleanup();
      let responseBody: unknown = null;
      try {
        responseBody =
          request.response && typeof request.response === 'object'
            ? request.response
            : request.responseText
              ? JSON.parse(request.responseText)
              : null;
      } catch {
        responseBody = null;
      }

      if (request.status < 200 || request.status >= 300) {
        const message =
          responseBody && typeof responseBody === 'object' && 'error' in responseBody
            ? String((responseBody as { error?: unknown }).error ?? '')
            : request.statusText;
        reject(new Error(message || `Upload failed with status ${request.status}`));
        return;
      }

      resolve(responseBody);
    };

    try {
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        cleanup();
        reject(new DOMException(`${errorLabel} aborted`, 'AbortError'));
        return;
      }
      request.send(formData);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
